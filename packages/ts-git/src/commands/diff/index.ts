import { FSAdapter } from '../../fs/types.js';
import {
  joinPaths,
  parseGitDir,
  normalizeRepoRelativePath,
} from '../../utils/path.js';
import { readIndex, indexEntryStage } from '../../core/index.js';
import { resolveHeadTreeOid, resolveHeadCommitOid } from '../../core/refs.js';
import {
  readObject,
  deserializeTree,
  deserializeCommit,
} from '../../core/objects.js';
import { NotAGitRepoError } from '../../errors.js';
import { resolveRevision, peelTo } from '../resolve-revision.js';
import { quoteGitPath } from '../ls-tree.js';
import {
  loadStatusContext,
  worktreeSide,
  type StatusContext,
} from '../status.js';
import type {
  DiffArgs,
  DiffResult,
  FileDelta,
  DiffSide,
  DiffFileStatus,
  Hunk,
  DiffLine,
  DiffOutputMode,
} from '../../types.js';
import type { LineDiffAlgorithm, LineDiffEdit } from './types.js';

// ============================================================================
// Snapshots: (mode, oid) per path for each side of the comparison
// ============================================================================

interface SnapshotEntry {
  mode: number;
  oid: string;
  /** Worktree entries read their content from disk. */
  worktree?: boolean;
}

type Snapshot = Map<string, SnapshotEntry>;

const ZERO_OID = '0000000';
const MODE_TREE = 0o040000;

function kindOf(mode: number): 'file' | 'symlink' | 'gitlink' {
  const t = mode & 0o170000;
  if (t === 0o120000) return 'symlink';
  if (t === 0o160000) return 'gitlink';
  return 'file';
}

function modeString(mode: number): string {
  return mode.toString(8).padStart(6, '0');
}

function compareBytes(a: string, b: string): number {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.length - bb.length;
}

async function snapshotTree(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string,
  prefix: string,
  out: Snapshot,
): Promise<void> {
  const { type, content } = await readObject(fs, gitdir, treeOid);
  if (type !== 'tree') throw new Error(`not a tree: ${treeOid}`);
  for (const entry of deserializeTree(content)) {
    const mode = parseInt(entry.mode, 8);
    const path = prefix + entry.path;
    if ((mode & 0o170000) === MODE_TREE) {
      await snapshotTree(fs, gitdir, entry.oid, path + '/', out);
    } else {
      out.set(path, { mode, oid: entry.oid });
    }
  }
}

interface IndexSnapshot {
  entries: Snapshot;
  /** Paths with conflict stages (excluded from diffs). */
  unmerged: Set<string>;
}

async function snapshotIndex(
  fs: FSAdapter,
  gitdir: string,
): Promise<IndexSnapshot> {
  const index = await readIndex(fs, gitdir);
  const entries: Snapshot = new Map();
  const unmerged = new Set<string>();
  for (const e of index.entries) {
    const path = normalizeRepoRelativePath(e.path);
    if (indexEntryStage(e.flags) !== 0) {
      unmerged.add(path);
      continue;
    }
    entries.set(path, { mode: e.mode, oid: e.oid });
  }
  for (const p of unmerged) entries.delete(p);
  return { entries, unmerged };
}

/** Tracked (index) paths as they currently are in the working tree. */
async function snapshotWorktree(
  ctx: StatusContext,
  indexSnap: IndexSnapshot,
): Promise<Snapshot> {
  const out: Snapshot = new Map();
  for (const path of indexSnap.entries.keys()) {
    const entry = ctx.indexByPath.get(path)?.[0];
    const side = await worktreeSide(ctx, path, entry);
    if (side) out.set(path, { ...side, worktree: true });
  }
  return out;
}

