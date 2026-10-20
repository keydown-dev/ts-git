import { FSAdapter } from '../fs/types.js';
import { readObject, deserializeTree, GitObjectType } from './objects.js';

/**
 * Commit-graph traversal helpers: ancestry checks, merge bases and the
 * object enumeration used to build packs (rev-list --objects).
 */

export interface CommitInfo {
  oid: string;
  tree: string;
  parents: string[];
  /** Committer timestamp (seconds since epoch). */
  time: number;
}

const decoder = new TextDecoder();

export function parseCommitHeaders(
  oid: string,
  content: Uint8Array,
): CommitInfo {
  const text = decoder.decode(content);
  const headerEnd = text.indexOf('\n\n');
  const headers = headerEnd === -1 ? text : text.slice(0, headerEnd);
  let tree = '';
  const parents: string[] = [];
  let time = 0;
  for (const line of headers.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) parents.push(line.slice(7, 47));
    else if (line.startsWith('committer ')) {
      const m = line.match(/> (\d+) [+-]\d{4}$/);
      if (m) time = parseInt(m[1], 10);
    }
  }
  return { oid, tree, parents, time };
}

/** Caching commit reader shared across one traversal. */
export class CommitReader {
  private cache = new Map<string, CommitInfo>();

  constructor(
    private fs: FSAdapter,
    private gitdir: string,
  ) {}

  /** Already-read commit, without touching storage. */
  peek(oid: string): CommitInfo | undefined {
    return this.cache.get(oid);
  }

  async read(oid: string): Promise<CommitInfo> {
    const cached = this.cache.get(oid);
    if (cached) return cached;
    const obj = await readObject(this.fs, this.gitdir, oid);
    if (obj.type !== 'commit') {
      throw new Error(`Object ${oid} is a ${obj.type}, not a commit`);
    }
    const info = parseCommitHeaders(oid, obj.content);
    this.cache.set(oid, info);
    return info;
  }
}

/** Peel annotated tags until a non-tag object is reached. */
export async function peelToNonTag(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<{ oid: string; type: GitObjectType }> {
  for (let depth = 0; depth < 20; depth++) {
    const obj = await readObject(fs, gitdir, oid);
    if (obj.type !== 'tag') return { oid, type: obj.type };
    const m = decoder.decode(obj.content).match(/^object ([0-9a-f]{40})/);
    if (!m) throw new Error(`Malformed tag object ${oid}`);
    oid = m[1];
  }
  throw new Error(`Tag chain too deep at ${oid}`);
}

/** Simple max-heap of commits keyed by committer time (newest first). */
class CommitQueue {
  private items: CommitInfo[] = [];

  get size(): number {
    return this.items.length;
  }

  push(c: CommitInfo): void {
    const a = this.items;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].time >= a[i].time) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop(): CommitInfo | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].time > a[m].time) m = l;
        if (r < a.length && a[r].time > a[m].time) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }

  toArray(): CommitInfo[] {
    return this.items;
  }
}

/** Is `ancestor` reachable from `descendant` (or equal to it)? */
export async function isAncestor(
  fs: FSAdapter,
  gitdir: string,
  ancestor: string,
  descendant: string,
  reader: CommitReader = new CommitReader(fs, gitdir),
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = new CommitQueue();
  queue.push(await reader.read(descendant));
  while (queue.size > 0) {
    const c = queue.pop()!;
    if (c.oid === ancestor) return true;
    for (const p of c.parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      queue.push(await reader.read(p));
    }
  }
  return false;
}

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const RESULT = 8;

/**
 * Best common ancestors of two commits (git merge-base --all), using git's
 * paint-down algorithm ordered by commit date.
 */
