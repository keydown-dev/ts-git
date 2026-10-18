import { FSAdapter } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';
import { readConfig, getConfigValue, getConfigValues } from '../core/config.js';
import {
  readIndex,
  writeIndex,
  indexEntryStage,
  compareIndexEntries,
  type IndexEntry,
} from '../core/index.js';
import { readObject, writeObject, serializeCommit } from '../core/objects.js';
import {
  getCurrentBranch,
  isHeadDetached,
  listRefs,
  resolveHeadCommitOid,
  setHeadDetached,
  writeRef,
} from '../core/refs.js';
import {
  findMergeBases,
  isAncestor,
  peelToNonTag,
} from '../core/commit-graph.js';
import { flattenTree, mergeTrees, writeFlatTree } from '../core/merge-tree.js';
import { expandRefName } from '../remote/refspec.js';
import {
  MergeConflictError,
  NonFastForwardError,
  UncommittedChangesError,
  TsGitError,
} from '../errors.js';
import type { Author } from '../types.js';
import { checkoutTree } from './checkout-helpers.js';
import {
  makeIndexEntry,
  modeStringToNumber,
  resolveRevision,
} from './tree-helpers.js';
import { requireGitdir } from './remote.js';

export interface MergeArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** What to merge: a branch, remote-tracking branch, tag or commit id. */
  theirs: string;
  /**
   * 'auto' (default) fast-forwards when possible, 'only' refuses anything
   * else (--ff-only), 'never' always creates a merge commit (--no-ff).
   */
  fastForward?: 'auto' | 'only' | 'never';
  /** Merge commit message; defaults to git's "Merge branch 'x'" form. */
  message?: string;
  /** Name for `theirs` in conflict markers (defaults to `theirs` as given). */
  theirsLabel?: string;
  /** Defaults to user.name / user.email from the repository config. */
  author?: Author;
  committer?: Author;
}

export type MergeResult =
  | { type: 'up-to-date'; oid: string }
  | { type: 'fast-forward'; oid: string; previous: string | null }
  | { type: 'merge'; oid: string; previous: string; mergeBase: string | null };

const MERGE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE'];

async function resolveAuthor(
  fs: FSAdapter,
  gitdir: string,
  given: Author | undefined,
): Promise<Required<Author>> {
  let author = given;
  if (!author) {
    const config = await readConfig(fs, gitdir);
    const name = getConfigValue(config, 'user', 'name');
    const email = getConfigValue(config, 'user', 'email');
    if (!name || !email) {
      throw new TsGitError(
        'Author identity unknown: pass `author` or set user.name and user.email',
      );
    }
    author = { name, email };
  }
  return {
    name: author.name,
    email: author.email,
    timestamp: author.timestamp ?? Math.floor(Date.now() / 1000),
    timezoneOffset: author.timezoneOffset ?? new Date().getTimezoneOffset(),
  };
}

/** Classify what the user asked to merge, for messages (fmt-merge-msg). */
async function describeTheirs(
  fs: FSAdapter,
  gitdir: string,
  theirs: string,
): Promise<string> {
  const refs = await listRefs(fs, gitdir);
  const full = expandRefName(theirs, (n) => refs.has(n));
  if (refs.has(full)) {
    if (full.startsWith('refs/heads/')) return `branch '${full.slice(11)}'`;
    if (full.startsWith('refs/remotes/')) {
      return `remote-tracking branch '${full.slice(13)}'`;
    }
    if (full.startsWith('refs/tags/')) return `tag '${full.slice(10)}'`;
  }
  return `commit '${theirs}'`;
}

/**
 * " into <branch>" suffix for merge messages, omitted for branches matching
 * merge.suppressDest (default: main and master), as fmt-merge-msg does.
 */