async function resolveSideTree(
  fs: FSAdapter,
  gitdir: string,
  side: DiffSide,
): Promise<string | null> {
  const candidates = [side.treeOid, side.ref].filter((v): v is string => !!v);
  for (const candidate of candidates) {
    try {
      const oid = await resolveRevision(fs, gitdir, candidate);
      return await peelTo(fs, gitdir, oid, 'tree');
    } catch {
      // try next
    }
  }
  if (candidates.length > 0) {
    throw new Error(`bad revision '${candidates[0]}'`);
  }
  // No ref at all (e.g. --cached on an unborn branch): the empty tree.
  return null;
}

// ============================================================================
// Public API: Main diff command
// ============================================================================

export async function diff(args: DiffArgs): Promise<DiffResult> {
  const { fs, dir: rawDir, gitdir: providedGitdir } = args;
  const { dir, gitdir } = parseGitDir(rawDir, providedGitdir);

  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  if (!args.lineDiffAlgorithm) {
    throw new Error(
      'No diff algorithm provided. ' +
        'Please install and configure a diff algorithm:\n' +
        '  npm install @keydown-app/ts-git-diff-myers\n' +
        '  import { myersLineDiff } from "@keydown-app/ts-git-diff-myers";\n' +
        '  await diff({ ..., lineDiffAlgorithm: myersLineDiff })',
    );
  }

  const { left, right } = await resolveComparisonSides(args, fs, gitdir);

  let ctx: StatusContext | null = null;
  let indexSnap: IndexSnapshot | null = null;
  const getIndex = async () => (indexSnap ??= await snapshotIndex(fs, gitdir));

  const build = async (side: DiffSide): Promise<Snapshot> => {
    switch (side.type) {
      case 'index':
        return (await getIndex()).entries;
      case 'worktree':
        ctx ??= await loadStatusContext(fs, dir, gitdir);
        return snapshotWorktree(ctx, await getIndex());
      default: {
        const tree = await resolveSideTree(fs, gitdir, side);
        const snap: Snapshot = new Map();
        if (tree) await snapshotTree(fs, gitdir, tree, '', snap);
        return snap;
      }
    }
  };

  const leftSnap = await build(left);
  const rightSnap = await build(right);
  const unmerged =
    left.type === 'index' ||
    right.type === 'index' ||
    left.type === 'worktree' ||
    right.type === 'worktree'
      ? (await getIndex()).unmerged
      : new Set<string>();

  const loadContent = async (
    path: string,
    entry: SnapshotEntry,
  ): Promise<Uint8Array> => {
    if (kindOf(entry.mode) === 'gitlink') {
      return new TextEncoder().encode(`Subproject commit ${entry.oid}\n`);
    }
    if (entry.worktree) {
      const full = joinPaths(dir, path);
      if (kindOf(entry.mode) === 'symlink') {
        return new TextEncoder().encode(await fs.readlink(full));
      }
      return fs.readFile(full);
    }
    return (await readObject(fs, gitdir, entry.oid)).content;
  };

  const deltas = await compareSnapshots(leftSnap, rightSnap, {
    paths: args.paths,
    unmerged,
    loadContent,
    lineDiffAlgorithm: args.lineDiffAlgorithm,
    contextLines: args.contextLines ?? 3,
  });

  let insertions = 0;
  let deletions = 0;
  for (const delta of deltas) {
    insertions += delta.addedLines ?? 0;
    deletions += delta.deletedLines ?? 0;
  }

  return {
    left,
    right,
    deltas,
    changed: deltas.length,
    insertions,
    deletions,
  };
}

async function resolveComparisonSides(
  args: DiffArgs,
  fs: FSAdapter,
  gitdir: string,
): Promise<{ left: DiffSide; right: DiffSide }> {
  if (args.left && args.right) {
    return { left: args.left, right: args.right };
  }

  // --cached / --staged: HEAD (peeled) vs index.
  if (args.cached) {
    const treeOid = await resolveHeadTreeOid(fs, gitdir);
    const commitOid = await resolveHeadCommitOid(fs, gitdir);
    return {
      left: {
        type: 'commit',
        ref: commitOid ?? undefined,
        treeOid: treeOid ?? undefined,
      },
      right: { type: 'index' },
    };
  }

  // Default: index vs worktree (git diff with no args).
  return {
    left: { type: 'index' },
    right: { type: 'worktree' },
  };
}

