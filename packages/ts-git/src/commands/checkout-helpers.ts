/**
 * Switch the index and working tree from one tree to another, the way
 * `git checkout <branch>` / `git switch` (two-way merge) and
 * `git checkout -f` / `git reset --hard` (one-way merge) do.
 *
 * This is the reusable building block for branch switching, hard resets and
 * fast-forward merges: callers move HEAD / the branch ref themselves after it
 * succeeds.
 */
import type { FSAdapter } from '../fs/types.js';
import { joinPaths, parseGitDir, dirname } from '../utils/path.js';
import {
  readIndex,
  writeIndex,
  IndexEntry,
  indexEntryStage,
} from '../core/index.js';
import { readObject } from '../core/objects.js';
import { createIgnoreChecker } from '../utils/walk.js';
import {
  NotAGitRepoError,
  CheckoutConflictError,
  UnmergedPathsError,
} from '../errors.js';
import {
  FlatTreeEntry,
  flattenTree,
  peelToTree,
  headCommitOid,
  readCommitTree,
  modeNumberToString,
  modeStringToNumber,
  hashWorktreeEntry,
  makeIndexEntry,
  trustExecutableBit,
  supportsSymlinks,
  tryLstat,
} from './tree-helpers.js';

export interface CheckoutTreeArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /**
   * Tree-ish (commit or tree OID) the current index and working tree are
   * based on. Defaults to HEAD's tree (the empty tree on an unborn branch);
   * pass `null` for the empty tree explicitly.
   */
  from?: string | null;
  /** Tree-ish (commit or tree OID) to switch the index and working tree to. */
  to: string;
  /**
   * Discard local changes, like `git checkout -f` / `git reset --hard`:
   * the index becomes exactly `to`, tracked files are overwritten or removed
   * and untracked files in the way are replaced. Untracked files elsewhere
   * are left alone.
   */
  force?: boolean;
  /** Validate only (throws on conflicts) without touching index or files. */
  dryRun?: boolean;
}

export interface CheckoutTreeResult {
  /** Paths written to the working tree (created or changed). */
  updated: string[];
  /** Paths removed from the working tree. */
  removed: string[];
}

interface Side {
  mode: string;
  oid: string;
}

function same(a: Side | undefined, b: Side | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.mode === b.mode && a.oid === b.oid;
}

/**
 * Update index and working tree from `from` to `to`.
 *
 * Without `force` this follows git's two-way merge rules (unpack-trees
 * `twoway_merge`): paths that are identical in both trees keep their index
 * entry and working tree file untouched (so unrelated local changes survive);
 * paths that differ are updated only when the index and working tree are
 * clean for them; otherwise a CheckoutConflictError listing every offending
 * path is thrown and nothing is modified. Untracked files that would be
 * overwritten are also reported, unless they are ignored (git overwrites
 * ignored files on checkout).
 */