export async function mergeIntoSuffix(
  fs: FSAdapter,
  gitdir: string,
  branch: string | null,
): Promise<string> {
  if (!branch) return '';
  const config = await readConfig(fs, gitdir);
  let patterns = getConfigValues(config, 'merge', 'suppressDest');
  const lastEmpty = patterns.lastIndexOf('');
  if (lastEmpty !== -1) patterns = patterns.slice(lastEmpty + 1);
  else if (patterns.length === 0) patterns = ['main', 'master'];
  const matches = patterns.some((p) =>
    new RegExp(
      `^${p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    ).test(branch),
  );
  return matches ? '' : ` into ${branch}`;
}

/** Updates the branch HEAD points at (or HEAD itself when detached). */
async function moveHead(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<void> {
  if (await isHeadDetached(fs, gitdir)) {
    await setHeadDetached(fs, gitdir, oid);
    return;
  }
  const head = (await fs.readFileString(joinPaths(gitdir, 'HEAD'))).trim();
  const ref = head.startsWith('ref: ') ? head.slice(5) : null;
  if (!ref) {
    await setHeadDetached(fs, gitdir, oid);
    return;
  }
  await writeRef(fs, gitdir, ref, oid, true);
}

/**
 * Join another line of history into the current branch (`git merge`).
 *
 * On conflicts the repository is left mid-merge exactly like git leaves it
 * (conflict markers in files, stages 1-3 in the index, MERGE_HEAD and
 * MERGE_MSG written) and a MergeConflictError listing the paths is thrown.
 * Resolve, add and commit to conclude, or call abortMerge().
 */
export async function merge(args: MergeArgs): Promise<MergeResult> {
  const { fs, dir } = args;
  const gitdir = await requireGitdir(args);
  const mode = args.fastForward ?? 'auto';

  if (await fs.exists(joinPaths(gitdir, 'MERGE_HEAD'))) {
    throw new TsGitError(
      'You have not concluded your merge (MERGE_HEAD exists). Commit or abort it first.',
    );
  }

  const theirsOid = (
    await peelToNonTag(
      fs,
      gitdir,
      await resolveRevision(fs, gitdir, args.theirs),
    )
  ).oid;
  if ((await readObject(fs, gitdir, theirsOid)).type !== 'commit') {
    throw new TsGitError(`${args.theirs} - not something we can merge`);
  }
  const headOid = await resolveHeadCommitOid(fs, gitdir);
  const branch = (await isHeadDetached(fs, gitdir))
    ? null
    : await getCurrentBranch(fs, gitdir);

  // Unborn branch: simply adopt their history.
  if (!headOid) {
    await checkoutTree({ fs, dir, gitdir, from: null, to: theirsOid });
    await moveHead(fs, gitdir, theirsOid);
    return { type: 'fast-forward', oid: theirsOid, previous: null };
  }

  if (await isAncestor(fs, gitdir, theirsOid, headOid)) {
    return { type: 'up-to-date', oid: headOid };
  }

  const canFastForward = await isAncestor(fs, gitdir, headOid, theirsOid);
  if (canFastForward && mode !== 'never') {
    await checkoutTree({ fs, dir, gitdir, from: headOid, to: theirsOid });
    await fs.writeFile(joinPaths(gitdir, 'ORIG_HEAD'), `${headOid}\n`);
    await moveHead(fs, gitdir, theirsOid);
    return { type: 'fast-forward', oid: theirsOid, previous: headOid };
  }
  if (mode === 'only') throw new NonFastForwardError();

  // A true merge needs an index that matches HEAD.
  const headCommit = await readObject(fs, gitdir, headOid);
  const headTree = new TextDecoder().decode(headCommit.content).slice(5, 45);
  const headFlat = await flattenTree(fs, gitdir, headTree);
  const index = await readIndex(fs, gitdir);
  const staged: string[] = [];
  const indexPaths = new Set<string>();
  for (const e of index.entries) {
    indexPaths.add(e.path);
    const h = headFlat.get(e.path);
    if (indexEntryStage(e.flags) !== 0 || !h || h.oid !== e.oid)
      staged.push(e.path);
  }
  for (const path of headFlat.keys())
    if (!indexPaths.has(path)) staged.push(path);
  if (staged.length > 0) {
    throw new UncommittedChangesError(
      'Your local changes to the following files would be overwritten by merge. ' +
        'Please commit your changes or stash them before you merge.',
      [...new Set(staged)].sort(),
    );
  }

  const bases = await findMergeBases(fs, gitdir, headOid, theirsOid);
  const baseOid = bases[0] ?? null;
  const baseTree = baseOid
    ? new TextDecoder()
        .decode((await readObject(fs, gitdir, baseOid)).content)
        .slice(5, 45)
    : null;
  const theirsTree = new TextDecoder()
    .decode((await readObject(fs, gitdir, theirsOid)).content)
    .slice(5, 45);

  const label = args.theirsLabel ?? args.theirs;
  const result = await mergeTrees(fs, gitdir, {
    base: baseTree,
    ours: headTree,
    theirs: theirsTree,
    oursLabel: 'HEAD',
    theirsLabel: label,
  });

  const dfConflicts = result.conflicts.filter(
    (c) => c.reason === 'directory/file',
  );
  if (dfConflicts.length > 0) {
    throw new MergeConflictError(
      'Merge aborted: a path is a file on one side and a directory on the other.',
      dfConflicts.map((c) => c.path),
    );
  }

  const message =
    args.message ??
    `Merge ${await describeTheirs(fs, gitdir, args.theirs)}` +
      (await mergeIntoSuffix(fs, gitdir, branch));

  const mergedTree = await writeFlatTree(fs, gitdir, result.entries);
  // Updates index + working tree, refusing to clobber local modifications.
  await checkoutTree({ fs, dir, gitdir, from: headOid, to: mergedTree });
  await fs.writeFile(joinPaths(gitdir, 'ORIG_HEAD'), `${headOid}\n`);

  if (result.conflicts.length > 0) {
    const conflicted = new Set(result.conflicts.map((c) => c.path));
    const after = await readIndex(fs, gitdir);
    const entries: IndexEntry[] = after.entries.filter(
      (e) => !conflicted.has(e.path),
    );
    for (const c of result.conflicts) {
      const stages: Array<[number, typeof c.base]> = [
        [1, c.base],
        [2, c.ours],
        [3, c.theirs],
      ];
      for (const [stage, side] of stages) {
        if (!side) continue;
        const entry = makeIndexEntry(
          c.path,
          side.oid,
          modeStringToNumber(side.mode),
        );
        entry.flags = (entry.flags & ~0x3000) | (stage << 12);
        entries.push(entry);
      }
    }
    entries.sort(compareIndexEntries);
    await writeIndex(fs, gitdir, { ...after, entries });

    const paths = [...conflicted].sort();
    await fs.writeFile(joinPaths(gitdir, 'MERGE_HEAD'), `${theirsOid}\n`);
    await fs.writeFile(
      joinPaths(gitdir, 'MERGE_MODE'),
      mode === 'never' ? 'no-ff' : '',
    );
    await fs.writeFile(
      joinPaths(gitdir, 'MERGE_MSG'),
      `${message}\n\n# Conflicts:\n${paths.map((p) => `#\t${p}\n`).join('')}`,
    );
    throw new MergeConflictError(
      `Automatic merge failed; fix conflicts and then commit the result.\n` +
        paths.map((p) => `CONFLICT: ${p}`).join('\n'),
      paths,
    );
  }

  const author = await resolveAuthor(fs, gitdir, args.author);
  const committer = args.committer
    ? await resolveAuthor(fs, gitdir, args.committer)
    : author;
  const commitOid = await writeObject(
    fs,
    gitdir,
    'commit',
    serializeCommit({
      tree: mergedTree,
      parent: [headOid, theirsOid],
      author,
      committer,
      message: message.endsWith('\n') ? message : `${message}\n`,
    }),
  );
  await moveHead(fs, gitdir, commitOid);
  return {
    type: 'merge',
    oid: commitOid,
    previous: headOid,
    mergeBase: baseOid,
  };
}