// ============================================================================
// Comparison
// ============================================================================

interface CompareOptions {
  paths?: string[];
  unmerged: Set<string>;
  loadContent: (path: string, entry: SnapshotEntry) => Promise<Uint8Array>;
  lineDiffAlgorithm: LineDiffAlgorithm;
  contextLines: number;
}

function matchesPaths(path: string, paths?: string[]): boolean {
  if (!paths || paths.length === 0) return true;
  return paths.some((p) => {
    const np = normalizeRepoRelativePath(p);
    return np === '' || np === '.' || path === np || path.startsWith(np + '/');
  });
}

/** git's buffer_is_binary(): a NUL byte in the first 8000 bytes. */
function isBinary(content: Uint8Array): boolean {
  const n = Math.min(content.length, 8000);
  for (let i = 0; i < n; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}

async function compareSnapshots(
  left: Snapshot,
  right: Snapshot,
  options: CompareOptions,
): Promise<FileDelta[]> {
  const allPaths = [...new Set([...left.keys(), ...right.keys()])]
    .filter((p) => !options.unmerged.has(p) && matchesPaths(p, options.paths))
    .sort(compareBytes);

  const deltas: FileDelta[] = [];
  for (const path of allPaths) {
    const l = left.get(path);
    const r = right.get(path);
    if (l && r && l.oid === r.oid && l.mode === r.mode) continue;

    let status: DiffFileStatus;
    if (!l) status = 'A';
    else if (!r) status = 'D';
    else if (kindOf(l.mode) !== kindOf(r.mode)) status = 'T';
    else status = 'M';

    const delta: FileDelta = {
      path,
      status,
      oldMode: l ? modeString(l.mode) : undefined,
      newMode: r ? modeString(r.mode) : undefined,
      oldOid: l ? l.oid.slice(0, 7) : undefined,
      newOid: r ? r.oid.slice(0, 7) : undefined,
      isBinary: false,
      addedLines: 0,
      deletedLines: 0,
    };

    // Mode-only change: no content to compare.
    if (l && r && l.oid === r.oid) {
      delta.hunks = [];
      deltas.push(delta);
      continue;
    }

    const oldContent = l
      ? await options.loadContent(path, l)
      : new Uint8Array();
    const newContent = r
      ? await options.loadContent(path, r)
      : new Uint8Array();
    delta.oldSize = oldContent.length;
    delta.newSize = newContent.length;

    if (isBinary(oldContent) || isBinary(newContent)) {
      delta.isBinary = true;
      deltas.push(delta);
      continue;
    }

    if (status === 'T') {
      // Printed as a deletion followed by a creation.
      const del = computeUnifiedDiff(oldContent, new Uint8Array(), options);
      const add = computeUnifiedDiff(new Uint8Array(), newContent, options);
      delta.hunks = del.hunks;
      delta.addedHunks = add.hunks;
      // --stat counts the pair as one modification.
      const whole = computeUnifiedDiff(oldContent, newContent, options);
      delta.addedLines = whole.addedLines;
      delta.deletedLines = whole.deletedLines;
    } else {
      const d = computeUnifiedDiff(oldContent, newContent, options);
      delta.hunks = d.hunks;
      delta.addedLines = d.addedLines;
      delta.deletedLines = d.deletedLines;
    }
    deltas.push(delta);
  }
  return deltas;
}

// ============================================================================
// Line diff: tokenize blobs, run pluggable algorithm, group into hunks
// ============================================================================

/**
 * Split text into lines that keep their terminating "\n" (the last line may
 * lack one). Comparing lines with their terminators makes "a" and "a\n"
 * different, as in git.
 */
function splitLines(content: Uint8Array): string[] {
  if (content.length === 0) return [];
  const text = new TextDecoder().decode(content);
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      if (start < text.length) lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  return lines;
}

interface DiffStats {
  hunks: Hunk[];
  addedLines: number;
  deletedLines: number;
}

/**
 * Reorder each run of consecutive changes so deletions precede additions
 * (git prints all '-' lines of a change group before its '+' lines).
 */
function normalizeEdits(edits: LineDiffEdit[]): LineDiffEdit[] {
  const out: LineDiffEdit[] = [];
  let i = 0;
  while (i < edits.length) {
    if (edits[i].type === ' ') {
      out.push(edits[i++]);
      continue;
    }
    const dels: LineDiffEdit[] = [];
    const adds: LineDiffEdit[] = [];
    while (i < edits.length && edits[i].type !== ' ') {
      (edits[i].type === '-' ? dels : adds).push(edits[i]);
      i++;
    }
    out.push(...dels, ...adds);
  }
  return out;
}

function computeUnifiedDiff(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  options: { lineDiffAlgorithm: LineDiffAlgorithm; contextLines: number },
): DiffStats {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  let edits: LineDiffEdit[];
  if (oldLines.length === 0) {
    edits = newLines.map((content, i) => ({
      type: '+' as const,
      oldIndex: -1,
      newIndex: i,
      content,
    }));
  } else if (newLines.length === 0) {
    edits = oldLines.map((content, i) => ({
      type: '-' as const,
      oldIndex: i,
      newIndex: -1,
      content,
    }));
  } else {
    edits = normalizeEdits(options.lineDiffAlgorithm(oldLines, newLines));
  }

  let addedLines = 0;
  let deletedLines = 0;
  for (const edit of edits) {
    if (edit.type === '+') addedLines++;
    if (edit.type === '-') deletedLines++;
  }

  return {
    hunks: groupIntoHunks(edits, oldLines, options.contextLines),
    addedLines,
    deletedLines,
  };
}

/**
 * git's default funcname rule (xdiff def_ff): the nearest line above the
 * hunk that starts with a letter, `_` or `$`, trailing whitespace removed,
 * truncated to 80 bytes.
 */
function findFuncLine(oldLines: string[], beforeIndex: number): string {
  for (let i = beforeIndex; i >= 0; i--) {
    const line = oldLines[i].replace(/\n$/, '');
    if (/^[A-Za-z_$]/.test(line)) {
      let bytes = new TextEncoder().encode(line);
      if (bytes.length > 80) bytes = bytes.subarray(0, 80);
      let text = new TextDecoder().decode(bytes);
      // A truncated multi-byte sequence decodes to U+FFFD; drop it.
      text = text.replace(/�+$/, '');
      return text.replace(/[\s]+$/, '');
    }
  }
  return '';
}

/**
 * Group an edit script into unified-diff hunks with git's rules: each
 * change gets `contextLines` lines of context, and changes separated by at
 * most 2 * contextLines unchanged lines share a hunk.
 */
function groupIntoHunks(
  edits: LineDiffEdit[],
  oldLines: string[],
  contextLines: number,
): Hunk[] {
  // Annotate each edit with its 0-based old/new line positions.
  const rows: {
    edit: LineDiffEdit;
    oldPos: number;
    newPos: number;
  }[] = [];
  let o = 0;
  let n = 0;
  for (const edit of edits) {
    rows.push({ edit, oldPos: o, newPos: n });
    if (edit.type !== '+') o++;
    if (edit.type !== '-') n++;
  }

  const changeIdx: number[] = [];
  rows.forEach((r, i) => {
    if (r.edit.type !== ' ') changeIdx.push(i);
  });
  if (changeIdx.length === 0) return [];

  // Build [start, end] row ranges for each hunk.
  const ranges: [number, number][] = [];
  let start = Math.max(0, changeIdx[0] - contextLines);
  let lastChange = changeIdx[0];
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k];
    const gap = idx - lastChange - 1; // unchanged rows in between
    if (gap > 2 * contextLines) {
      ranges.push([
        start,
        Math.min(rows.length - 1, lastChange + contextLines),
      ]);
      start = Math.max(0, idx - contextLines);
    }
    lastChange = idx;
  }
  ranges.push([start, Math.min(rows.length - 1, lastChange + contextLines)]);

  return ranges.map(([s, e]) => {
    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = s; i <= e; i++) {
      const { edit } = rows[i];
      const noNewline = !edit.content.endsWith('\n');
      const line: DiffLine = {
        type: edit.type,
        content: noNewline ? edit.content : edit.content.slice(0, -1),
      };
      if (noNewline) line.noNewline = true;
      lines.push(line);
      if (edit.type !== '+') oldCount++;
      if (edit.type !== '-') newCount++;
    }
    const oldStart0 = rows[s].oldPos;
    const newStart0 = rows[s].newPos;
    const hunk: Hunk = {
      // 1-based start; git prints "start-1" when the count is zero.
      oldStart: oldCount === 0 ? oldStart0 : oldStart0 + 1,
      oldLines: oldCount,
      newStart: newCount === 0 ? newStart0 : newStart0 + 1,
      newLines: newCount,
      lines,
    };
    const func = findFuncLine(oldLines, oldStart0 - 1);
    if (func) hunk.context = func;
    return hunk;
  });
}

