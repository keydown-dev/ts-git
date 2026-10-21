import { FSAdapter, FileStats } from '../fs/types.js';
import {
  parseGitDir,
  joinPaths,
  normalizeRepoRelativePath,
} from '../utils/path.js';
import {
  readIndex,
  type IndexEntry,
  groupIndexEntriesByPath,
  pickRepresentativeIndexEntry,
  indexEntryStage,
} from '../core/index.js';
import { resolveHeadTreeOid } from '../core/refs.js';
import { readObject, computeOid, deserializeTree } from '../core/objects.js';
import { readConfig, getConfigValue } from '../core/config.js';
import {
  parseIgnoreFile,
  createMatcher,
  type IgnorePattern,
} from '../utils/gitignore.js';
import { NotAGitRepoError } from '../errors.js';
import { quoteGitPath } from './ls-tree.js';
import type {
  StatusMatrixArgs,
  StatusRow,
  StatusName,
  HeadStatus,
  WorkdirStatus,
  StageStatus,
} from '../types.js';

// ============================================================================
// Shared status engine
// ============================================================================

/** A (mode, oid) pair: what git compares for a path on each side. */
export interface Side {
  mode: number;
  oid: string;
}

const MODE_FILE = 0o100644;
const MODE_EXEC = 0o100755;
const MODE_SYMLINK = 0o120000;
const MODE_GITLINK = 0o160000;
const MODE_TREE = 0o040000;

type ObjectKind = 'file' | 'symlink' | 'gitlink';

function kindOfMode(mode: number): ObjectKind {
  const t = mode & 0o170000;
  if (t === MODE_SYMLINK) return 'symlink';
  if (t === MODE_GITLINK) return 'gitlink';
  return 'file';
}

function sameSide(a: Side, b: Side): boolean {
  return a.oid === b.oid && a.mode === b.mode;
}

function compareBytes(a: string, b: string): number {
  // Byte-wise (UTF-8) comparison, as git sorts paths.
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.length - bb.length;
}

function isTrue(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined) return dflt;
  return ['true', 'yes', 'on', '1'].includes(value.toLowerCase());
}

/** Collect every non-tree entry of a tree recursively: path -> (mode, oid). */
async function readTreeRecursive(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string,
  prefix: string,
  out: Map<string, Side>,
): Promise<void> {
  const { type, content } = await readObject(fs, gitdir, treeOid);
  if (type !== 'tree') return;
  for (const entry of deserializeTree(content)) {
    const path = prefix + entry.path;
    const mode = parseInt(entry.mode, 8);
    if ((mode & 0o170000) === MODE_TREE) {
      await readTreeRecursive(fs, gitdir, entry.oid, path + '/', out);
    } else {
      out.set(path, { mode, oid: entry.oid });
    }
  }
}

interface WorktreeScan {
  /** Untracked, not-ignored files and symlinks (repo-relative paths). */
  untracked: string[];
  /** Untracked nested repositories (shown by git as `dir/`). */
  nestedRepos: string[];
  /** Ignored untracked paths; directories end with `/`. */
  ignored: string[];
}

/** @internal */
export interface StatusContext {
  fs: FSAdapter;
  dir: string;
  gitdir: string;
  head: Map<string, Side>;
  hasHead: boolean;
  indexByPath: Map<string, IndexEntry[]>;
  trustFileMode: boolean;
  trustSymlinks: boolean;
  ignoreCase: boolean;
  indexMtimeMs: number | null;
}

/** @internal Shared with diff. */
export async function loadStatusContext(
  fs: FSAdapter,
  dir: string,
  gitdir: string,
): Promise<StatusContext> {
  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  const config = await readConfig(fs, gitdir);
  const head = new Map<string, Side>();
  const headTree = await resolveHeadTreeOid(fs, gitdir);
  if (headTree) {
    await readTreeRecursive(fs, gitdir, headTree, '', head);
  }

  const index = await readIndex(fs, gitdir);
  let indexMtimeMs: number | null = null;
  const indexPath = joinPaths(gitdir, 'index');
  if (await fs.exists(indexPath)) {
    indexMtimeMs = (await fs.stat(indexPath)).mtimeMs;
  }

  return {
    fs,
    dir,
    gitdir,
    head,
    hasHead: headTree !== null,
    indexByPath: groupIndexEntriesByPath(index.entries),
    trustFileMode: isTrue(getConfigValue(config, 'core', 'filemode'), true),
    trustSymlinks: isTrue(getConfigValue(config, 'core', 'symlinks'), true),
    ignoreCase: isTrue(getConfigValue(config, 'core', 'ignorecase'), false),
    indexMtimeMs,
  };
}