export async function findMergeBases(
  fs: FSAdapter,
  gitdir: string,
  a: string,
  b: string,
  reader: CommitReader = new CommitReader(fs, gitdir),
): Promise<string[]> {
  if (a === b) return [a];
  const flags = new Map<string, number>();
  const queue = new CommitQueue();
  const results: string[] = [];

  flags.set(a, PARENT1);
  flags.set(b, (flags.get(b) ?? 0) | PARENT2);
  queue.push(await reader.read(a));
  queue.push(await reader.read(b));

  const hasNonStale = () =>
    queue.toArray().some((c) => !((flags.get(c.oid) ?? 0) & STALE));

  while (queue.size > 0 && hasNonStale()) {
    const c = queue.pop()!;
    let f = (flags.get(c.oid) ?? 0) & (PARENT1 | PARENT2 | STALE);
    if ((f & (PARENT1 | PARENT2)) === (PARENT1 | PARENT2)) {
      if (!((flags.get(c.oid) ?? 0) & RESULT)) {
        flags.set(c.oid, (flags.get(c.oid) ?? 0) | RESULT);
        results.push(c.oid);
      }
      f |= STALE;
    }
    for (const p of c.parents) {
      const pf = flags.get(p) ?? 0;
      if ((pf & f) === f) continue;
      flags.set(p, pf | f);
      queue.push(await reader.read(p));
    }
  }

  const candidates = results.filter((oid) => !((flags.get(oid) ?? 0) & STALE));
  // Drop candidates that are ancestors of other candidates.
  const best: string[] = [];
  for (const c of candidates) {
    let redundant = false;
    for (const other of candidates) {
      if (other !== c && (await isAncestor(fs, gitdir, c, other, reader))) {
        redundant = true;
        break;
      }
    }
    if (!redundant) best.push(c);
  }
  return best;
}

/**
 * Most recent commits reachable from `tips`, newest first, up to `limit`.
 * Used to advertise "have" lines during fetch negotiation.
 */
export async function recentCommits(
  fs: FSAdapter,
  gitdir: string,
  tips: string[],
  limit: number,
): Promise<string[]> {
  const reader = new CommitReader(fs, gitdir);
  const seen = new Set<string>();
  const queue = new CommitQueue();
  for (const tip of tips) {
    if (seen.has(tip)) continue;
    seen.add(tip);
    try {
      queue.push(await reader.read(tip));
    } catch {
      // Not a commit (or missing): skip.
    }
  }
  const out: string[] = [];
  while (queue.size > 0 && out.length < limit) {
    const c = queue.pop()!;
    out.push(c.oid);
    for (const p of c.parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        queue.push(await reader.read(p));
      } catch {
        // Missing parent (e.g. shallow boundary).
      }
    }
  }
  return out;
}

export interface EnumeratedObject {
  oid: string;
  type: GitObjectType;
  content: Uint8Array;
}

/**
 * Enumerate every object reachable from `wants` but not from `haves`
 * (git rev-list --objects <wants> --not <haves>). `haves` that don't exist
 * locally are ignored. Objects are returned in pack-friendly order:
 * commits/tags first, then trees and blobs.
 */