// ============================================================================
// Formatters: Convert diff result to Git output formats
// ============================================================================

function quoted(prefix: string, path: string): string {
  return quoteGitPath(prefix + path);
}

function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function formatHunks(hunks: Hunk[], out: string[]): void {
  for (const hunk of hunks) {
    const header = `@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@`;
    out.push(hunk.context ? `${header} ${hunk.context}` : header);
    for (const line of hunk.lines) {
      out.push(`${line.type}${line.content}`);
      if (line.noNewline) out.push('\\ No newline at end of file');
    }
  }
}

function formatFileBlock(
  delta: FileDelta,
  kind: 'A' | 'D' | 'M',
  hunks: Hunk[] | undefined,
  out: string[],
): void {
  const a = quoted('a/', delta.path);
  const b = quoted('b/', delta.path);
  out.push(`diff --git ${a} ${b}`);

  const oldOid = delta.oldOid ?? ZERO_OID;
  const newOid = delta.newOid ?? ZERO_OID;
  const contentChanged = kind !== 'M' || oldOid !== newOid;

  if (kind === 'A') {
    out.push(`new file mode ${delta.newMode}`);
    out.push(`index ${ZERO_OID}..${newOid}`);
  } else if (kind === 'D') {
    out.push(`deleted file mode ${delta.oldMode}`);
    out.push(`index ${oldOid}..${ZERO_OID}`);
  } else {
    const modeChanged = delta.oldMode !== delta.newMode;
    if (modeChanged) {
      out.push(`old mode ${delta.oldMode}`);
      out.push(`new mode ${delta.newMode}`);
    }
    if (contentChanged) {
      out.push(
        modeChanged
          ? `index ${oldOid}..${newOid}`
          : `index ${oldOid}..${newOid} ${delta.newMode}`,
      );
    }
  }

  if (!contentChanged) return;

  const left = kind === 'A' ? '/dev/null' : a;
  const right = kind === 'D' ? '/dev/null' : b;

  if (delta.isBinary) {
    out.push(`Binary files ${left} and ${right} differ`);
    return;
  }
  if (!hunks || hunks.length === 0) return; // e.g. empty file added

  // git appends a TAB to names containing a space, to help patch parsers.
  const tab = delta.path.includes(' ') ? '\t' : '';
  out.push(`--- ${left}${kind === 'A' ? '' : tab}`);
  out.push(`+++ ${right}${kind === 'D' ? '' : tab}`);
  formatHunks(hunks, out);
}