async function lstatOrNull(
  fs: FSAdapter,
  path: string,
): Promise<FileStats | null> {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}

/**
 * The index entry's cached stat data still describes the file and the entry
 * is not "racily clean", so the recorded OID can be trusted without
 * re-hashing (git's ie_match_stat / is_racy_timestamp). Times are compared
 * at millisecond precision, which is what FSAdapter exposes.
 */
function statMatchesEntry(
  entry: IndexEntry,
  stat: FileStats,
  indexMtimeMs: number | null,
): boolean {
  if (indexMtimeMs === null) return false;
  const ms = (sec: number, ns: number) => sec * 1000 + Math.floor(ns / 1e6);
  const entryMtime = ms(entry.mtimeSeconds, entry.mtimeNanoseconds);
  const entryCtime = ms(entry.ctimeSeconds, entry.ctimeNanoseconds);
  if (entry.size !== stat.size >>> 0) return false;
  if (entryMtime !== Math.floor(stat.mtimeMs)) return false;
  if (entryCtime !== Math.floor(stat.ctimeMs)) return false;
  if (entry.ino !== 0 && entry.ino !== stat.ino >>> 0) return false;
  // Racy: the file may have been modified in the same instant the index
  // was written; only trust entries clearly older than the index file.
  if (entryMtime + 1000 >= indexMtimeMs) return false;
  return true;
}

/**
 * Compute what git would record for the worktree path: mode (honouring
 * core.filemode / core.symlinks) and blob OID. Returns null when the path
 * does not exist as a file/symlink (missing, or a directory where a file was
 * expected).
 */
/** @internal Shared with diff. */
export async function worktreeSide(
  ctx: StatusContext,
  path: string,
  indexEntry: IndexEntry | undefined,
): Promise<Side | null> {
  const fullPath = joinPaths(ctx.dir, path);
  const stat = await lstatOrNull(ctx.fs, fullPath);
  if (!stat) return null;

  const recordedMode = indexEntry?.mode ?? ctx.head.get(path)?.mode;

  if (stat.isDirectory) {
    // A checked-out (or not initialised) submodule.
    if (recordedMode !== undefined && kindOfMode(recordedMode) === 'gitlink') {
      return {
        mode: MODE_GITLINK,
        oid: indexEntry?.oid ?? ctx.head.get(path)!.oid,
      };
    }
    return null;
  }

  let mode: number;
  if (stat.isSymbolicLink && ctx.trustSymlinks) {
    mode = MODE_SYMLINK;
  } else if (!ctx.trustFileMode) {
    // core.filemode=false: keep whatever regular-file mode was recorded.
    mode =
      recordedMode !== undefined && kindOfMode(recordedMode) === 'file'
        ? recordedMode
        : MODE_FILE;
  } else {
    mode = stat.mode & 0o100 ? MODE_EXEC : MODE_FILE;
  }

  if (
    indexEntry &&
    indexEntry.mode === mode &&
    statMatchesEntry(indexEntry, stat, ctx.indexMtimeMs)
  ) {
    return { mode, oid: indexEntry.oid };
  }

  const content = stat.isSymbolicLink
    ? new TextEncoder().encode(await ctx.fs.readlink(fullPath))
    : await ctx.fs.readFile(fullPath);
  return { mode, oid: await computeOid('blob', content) };
}

async function loadIgnorePatterns(
  ctx: StatusContext,
): Promise<IgnorePattern[]> {
  const patterns: IgnorePattern[] = [];
  const opts = { ignoreCase: ctx.ignoreCase };
  // Lowest precedence first: core.excludesFile, then info/exclude.
  const config = await readConfig(ctx.fs, ctx.gitdir);
  const excludesFile = getConfigValue(config, 'core', 'excludesfile');
  if (excludesFile && excludesFile.startsWith('/')) {
    if (await ctx.fs.exists(excludesFile)) {
      patterns.push(
        ...parseIgnoreFile(await ctx.fs.readFileString(excludesFile), '', opts),
      );
    }
  }
  const infoExclude = joinPaths(ctx.gitdir, 'info', 'exclude');
  if (await ctx.fs.exists(infoExclude)) {
    patterns.push(
      ...parseIgnoreFile(await ctx.fs.readFileString(infoExclude), '', opts),
    );
  }
  return patterns;
}

