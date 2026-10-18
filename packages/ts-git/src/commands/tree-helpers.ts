/**
 * Shared helpers for porcelain commands that read and write trees, resolve
 * revisions and inspect the working tree (commit, reset, checkout, add).
 */
import type { FSAdapter, FileStats } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';
import {
  readObject,
  writeObject,
  deserializeTree,
  computeOid,
  hasObject,
} from '../core/objects.js';
import {
  IndexEntry,
  createFlags,
  comparePathBytes,
  indexEntryStage,
} from '../core/index.js';
import { readRef, resolveHead } from '../core/refs.js';
import { readConfig, getConfigValue } from '../core/config.js';
import { hexToBuffer, concatBuffers, stringToBuffer } from '../utils/buffer.js';
import {
  NotFoundError,
  InvalidRefError,
  UnmergedPathsError,
} from '../errors.js';

/** A blob/symlink/gitlink entry of a flattened tree, keyed by full path. */
export interface FlatTreeEntry {
  path: string;
  /** Canonical mode string: 100644, 100755, 120000 or 160000. */
  mode: string;
  oid: string;
}

export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** True for a tree entry mode (git writes `40000`; some tools pad to `040000`). */
export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Canonical mode string for an index/tree numeric mode (as git's create_ce_mode). */
export function modeNumberToString(mode: number): string {
  const type = mode & 0o170000;
  if (type === 0o120000) return '120000';
  if (type === 0o160000) return '160000';
  if (type === 0o040000) return '40000';
  return (mode & 0o111) !== 0 ? '100755' : '100644';
}

export function modeStringToNumber(mode: string): number {
  return parseInt(mode, 8);
}

/** Read a commit and return its tree OID. */
export async function readCommitTree(
  fs: FSAdapter,
  gitdir: string,
  commitOid: string,
): Promise<string> {
  const { type, content } = await readObject(fs, gitdir, commitOid);
  if (type !== 'commit') {
    throw new InvalidRefError(`${commitOid} is not a commit`, commitOid);
  }
  const text = new TextDecoder().decode(content);
  const match = /^tree ([0-9a-f]{40})$/m.exec(text);
  if (!match) {
    throw new InvalidRefError(`Commit ${commitOid} has no tree`, commitOid);
  }
  return match[1];
}

/** Parent OIDs of a commit. */
export async function readCommitParents(
  fs: FSAdapter,
  gitdir: string,
  commitOid: string,
): Promise<string[]> {
  const { content } = await readObject(fs, gitdir, commitOid);
  const text = new TextDecoder().decode(content);
  const header = text.slice(0, text.indexOf('\n\n') >>> 0);
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return parents;
}

/**
 * Peel an object to a tree OID: a tree stays itself, a commit yields its tree,
 * an annotated tag is followed.
 */
export async function peelToTree(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<string> {
  for (let depth = 0; depth < 32; depth++) {
    // The empty tree is valid even when no object file exists for it.
    if (oid === EMPTY_TREE_OID) return oid;
    const { type, content } = await readObject(fs, gitdir, oid);
    if (type === 'tree') return oid;
    if (type === 'commit') return readCommitTree(fs, gitdir, oid);
    if (type === 'tag') {
      oid = tagTarget(content);
      continue;
    }
    throw new InvalidRefError(`${oid} is not a tree-ish`, oid);
  }
  throw new InvalidRefError(`Too many levels of tags at ${oid}`, oid);
}

/** Peel an object (annotated tags) to a commit OID. */
export async function peelToCommit(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<string> {
  for (let depth = 0; depth < 32; depth++) {
    const { type, content } = await readObject(fs, gitdir, oid);
    if (type === 'commit') return oid;
    if (type === 'tag') {
      oid = tagTarget(content);
      continue;
    }
    throw new InvalidRefError(`${oid} is not a commit`, oid);
  }
  throw new InvalidRefError(`Too many levels of tags at ${oid}`, oid);
}

function tagTarget(content: Uint8Array): string {
  const text = new TextDecoder().decode(content);
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  if (!match) throw new InvalidRefError('Malformed tag object');
  return match[1];
}

/** HEAD's commit OID, or null on an unborn branch. */
export async function headCommitOid(
  fs: FSAdapter,
  gitdir: string,
): Promise<string | null> {
  const head = await resolveHead(fs, gitdir);
  if (!head) return null;
  if (head.type === 'commit') return head.oid;
  const oid = await readRef(fs, gitdir, head.ref);
  return oid && /^[0-9a-f]{40}$/i.test(oid) ? oid : null;
}

/**
 * Resolve a revision to an object OID (not peeled). Supports `HEAD`, full
 * 40-hex OIDs, unique abbreviated OIDs of loose objects, full ref names,
 * `heads/…`, `tags/…`, `remotes/…` and short branch/tag/remote names (in
 * git's `git rev-parse` order), plus `~N` / `^N` suffixes (and `^{commit}`,
 * `^{tree}`).
 */
export async function resolveRevision(
  fs: FSAdapter,
  gitdir: string,
  rev: string,
): Promise<string> {
  const suffix = /(\^\{(commit|tree)\}|~\d*|\^\d*)$/.exec(rev);
  if (suffix && suffix.index > 0) {
    const base = await resolveRevision(fs, gitdir, rev.slice(0, suffix.index));
    const op = suffix[1];
    if (op === '^{commit}') return peelToCommit(fs, gitdir, base);
    if (op === '^{tree}') return peelToTree(fs, gitdir, base);
    const n = op.length > 1 ? parseInt(op.slice(1), 10) : 1;
    let oid = await peelToCommit(fs, gitdir, base);
    if (op.startsWith('~')) {
      for (let i = 0; i < n; i++) {
        const parents = await readCommitParents(fs, gitdir, oid);
        if (parents.length === 0) {
          throw new NotFoundError(`Revision '${rev}' not found`, rev);
        }
        oid = parents[0];
      }
      return oid;
    }
    if (n === 0) return oid;
    const parents = await readCommitParents(fs, gitdir, oid);
    if (parents.length < n) {
      throw new NotFoundError(`Revision '${rev}' not found`, rev);
    }
    return parents[n - 1];
  }

  if (rev === 'HEAD' || rev === '@') {
    const oid = await headCommitOid(fs, gitdir);
    if (!oid) {
      throw new NotFoundError(
        `ambiguous argument 'HEAD': unknown revision or path not in the working tree`,
        'HEAD',
      );
    }
    return oid;
  }

  if (/^[0-9a-f]{40}$/i.test(rev)) {
    const oid = rev.toLowerCase();
    if (await hasObject(fs, gitdir, oid)) return oid;
    throw new NotFoundError(`Not a valid object name ${rev}`, rev);
  }

  const candidates = rev.startsWith('refs/')
    ? [rev]
    : [
        `refs/${rev}`,
        `refs/tags/${rev}`,
        `refs/heads/${rev}`,
        `refs/remotes/${rev}`,
        `refs/remotes/${rev}/HEAD`,
      ];
  for (const name of candidates) {
    let value = await readRef(fs, gitdir, name);
    // Follow symbolic refs such as refs/remotes/origin/HEAD.
    for (let i = 0; value && value.startsWith('ref: ') && i < 5; i++) {
      value = await readRef(fs, gitdir, value.slice(5).trim());
    }
    if (value && /^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  }

  if (/^[0-9a-f]{4,39}$/i.test(rev)) {
    const match = await findLooseObjectByPrefix(fs, gitdir, rev.toLowerCase());
    if (match) return match;
  }

  throw new NotFoundError(`Not a valid object name: '${rev}'`, rev);
}

async function findLooseObjectByPrefix(
  fs: FSAdapter,
  gitdir: string,
  prefix: string,
): Promise<string | null> {
  const dir = joinPaths(gitdir, 'objects', prefix.slice(0, 2));
  if (!(await fs.exists(dir))) return null;
  const rest = prefix.slice(2);
  const matches = (await fs.readdir(dir))
    .map((e) => e.name)
    .filter((name) => name.startsWith(rest));
  if (matches.length > 1) {
    throw new InvalidRefError(`short object ID ${prefix} is ambiguous`, prefix);
  }
  return matches.length === 1 ? prefix.slice(0, 2) + matches[0] : null;
}

/** Flatten a tree recursively into a path -> entry map (blobs, symlinks, gitlinks). */
export async function flattenTree(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string | null,
): Promise<Map<string, FlatTreeEntry>> {
  const out = new Map<string, FlatTreeEntry>();
  if (treeOid) {
    await flattenInto(fs, gitdir, treeOid, '', out);
  }
  return out;
}

async function flattenInto(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string,
  prefix: string,
  out: Map<string, FlatTreeEntry>,
): Promise<void> {
  if (treeOid === EMPTY_TREE_OID) return;
  const { type, content } = await readObject(fs, gitdir, treeOid);
  if (type !== 'tree') {
    throw new InvalidRefError(`${treeOid} is not a tree`, treeOid);
  }
  for (const entry of deserializeTree(content)) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (isTreeMode(entry.mode)) {
      await flattenInto(fs, gitdir, entry.oid, path, out);
    } else {
      out.set(path, {
        path,
        mode: modeNumberToString(modeStringToNumber(entry.mode)),
        oid: entry.oid,
      });
    }
  }
}

/**
 * Compare tree entry names the way git sorts trees: by bytes, with a tree
 * entry compared as if its name had a trailing '/'.
 */
export function compareTreeEntryNames(
  a: { name: string; isTree: boolean },
  b: { name: string; isTree: boolean },
): number {
  return comparePathBytes(
    a.isTree ? `${a.name}/` : a.name,
    b.isTree ? `${b.name}/` : b.name,
  );
}

interface TreeBuildNode {
  files: Map<string, { mode: string; oid: string }>;
  dirs: Map<string, TreeBuildNode>;
}

/**
 * Write tree objects for a set of stage-0 index entries (git write-tree) and
 * return the root tree OID. Throws UnmergedPathsError on conflicted entries.
 */
export async function writeTreeFromIndex(
  fs: FSAdapter,
  gitdir: string,
  entries: IndexEntry[],
): Promise<string> {
  const unmerged = [
    ...new Set(
      entries.filter((e) => indexEntryStage(e.flags) !== 0).map((e) => e.path),
    ),
  ];
  if (unmerged.length > 0) {
    throw new UnmergedPathsError(
      `Committing is not possible because you have unmerged files: ${unmerged.join(', ')}`,
      unmerged,
    );
  }

  const root: TreeBuildNode = { files: new Map(), dirs: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], {
      mode: modeNumberToString(entry.mode),
      oid: entry.oid,
    });
  }

  return writeTreeNode(fs, gitdir, root);
}

async function writeTreeNode(
  fs: FSAdapter,
  gitdir: string,
  node: TreeBuildNode,
): Promise<string> {
  const items: { name: string; isTree: boolean; mode: string; oid: string }[] =
    [];
  for (const [name, file] of node.files) {
    items.push({ name, isTree: false, mode: file.mode, oid: file.oid });
  }
  for (const [name, child] of node.dirs) {
    const oid = await writeTreeNode(fs, gitdir, child);
    items.push({ name, isTree: true, mode: '40000', oid });
  }
  items.sort(compareTreeEntryNames);

  const parts: Uint8Array[] = [];
  for (const item of items) {
    parts.push(
      stringToBuffer(`${item.mode} ${item.name}\0`),
      hexToBuffer(item.oid),
    );
  }
  return writeObject(fs, gitdir, 'tree', concatBuffers(...parts));
}

/** Read `core.filemode` (default true, like git on POSIX filesystems). */
export async function trustExecutableBit(
  fs: FSAdapter,
  gitdir: string,
): Promise<boolean> {
  try {
    const config = await readConfig(fs, gitdir);
    const value = getConfigValue(config, 'core', 'filemode');
    if (value === undefined) return true;
    return !/^(false|no|off|0)$/i.test(value.trim());
  } catch {
    return true;
  }
}

/** Read `core.symlinks` (default true). */
export async function supportsSymlinks(
  fs: FSAdapter,
  gitdir: string,
): Promise<boolean> {
  try {
    const config = await readConfig(fs, gitdir);
    const value = getConfigValue(config, 'core', 'symlinks');
    if (value === undefined) return true;
    return !/^(false|no|off|0)$/i.test(value.trim());
  } catch {
    return true;
  }
}

/** lstat that returns null for a missing path. */
export async function tryLstat(
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
 * Mode and blob content of a working tree path as git would stage it, or null
 * when nothing (or a directory) is there.
 */
export async function readWorktreeEntry(
  fs: FSAdapter,
  dir: string,
  filepath: string,
  options: { trustExecutable?: boolean; existingMode?: number } = {},
): Promise<{ mode: number; content: Uint8Array; stats: FileStats } | null> {
  const fullPath = joinPaths(dir, filepath);
  const stats = await tryLstat(fs, fullPath);
  if (!stats || stats.isDirectory) return null;

  if (stats.isSymbolicLink) {
    const target = await fs.readlink(fullPath);
    return { mode: 0o120000, content: stringToBuffer(target), stats };
  }

  let mode: number;
  if (options.trustExecutable === false) {
    // core.filemode=false: keep the mode recorded in the index (git does the same).
    const existing = options.existingMode;
    mode =
      existing !== undefined && (existing & 0o170000) === 0o100000
        ? existing
        : 0o100644;
  } else {
    mode = (stats.mode & 0o111) !== 0 ? 0o100755 : 0o100644;
  }

  const content = await fs.readFile(fullPath);
  return { mode, content, stats };
}

/** Blob OID and mode of a working tree path, or null if absent. */
export async function hashWorktreeEntry(
  fs: FSAdapter,
  dir: string,
  filepath: string,
  options: { trustExecutable?: boolean; existingMode?: number } = {},
): Promise<{ mode: number; oid: string; stats: FileStats } | null> {
  const entry = await readWorktreeEntry(fs, dir, filepath, options);
  if (!entry) return null;
  return {
    mode: entry.mode,
    oid: await computeOid('blob', entry.content),
    stats: entry.stats,
  };
}

/** Build a stage-0 index entry with stat data taken from `stats` (when given). */
export function makeIndexEntry(
  path: string,
  oid: string,
  mode: number,
  stats?: FileStats | null,
): IndexEntry {
  const sec = (ms: number) => Math.floor(ms / 1000);
  const nsec = (ms: number) => Math.floor((ms % 1000) * 1e6);
  return {
    ctimeSeconds: stats ? sec(stats.ctimeMs) : 0,
    ctimeNanoseconds: stats ? nsec(stats.ctimeMs) : 0,
    mtimeSeconds: stats ? sec(stats.mtimeMs) : 0,
    mtimeNanoseconds: stats ? nsec(stats.mtimeMs) : 0,
    dev: stats ? stats.dev : 0,
    ino: stats ? stats.ino : 0,
    mode,
    uid: stats ? stats.uid : 0,
    gid: stats ? stats.gid : 0,
    // git stores the on-disk size truncated to 32 bits
    size: stats ? stats.size % 0x100000000 : 0,
    oid,
    flags: createFlags(path),
    path,
  };
}

/**
 * Match a repo-relative path against git pathspecs: an exact path, a
 * directory prefix (`dir` or `dir/`), `.` / empty for everything, or a glob
 * (`*`, `?`, `[...]`, where `*` also matches `/`, like git's default pathspec
 * magic).
 */
export function matchesPathspec(path: string, specs: string[]): boolean {
  for (const raw of specs) {
    let spec = raw.replace(/\\/g, '/');
    while (spec.startsWith('./')) spec = spec.slice(2);
    spec = spec.replace(/\/+$/, '');
    if (spec === '' || spec === '.') return true;
    if (path === spec || path.startsWith(`${spec}/`)) return true;
    if (/[*?[]/.test(spec) && globToRegex(spec).test(path)) return true;
  }
  return false;
}

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        re += '\\[';
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  // A glob pathspec also matches everything below a matching directory.
  return new RegExp(`^${re}(?:/.*)?$`);
}