/**
 * Format diff result as a unified patch, exactly as `git diff` prints it
 * (rename detection off).
 */
export function formatPatch(
  result: DiffResult,
  _options: { contextLines?: number } = {},
): string {
  const out: string[] = [];

  for (const delta of result.deltas) {
    if (delta.status === 'A') {
      formatFileBlock(delta, 'A', delta.hunks, out);
    } else if (delta.status === 'D') {
      formatFileBlock(delta, 'D', delta.hunks, out);
    } else if (delta.status === 'T') {
      formatFileBlock(
        { ...delta, newMode: undefined, newOid: undefined },
        'D',
        delta.hunks,
        out,
      );
      formatFileBlock(
        { ...delta, oldMode: undefined, oldOid: undefined },
        'A',
        delta.addedHunks,
        out,
      );
    } else {
      formatFileBlock(delta, 'M', delta.hunks, out);
    }
  }

  return out.length > 0 ? out.join('\n') + '\n' : '';
}

/** `git diff --name-only` (no trailing newline). */
export function formatNameOnly(result: DiffResult): string {
  return result.deltas.map((d) => quoteGitPath(d.path)).join('\n');
}

/** `git diff --name-status` (no trailing newline). */
export function formatNameStatus(result: DiffResult): string {
  return result.deltas
    .map((d) => {
      if (d.status === 'R' || d.status === 'C') {
        const score = String(d.similarity ?? 0).padStart(3, '0');
        return `${d.status}${score}\t${quoteGitPath(d.oldPath ?? '')}\t${quoteGitPath(d.path)}`;
      }
      return `${d.status}\t${quoteGitPath(d.path)}`;
    })
    .join('\n');
}