/**
 * Walk the worktree to find untracked and ignored paths, applying
 * .gitignore files (deeper files take precedence), .git/info/exclude and an
 * absolute core.excludesFile. Directories excluded by a pattern are not
 * descended into unless they contain tracked files. Nested repositories
 * (directories with a `.git`) are reported, not descended into.
 */
async function scanWorktree(
  ctx: StatusContext,
  options: { collectIgnored: boolean; expandIgnoredDirs?: boolean },
): Promise<WorktreeScan> {
  const result: WorktreeScan = { untracked: [], nestedRepos: [], ignored: [] };
  const trackedDirs = new Set<string>();
  for (const path of ctx.indexByPath.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      trackedDirs.add(parts.slice(0, i).join('/'));
    }
  }

  const gitdirRel =
    ctx.gitdir.startsWith(ctx.dir + '/') && ctx.gitdir !== ctx.dir
      ? ctx.gitdir.slice(ctx.dir.length + 1)
      : null;

  const basePatterns = await loadIgnorePatterns(ctx);

  const walk = async (
    rel: string,
    patterns: IgnorePattern[],
    insideIgnored: boolean,
  ): Promise<void> => {
    const abs = rel === '' ? ctx.dir : joinPaths(ctx.dir, rel);
    let local = patterns;
    const gi = joinPaths(abs, '.gitignore');
    if (await ctx.fs.exists(gi)) {
      try {
        local = [
          ...patterns,
          ...parseIgnoreFile(await ctx.fs.readFileString(gi), rel, {
            ignoreCase: ctx.ignoreCase,
          }),
        ];
      } catch {
        // unreadable .gitignore: ignore it
      }
    }
    const matcher = createMatcher(local);

    let entries;
    try {
      entries = await ctx.fs.readdir(abs);
    } catch {
      return;
    }
    entries.sort((a, b) => compareBytes(a.name, b.name));

    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === '.git' || path === gitdirRel) continue;
      const trackedEntries = ctx.indexByPath.get(path);
      if (trackedEntries) {
        // Tracked paths are handled elsewhere, unless a tracked file was
        // replaced by a directory (its contents are then untracked).
        const isGitlink = trackedEntries.some(
          (e) => kindOfMode(e.mode) === 'gitlink',
        );
        if (!entry.isDirectory || isGitlink) continue;
      }

      if (entry.isDirectory) {
        const ignoredDir = insideIgnored || matcher(path, true);
        const hasTracked = trackedDirs.has(path);
        if (
          !hasTracked &&
          (await ctx.fs.exists(joinPaths(abs, entry.name, '.git')))
        ) {
          if (ignoredDir) {
            if (options.collectIgnored) result.ignored.push(path + '/');
          } else {
            result.nestedRepos.push(path);
          }
          continue;
        }
        if (ignoredDir && !hasTracked) {
          if (!options.collectIgnored) continue;
          if (!options.expandIgnoredDirs) {
            result.ignored.push(path + '/');
            continue;
          }
        }
        await walk(path, local, ignoredDir);
      } else if (entry.isFile || entry.isSymbolicLink) {
        if (insideIgnored || matcher(path, false)) {
          if (options.collectIgnored) result.ignored.push(path);
        } else {
          result.untracked.push(path);
        }
      }
    }
  };

  await walk('', basePatterns, false);
  return result;
}

// ============================================================================
// Porcelain (git status --porcelain=v1)
// ============================================================================

export interface StatusEntry {
  /** Repo-relative path; directories (collapsed untracked/ignored) end with `/`. */
  path: string;
  /** Index status (X column). */
  index: string;
  /** Worktree status (Y column). */
  worktree: string;
}

export interface StatusPorcelainArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** --untracked-files mode (default `normal`). */
  untrackedFiles?: 'no' | 'normal' | 'all';
  /** --ignored (traditional mode). */
  ignored?: boolean;
}