export async function enumerateObjects(
  fs: FSAdapter,
  gitdir: string,
  wants: string[],
  haves: string[],
): Promise<EnumeratedObject[]> {
  const reader = new CommitReader(fs, gitdir);
  const out: EnumeratedObject[] = [];
  const emitted = new Set<string>();

  // 1. Peel haves and wants.
  const uninteresting = new Set<string>(haves);
  const haveCommits: string[] = [];
  for (const have of haves) {
    try {
      const peeled = await peelToNonTag(fs, gitdir, have);
      if (peeled.type === 'commit') haveCommits.push(peeled.oid);
      else uninteresting.add(peeled.oid);
    } catch {
      // Unknown to us: can't use it.
    }
  }

  const rootTrees: string[] = [];
  const otherRoots: string[] = [];
  const wantCommits: string[] = [];
  for (const want of wants) {
    let oid = want;
    for (let depth = 0; depth < 20; depth++) {
      if (uninteresting.has(oid) || emitted.has(oid)) break;
      const obj = await readObject(fs, gitdir, oid);
      if (obj.type === 'tag') {
        emitted.add(oid);
        out.push({ oid, type: 'tag', content: obj.content });
        oid = decoder.decode(obj.content).slice(7, 47);
        continue;
      }
      if (obj.type === 'commit') wantCommits.push(oid);
      else if (obj.type === 'tree') rootTrees.push(oid);
      else otherRoots.push(oid);
      break;
    }
  }

  // 2. Interleaved date-ordered walk (git's limit_list): uninteresting
  // marks flow from haves to their ancestors, and the walk stops once only
  // uninteresting commits remain queued (plus a little slop for clock
  // skew), instead of visiting the haves' entire history. Any imprecision
  // only ever sends extra objects, never fewer.
  const queue = new CommitQueue();
  const queued = new Set<string>();
  const processed = new Set<string>();
  const markUninteresting = (start: string): void => {
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (uninteresting.has(oid) && oid !== start) continue;
      uninteresting.add(oid);
      // Already walked past it: push the mark down to its known parents.
      if (processed.has(oid)) {
        const info = reader.peek(oid);
        for (const p of info?.parents ?? []) {
          if (!uninteresting.has(p)) stack.push(p);
        }
      }
    }
  };
  const enqueue = async (oid: string): Promise<void> => {
    if (queued.has(oid)) return;
    queued.add(oid);
    try {
      queue.push(await reader.read(oid));
    } catch {
      // Missing (e.g. shallow) commit.
    }
  };
  for (const oid of haveCommits) markUninteresting(oid);
  for (const oid of [...haveCommits, ...wantCommits]) await enqueue(oid);

  // git's still_interesting(): keep going while the newest queued commit
  // is at least as new as the last one walked (ties and clock skew), or
  // while anything interesting is queued; otherwise allow a few more steps.
  const SLOP = 5;
  let slop = SLOP;
  let lastTime = Infinity;
  while (queue.size > 0) {
    const newest = queue.toArray()[0];
    if (
      lastTime <= newest.time ||
      queue.toArray().some((c) => !uninteresting.has(c.oid))
    ) {
      slop = SLOP;
    } else if (--slop < 0) {
      break;
    }
    const c = queue.pop()!;
    lastTime = c.time;
    processed.add(c.oid);
    const flagged = uninteresting.has(c.oid);
    for (const p of c.parents) {
      if (flagged) markUninteresting(p);
      await enqueue(p);
    }
  }

  const commits: CommitInfo[] = [];
  const boundary = new Set<string>();
  for (const oid of processed) {
    if (uninteresting.has(oid)) continue;
    const c = reader.peek(oid)!;
    commits.push(c);
    for (const p of c.parents) {
      if (uninteresting.has(p)) boundary.add(p);
    }
  }

  for (const c of commits) {
    const obj = await readObject(fs, gitdir, c.oid);
    emitted.add(c.oid);
    out.push({ oid: c.oid, type: 'commit', content: obj.content });
    rootTrees.push(c.tree);
  }

  // 3. Trees/blobs of boundary commits are uninteresting.
  const knownObjects = new Set<string>();
  const markTree = async (treeOid: string): Promise<void> => {
    if (knownObjects.has(treeOid)) return;
    knownObjects.add(treeOid);
    const obj = await readObject(fs, gitdir, treeOid);
    for (const e of deserializeTree(obj.content)) {
      if (e.mode === '160000') continue;
      if (e.mode === '40000' || e.mode === '040000') await markTree(e.oid);
      else knownObjects.add(e.oid);
    }
  };
  for (const oid of boundary) {
    try {
      await markTree((await reader.read(oid)).tree);
    } catch {
      // Ignore boundary commits we can't read.
    }
  }
  for (const oid of uninteresting) knownObjects.add(oid);

  // 4. Emit trees and blobs not already known to the other side.
  const walkTree = async (treeOid: string): Promise<void> => {
    if (knownObjects.has(treeOid) || emitted.has(treeOid)) return;
    emitted.add(treeOid);
    const obj = await readObject(fs, gitdir, treeOid);
    out.push({ oid: treeOid, type: 'tree', content: obj.content });
    for (const e of deserializeTree(obj.content)) {
      if (e.mode === '160000') continue; // submodule commit: not ours
      if (e.mode === '40000' || e.mode === '040000') {
        await walkTree(e.oid);
      } else if (!knownObjects.has(e.oid) && !emitted.has(e.oid)) {
        emitted.add(e.oid);
        const blob = await readObject(fs, gitdir, e.oid);
        out.push({ oid: e.oid, type: blob.type, content: blob.content });
      }
    }
  };
  for (const tree of rootTrees) await walkTree(tree);
  for (const oid of otherRoots) {
    if (knownObjects.has(oid) || emitted.has(oid)) continue;
    emitted.add(oid);
    const obj = await readObject(fs, gitdir, oid);
    out.push({ oid, type: obj.type, content: obj.content });
  }

  return out;
}
