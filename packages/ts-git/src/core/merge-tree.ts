import { FSAdapter } from '../fs/types.js';
import {
  readObject,
  writeObject,
  deserializeTree,
  serializeTree,
  type TreeEntryRaw,
} from './objects.js';
import { mergeFile, isBinaryContent } from './merge-file.js';

/**
 * Three-way merge of trees at the object level (no working tree access).
 * Paths are compared flat; content changed on both sides is merged line by
 * line with mergeFile().
 */

export interface FlatEntry {
  mode: string;
  oid: string;
}

export type FlatTree = Map<string, FlatEntry>;

export type ConflictReason =
  | 'content'
  | 'add/add'
  | 'modify/delete'
  | 'mode'
  | 'binary'
  | 'directory/file';

export interface MergeConflict {
  path: string;
  reason: ConflictReason;
  /** Index stages: 1 = base, 2 = ours, 3 = theirs. */
  base?: FlatEntry;
  ours?: FlatEntry;
  theirs?: FlatEntry;
}

export interface TreeMergeResult {
  /**
   * Resulting tree. Conflicted paths hold what belongs in the working tree:
   * a blob with conflict markers for content conflicts, else the surviving
   * side's version.
   */
  entries: FlatTree;
  conflicts: MergeConflict[];
}

function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Normalize tree entry modes the way git does (e.g. 100664 -> 100644). */
function normalizeMode(mode: string): string {
  if (isTreeMode(mode)) return '40000';
  if (mode === '120000' || mode === '160000' || mode === '100755') return mode;
  return '100644';
}

export async function flattenTree(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string | null,
  prefix = '',
  out: FlatTree = new Map(),
): Promise<FlatTree> {
  if (!treeOid) return out;
  const obj = await readObject(fs, gitdir, treeOid);
  if (obj.type !== 'tree') throw new Error(`${treeOid} is not a tree`);
  for (const e of deserializeTree(obj.content)) {
    const path = prefix ? `${prefix}/${e.path}` : e.path;
    if (isTreeMode(e.mode)) {
      await flattenTree(fs, gitdir, e.oid, path, out);
    } else {
      out.set(path, { mode: normalizeMode(e.mode), oid: e.oid });
    }
  }
  return out;
}

function same(a?: FlatEntry, b?: FlatEntry): boolean {
  if (!a || !b) return a === b;
  return a.mode === b.mode && a.oid === b.oid;
}

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

async function blobBytes(
  fs: FSAdapter,
  gitdir: string,
  entry?: FlatEntry,
): Promise<Uint8Array> {
  if (!entry) return new Uint8Array(0);
  return (await readObject(fs, gitdir, entry.oid)).content;
}

export async function mergeTrees(
  fs: FSAdapter,
  gitdir: string,
  args: {
    base: string | null;
    ours: string | null;
    theirs: string | null;
    oursLabel?: string;
    theirsLabel?: string;
  },
): Promise<TreeMergeResult> {
  const [B, O, T] = await Promise.all([
    flattenTree(fs, gitdir, args.base),
    flattenTree(fs, gitdir, args.ours),
    flattenTree(fs, gitdir, args.theirs),
  ]);
  const entries: FlatTree = new Map();
  const conflicts: MergeConflict[] = [];
  const paths = [...new Set([...B.keys(), ...O.keys(), ...T.keys()])].sort();

  for (const path of paths) {
    const b = B.get(path);
    const o = O.get(path);
    const t = T.get(path);

    if (same(o, t)) {
      if (o) entries.set(path, o);
      continue;
    }
    if (same(b, o)) {
      if (t) entries.set(path, t);
      continue;
    }
    if (same(b, t)) {
      if (o) entries.set(path, o);
      continue;
    }

    // Changed differently on both sides.
    if (!o || !t) {
      // One side deleted, the other modified: keep the modified version.
      entries.set(path, (o ?? t)!);
      conflicts.push({
        path,
        reason: 'modify/delete',
        base: b,
        ours: o,
        theirs: t,
      });
      continue;
    }

    // Mode resolution: take the side that changed it.
    let mode: string;
    let modeConflict = false;
    if (o.mode === t.mode) mode = o.mode;
    else if (b && b.mode === o.mode) mode = t.mode;
    else if (b && b.mode === t.mode) mode = o.mode;
    else {
      mode = o.mode;
      modeConflict = true;
    }

    const regular = (m: string) => m === '100644' || m === '100755';
    if (!regular(o.mode) || !regular(t.mode) || (b && !regular(b.mode))) {
      // Symlinks / submodules: no content merge.
      if (o.oid === t.oid && !modeConflict) {
        entries.set(path, { mode, oid: o.oid });
        continue;
      }
      entries.set(path, o);
      conflicts.push({
        path,
        reason: b ? 'content' : 'add/add',
        base: b,
        ours: o,
        theirs: t,
      });
      continue;
    }

    let oid = o.oid;
    if (o.oid !== t.oid) {
      const [bb, ob, tb] = await Promise.all([
        blobBytes(fs, gitdir, b),
        blobBytes(fs, gitdir, o),
        blobBytes(fs, gitdir, t),
      ]);
      if (isBinaryContent(bb) || isBinaryContent(ob) || isBinaryContent(tb)) {
        entries.set(path, o);
        conflicts.push({ path, reason: 'binary', base: b, ours: o, theirs: t });
        continue;
      }
      const merged = mergeFile(
        decoder.decode(bb),
        decoder.decode(ob),
        decoder.decode(tb),
        {
          oursLabel: args.oursLabel ?? 'ours',
          theirsLabel: args.theirsLabel ?? 'theirs',
        },
      );
      oid = await writeObject(
        fs,
        gitdir,
        'blob',
        encoder.encode(merged.content),
      );
      if (!merged.clean) {
        entries.set(path, { mode, oid });
        conflicts.push({
          path,
          reason: b ? 'content' : 'add/add',
          base: b,
          ours: o,
          theirs: t,
        });
        continue;
      }
    }
    entries.set(path, { mode, oid });
    if (modeConflict) {
      conflicts.push({ path, reason: 'mode', base: b, ours: o, theirs: t });
    }
  }

  // A path can't be both a file and a directory.
  const sorted = [...entries.keys()].sort();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const p = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].startsWith(p); j++) {
      if (sorted[j][p.length] === '/') {
        conflicts.push({
          path: p,
          reason: 'directory/file',
          base: B.get(p),
          ours: O.get(p),
          theirs: T.get(p),
        });
        break;
      }
    }
  }

  return { entries, conflicts };
}

/** Git tree ordering: compare names as if directories had a trailing "/". */
function treeSortKey(e: TreeEntryRaw): string {
  return isTreeMode(e.mode) ? `${e.path}/` : e.path;
}

/** Write nested tree objects for a flat path map; returns the root tree id. */
export async function writeFlatTree(
  fs: FSAdapter,
  gitdir: string,
  entries: FlatTree,
): Promise<string> {
  interface Dir {
    files: TreeEntryRaw[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of entries) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({
      mode: entry.mode,
      path: parts[parts.length - 1],
      oid: entry.oid,
    });
  }

  const write = async (dir: Dir): Promise<string> => {
    const list: TreeEntryRaw[] = [...dir.files];
    for (const [name, sub] of dir.dirs) {
      list.push({ mode: '40000', path: name, oid: await write(sub) });
    }
    list.sort((a, b) => {
      const ka = treeSortKey(a);
      const kb = treeSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return writeObject(fs, gitdir, 'tree', serializeTree(list));
  };
  return write(root);
}