function decimalWidth(n: number): number {
  return String(n).length;
}

function scaleLinear(it: number, width: number, maxChange: number): number {
  if (!it) return 0;
  return 1 + Math.floor((it * (width - 1)) / maxChange);
}

/** Display width (approximate utf8_strwidth: wide CJK counts as 2). */
function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

/**
 * Format diff result as `git diff --stat` output (80 columns, as git uses
 * when not writing to a terminal). Returns '' when there are no changes.
 */
export function formatStat(
  result: DiffResult,
  options: { width?: number } = {},
): string {
  if (result.deltas.length === 0) {
    return '';
  }

  let width = options.width ?? 80;
  let maxLen = 0;
  let maxChange = 0;
  let numberWidth = 0;
  let binWidth = 0;

  const files = result.deltas.map((d) => {
    const name = quoteGitPath(d.path);
    const added = d.isBinary ? (d.newSize ?? 0) : (d.addedLines ?? 0);
    const deleted = d.isBinary ? (d.oldSize ?? 0) : (d.deletedLines ?? 0);
    maxLen = Math.max(maxLen, strWidth(name));
    if (d.isBinary) {
      binWidth = Math.max(
        binWidth,
        14 + decimalWidth(added) + decimalWidth(deleted),
      );
      numberWidth = 3;
    } else {
      maxChange = Math.max(maxChange, added + deleted);
    }
    return { name, added, deleted, isBinary: !!d.isBinary };
  });

  numberWidth = Math.max(numberWidth, decimalWidth(maxChange));
  if (width < 16 + 6 + numberWidth) width = 16 + 6 + numberWidth;

  let graphWidth = maxChange + 4 > binWidth ? maxChange : binWidth - 4;
  let nameWidth = maxLen;

  if (nameWidth + numberWidth + 6 + graphWidth > width) {
    if (graphWidth > Math.floor((width * 3) / 8) - numberWidth - 6) {
      graphWidth = Math.floor((width * 3) / 8) - numberWidth - 6;
      if (graphWidth < 6) graphWidth = 6;
    }
    if (nameWidth > width - numberWidth - 6 - graphWidth) {
      nameWidth = width - numberWidth - 6 - graphWidth;
    } else {
      graphWidth = width - numberWidth - 6 - nameWidth;
    }
  }

  const lines: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const f of files) {
    let name = f.name;
    let prefix = '';
    let len = nameWidth;
    if (nameWidth < strWidth(name)) {
      prefix = '...';
      len -= 3;
      // Keep the last `len` columns, then cut at the first '/'.
      while (strWidth(name) > len) name = name.slice(1);
      const slash = name.indexOf('/');
      if (slash !== -1) name = name.slice(slash);
    }
    const padding = ' '.repeat(Math.max(0, len - strWidth(name)));

    if (f.isBinary) {
      let line = ` ${prefix}${name}${padding} | ${'Bin'.padStart(numberWidth)}`;
      if (f.added || f.deleted) {
        line += ` ${f.deleted} -> ${f.added} bytes`;
      }
      lines.push(line);
      continue;
    }

    insertions += f.added;
    deletions += f.deleted;
    let add = f.added;
    let del = f.deleted;
    if (graphWidth <= maxChange) {
      let total = scaleLinear(add + del, graphWidth, maxChange);
      if (total < 2 && add && del) total = 2;
      if (add < del) {
        add = scaleLinear(add, graphWidth, maxChange);
        del = total - add;
      } else {
        del = scaleLinear(del, graphWidth, maxChange);
        add = total - del;
      }
    }
    const total = f.added + f.deleted;
    lines.push(
      ` ${prefix}${name}${padding} | ${String(total).padStart(numberWidth)}${total ? ' ' : ''}${'+'.repeat(add)}${'-'.repeat(del)}`,
    );
  }

  const n = files.length;
  let summary = n === 1 ? ` ${n} file changed` : ` ${n} files changed`;
  if (insertions || deletions === 0) {
    summary +=
      insertions === 1
        ? `, ${insertions} insertion(+)`
        : `, ${insertions} insertions(+)`;
  }
  if (deletions || insertions === 0) {
    summary +=
      deletions === 1
        ? `, ${deletions} deletion(-)`
        : `, ${deletions} deletions(-)`;
  }
  lines.push(summary);

  return lines.join('\n') + '\n';
}