/** `git merge --abort`: restore the pre-merge state and forget the merge. */
export async function abortMerge(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
}): Promise<void> {
  const { fs, dir } = args;
  const gitdir = await requireGitdir(args);
  if (!(await fs.exists(joinPaths(gitdir, 'MERGE_HEAD')))) {
    throw new TsGitError('There is no merge to abort (MERGE_HEAD missing).');
  }
  const headOid = await resolveHeadCommitOid(fs, gitdir);
  if (headOid) {
    // Files the merge brought in are in the index but not in HEAD; a
    // HEAD-to-HEAD checkout wouldn't know to remove them.
    const headTree = new TextDecoder()
      .decode((await readObject(fs, gitdir, headOid)).content)
      .slice(5, 45);
    const headFlat = await flattenTree(fs, gitdir, headTree);
    const index = await readIndex(fs, gitdir);
    for (const path of new Set(index.entries.map((e) => e.path))) {
      if (headFlat.has(path)) continue;
      const file = joinPaths(dir, path);
      if (await fs.exists(file)) await fs.unlink(file);
    }
    await writeIndex(fs, gitdir, {
      ...index,
      entries: index.entries.filter((e) => headFlat.has(e.path)),
    });
    await checkoutTree({ fs, dir, gitdir, to: headOid, force: true });
  }
  for (const name of MERGE_FILES) {
    const path = joinPaths(gitdir, name);
    if (await fs.exists(path)) await fs.unlink(path);
  }
}

/** Is the repository in the middle of a conflicted merge? */
export async function isMerging(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
}): Promise<boolean> {
  const gitdir = await requireGitdir(args);
  return args.fs.exists(joinPaths(gitdir, 'MERGE_HEAD'));
}
