import { FSAdapter } from '../fs/types.js';
import {
  parseGitDir,
  joinPaths,
  normalizeRepoRelativePath,
} from '../utils/path.js';
import { writeObject } from '../core/objects.js';
import {
  readIndex,
  writeIndex,
  IndexEntry,
  indexEntryStage,
} from '../core/index.js';
import { walkDir, createIgnoreChecker } from '../utils/walk.js';
import {
  IsADirectoryError,
  NotAGitRepoError,
  NotFoundError,
  TsGitError,
} from '../errors.js';
import {
  readWorktreeEntry,
  trustExecutableBit,
  makeIndexEntry,
  tryLstat,
  matchesPathspec,
  headCommitOid,
  readCommitTree,
  flattenTree,
  modeNumberToString,
  hashWorktreeEntry,
} from './tree-helpers.js';

export interface AddResult {
  added: string[];
  updated: string[];
  removed?: string[];
}

/**
 * Thrown by `add` when explicitly named paths are ignored (git: "The
 * following paths are ignored by one of your .gitignore files"). As in git,
 * the other paths have still been staged; `result` describes what was done.
 */
export class IgnoredPathsError extends TsGitError {
  public readonly code = 'EIGNORED';
  public readonly paths: string[];
  public readonly result: AddResult;

  constructor(paths: string[], result: AddResult) {
    super(
      `The following paths are ignored by one of your .gitignore files:\n${paths.join('\n')}\nhint: Use force if you really want to add them.`,
    );
    this.name = 'IgnoredPathsError';
    this.paths = paths;
    this.result = result;
  }
}

function isGlob(spec: string): boolean {
  return /[*?[]/.test(spec);
}

function normalizeSpec(spec: string): string {
  const p = normalizeRepoRelativePath(spec);
  return p === '.' ? '' : p;
}

/**
 * `git add [-f] <pathspec>...` (git 2.x semantics, i.e. `add -A` limited to
 * the pathspecs):
 *
 * - files are hashed and staged with their mode (100644 / 100755 honouring
 *   core.filemode, 120000 for symlinks)
 * - directories (and `.`) are added recursively, skipping ignored files
 *   unless `force`; tracked files below them are always updated
 * - tracked files that were deleted from the working tree are removed from
 *   the index
 * - a pathspec matching nothing in the working tree or index throws
 *   NotFoundError before anything is changed
 * - an explicitly named ignored, untracked file throws IgnoredPathsError
 *   (after staging the other paths), unless `force`
 */
export async function add(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  filepath: string | string[];
  force?: boolean;
}): Promise<AddResult> {
  const {
    fs,
    dir: rawDir,
    gitdir: providedGitdir,
    filepath,
    force = false,
  } = args;
  const { dir, gitdir } = parseGitDir(rawDir, providedGitdir);

  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  const specs = (Array.isArray(filepath) ? filepath : [filepath]).map(
    normalizeSpec,
  );

  const index = await readIndex(fs, gitdir);
  const trustExec = await trustExecutableBit(fs, gitdir);
  const isIgnored = await createIgnoreChecker(fs, dir, gitdir);
  const tracked = new Set(index.entries.map((e) => e.path));

  /** Worktree files to stage. */
  const toStage = new Set<string>();
  /** Tracked paths to drop from the index (deleted in the worktree). */
  const toRemove = new Set<string>();
  const ignored: string[] = [];
  const unmatched: string[] = [];

  let allFiles: string[] | null = null;
  const listAll = async () => {
    if (!allFiles) {
      allFiles = force
        ? // With force nothing is ignored (only the git directory is skipped).
          (
            await walkDir(fs, dir, { includeSymlinks: true, ignoreFiles: [] })
          ).filter((p) => !isInsideGitdir(p, dir, gitdir))
        : await walkDir(fs, dir, { gitdir, includeSymlinks: true });
    }
    return allFiles;
  };

  for (const spec of specs) {
    // The repository root ('.') always matches.
    let matched = spec === '';

    if (spec !== '' && !isGlob(spec)) {
      const st = await tryLstat(fs, joinPaths(dir, spec));
      if (st && !st.isDirectory) {
        matched = true;
        if (!tracked.has(spec) && !force && (await isIgnored(spec, false))) {
          ignored.push(spec);
        } else {
          toStage.add(spec);
        }
        // A file replacing a tracked directory: drop the entries below it.
        for (const p of tracked) {
          if (p.startsWith(`${spec}/`)) toRemove.add(p);
        }
        continue;
      }
      // An existing directory always matches, even when empty (like git).
      if (st) matched = true;
      if (st && st.isDirectory && !force && !tracked.has(spec)) {
        if (await isIgnored(spec, true)) {
          // `git add ignored-dir` reports the directory itself.
          const hasTracked = [...tracked].some((p) => p.startsWith(`${spec}/`));
          if (!hasTracked) {
            ignored.push(spec);
            continue;
          }
        }
      }
    }

    // Directory, '.', or glob: everything below it in the worktree...
    for (const file of await listAll()) {
      if (matchesPathspec(file, [spec])) {
        matched = true;
        toStage.add(file);
      }
    }
    // ...plus tracked files below it (updated even if ignored, removed if gone).
    for (const p of tracked) {
      if (!matchesPathspec(p, [spec])) continue;
      matched = true;
      const st = await tryLstat(fs, joinPaths(dir, p));
      if (st && !st.isDirectory) {
        toStage.add(p);
      } else {
        toRemove.add(p);
      }
    }

    if (!matched) {
      unmatched.push(spec);
    }
  }

  if (unmatched.length > 0) {
    throw new NotFoundError(
      `pathspec '${unmatched[0]}' did not match any files`,
      unmatched[0],
    );
  }

  const result: AddResult = { added: [], updated: [] };
  const removed: string[] = [];

  // Index entries grouped by path (several entries = unmerged stages).
  const byPath = new Map<string, IndexEntry[]>();
  for (const e of index.entries) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }
  // Leading directories of tracked paths, to detect file-replaces-dir cases.
  const trackedDirs = new Set<string>();
  for (const p of byPath.keys()) {
    for (let k = p.indexOf('/'); k !== -1; k = p.indexOf('/', k + 1)) {
      trackedDirs.add(p.slice(0, k));
    }
  }

  for (const path of [...toRemove].sort()) {
    if (toStage.has(path)) continue;
    if (byPath.delete(path)) removed.push(path);
  }

  for (const path of [...toStage].sort()) {
    const entries = byPath.get(path) ?? [];
    const existing = entries.find((e) => indexEntryStage(e.flags) === 0);
    const wt = await readWorktreeEntry(fs, dir, path, {
      trustExecutable: trustExec,
      existingMode: existing?.mode,
    });
    if (!wt) continue;

    const oid = await writeObject(fs, gitdir, 'blob', wt.content);
    const unchanged =
      existing !== undefined &&
      entries.length === 1 &&
      existing.oid === oid &&
      modeNumberToString(existing.mode) === modeNumberToString(wt.mode);

    // Replace all stages of this path, plus D/F conflicting entries: a file
    // at a/b removes an entry "a" and any entries below "a/b/".
    for (let k = path.indexOf('/'); k !== -1; k = path.indexOf('/', k + 1)) {
      byPath.delete(path.slice(0, k));
    }
    if (trackedDirs.has(path)) {
      for (const p of [...byPath.keys()]) {
        if (p.startsWith(`${path}/`)) byPath.delete(p);
      }
    }
    byPath.set(path, [makeIndexEntry(path, oid, wt.mode, wt.stats)]);

    if (unchanged) continue; // stat refreshed only
    if (entries.length > 0) result.updated.push(path);
    else result.added.push(path);
  }

  index.entries = [...byPath.values()].flat();
  await writeIndex(fs, gitdir, index);

  if (removed.length > 0) {
    result.removed = removed;
  }

  if (ignored.length > 0) {
    throw new IgnoredPathsError(ignored, result);
  }

  return result;
}

