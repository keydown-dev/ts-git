/**
 * Three-way line merge (diff3), following git's xdiff merge semantics:
 * - changes from both sides that overlap *or touch* conflict;
 * - identical changes on both sides merge cleanly;
 * - conflicts are shrunk by dropping lines common to the start/end of both
 *   sides ("zealous" mode, git's default).
 */

export interface MergeFileOptions {
  oursLabel?: string;
  theirsLabel?: string;
  /** Marker length (git default: 7). */
  markerSize?: number;
}

export interface MergeFileResult {
  clean: boolean;
  /** Merged text, with conflict markers when not clean. */
  content: string;
  conflicts: number;
}

/** Split text into lines, keeping each line's terminating "\n". */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** A replaced region: a[aStart, aEnd) becomes b[bStart, bEnd). */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Myers O(ND) diff over line arrays, returning change hunks in order.
 */
export function diffLineHunks(a: string[], b: string[]): Hunk[] {
  // Intern lines so comparisons are integer compares.
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) {
      id = ids.size;
      ids.set(s, id);
    }
    return id;
  };
  const A = a.map(intern);
  const B = b.map(intern);

  // Trim common prefix/suffix.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (
    suf < A.length - pre &&
    suf < B.length - pre &&
    A[A.length - 1 - suf] === B[B.length - 1 - suf]
  ) {
    suf++;
  }
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length;
  const m = b2.length;

  // Edit script as matched pairs (common lines).
  const matches: Array<[number, number]> = [];
  if (n > 0 && m > 0) {
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
          x = v[offset + k + 1];
        } else {
          x = v[offset + k - 1] + 1;
        }
        let y = x - k;
        while (x < n && y < m && a2[x] === b2[y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
    }
    // Backtrack.
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
      const vd = trace[d];
      const k = x - y;
      let prevK: number;
      if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = vd[offset + prevK];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x--;
        y--;
        matches.push([x, y]);
      }
      if (d > 0) {
        x = prevX;
        y = prevY;
      }
    }
    matches.reverse();
  }

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ma, mb] of [...matches, [n, m] as [number, number]]) {
    if (ma > ai || mb > bi) {
      hunks.push({
        aStart: ai + pre,
        aEnd: ma + pre,
        bStart: bi + pre,
        bEnd: mb + pre,
      });
    }
    ai = ma + 1;
    bi = mb + 1;
  }
  return hunks;
}

interface SideHunk extends Hunk {
  side: 0 | 1;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

function withTrailingNewline(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1];
  return last.endsWith('\n') ? lines : [...lines.slice(0, -1), `${last}\n`];
}

export function mergeFile(
  base: string,
  ours: string,
  theirs: string,
  options: MergeFileOptions = {},
): MergeFileResult {
  const size = options.markerSize ?? 7;
  const oursLabel = options.oursLabel ?? 'ours';
  const theirsLabel = options.theirsLabel ?? 'theirs';

  const O = splitLines(base);
  const A = splitLines(ours);
  const B = splitLines(theirs);
  const sides = [A, B];

  const hunks: SideHunk[] = [
    ...diffLineHunks(O, A).map((h) => ({ ...h, side: 0 as const })),
    ...diffLineHunks(O, B).map((h) => ({ ...h, side: 1 as const })),
  ].sort((x, y) => x.aStart - y.aStart || x.side - y.side);

  const out: string[] = [];
  let conflicts = 0;
  let pos = 0; // position in base
  let i = 0;
  while (i < hunks.length) {
    // Group hunks whose base ranges overlap or touch.
    const group: SideHunk[] = [hunks[i]];
    let groupEnd = hunks[i].aEnd;
    let j = i + 1;
    while (j < hunks.length && hunks[j].aStart <= groupEnd) {
      group.push(hunks[j]);
      groupEnd = Math.max(groupEnd, hunks[j].aEnd);
      j++;
    }
    const groupStart = group[0].aStart;
    out.push(...O.slice(pos, groupStart));

    const touched = new Set(group.map((h) => h.side));
    // Text each side has for base range [groupStart, groupEnd).
    const sideText = (side: 0 | 1): string[] => {
      const lines = sides[side];
      const hs = group.filter((h) => h.side === side);
      if (hs.length === 0) return O.slice(groupStart, groupEnd);
      const res: string[] = [];
      let p = groupStart;
      for (const h of hs) {
        res.push(...O.slice(p, h.aStart));
        res.push(...lines.slice(h.bStart, h.bEnd));
        p = h.aEnd;
      }
      res.push(...O.slice(p, groupEnd));
      return res;
    };

    if (touched.size === 1) {
      out.push(...sideText(group[0].side));
    } else {
      const a = sideText(0);
      const b = sideText(1);
      if (sameLines(a, b)) {
        out.push(...a);
      } else {
        // Zealous: hoist common leading/trailing lines out of the conflict.
        let head = 0;
        while (head < a.length && head < b.length && a[head] === b[head])
          head++;
        let tail = 0;
        while (
          tail < a.length - head &&
          tail < b.length - head &&
          a[a.length - 1 - tail] === b[b.length - 1 - tail]
        ) {
          tail++;
        }
        out.push(...a.slice(0, head));
        out.push(`${'<'.repeat(size)} ${oursLabel}\n`);
        out.push(...withTrailingNewline(a.slice(head, a.length - tail)));
        out.push(`${'='.repeat(size)}\n`);
        out.push(...withTrailingNewline(b.slice(head, b.length - tail)));
        out.push(`${'>'.repeat(size)} ${theirsLabel}\n`);
        out.push(...a.slice(a.length - tail));
        conflicts++;
      }
    }
    pos = groupEnd;
    i = j;
  }
  out.push(...O.slice(pos));

  return { clean: conflicts === 0, content: out.join(''), conflicts };
}

/** Git's binary heuristic: a NUL byte in the first 8000 bytes. */
export function isBinaryContent(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}