/**
 * Format diff result according to the specified output mode
 */
export function formatDiff(
  result: DiffResult,
  mode: DiffOutputMode = 'patch',
  options?: { contextLines?: number },
): string {
  switch (mode) {
    case 'name-only':
      return formatNameOnly(result);
    case 'name-status':
      return formatNameStatus(result);
    case 'stat':
      return formatStat(result);
    case 'patch':
    default:
      return formatPatch(result, options);
  }
}

// ============================================================================
// Helper functions for command parser integration
// ============================================================================

/**
 * Resolve a revision (commit, tree, tag, ref, abbreviated OID, HEAD~n...)
 * to the tree it denotes.
 */
export async function resolveCommitRef(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<{ type: 'commit' | 'tree'; oid: string; treeOid: string } | null> {
  let oid: string;
  try {
    oid = await resolveRevision(fs, gitdir, ref);
  } catch {
    return null;
  }
  try {
    const commitOid = await peelTo(fs, gitdir, oid, 'commit');
    const { content } = await readObject(fs, gitdir, commitOid);
    return {
      type: 'commit',
      oid: commitOid,
      treeOid: deserializeCommit(content).tree,
    };
  } catch {
    // not a commit-ish; maybe a tree-ish
  }
  try {
    const treeOid = await peelTo(fs, gitdir, oid, 'tree');
    return { type: 'tree', oid: treeOid, treeOid };
  } catch {
    return null;
  }
}

/** Best common ancestor(s) of two commits (git merge-base --all). */
export async function mergeBase(
  fs: FSAdapter,
  gitdir: string,
  a: string,
  b: string,
): Promise<string[]> {
  const parentsOf = async (oid: string): Promise<string[]> => {
    const { content } = await readObject(fs, gitdir, oid);
    return deserializeCommit(content).parent;
  };
  const ancestors = async (start: string): Promise<Set<string>> => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      for (const p of await parentsOf(stack.pop()!)) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return seen;
  };
  const ancA = await ancestors(a);
  const ancB = await ancestors(b);
  const common = [...ancA].filter((x) => ancB.has(x));
  // Drop common ancestors that are ancestors of another common ancestor.
  const result: string[] = [];
  for (const c of common) {
    let redundant = false;
    for (const other of common) {
      if (other !== c && (await ancestors(other)).has(c)) {
        redundant = true;
        break;
      }
    }
    if (!redundant) result.push(c);
  }
  return result;
}

