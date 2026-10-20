import { FSAdapter } from '../fs/types.js';
import { parseGitDir, joinPaths } from '../utils/path.js';
import {
  readIndex,
  writeIndex,
  IndexEntry,
  indexEntryStage,
} from '../core/index.js';
import { resolveHead, writeRef, setHeadDetached } from '../core/refs.js';
import { NotAGitRepoError, TsGitError } from '../errors.js';
import {
  flattenTree,
  FlatTreeEntry,
  readCommitTree,
  resolveRevision,
  peelToCommit,
  peelToTree,
  headCommitOid,
  matchesPathspec,
  modeNumberToString,
  modeStringToNumber,
  makeIndexEntry,
  hashWorktreeEntry,
  trustExecutableBit,
  EMPTY_TREE_OID,
} from './tree-helpers.js';
import { checkoutTree } from './checkout-helpers.js';
import { clearMergeState, isMergeInProgress } from './merge-state.js';

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetResult {
  /** Paths whose index entry was changed by the reset. */
  unstaged: string[];
  /** Commit HEAD points to after the reset (null on an unborn branch). */
  oid?: string | null;
}

/**
 * `git reset`.
 *
 * - With `filepath` (`git reset [<ref>] -- <pathspec>...`): index entries
 *   matching the pathspecs (exact paths, directories, `.` or globs) are set
 *   to their version in `ref` (default HEAD), or removed when absent there
 *   (on an unborn branch they are simply removed). HEAD and the working tree
 *   are untouched. Only `mixed` mode is allowed, as in git.
 * - Without `filepath` (`git reset [--soft|--mixed|--hard] [<ref>]`):
 *   the current branch (or detached HEAD) is moved to `ref` (default HEAD)
 *   and ORIG_HEAD records the previous commit; `mixed` (default) also resets
 *   the index, `hard` also resets the working tree (tracked files only;
 *   untracked files are left alone).
 */
export async function reset(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  filepath?: string | string[];
  /** Commit-ish to reset to (default HEAD). */
  ref?: string;
  /** Reset mode (default 'mixed'). */
  mode?: ResetMode;
}): Promise<ResetResult> {
  const {
    fs,
    dir,
    gitdir: providedGitdir,
    filepath,
    ref,
    mode = 'mixed',
  } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);

  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  const currentHead = await headCommitOid(fs, gitdir);

  if (filepath !== undefined) {
    if (mode !== 'mixed') {
      throw new TsGitError(`Cannot do ${mode} reset with paths.`);
    }
    const specs = Array.isArray(filepath) ? filepath : [filepath];
    // With paths the source may be any tree-ish.
    let treeOid: string | null = null;
    if (ref !== undefined) {
      treeOid = await peelToTree(
        fs,
        gitdir,
        await resolveRevision(fs, gitdir, ref),
      );
    } else if (currentHead) {
      treeOid = await readCommitTree(fs, gitdir, currentHead);
    }
    const tree = await flattenTree(fs, gitdir, treeOid);
    const unstaged = await resetIndex(fs, dir, gitdir, tree, (p) =>
      matchesPathspec(p, specs),
    );
    return { unstaged, oid: currentHead };
  }

  // Whole-tree reset.
  if (mode === 'soft' && (await isMergeInProgress(fs, gitdir))) {
    throw new TsGitError('Cannot do a soft reset in the middle of a merge.');
  }
  let targetOid: string | null;
  if (ref !== undefined) {
    targetOid = await peelToCommit(
      fs,
      gitdir,
      await resolveRevision(fs, gitdir, ref),
    );
  } else {
    // On an unborn branch git resets to the empty tree and leaves refs alone.
    targetOid = currentHead;
  }

  const targetTree = targetOid
    ? await readCommitTree(fs, gitdir, targetOid)
    : null;

  let unstaged: string[] = [];
  if (mode === 'mixed') {
    const tree = await flattenTree(fs, gitdir, targetTree);
    unstaged = await resetIndex(fs, dir, gitdir, tree, () => true);
  } else if (mode === 'hard') {
    const before = await readIndex(fs, gitdir);
    await checkoutTree({
      fs,
      dir,
      gitdir,
      to: targetTree ?? EMPTY_TREE_OID,
      force: true,
    });
    const after = await readIndex(fs, gitdir);
    unstaged = changedPaths(before.entries, after.entries);
  }

  if (targetOid) {
    await moveHead(fs, gitdir, targetOid, currentHead);
  }
  await clearMergeState(fs, gitdir);

  return { unstaged, oid: targetOid };
}

/** Point the current branch (or detached HEAD) at `oid`, recording ORIG_HEAD. */
async function moveHead(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
  previous: string | null,
): Promise<void> {
  if (previous) {
    await fs.writeFile(joinPaths(gitdir, 'ORIG_HEAD'), `${previous}\n`);
  }
  const head = await resolveHead(fs, gitdir);
  if (head?.type === 'symbolic') {
    await writeRef(fs, gitdir, head.ref, oid, true);
  } else {
    await setHeadDetached(fs, gitdir, oid);
  }
}

function entryKey(e: IndexEntry): string {
  return `${indexEntryStage(e.flags)}:${modeNumberToString(e.mode)}:${e.oid}`;
}

function changedPaths(before: IndexEntry[], after: IndexEntry[]): string[] {
  const group = (entries: IndexEntry[]) => {
    const m = new Map<string, string[]>();
    for (const e of entries) {
      const list = m.get(e.path) ?? [];
      list.push(entryKey(e));
      m.set(e.path, list);
    }
    return m;
  };
  const a = group(before);
  const b = group(after);
  const changed: string[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const x = (a.get(path) ?? []).sort().join('|');
    const y = (b.get(path) ?? []).sort().join('|');
    if (x !== y) changed.push(path);
  }
  return changed.sort();
}

/**
 * Make the index match `tree` for every path accepted by `selects`
 * (git's read-tree for `reset --mixed` / `reset -- <paths>`). Unchanged
 * entries keep their stat data; changed ones get fresh stat data when the
 * working tree file already matches (like git's post-reset refresh).
 * Returns the paths whose index entry changed.
 */
async function resetIndex(
  fs: FSAdapter,
  dir: string,
  gitdir: string,
  tree: Map<string, FlatTreeEntry>,
  selects: (path: string) => boolean,
): Promise<string[]> {
  const index = await readIndex(fs, gitdir);
  const trustExec = await trustExecutableBit(fs, gitdir);
  const before = [...index.entries];

  const kept: IndexEntry[] = [];
  const existing = new Map<string, IndexEntry>();
  for (const e of index.entries) {
    if (!selects(e.path)) {
      kept.push(e);
    } else if (indexEntryStage(e.flags) === 0) {
      existing.set(e.path, e);
    }
    // Selected unmerged entries are dropped and replaced by the tree version.
  }

  for (const [path, t] of tree) {
    if (!selects(path)) continue;
    const mode = modeStringToNumber(t.mode);
    const prev = existing.get(path);
    if (
      prev &&
      prev.oid === t.oid &&
      modeNumberToString(prev.mode) === t.mode
    ) {
      kept.push(prev);
      continue;
    }
    let stats = null;
    if (t.mode !== '160000') {
      const wt = await hashWorktreeEntry(fs, dir, path, {
        trustExecutable: trustExec,
        existingMode: mode,
      });
      if (wt && wt.oid === t.oid && modeNumberToString(wt.mode) === t.mode) {
        stats = wt.stats;
      }
    }
    kept.push(makeIndexEntry(path, t.oid, mode, stats));
  }

  index.entries = kept;
  await writeIndex(fs, gitdir, index);
  return changedPaths(before, kept);
}