export async function checkoutTree(
  args: CheckoutTreeArgs,
): Promise<CheckoutTreeResult> {
  const {
    fs,
    dir,
    gitdir: providedGitdir,
    force = false,
    dryRun = false,
  } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);

  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  let fromTree: string | null;
  if (args.from === undefined) {
    const head = await headCommitOid(fs, gitdir);
    fromTree = head ? await readCommitTree(fs, gitdir, head) : null;
  } else if (args.from === null) {
    fromTree = null;
  } else {
    fromTree = await peelToTree(fs, gitdir, args.from);
  }
  const toTree = await peelToTree(fs, gitdir, args.to);

  const oldTree = await flattenTree(fs, gitdir, fromTree);
  const newTree = await flattenTree(fs, gitdir, toTree);
  const index = await readIndex(fs, gitdir);
  const trustExec = await trustExecutableBit(fs, gitdir);
  const symlinks = await supportsSymlinks(fs, gitdir);

  const unmerged = [
    ...new Set(
      index.entries
        .filter((e) => indexEntryStage(e.flags) !== 0)
        .map((e) => e.path),
    ),
  ];
  if (unmerged.length > 0 && !force) {
    throw new UnmergedPathsError(
      'you need to resolve your current index first',
      unmerged,
    );
  }

  const current = new Map<string, IndexEntry>();
  for (const e of index.entries) {
    if (indexEntryStage(e.flags) === 0) current.set(e.path, e);
  }
  const indexSide = (e: IndexEntry | undefined): Side | undefined =>
    e ? { mode: modeNumberToString(e.mode), oid: e.oid } : undefined;

  const allPaths = new Set<string>([
    ...oldTree.keys(),
    ...newTree.keys(),
    ...current.keys(),
    ...unmerged,
  ]);

  /** Final index, keyed by path. */
  const finalIndex = new Map<string, IndexEntry>();
  /** Files to write: path -> target entry. */
  const writes = new Map<string, FlatTreeEntry>();
  /** Tracked worktree paths to delete. */
  const removals = new Set<string>();
  const conflicts: string[] = [];
  const untrackedConflicts: string[] = [];

  /** Is the worktree file for index entry `e` unmodified? (verify_uptodate) */
  const isUpToDate = async (path: string, e: IndexEntry): Promise<boolean> => {
    if ((e.mode & 0o170000) === 0o160000) return true; // gitlinks: not checked
    const full = joinPaths(dir, path);
    const st = await tryLstat(fs, full);
    if (!st) return true; // deleted in worktree: nothing to lose
    if (st.isDirectory) return false;
    const wt = await hashWorktreeEntry(fs, dir, path, {
      trustExecutable: trustExec,
      existingMode: e.mode,
    });
    if (!wt) return true;
    return (
      wt.oid === e.oid &&
      modeNumberToString(wt.mode) === modeNumberToString(e.mode)
    );
  };

  for (const path of [...allPaths].sort()) {
    const o = oldTree.get(path);
    const n = newTree.get(path);
    const iEntry = current.get(path);
    const i = indexSide(iEntry);

    if (force) {
      if (n) {
        writes.set(path, n);
      } else if (o || iEntry || unmerged.includes(path)) {
        removals.add(path);
      }
      continue;
    }

    if (iEntry && i) {
      if (
        (!o && !n) ||
        (!o && n && same(i, n)) ||
        (o && n && same(o, n)) ||
        (o && n && !same(o, n) && same(i, n))
      ) {
        finalIndex.set(path, iEntry); // keep_entry
      } else if (o && !n && same(i, o)) {
        // deleted_entry
        if (await isUpToDate(path, iEntry)) {
          removals.add(path);
        } else {
          conflicts.push(path);
        }
      } else if (o && n && same(i, o) && !same(i, n)) {
        // merged_entry
        if (await isUpToDate(path, iEntry)) {
          writes.set(path, n);
        } else {
          conflicts.push(path);
        }
      } else {
        conflicts.push(path); // reject_merge: staged changes in the way
      }
    } else if (n) {
      if (o) {
        // Deletion staged in the index.
        if (!same(o, n)) conflicts.push(path);
      } else {
        writes.set(path, n); // new file: verify_absent below
      }
    }
    // else: only in the old tree and already removed from the index: the
    // worktree file (if any) is untracked now; leave it.
  }

  // Index entries that remain tracked after the checkout (for D/F checks).
  const remainingTracked = new Set<string>([
    ...finalIndex.keys(),
    ...writes.keys(),
  ]);
  const trackedBefore = new Set<string>([...current.keys(), ...unmerged]);

  if (!force) {
    const isIgnored = await createIgnoreChecker(fs, dir, gitdir);

    for (const [path] of writes) {
      // Leading directories must not be untracked files / kept tracked files.
      const parts = path.split('/');
      for (let k = 1; k < parts.length; k++) {
        const prefix = parts.slice(0, k).join('/');
        const st = await tryLstat(fs, joinPaths(dir, prefix));
        if (!st || st.isDirectory) continue;
        if (remainingTracked.has(prefix)) {
          conflicts.push(prefix);
        } else if (
          !trackedBefore.has(prefix) &&
          !(await isIgnored(prefix, false))
        ) {
          untrackedConflicts.push(prefix);
        }
      }

      if (current.has(path)) continue; // tracked: verified by isUpToDate
      const st = await tryLstat(fs, joinPaths(dir, path));
      if (!st) continue;
      if (st.isDirectory) {
        // A directory is in the way: every file inside must be tracked and
        // going away, or ignored.
        const blockers = await untrackedInDirectory(
          fs,
          dir,
          path,
          (p) => trackedBefore.has(p) && !remainingTracked.has(p),
          isIgnored,
        );
        for (const p of blockers) {
          if (remainingTracked.has(p)) conflicts.push(p);
          else untrackedConflicts.push(p);
        }
      } else if (!(await isIgnored(path, false))) {
        untrackedConflicts.push(path);
      }
    }

    if (conflicts.length > 0 || untrackedConflicts.length > 0) {
      const parts: string[] = [];
      if (conflicts.length > 0) {
        parts.push(
          `Your local changes to the following files would be overwritten by checkout:\n\t${[...new Set(conflicts)].join('\n\t')}`,
        );
      }
      if (untrackedConflicts.length > 0) {
        parts.push(
          `The following untracked working tree files would be overwritten by checkout:\n\t${[...new Set(untrackedConflicts)].join('\n\t')}`,
        );
      }
      parts.push('Aborting');
      throw new CheckoutConflictError(
        parts.join('\n'),
        [...new Set(conflicts)],
        [...new Set(untrackedConflicts)],
      );
    }
  }

  const result: CheckoutTreeResult = { updated: [], removed: [] };

  if (dryRun) {
    result.updated = [...writes.keys()];
    result.removed = [...removals];
    return result;
  }

  // 1. Remove tracked files that go away (deepest first), pruning empty dirs.
  for (const path of [...removals].sort().reverse()) {
    const full = joinPaths(dir, path);
    const st = await tryLstat(fs, full);
    // (A tracked file locally replaced by a directory is left alone: the
    // directory's contents are untracked.)
    if (st && !st.isDirectory) {
      await fs.unlink(full);
      result.removed.push(path);
    }
    await pruneEmptyParents(fs, dir, path);
  }

  // 2. Write new and changed files.
  for (const [path, entry] of [...writes].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const full = joinPaths(dir, path);

    // In force mode keep files that already have the right content.
    if (force) {
      const existing = current.get(path);
      const wt = await hashWorktreeEntry(fs, dir, path, {
        trustExecutable: trustExec,
        existingMode: existing?.mode,
      });
      if (
        wt &&
        wt.oid === entry.oid &&
        modeNumberToString(wt.mode) === entry.mode
      ) {
        finalIndex.set(
          path,
          makeIndexEntry(
            path,
            entry.oid,
            modeStringToNumber(entry.mode),
            wt.stats,
          ),
        );
        continue;
      }
    }

    await makeRoomFor(fs, dir, path);
    const stats = await writeEntry(fs, gitdir, full, entry, {
      trustExec,
      symlinks,
    });
    finalIndex.set(
      path,
      makeIndexEntry(path, entry.oid, modeStringToNumber(entry.mode), stats),
    );
    result.updated.push(path);
  }

  index.entries = [...finalIndex.values()];
  await writeIndex(fs, gitdir, index);

  return result;
}