function unmergedCode(stages: Set<number>): string {
  const key = [1, 2, 3].map((s) => (stages.has(s) ? '1' : '0')).join('');
  switch (key) {
    case '100':
      return 'DD';
    case '010':
      return 'AU';
    case '110':
      return 'UD';
    case '001':
      return 'UA';
    case '101':
      return 'DU';
    case '011':
      return 'AA';
    default:
      return 'UU';
  }
}

function changeCode(from: Side | undefined, to: Side | undefined): string {
  if (!from && !to) return ' ';
  if (!from) return 'A';
  if (!to) return 'D';
  if (sameSide(from, to)) return ' ';
  if (kindOfMode(from.mode) !== kindOfMode(to.mode)) return 'T';
  return 'M';
}

/**
 * Collapse untracked files into the outermost directory that contains no
 * tracked files, as `git status -unormal` does.
 */
function collapseUntracked(
  files: string[],
  indexPaths: Iterable<string>,
): string[] {
  const tracked = new Set(indexPaths);
  const trackedDirs = ancestorDirs(tracked);
  const out = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    let shown: string | null = file;
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!trackedDirs.has(d)) {
        // git (index_name_is_other) hides a collapsed directory whose name
        // is itself a tracked path, e.g. a tracked file replaced by a dir.
        shown = tracked.has(d) ? null : d + '/';
        break;
      }
    }
    if (shown !== null) out.add(shown);
  }
  return [...out];
}

function ancestorDirs(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.replace(/\/$/, '').split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return dirs;
}

/**
 * Traditional `--ignored` output: an ignored path is shown through its
 * outermost ancestor directory that holds neither tracked nor untracked
 * (non-ignored) content.
 */
function collapseIgnored(
  ignored: string[],
  indexPaths: Iterable<string>,
  untracked: string[],
): string[] {
  const busy = ancestorDirs([...indexPaths, ...untracked]);
  for (const u of untracked) busy.add(u);
  const out = new Set<string>();
  for (const path of ignored) {
    const parts = path.replace(/\/$/, '').split('/');
    let shown = path;
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!busy.has(d)) {
        shown = d + '/';
        break;
      }
    }
    out.add(shown);
  }
  return [...out];
}

/**
 * Status entries in the order `git status --porcelain=v1 --no-renames`
 * prints them: tracked changes (sorted by path), then untracked, then
 * ignored.
 */
export async function statusEntries(
  args: StatusPorcelainArgs,
): Promise<StatusEntry[]> {
  const { fs, dir: rawDir, gitdir: providedGitdir } = args;
  const { dir, gitdir } = parseGitDir(rawDir, providedGitdir);
  const untrackedMode = args.untrackedFiles ?? 'normal';
  const ctx = await loadStatusContext(fs, dir, gitdir);

  const tracked: StatusEntry[] = [];
  const paths = new Set<string>([
    ...ctx.head.keys(),
    ...ctx.indexByPath.keys(),
  ]);

  for (const path of paths) {
    const list = ctx.indexByPath.get(path);
    const stages = new Set((list ?? []).map((e) => indexEntryStage(e.flags)));

    if (list && !stages.has(0)) {
      const code = unmergedCode(stages);
      tracked.push({ path, index: code[0], worktree: code[1] });
      continue;
    }

    const indexEntry = list?.find((e) => indexEntryStage(e.flags) === 0);
    const headSide = ctx.head.get(path);
    const indexSide = indexEntry
      ? { mode: indexEntry.mode, oid: indexEntry.oid }
      : undefined;

    const x = changeCode(headSide, indexSide);
    let y = ' ';
    if (indexEntry) {
      const wt = await worktreeSide(ctx, path, indexEntry);
      y = changeCode(indexSide, wt ?? undefined);
    }
    if (x !== ' ' || y !== ' ') {
      tracked.push({ path, index: x, worktree: y });
    }
  }
  tracked.sort((a, b) => compareBytes(a.path, b.path));

  const result = [...tracked];
  if (untrackedMode === 'no' && !args.ignored) return result;

  const scan = await scanWorktree(ctx, {
    collectIgnored: !!args.ignored,
    // With -uall, individual files inside ignored directories are listed.
    expandIgnoredDirs: untrackedMode === 'all',
  });

  if (untrackedMode !== 'no') {
    const shown =
      untrackedMode === 'all'
        ? scan.untracked
        : collapseUntracked(scan.untracked, ctx.indexByPath.keys());
    const all = [...shown, ...scan.nestedRepos.map((p) => p + '/')];
    all.sort(compareBytes);
    for (const path of all) {
      result.push({ path, index: '?', worktree: '?' });
    }
  }

  if (args.ignored) {
    let ignored = scan.ignored;
    if (untrackedMode === 'normal') {
      ignored = collapseIgnored(ignored, ctx.indexByPath.keys(), [
        ...scan.untracked,
        ...scan.nestedRepos,
      ]);
    }
    for (const path of [...ignored].sort(compareBytes)) {
      result.push({ path, index: '!', worktree: '!' });
    }
  }

  return result;
}