/**
 * Parse `A..B`, `A...B` (merge base of A and B, to B), `A..`/`..B` (HEAD
 * fills the empty side). Returns null if `spec` is not a range.
 */
export async function resolveRangeSpec(
  fs: FSAdapter,
  gitdir: string,
  spec: string,
): Promise<{ left: DiffSide; right: DiffSide } | null> {
  const triple = spec.match(/^(.*?)\.\.\.(.*)$/);
  const double = triple ? null : spec.match(/^(.*?)\.\.(.*)$/);
  const m = triple ?? double;
  if (!m) return null;

  const leftRef = m[1] || 'HEAD';
  const rightRef = m[2] || 'HEAD';
  const right = await resolveCommitRef(fs, gitdir, rightRef);
  let left = await resolveCommitRef(fs, gitdir, leftRef);
  if (!left || !right) {
    throw new Error(`Invalid commit range: ${spec}`);
  }

  if (triple) {
    const bases = await mergeBase(fs, gitdir, left.oid, right.oid);
    if (bases.length === 0) {
      throw new Error(`${spec}: no merge base`);
    }
    left = await resolveCommitRef(fs, gitdir, bases[0]);
    if (!left) throw new Error(`Invalid commit range: ${spec}`);
  }

  return {
    left: { type: 'commit', ref: left.oid, treeOid: left.treeOid },
    right: { type: 'commit', ref: right.oid, treeOid: right.treeOid },
  };
}

/**
 * Resolve diff target specs like "A..B" or "A...B"
 */
export async function resolveDiffSpecs(
  fs: FSAdapter,
  gitdir: string,
  specs: string[],
): Promise<{ left: DiffSide; right: DiffSide; paths: string[] } | null> {
  if (specs.length === 0) {
    return null;
  }

  const paths: string[] = [];
  const refs: string[] = [];

  let foundSeparator = false;
  for (const spec of specs) {
    if (spec === '--') {
      foundSeparator = true;
      continue;
    }
    if (foundSeparator) {
      paths.push(spec);
    } else if (!spec.startsWith('-')) {
      refs.push(spec);
    }
  }

  if (refs.length === 0) {
    return null;
  }

  if (refs.length === 1) {
    const spec = refs[0];
    const range = await resolveRangeSpec(fs, gitdir, spec);
    if (range) return { ...range, paths };

    // Single ref: compare that commit to worktree
    const resolved = await resolveCommitRef(fs, gitdir, spec);
    if (resolved) {
      return {
        left: { type: 'commit', ref: resolved.oid, treeOid: resolved.treeOid },
        right: { type: 'worktree' },
        paths,
      };
    }

    throw new Error(`Invalid ref: ${spec}`);
  }

  if (refs.length === 2) {
    const left = await resolveCommitRef(fs, gitdir, refs[0]);
    const right = await resolveCommitRef(fs, gitdir, refs[1]);

    if (!left || !right) {
      throw new Error(`Invalid refs: ${refs.join(', ')}`);
    }

    return {
      left: { type: 'commit', ref: left.oid, treeOid: left.treeOid },
      right: { type: 'commit', ref: right.oid, treeOid: right.treeOid },
      paths,
    };
  }

  throw new Error(`Too many refs specified: ${refs.join(' ')}`);
}

export type { LineDiffEdit, LineDiffAlgorithm } from './types.js';