/** Files below `dirPath` that block replacing it with a file. */
async function untrackedInDirectory(
  fs: FSAdapter,
  dir: string,
  dirPath: string,
  goingAway: (path: string) => boolean,
  isIgnored: (path: string, isDir: boolean) => Promise<boolean>,
): Promise<string[]> {
  const blockers: string[] = [];
  const entries = await fs.readdir(joinPaths(dir, dirPath));
  for (const entry of entries) {
    const child = `${dirPath}/${entry.name}`;
    if (entry.isDirectory) {
      if (await isIgnored(child, true)) continue;
      blockers.push(
        ...(await untrackedInDirectory(fs, dir, child, goingAway, isIgnored)),
      );
    } else if (!goingAway(child) && !(await isIgnored(child, false))) {
      blockers.push(child);
    }
  }
  return blockers;
}

/** Remove whatever occupies `path` or its leading directories as non-dirs. */
async function makeRoomFor(
  fs: FSAdapter,
  dir: string,
  path: string,
): Promise<void> {
  const parts = path.split('/');
  for (let k = 1; k < parts.length; k++) {
    const prefix = joinPaths(dir, parts.slice(0, k).join('/'));
    const st = await tryLstat(fs, prefix);
    if (st && !st.isDirectory) {
      await fs.unlink(prefix);
    }
  }
  const full = joinPaths(dir, path);
  const st = await tryLstat(fs, full);
  if (st) {
    if (st.isDirectory) {
      await fs.rmdir(full, { recursive: true });
    } else {
      await fs.unlink(full);
    }
  }
  const parent = dirname(full);
  if (!(await fs.exists(parent))) {
    await fs.mkdir(parent, { recursive: true });
  }
}

/**
 * Write one tree entry to the working tree and return its lstat data (for the
 * index), or null for gitlinks.
 */
async function writeEntry(
  fs: FSAdapter,
  gitdir: string,
  full: string,
  entry: FlatTreeEntry,
  opts: { trustExec: boolean; symlinks: boolean },
) {
  if (entry.mode === '160000') {
    // Submodule: create an empty directory placeholder, like git does.
    await fs.mkdir(full, { recursive: true });
    return null;
  }

  const { content } = await readObject(fs, gitdir, entry.oid);

  if (entry.mode === '120000' && opts.symlinks) {
    await fs.symlink(new TextDecoder().decode(content), full);
    return fs.lstat(full);
  }

  // Regular file (or a symlink checked out as a plain file when
  // core.symlinks=false).
  await fs.writeFile(full, content);
  if (fs.chmod && opts.trustExec && entry.mode !== '120000') {
    const st = await fs.lstat(full);
    const perms = st.mode & 0o777;
    // Like git: executable files get x wherever r is set (honouring umask),
    // other files lose all x bits.
    const wanted =
      entry.mode === '100755' ? perms | ((perms & 0o444) >> 2) : perms & ~0o111;
    if (wanted !== perms) {
      await fs.chmod(full, wanted);
    }
  }
  return fs.lstat(full);
}

async function pruneEmptyParents(
  fs: FSAdapter,
  dir: string,
  path: string,
): Promise<void> {
  const parts = path.split('/');
  for (let k = parts.length - 1; k > 0; k--) {
    const d = joinPaths(dir, parts.slice(0, k).join('/'));
    try {
      const st = await tryLstat(fs, d);
      if (!st || !st.isDirectory) return;
      if ((await fs.readdir(d)).length > 0) return;
      await fs.rmdir(d);
    } catch {
      return;
    }
  }
}