/**
 * Exactly what `git status --porcelain=v1 --no-renames` prints (rename
 * detection is not implemented: renames appear as a deletion plus an
 * addition). Paths are quoted like git (core.quotePath=true).
 */
export async function statusPorcelain(
  args: StatusPorcelainArgs,
): Promise<string> {
  const entries = await statusEntries(args);
  return entries
    .map((e) => `${e.index}${e.worktree} ${quoteGitPath(e.path, true, true)}\n`)
    .join('');
}

// ============================================================================
// statusMatrix (isomorphic-git compatible)
// ============================================================================

/**
 * Status matrix rows `[filepath, head, workdir, stage]`:
 * - head: 0 absent, 1 present in HEAD
 * - workdir: 0 absent, 1 identical to HEAD, 2 different from HEAD
 * - stage: 0 absent, 1 identical to HEAD, 2 identical to workdir,
 *   3 different from both
 *
 * "Identical" compares blob OID and mode (the executable bit only when
 * core.filemode is true), so mode-only changes are reported. Ignored
 * untracked files are omitted. `filepaths` restricts the result to those
 * paths or anything below them. Rows are sorted by path.
 */
export async function statusMatrix(
  args: StatusMatrixArgs,
): Promise<StatusRow[]> {
  const { fs, dir: rawDir, gitdir: providedGitdir, filepaths, filter } = args;
  const { dir, gitdir } = parseGitDir(rawDir, providedGitdir);
  const ctx = await loadStatusContext(fs, dir, gitdir);

  const scan = await scanWorktree(ctx, { collectIgnored: false });
  const all = new Set<string>([
    ...ctx.head.keys(),
    ...ctx.indexByPath.keys(),
    ...scan.untracked,
  ]);

  const prefixes = filepaths?.map((p) => normalizeRepoRelativePath(p));
  if (prefixes) {
    // Explicitly named, existing, untracked paths are reported even when
    // ignored (matches the previous behaviour of status(filepath)).
    for (const p of prefixes) {
      if (p === '' || p === '.' || all.has(p)) continue;
      const stat = await lstatOrNull(fs, joinPaths(dir, p));
      if (stat && (stat.isFile || stat.isSymbolicLink)) all.add(p);
    }
  }

  const selected = [...all]
    .filter(
      (path) =>
        !prefixes ||
        prefixes.some(
          (p) =>
            p === '' || p === '.' || path === p || path.startsWith(p + '/'),
        ),
    )
    .filter((path) => !filter || filter(path))
    .sort(compareBytes);

  const matrix: StatusRow[] = [];
  for (const path of selected) {
    const list = ctx.indexByPath.get(path);
    const indexEntry = list ? pickRepresentativeIndexEntry(list) : undefined;
    const headSide = ctx.head.get(path);
    const wt = await worktreeSide(ctx, path, indexEntry);

    const head: HeadStatus = headSide ? 1 : 0;
    let workdir: WorkdirStatus;
    if (!wt) workdir = 0;
    else if (headSide && sameSide(headSide, wt)) workdir = 1;
    else workdir = 2;

    let stage: StageStatus;
    if (!indexEntry) {
      stage = 0;
    } else {
      const indexSide = { mode: indexEntry.mode, oid: indexEntry.oid };
      if (headSide && sameSide(headSide, indexSide)) stage = 1;
      else if (wt && sameSide(wt, indexSide)) stage = 2;
      else stage = 3;
    }

    matrix.push([path, head, workdir, stage]);
  }

  return matrix;
}