function isInsideGitdir(path: string, dir: string, gitdir: string): boolean {
  if (!gitdir.startsWith(`${dir}/`)) return false;
  const rel = gitdir.slice(dir.length + 1);
  return path === rel || path.startsWith(`${rel}/`);
}

/**
 * `git add -A`: stage every change in the working tree (new, modified and
 * deleted files), honouring ignore rules.
 */
export async function addAll(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  force?: boolean;
}): Promise<AddResult> {
  const result = await add({ ...args, filepath: '.' });
  return { ...result, removed: result.removed ?? [] };
}

/**
 * `git rm --cached [-r] [-f] <pathspec>...`: remove paths from the index only.
 *
 * - a path matching no index entry throws NotFoundError (nothing changes)
 * - a directory requires `recursive` (IsADirectoryError otherwise)
 * - like git, refuses (TsGitError) when the staged content differs from both
 *   the working tree file and HEAD, unless `force`
 */
export async function remove(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  filepath: string | string[];
  recursive?: boolean;
  force?: boolean;
}): Promise<void> {
  const {
    fs,
    dir: rawDir,
    gitdir: providedGitdir,
    filepath,
    recursive = false,
    force = false,
  } = args;
  const { dir, gitdir } = parseGitDir(rawDir, providedGitdir);

  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  const specs = (Array.isArray(filepath) ? filepath : [filepath]).map(
    normalizeSpec,
  );
  const index = await readIndex(fs, gitdir);
  const paths = [...new Set(index.entries.map((e) => e.path))];
  const selected = new Set<string>();

  for (const spec of specs) {
    const exact = paths.includes(spec);
    const matches = paths.filter((p) => matchesPathspec(p, [spec]));
    if (matches.length === 0) {
      throw new NotFoundError(
        `pathspec '${spec}' did not match any files`,
        spec,
      );
    }
    if (!exact && !isGlob(spec) && !recursive) {
      throw new IsADirectoryError(
        `not removing '${spec}' recursively without -r`,
        joinPaths(dir, spec),
      );
    }
    for (const p of matches) selected.add(p);
  }

  if (!force) {
    const headOid = await headCommitOid(fs, gitdir);
    const headTree = await flattenTree(
      fs,
      gitdir,
      headOid ? await readCommitTree(fs, gitdir, headOid) : null,
    );
    const trustExec = await trustExecutableBit(fs, gitdir);
    const offending: string[] = [];
    for (const path of selected) {
      const entry = index.entries.find(
        (e) => e.path === path && indexEntryStage(e.flags) === 0,
      );
      if (!entry) continue;
      const head = headTree.get(path);
      const staged =
        !head ||
        head.oid !== entry.oid ||
        head.mode !== modeNumberToString(entry.mode);
      if (!staged) continue;
      const wt = await hashWorktreeEntry(fs, dir, path, {
        trustExecutable: trustExec,
        existingMode: entry.mode,
      });
      if (!wt) continue; // missing in worktree: no local changes to lose
      const local =
        wt.oid !== entry.oid ||
        modeNumberToString(wt.mode) !== modeNumberToString(entry.mode);
      if (local) offending.push(path);
    }
    if (offending.length > 0) {
      throw new TsGitError(
        `the following file has staged content different from both the file and the HEAD:\n    ${offending.join('\n    ')}\n(use force to force removal)`,
      );
    }
  }

  index.entries = index.entries.filter(
    (e: IndexEntry) => !selected.has(e.path),
  );
  await writeIndex(fs, gitdir, index);
}
