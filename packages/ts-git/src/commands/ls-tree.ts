import { FSAdapter } from '../fs/types.js';
import { readObject, deserializeTree } from '../core/objects.js';
import { joinPaths } from '../utils/path.js';
import { resolveRevision, peelTo } from './resolve-revision.js';

export interface LsTreeArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** Tree-ish: tree/commit/tag OID (full or abbreviated) or revision. */
  tree: string;
  /** -r: recurse into sub-trees. */
  recursive?: boolean;
  /** -t: show tree entries even when recursing into them. */
  showTrees?: boolean;
  /** -d: show only tree entries (and gitlinks), not blobs. */
  treesOnly?: boolean;
  /** -l/--long: include object sizes. */
  long?: boolean;
  /** --name-only (kept for compatibility; affects formatLsTree only). */
  nameOnly?: boolean;
  /** Literal path patterns, as `git ls-tree <tree-ish> [<path>...]`. */
  paths?: string[];
}

export interface TreeEntry {
  /** Mode as git prints it: six octal digits (`040000` for trees). */
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  oid: string;
  /** Path relative to the root of the listed tree. */
  path: string;
  /** Object size in bytes (blobs only, when `long` is set). */
  size?: number;
}

export interface LsTreeResult {
  entries: TreeEntry[];
}

/** Object type implied by a tree entry mode (gitlinks are commits). */
export function typeFromMode(mode: string): 'blob' | 'tree' | 'commit' {
  const m = parseInt(mode, 8);
  if ((m & 0o170000) === 0o040000) return 'tree';
  if ((m & 0o170000) === 0o160000) return 'commit';
  return 'blob';
}

/** True for tree modes, whether written as `40000` (git) or `040000`. */
export function isTreeMode(mode: string): boolean {
  return typeFromMode(mode) === 'tree';
}

const C_ESCAPES: Record<number, string> = {
  0x07: 'a',
  0x08: 'b',
  0x09: 't',
  0x0a: 'n',
  0x0b: 'v',
  0x0c: 'f',
  0x0d: 'r',
  0x22: '"',
  0x5c: '\\',
};

/**
 * Quote a path the way git does for human-readable output
 * (quote_c_style with core.quotePath=true): if the name contains control
 * characters, `"`, `\`, DEL or non-ASCII bytes it is wrapped in double quotes
 * with C escapes and octal escapes for other bytes.
 */
export function quoteGitPath(name: string, quotePath: boolean = true): string {
  const bytes = new TextEncoder().encode(name);
  let needsQuote = false;
  for (const b of bytes) {
    if (b < 0x20 || b === 0x22 || b === 0x5c || b === 0x7f) needsQuote = true;
    else if (b >= 0x80 && quotePath) needsQuote = true;
    if (needsQuote) break;
  }
  if (!needsQuote) return name;

  let out = '"';
  let run: number[] = [];
  const flush = () => {
    if (run.length) {
      out += new TextDecoder().decode(new Uint8Array(run));
      run = [];
    }
  };
  for (const b of bytes) {
    if (C_ESCAPES[b]) {
      flush();
      out += '\\' + C_ESCAPES[b];
    } else if (b < 0x20 || b === 0x7f || (b >= 0x80 && quotePath)) {
      flush();
      out += '\\' + b.toString(8).padStart(3, '0');
    } else {
      run.push(b);
    }
  }
  flush();
  return out + '"';
}

/**
 * git's show_recursive(): should we descend into the tree at `path`?
 * Always with -r; otherwise only when a pathspec names something inside it.
 */
function shouldRecurse(
  path: string,
  recursive: boolean,
  paths: string[],
): boolean {
  if (recursive) return true;
  for (const spec of paths) {
    if (
      spec.length > path.length &&
      spec.startsWith(path) &&
      spec[path.length] === '/'
    ) {
      return true;
    }
  }
  return false;
}

/** Literal pathspec match used by ls-tree (no globbing). */
function matchesPathspec(
  path: string,
  isTree: boolean,
  paths: string[],
): boolean {
  if (paths.length === 0) return true;
  for (const raw of paths) {
    const spec = raw.replace(/\/+$/, '');
    const dirSpec = raw.endsWith('/');
    if (path === spec) {
      if (!dirSpec || isTree) return true;
      continue;
    }
    // Entry lies under the pathspec directory.
    if (spec === '' || path.startsWith(spec + '/')) return true;
    // Entry is a leading directory of the pathspec (needed for recursion).
    if (isTree && raw.startsWith(path + '/')) return true;
  }
  return false;
}

function normalizeSpec(spec: string): string {
  let s = spec.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s === '.' || s === '') return '';
  return s;
}

export async function lsTree(args: LsTreeArgs): Promise<LsTreeResult> {
  const {
    fs,
    dir,
    gitdir = joinPaths(dir, '.git'),
    tree,
    recursive = false,
    showTrees: showTreesArg = false,
    treesOnly = false,
    long = false,
  } = args;
  // "-d -r should imply -t, but -d by itself should not have to" (git).
  const showTrees = showTreesArg || (treesOnly && recursive);
  const paths = (args.paths ?? []).map(normalizeSpec);
  // A pathspec of "." (or "") means the whole tree.
  const effectivePaths = paths.includes('') ? [] : paths;

  const oid = await resolveRevision(fs, gitdir, tree);
  const treeOid = await peelTo(fs, gitdir, oid, 'tree').catch(() => {
    throw new Error(`not a tree object: ${tree}`);
  });

  const entries: TreeEntry[] = [];

  const walk = async (currentOid: string, prefix: string): Promise<void> => {
    const { type, content } = await readObject(fs, gitdir, currentOid);
    if (type !== 'tree') throw new Error(`not a tree object: ${currentOid}`);

    for (const raw of deserializeTree(content)) {
      const path = prefix + raw.path;
      const entryType = typeFromMode(raw.mode);
      const isTree = entryType === 'tree';
      if (!matchesPathspec(path, isTree, effectivePaths)) continue;

      const entry: TreeEntry = {
        mode: raw.mode.padStart(6, '0'),
        type: entryType,
        oid: raw.oid,
        path,
      };

      if (isTree && shouldRecurse(path, recursive, effectivePaths)) {
        if (showTrees) entries.push(entry);
        await walk(raw.oid, path + '/');
        continue;
      }

      if (entryType === 'blob') {
        if (treesOnly) continue;
        if (long) {
          entry.size = (await readObject(fs, gitdir, raw.oid)).content.length;
        }
      }
      entries.push(entry);
    }
  };

  await walk(treeOid, '');
  return { entries };
}

/**
 * Render ls-tree output exactly as `git ls-tree` prints it
 * (`<mode> SP <type> SP <object> TAB <file>` per line).
 */
export function formatLsTree(
  result: LsTreeResult,
  options: {
    nameOnly?: boolean;
    long?: boolean;
    /** -z: NUL-terminate lines and do not quote names. */
    zeroTerminated?: boolean;
  } = {},
): string {
  const term = options.zeroTerminated ? '\0' : '\n';
  const name = (p: string) => (options.zeroTerminated ? p : quoteGitPath(p));
  return result.entries
    .map((e) => {
      if (options.nameOnly) return name(e.path) + term;
      const size =
        e.size !== undefined ? String(e.size).padStart(7) : '-'.padStart(7);
      const meta = options.long
        ? `${e.mode} ${e.type} ${e.oid} ${size}`
        : `${e.mode} ${e.type} ${e.oid}`;
      return `${meta}\t${name(e.path)}${term}`;
    })
    .join('');
}