export async function status(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  filepath: string;
}): Promise<StatusName> {
  const { fs, dir, gitdir: providedGitdir, filepath } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);
  const path = normalizeRepoRelativePath(filepath);

  const matrix = await statusMatrix({ fs, dir, gitdir, filepaths: [path] });
  const row = matrix.find((r) => r[0] === path);
  if (!row) {
    return 'absent';
  }

  const [, head, workdir, stage] = row;
  if (head === 0 && stage === 0 && workdir !== 0) {
    if (await isIgnoredPath(fs, dir, gitdir, path)) return 'ignored';
  }
  return translateStatus(head, workdir, stage);
}

async function isIgnoredPath(
  fs: FSAdapter,
  dir: string,
  gitdir: string,
  path: string,
): Promise<boolean> {
  const ctx = await loadStatusContext(fs, dir, gitdir);
  const patterns = await loadIgnorePatterns(ctx);
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const rel = parts.slice(0, i).join('/');
    const gi = joinPaths(dir, rel, '.gitignore');
    if (await fs.exists(gi)) {
      patterns.push(
        ...parseIgnoreFile(await fs.readFileString(gi), rel, {
          ignoreCase: ctx.ignoreCase,
        }),
      );
    }
    const matcher = createMatcher(patterns);
    const sub = parts.slice(0, i + 1).join('/');
    const isLast = i === parts.length - 1;
    if (matcher(sub, !isLast)) return true;
  }
  return false;
}

function translateStatus(
  head: HeadStatus,
  workdir: WorkdirStatus,
  stage: StageStatus,
): StatusName {
  const key = `${head}${workdir}${stage}`;
  switch (key) {
    case '020':
      return '*added';
    case '022':
      return 'added';
    case '023':
      return '*added';
    case '111':
      return 'unmodified';
    case '121':
      return '*modified';
    case '122':
      return 'modified';
    case '123':
      return '*modified';
    case '101':
      return '*deleted';
    case '100':
      return 'deleted';
    case '103':
      return '*deleted';
    case '110':
      return '*undeleted';
    case '120':
      return '*undeletemodified';
    case '113':
      return '*unmodified';
    case '003':
      return '*absent';
    default:
      return 'absent';
  }
}

/**
 * Classify a status matrix row into `git status --porcelain` style codes.
 * `stagedStatus` is the X column (index vs HEAD) and `unstagedStatus` the Y
 * column (worktree vs index, `?` for untracked).
 */
export function classifyStatusRow(row: StatusRow): {
  isStaged: boolean;
  isUnstaged: boolean;
  isUntracked: boolean;
  isClean: boolean;
  stagedStatus: string;
  unstagedStatus: string;
} {
  const [, head, workdir, stage] = row;

  // X: index vs HEAD
  let stagedStatus = ' ';
  if (stage === 0) {
    if (head === 1) stagedStatus = 'D';
  } else if (stage === 2) {
    // Index identical to the worktree; an absent worktree means the entry
    // is effectively gone.
    if (workdir === 0) stagedStatus = head === 1 ? 'D' : ' ';
    else stagedStatus = head === 1 ? 'M' : 'A';
  } else if (stage === 3) {
    stagedStatus = head === 1 ? 'M' : 'A';
  }

  // Y: worktree vs index
  let unstagedStatus = ' ';
  if (stage === 1) {
    if (workdir === 0) unstagedStatus = 'D';
    else if (workdir === 2) unstagedStatus = 'M';
  } else if (stage === 3) {
    unstagedStatus = workdir === 0 ? 'D' : 'M';
  }

  // Not in the index but present on disk (also after a staged deletion).
  const isUntracked = stage === 0 && workdir !== 0;

  const isStaged = stagedStatus !== ' ';
  const isUnstaged = unstagedStatus !== ' ';
  if (isUntracked && !isUnstaged) unstagedStatus = '?';

  return {
    isStaged,
    isUnstaged,
    isUntracked,
    isClean: !isStaged && !isUnstaged && !isUntracked,
    stagedStatus,
    unstagedStatus,
  };
}
