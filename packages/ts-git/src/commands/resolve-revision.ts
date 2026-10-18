/**
 * Minimal revision resolution (a subset of gitrevisions(7)) for the
 * read-side plumbing commands: full or abbreviated OIDs, ref names resolved
 * with git's DWIM order, `HEAD`/`ORIG_HEAD`/`FETCH_HEAD`, `<rev>^{type}`,
 * `<rev>^{}`, `<rev>~<n>`, `<rev>^<n>`, `<rev>:<path>` and `:<path>`.
 */
import { FSAdapter } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';
import {
  readObject,
  deserializeCommit,
  deserializeTag,
  deserializeTree,
  type GitObjectType,
} from '../core/objects.js';
import { listPackedOids } from '../core/packfile.js';
import { readRef } from '../core/refs.js';
import {
  readIndex,
  groupIndexEntriesByPath,
  indexEntryStage,
} from '../core/index.js';
import { ObjectNotFoundError } from '../errors.js';

const FULL_OID = /^[0-9a-f]{40}$/i;
const HEX = /^[0-9a-f]+$/i;

/** Expand an abbreviated object name (at least 4 hex digits). */
export async function expandOid(
  fs: FSAdapter,
  gitdir: string,
  prefix: string,
): Promise<string | null> {
  const p = prefix.toLowerCase();
  if (FULL_OID.test(p)) return p;
  if (p.length < 4 || !HEX.test(p)) return null;

  const matches = new Set<string>();
  const fanoutDir = joinPaths(gitdir, 'objects', p.slice(0, 2));
  if (await fs.exists(fanoutDir)) {
    for (const entry of await fs.readdir(fanoutDir)) {
      const oid = p.slice(0, 2) + entry.name;
      if (FULL_OID.test(oid) && oid.startsWith(p)) matches.add(oid);
    }
  }
  for (const oid of await listPackedOids(fs, gitdir)) {
    if (oid.startsWith(p)) matches.add(oid);
  }

  if (matches.size > 1) {
    throw new Error(`short object ID ${prefix} is ambiguous`);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

async function readRefFully(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 5) return null;
  let value: string | null;
  if (!ref.startsWith('refs/')) {
    // Pseudo-refs such as HEAD, ORIG_HEAD, FETCH_HEAD live in $GIT_DIR.
    const p = joinPaths(gitdir, ref);
    if (!(await fs.exists(p))) return null;
    const stat = await fs.stat(p);
    if (!stat.isFile) return null;
    value = (await fs.readFileString(p)).split('\n')[0].trim();
  } else {
    try {
      value = await readRef(fs, gitdir, ref);
    } catch {
      // e.g. the name is a directory such as refs/heads
      return null;
    }
  }
  if (!value) return null;
  if (value.startsWith('ref:')) {
    return readRefFully(fs, gitdir, value.slice(4).trim(), depth + 1);
  }
  const oid = value.split(/\s/)[0];
  return FULL_OID.test(oid) ? oid.toLowerCase() : null;
}

/** Resolve a ref name using git's DWIM rules (see gitrevisions(7)). */
export async function resolveRefName(
  fs: FSAdapter,
  gitdir: string,
  name: string,
): Promise<string | null> {
  if (!name || name.includes('..')) return null;
  const candidates = [
    name,
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
  for (const candidate of candidates) {
    // Only all-caps names (HEAD, ORIG_HEAD, ...) or refs/* are looked up
    // directly in $GIT_DIR, as in git.
    if (
      candidate === name &&
      !name.startsWith('refs/') &&
      !/^[A-Z_]+$/.test(name)
    ) {
      continue;
    }
    const oid = await readRefFully(fs, gitdir, candidate);
    if (oid) return oid;
  }
  return null;
}

async function objectType(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<{ type: GitObjectType; content: Uint8Array }> {
  const { type, content } = await readObject(fs, gitdir, oid);
  return { type, content };
}

/** Peel tags (and commits, for `tree`) until an object of `target` type. */
export async function peelTo(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
  target: GitObjectType | 'any',
): Promise<string> {
  let current = oid;
  for (let i = 0; i < 100; i++) {
    const { type, content } = await objectType(fs, gitdir, current);
    if (target === 'any' ? type !== 'tag' : type === target) return current;
    if (type === 'tag') {
      current = deserializeTag(content).object;
    } else if (type === 'commit' && target === 'tree') {
      current = deserializeCommit(content).tree;
    } else {
      throw new Error(`${oid} cannot be peeled to ${target}`);
    }
  }
  throw new Error(`too many levels of tags for ${oid}`);
}

/** Look up `path` inside the tree `treeOid`. */
export async function lookupTreePath(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string,
  path: string,
): Promise<{ oid: string; mode: string } | null> {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { oid: treeOid, mode: '40000' };
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const { type, content } = await objectType(fs, gitdir, current);
    if (type !== 'tree') return null;
    const entry = deserializeTree(content).find((e) => e.path === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    current = entry.oid;
  }
  return null;
}

async function resolveBase(
  fs: FSAdapter,
  gitdir: string,
  name: string,
): Promise<string | null> {
  if (name === '@') name = 'HEAD';
  if (FULL_OID.test(name)) return name.toLowerCase();
  const fromRef = await resolveRefName(fs, gitdir, name);
  if (fromRef) return fromRef;
  return expandOid(fs, gitdir, name);
}

/**
 * Resolve a revision expression to an object ID.
 * Throws ObjectNotFoundError when it cannot be resolved.
 */
export async function resolveRevision(
  fs: FSAdapter,
  gitdir: string,
  rev: string,
): Promise<string> {
  const notFound = (): never => {
    throw new ObjectNotFoundError(`Not a valid object name ${rev}`, rev);
  };

  // `:path` / `:<stage>:path` — index lookup
  const indexMatch = rev.match(/^:(?:([0-3]):)?(.+)$/);
  if (indexMatch) {
    const stage = indexMatch[1] ? parseInt(indexMatch[1], 10) : 0;
    const index = await readIndex(fs, gitdir);
    const list = groupIndexEntriesByPath(index.entries).get(indexMatch[2]);
    const entry = list?.find((e) => indexEntryStage(e.flags) === stage);
    return entry ? entry.oid : notFound();
  }

  // `<rev>:<path>` — tree lookup
  const colon = rev.indexOf(':');
  if (colon > 0) {
    const base = await resolveRevision(fs, gitdir, rev.slice(0, colon));
    const tree = await peelTo(fs, gitdir, base, 'tree');
    const found = await lookupTreePath(fs, gitdir, tree, rev.slice(colon + 1));
    return found ? found.oid : notFound();
  }

  // Split the base name from trailing navigation operators.
  const opMatch = rev.match(/^(.*?)((?:\^\{[a-z]*\}|~\d*|\^\d*)*)$/);
  const baseName = opMatch ? opMatch[1] : rev;
  let ops = opMatch ? opMatch[2] : '';

  let oid = await resolveBase(fs, gitdir, baseName);
  if (!oid) return notFound();

  while (ops.length > 0) {
    let m: RegExpMatchArray | null;
    if ((m = ops.match(/^\^\{([a-z]*)\}/))) {
      const what = m[1];
      if (what === '') {
        oid = await peelTo(fs, gitdir, oid, 'any');
      } else if (what === 'object') {
        // ^{object}: just require existence
        await objectType(fs, gitdir, oid);
      } else if (['commit', 'tree', 'blob', 'tag'].includes(what)) {
        oid = await peelTo(fs, gitdir, oid, what as GitObjectType);
      } else {
        notFound();
      }
    } else if ((m = ops.match(/^~(\d*)/))) {
      const n = m[1] === '' ? 1 : parseInt(m[1], 10);
      for (let i = 0; i < n; i++) {
        const commitOid = await peelTo(fs, gitdir, oid, 'commit');
        const { content } = await objectType(fs, gitdir, commitOid);
        const parent = deserializeCommit(content).parent[0];
        if (!parent) return notFound();
        oid = parent;
      }
    } else if ((m = ops.match(/^\^(\d*)/))) {
      const n = m[1] === '' ? 1 : parseInt(m[1], 10);
      const commitOid = await peelTo(fs, gitdir, oid, 'commit');
      if (n > 0) {
        const { content } = await objectType(fs, gitdir, commitOid);
        const parent = deserializeCommit(content).parent[n - 1];
        if (!parent) return notFound();
        oid = parent;
      } else {
        oid = commitOid;
      }
    } else {
      return notFound();
    }
    ops = ops.slice(m![0].length);
  }

  return oid;
}
