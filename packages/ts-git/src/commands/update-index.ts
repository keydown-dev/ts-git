import { FSAdapter } from '../fs/types.js';
import { joinPaths, normalizeRepoRelativePath } from '../utils/path.js';
import {
  readIndex,
  writeIndex,
  indexEntryStage,
  type IndexEntry,
} from '../core/index.js';
import { writeObject } from '../core/objects.js';
import { readConfig, getConfigValue } from '../core/config.js';

export interface CacheInfo {
  /** Octal mode string (e.g. `100644`) or number. */
  mode: string | number;
  oid: string;
  path: string;
}

export interface UpdateIndexArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** --add: allow adding paths that are not yet in the index. */
  add?: boolean;
  /** --remove: remove index entries whose file is missing from the worktree. */
  remove?: boolean;
  /** --force-remove: remove the entries even if the files still exist. */
  forceRemove?: boolean;
  /** Paths (relative to `dir`) to update. */
  filepath?: string | string[];
  /** --cacheinfo <mode>,<object>,<path> entries. */
  cacheinfo?: CacheInfo[];
  /** @deprecated alias of `add` kept for compatibility. */
  force?: boolean;
}

export interface UpdateIndexResult {
  added: string[];
  removed: string[];
  updated: string[];
}

function parseMode(mode: string | number): number {
  return typeof mode === 'number' ? mode : parseInt(mode, 8);
}

function encodedLength(path: string): number {
  return new TextEncoder().encode(path).length;
}

function isFileModeEnabled(value: string | undefined): boolean {
  if (value === undefined) return true; // git's default
  return !['false', 'no', 'off', '0', ''].includes(value.toLowerCase());
}

function buildEntry(
  path: string,
  oid: string,
  mode: number,
  stat?: {
    ctimeMs: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    uid: number;
    gid: number;
    size: number;
  },
): IndexEntry {
  const sec = (ms: number) => Math.floor(ms / 1000) >>> 0;
  const nsec = (ms: number) =>
    Math.max(0, Math.floor((ms - Math.floor(ms / 1000) * 1000) * 1e6)) >>> 0;
  return {
    ctimeSeconds: stat ? sec(stat.ctimeMs) : 0,
    ctimeNanoseconds: stat ? nsec(stat.ctimeMs) : 0,
    mtimeSeconds: stat ? sec(stat.mtimeMs) : 0,
    mtimeNanoseconds: stat ? nsec(stat.mtimeMs) : 0,
    dev: stat ? stat.dev >>> 0 : 0,
    ino: stat ? stat.ino >>> 0 : 0,
    mode,
    uid: stat ? stat.uid >>> 0 : 0,
    gid: stat ? stat.gid >>> 0 : 0,
    size: stat ? stat.size >>> 0 : 0,
    oid,
    flags: Math.min(encodedLength(path), 0xfff),
    path,
  };
}

/**
 * `git update-index` for the common modes:
 * `[--add] [--remove | --force-remove] <file>...` and
 * `[--add] --cacheinfo <mode>,<object>,<path>`.
 *
 * Like git, file contents are written to the object database, executable
 * bits are honoured when core.filemode is true (otherwise an existing
 * entry's mode is kept), symlinks are stored as mode 120000 blobs of the
 * link target, and adding a path that is not in the index requires `add`.
 */
export async function updateIndex(
  args: UpdateIndexArgs,
): Promise<UpdateIndexResult> {
  const {
    fs,
    dir,
    gitdir = joinPaths(dir, '.git'),
    remove = false,
    forceRemove = false,
    filepath = [],
    cacheinfo = [],
  } = args;
  const add = args.add || args.force || false;
  const files = Array.isArray(filepath) ? filepath : [filepath];
  const index = await readIndex(fs, gitdir);
  const result: UpdateIndexResult = { added: [], removed: [], updated: [] };

  const config = await readConfig(fs, gitdir);
  const trustFileMode = isFileModeEnabled(
    getConfigValue(config, 'core', 'filemode'),
  );

  const findEntries = (path: string) =>
    index.entries.filter((e) => normalizeRepoRelativePath(e.path) === path);

  const removePath = (path: string) => {
    index.entries = index.entries.filter(
      (e) => normalizeRepoRelativePath(e.path) !== path,
    );
  };

  const setEntry = (entry: IndexEntry) => {
    const existing = findEntries(entry.path);
    // A stage-0 entry replaces every stage (resolves a conflict).
    removePath(entry.path);
    index.entries.push(entry);
    if (existing.length > 0) result.updated.push(entry.path);
    else result.added.push(entry.path);
  };

  for (const info of cacheinfo) {
    const path = normalizeRepoRelativePath(info.path);
    if (!/^[0-9a-f]{40}$/i.test(info.oid)) {
      throw new Error(`git update-index: --cacheinfo cannot add ${info.path}`);
    }
    if (findEntries(path).length === 0 && !add) {
      throw new Error(
        `error: ${path}: cannot add to the index - missing --add option?`,
      );
    }
    setEntry(buildEntry(path, info.oid.toLowerCase(), parseMode(info.mode)));
  }

  for (const file of files) {
    const path = normalizeRepoRelativePath(file);
    const fullPath = joinPaths(dir, path);

    if (forceRemove) {
      if (findEntries(path).length > 0) {
        removePath(path);
        result.removed.push(path);
      }
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(fullPath);
    } catch {
      stat = null;
    }

    if (!stat) {
      if (remove) {
        if (findEntries(path).length > 0) {
          removePath(path);
          result.removed.push(path);
        }
        continue;
      }
      throw new Error(`error: ${path}: does not exist and --remove not passed`);
    }

    if (stat.isDirectory) {
      throw new Error(
        `error: ${path}: is a directory - add individual files instead`,
      );
    }

    const existing = findEntries(path);
    if (existing.length === 0 && !add) {
      throw new Error(
        `error: ${path}: cannot add to the index - missing --add option?`,
      );
    }

    let content: Uint8Array;
    let mode: number;
    if (stat.isSymbolicLink) {
      content = new TextEncoder().encode(await fs.readlink(fullPath));
      mode = 0o120000;
    } else {
      content = await fs.readFile(fullPath);
      const stage0 = existing.find((e) => indexEntryStage(e.flags) === 0);
      if (trustFileMode) {
        mode = stat.mode & 0o100 ? 0o100755 : 0o100644;
      } else if (
        stage0 &&
        (stage0.mode === 0o100755 || stage0.mode === 0o100644)
      ) {
        mode = stage0.mode;
      } else {
        mode = 0o100644;
      }
    }

    const oid = await writeObject(fs, gitdir, 'blob', content);
    setEntry(buildEntry(path, oid, mode, stat));
  }

  await writeIndex(fs, gitdir, index);
  return result;
}
