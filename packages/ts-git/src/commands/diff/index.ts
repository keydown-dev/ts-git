import { FSAdapter } from '../../fs/types.js';
import {
  joinPaths,
  parseGitDir,
  normalizeRepoRelativePath,
} from '../../utils/path.js';
import {
  readIndex,
  groupIndexEntriesByPath,
  pickRepresentativeIndexEntry,
} from '../../core/index.js';
import {
  readRef,
  resolveHeadTreeOid,
  resolveHeadCommitOid,
} from '../../core/refs.js';
import { readObject, deserializeTree, computeOid } from '../../core/objects.js';
import { walkDir } from '../../utils/walk.js';
import { NotAGitRepoError } from '../../errors.js';
import type {
  DiffArgs,
  DiffResult,
  FileDelta,
  DiffSide,
  DiffSourceType,
  DiffFileStatus,
  Hunk,
  DiffLine,
  DiffOutputMode,
} from '../../types.js';
import type { LineDiffAlgorithm, LineDiffEdit } from './types.js';

// ============================================================================
// Types for internal diff computation
// ============================================================================

interface SnapshotEntry {
  path: string;
  oid: string;
  mode: string;
  exists: boolean;
  content?: Uint8Array;
  isBinary?: boolean;
}

interface Snapshot {
  type: DiffSourceType;
  ref?: string;
  entries: Map<string, SnapshotEntry>;
}

interface CompareOptions {
  paths?: string[];
  lineDiffAlgorithm: LineDiffAlgorithm;
  contextLines: number;
}

// ============================================================================
// Public API: Main diff command
// ============================================================================

export async function diff(args: DiffArgs): Promise<DiffResult> {
  const { fs, dir, gitdir: providedGitdir } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);

  // Check if this is a git repository
  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  // Determine left and right sides of the comparison
  const { left, right } = await resolveComparisonSides(args, fs, dir, gitdir);

  // Build snapshots for both sides
  const leftSnapshot = await buildSnapshot(fs, dir, gitdir, left);
  const rightSnapshot = await buildSnapshot(fs, dir, gitdir, right);

  if (!args.lineDiffAlgorithm) {
    throw new Error(
      'No diff algorithm provided. ' +
        'Please install and configure a diff algorithm:\n' +
        '  npm install @keydown-app/ts-git-diff-myers\n' +
        '  import { myersLineDiff } from "@keydown-app/ts-git-diff-myers";\n' +
        '  await diff({ ..., lineDiffAlgorithm: myersLineDiff })',
    );
  }
  const lineDiffAlgorithm = args.lineDiffAlgorithm;
  const contextLines = args.contextLines ?? 3;

  // Compare snapshots and generate deltas
  const deltas = compareSnapshots(leftSnapshot, rightSnapshot, {
    paths: args.paths,
    lineDiffAlgorithm,
    contextLines,
  });

  // Compute stats
  let changed = 0;
  let insertions = 0;
  let deletions = 0;

  for (const delta of deltas) {
    changed++;
    if (delta.addedLines !== undefined) {
      insertions += delta.addedLines;
    }
    if (delta.deletedLines !== undefined) {
      deletions += delta.deletedLines;
    }
  }

  return {
    left,
    right,
    deltas,
    changed,
    insertions,
    deletions,
  };
}

// ============================================================================
// Snapshot Selection: Resolve what to compare
// ============================================================================

async function resolveComparisonSides(
  args: DiffArgs,
  fs: FSAdapter,
  _dir: string,
  gitdir: string,
): Promise<{ left: DiffSide; right: DiffSide }> {
  // Handle explicit --cached / --staged mode (left = peeled HEAD tree, never raw symbolic HEAD)
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

  // Handle explicit left/right sides
  if (args.left && args.right) {
    return { left: args.left, right: args.right };
  }

  // Default: compare index vs worktree (git diff with no args)
  return {
    left: { type: 'index' },
    right: { type: 'worktree' },
  };
}

// ============================================================================
// Snapshot Building: Create a unified view of files from any source
// ============================================================================

async function buildSnapshot(
  fs: FSAdapter,
  dir: string,
  gitdir: string,
  side: DiffSide,
): Promise<Snapshot> {
  const entries = new Map<string, SnapshotEntry>();

  switch (side.type) {
    case 'worktree':
      await buildWorktreeSnapshot(fs, dir, gitdir, entries);
      break;
    case 'index':
      await buildIndexSnapshot(fs, gitdir, entries);
      break;
    case 'commit':
    case 'tree': {
      let treeOid: string | null = null;

      if (side.treeOid) {
        // Try to resolve the treeOid (it might be a commit OID)
        treeOid = await resolveTreeOid(fs, gitdir, side.treeOid);
      }

      if (!treeOid && side.ref) {
        treeOid = await resolveTreeOid(fs, gitdir, side.ref);
      }

      if (treeOid) {
        await buildTreeSnapshot(fs, gitdir, treeOid, entries);
      }
      break;
    }
  }

  return { type: side.type, ref: side.ref, entries };
}

async function buildWorktreeSnapshot(
  fs: FSAdapter,
  dir: string,
  gitdir: string,
  entries: Map<string, SnapshotEntry>,
): Promise<void> {
  // Get tracked files from index to know what to compare
  const index = await readIndex(fs, gitdir);
  const trackedPaths = new Set(
    index.entries.map((e) => normalizeRepoRelativePath(e.path)),
  );

  // Walk the directory to find all files
  const files = await walkDir(fs, dir, { gitdir });

  for (const filepath of files) {
    const np = normalizeRepoRelativePath(filepath);
    if (!trackedPaths.has(np)) {
      continue;
    }

    const fullPath = joinPaths(dir, np);
    const content = await fs.readFile(fullPath);
    const stats = await fs.stat(fullPath);
    const mode = normalizeFileMode(stats.mode);
    const oid = await computeOid('blob', content);
    const isBinary = detectBinary(content);

    entries.set(np, {
      path: np,
      oid,
      mode,
      exists: true,
      content,
      isBinary,
    });
  }

  // Include tracked files that no longer exist (deleted)
  for (const indexPath of trackedPaths) {
    const fullPath = joinPaths(dir, indexPath);
    if (!(await fs.exists(fullPath)) && !entries.has(indexPath)) {
      entries.set(indexPath, {
        path: indexPath,
        oid: '',
        mode: '0',
        exists: false,
      });
    }
  }
}

async function buildIndexSnapshot(
  fs: FSAdapter,
  gitdir: string,
  entries: Map<string, SnapshotEntry>,
): Promise<void> {
  const index = await readIndex(fs, gitdir);
  const byPath = groupIndexEntriesByPath(index.entries);

  for (const [, list] of byPath) {
    const entry = pickRepresentativeIndexEntry(list);
    if (!entry) continue;
    // For index entries, we try to read the blob content from the object store
    let content: Uint8Array | undefined;
    let isBinary: boolean | undefined;

    try {
      const obj = await readObject(fs, gitdir, entry.oid);
      if (obj.type === 'blob') {
        content = obj.content;
        isBinary = detectBinary(content);
      }
    } catch {
      // Object may not exist (e.g., uncommitted content), that's ok
      // We still include the entry with its OID for comparison purposes
    }

    const mode = normalizeFileMode(entry.mode);

    const p = normalizeRepoRelativePath(entry.path);
    entries.set(p, {
      path: p,
      oid: entry.oid,
      mode,
      exists: true,
      content,
      isBinary,
    });
  }
}

async function buildTreeSnapshot(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string,
  entries: Map<string, SnapshotEntry>,
  prefix: string = '',
): Promise<void> {
  try {
    const { content } = await readObject(fs, gitdir, treeOid);
    const treeEntries = deserializeTree(content);

    for (const entry of treeEntries) {
      const fullPath = normalizeRepoRelativePath(
        prefix ? `${prefix}/${entry.path}` : entry.path,
      );

      if (entry.mode === '040000' || entry.mode === '40000') {
        // It's a subdirectory tree
        await buildTreeSnapshot(fs, gitdir, entry.oid, entries, fullPath);
      } else {
        // It's a blob
        let content: Uint8Array | undefined;
        let isBinary: boolean | undefined;

        try {
          const obj = await readObject(fs, gitdir, entry.oid);
          if (obj.type === 'blob') {
            content = obj.content;
            isBinary = detectBinary(content);
          }
        } catch {
          // Object not found
        }

        entries.set(fullPath, {
          path: fullPath,
          oid: entry.oid,
          mode: entry.mode,
          exists: true,
          content,
          isBinary,
        });
      }
    }
  } catch {
    // Tree not found, return empty
  }
}

async function resolveTreeOid(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<string | null> {
  if (ref === 'HEAD' || ref === 'head') {
    return resolveHeadTreeOid(fs, gitdir);
  }

  // Try to resolve as a commit OID first
  try {
    const { type, content } = await readObject(fs, gitdir, ref);
    if (type === 'commit') {
      const commit = deserializeCommit(content);
      return commit.tree;
    }
    if (type === 'tree') {
      return ref;
    }
  } catch {
    // Not a valid OID, try as ref
  }

  const oid = await readRef(fs, gitdir, ref);
  if (oid && !oid.startsWith('ref:')) {
    try {
      const { type, content } = await readObject(fs, gitdir, oid);
      if (type === 'commit') {
        const commit = deserializeCommit(content);
        return commit.tree;
      }
    } catch {
      // Not a valid commit
    }
  }

  return null;
}

function deserializeCommit(content: Uint8Array): {
  tree: string;
  parent: string[];
} {
  const str = new TextDecoder().decode(content);
  const lines = str.split('\n');

  let tree = '';
  const parent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5);
    } else if (line.startsWith('parent ')) {
      parent.push(line.slice(7));
    }
  }

  return { tree, parent };
}

function normalizeFileMode(mode: number): string {
  if ((mode & 0o170000) === 0o120000) return '120000';
  if ((mode & 0o170000) === 0o160000) return '160000';
  if ((mode & 0o170000) === 0o040000) return '040000';
  if ((mode & 0o100) !== 0) return '100755';
  return '100644';
}

function detectBinary(content: Uint8Array): boolean {
  // Simple binary detection: check for null bytes in the first 8KB
  const checkLength = Math.min(content.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (content[i] === 0) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Snapshot Comparison: Find changed files
// ============================================================================

function compareSnapshots(
  left: Snapshot,
  right: Snapshot,
  options: CompareOptions,
): FileDelta[] {
  const deltas: FileDelta[] = [];

  // Get all unique paths from both snapshots
  const allPaths = new Set<string>([
    ...left.entries.keys(),
    ...right.entries.keys(),
  ]);

  for (const path of allPaths) {
    // Apply path filter if specified
    if (options.paths && options.paths.length > 0) {
      const normPath = normalizeRepoRelativePath(path);
      const matches = options.paths.some((p) => {
        const np = normalizeRepoRelativePath(p);
        return normPath === np || normPath.startsWith(np + '/');
      });
      if (!matches) continue;
    }

    const leftEntry = left.entries.get(path);
    const rightEntry = right.entries.get(path);

    const delta = compareEntries(path, options, leftEntry, rightEntry);
    if (delta) {
      deltas.push(delta);
    }
  }

  // Sort deltas by path for consistent output
  return deltas.sort((a, b) => a.path.localeCompare(b.path));
}

function compareEntries(
  path: string,
  compareOptions: CompareOptions,
  left?: SnapshotEntry,
  right?: SnapshotEntry,
): FileDelta | null {
  const leftExists = left?.exists ?? false;
  const rightExists = right?.exists ?? false;
  const leftOid = left?.oid ?? '';
  const rightOid = right?.oid ?? '';

  // No change
  if (leftExists && rightExists && leftOid === rightOid) {
    return null;
  }

  // Determine status
  let status: DiffFileStatus;
  if (!leftExists && rightExists) {
    status = 'A'; // Added
  } else if (leftExists && !rightExists) {
    status = 'D'; // Deleted
  } else {
    status = 'M'; // Modified
  }

  // Build delta
  const delta: FileDelta = {
    path,
    status,
    oldMode: left?.mode,
    newMode: right?.mode,
    oldOid: leftOid.slice(0, 7) || undefined,
    newOid: rightOid.slice(0, 7) || undefined,
    isBinary: right?.isBinary ?? left?.isBinary ?? false,
  };

  // For text files, compute diff hunks (including full deletions: old vs empty)
  if (!delta.isBinary && status === 'D' && left?.content) {
    const { hunks, addedLines, deletedLines } = computeUnifiedDiff(
      left.content,
      undefined,
      compareOptions.contextLines,
      compareOptions.lineDiffAlgorithm,
    );
    delta.hunks = hunks;
    delta.addedLines = addedLines;
    delta.deletedLines = deletedLines;
  } else if (!delta.isBinary && status !== 'D') {
    const leftContent = left?.content;
    const rightContent = right?.content;

    if (leftContent || rightContent) {
      const { hunks, addedLines, deletedLines } = computeUnifiedDiff(
        leftContent,
        rightContent,
        compareOptions.contextLines,
        compareOptions.lineDiffAlgorithm,
      );
      delta.hunks = hunks;
      delta.addedLines = addedLines;
      delta.deletedLines = deletedLines;
    }
  }

  // For additions, compute stats from new content
  if (status === 'A' && right?.content && !right.isBinary) {
    const lines = splitLines(right.content);
    delta.addedLines = lines.length;
    delta.deletedLines = 0;
  }

  return delta;
}

// ============================================================================
// Line diff: tokenize blobs, run pluggable algorithm, group into hunks
// ============================================================================

function splitLines(content: Uint8Array | undefined): string[] {
  if (!content || content.length === 0) {
    return [];
  }
  const text = new TextDecoder().decode(content);
  return text.split('\n');
}

interface DiffStats {
  hunks: Hunk[];
  addedLines: number;
  deletedLines: number;
}

function computeUnifiedDiff(
  oldContent: Uint8Array | undefined,
  newContent: Uint8Array | undefined,
  contextLines: number,
  lineDiff: LineDiffAlgorithm,
): DiffStats {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  // Handle empty cases
  if (oldLines.length === 0 && newLines.length === 0) {
    return { hunks: [], addedLines: 0, deletedLines: 0 };
  }
  if (oldLines.length === 0) {
    return {
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: newLines.length,
          lines: newLines.map((content) => ({ type: '+', content })),
        },
      ],
      addedLines: newLines.length,
      deletedLines: 0,
    };
  }
  if (newLines.length === 0) {
    return {
      hunks: [
        {
          oldStart: 1,
          oldLines: oldLines.length,
          newStart: 0,
          newLines: 0,
          lines: oldLines.map((content) => ({ type: '-', content })),
        },
      ],
      addedLines: 0,
      deletedLines: oldLines.length,
    };
  }

  const edits = lineDiff(oldLines, newLines);

  const hunks = groupIntoHunks(edits, oldLines, newLines, contextLines);

  let addedLines = 0;
  let deletedLines = 0;
  for (const edit of edits) {
    if (edit.type === '+') addedLines++;
    if (edit.type === '-') deletedLines++;
  }

  return { hunks, addedLines, deletedLines };
}

function groupIntoHunks(
  edits: LineDiffEdit[],
  oldLines: string[],
  newLines: string[],
  contextLines: number,
): Hunk[] {
  if (edits.length === 0) {
    return [];
  }

  const hunks: Hunk[] = [];

  // Find regions with changes
  const changeIndices: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== ' ') {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    return [];
  }

  // Group changes into hunks
  let hunkStart = 0;
  let hunkEnd = 0;

  for (let i = 0; i < changeIndices.length; i++) {
    const changeIdx = changeIndices[i];

    if (hunkEnd === 0) {
      // First change - start new hunk
      hunkStart = Math.max(0, changeIdx - contextLines);
      hunkEnd = Math.min(edits.length - 1, changeIdx + contextLines);
    } else if (changeIdx <= hunkEnd + contextLines * 2) {
      // Close enough to extend current hunk
      hunkEnd = Math.min(edits.length - 1, changeIdx + contextLines);
    } else {
      // Far enough to start a new hunk - finalize current
      const hunk = createHunk(edits, hunkStart, hunkEnd, oldLines, newLines);
      hunks.push(hunk);

      // Start new hunk
      hunkStart = Math.max(0, changeIdx - contextLines);
      hunkEnd = Math.min(edits.length - 1, changeIdx + contextLines);
    }
  }

  // Don't forget the last hunk
  if (hunkEnd > 0 || changeIndices.length > 0) {
    const hunk = createHunk(edits, hunkStart, hunkEnd, oldLines, newLines);
    hunks.push(hunk);
  }

  return hunks;
}

function createHunk(
  edits: LineDiffEdit[],
  start: number,
  end: number,
  oldLines: string[],
  newLines: string[],
): Hunk {
  const lines: DiffLine[] = [];
  let oldCount = 0;
  let newCount = 0;
  let oldStart = -1;
  let newStart = -1;

  // Find context line for header
  let contextLine = '';

  for (let i = start; i <= end; i++) {
    const edit = edits[i];
    const line: DiffLine = {
      type: edit.type,
      content: edit.content,
    };
    lines.push(line);

    if (edit.type === ' ' || edit.type === '-') {
      if (oldStart === -1) {
        oldStart = edit.oldIndex + 1; // 1-based
      }
      oldCount++;
    }
    if (edit.type === ' ' || edit.type === '+') {
      if (newStart === -1) {
        newStart = edit.newIndex + 1; // 1-based
      }
      newCount++;
    }

    // Capture first context line for the header
    if (!contextLine && edit.type === ' ') {
      contextLine = edit.content.slice(0, 40);
    }
  }

  // Handle edge cases
  if (oldStart === -1) oldStart = oldLines.length > 0 ? oldLines.length : 0;
  if (newStart === -1) newStart = newLines.length > 0 ? newLines.length : 0;

  // Adjust for empty files
  if (oldCount === 0) oldStart = 0;
  if (newCount === 0) newStart = 0;

  return {
    oldStart: oldStart === 0 && oldCount === 0 ? 0 : oldStart,
    oldLines: oldCount,
    newStart: newStart === 0 && newCount === 0 ? 0 : newStart,
    newLines: newCount,
    context: contextLine,
    lines,
  };
}

// ============================================================================
// Formatters: Convert diff result to Git output formats
// ============================================================================

/**
 * Format diff result as unified patch (default git diff output)
 */
export function formatPatch(
  result: DiffResult,
  _options: { contextLines?: number } = {},
): string {
  // contextLines is reserved for future use when computing hunks with custom context
  const lines: string[] = [];

  for (const delta of result.deltas) {
    // File header
    lines.push(`diff --git a/${delta.path} b/${delta.path}`);

    // Mode change or new/deleted file indicators
    if (delta.status === 'A') {
      lines.push(`new file mode ${delta.newMode || '100644'}`);
      lines.push(`index 0000000..${delta.newOid}`);
    } else if (delta.status === 'D') {
      lines.push(`deleted file mode ${delta.oldMode || '100644'}`);
      lines.push(`index ${delta.oldOid}..0000000`);
    } else {
      // Modified
      if (delta.oldMode !== delta.newMode && delta.oldMode && delta.newMode) {
        lines.push(`old mode ${delta.oldMode}`);
        lines.push(`new mode ${delta.newMode}`);
      }
      lines.push(
        `index ${delta.oldOid || '0000000'}..${delta.newOid || '0000000'} ${delta.newMode || '100644'}`,
      );
    }

    // Diff chunk headers
    lines.push(delta.status === 'A' ? '--- /dev/null' : `--- a/${delta.path}`);
    lines.push(delta.status === 'D' ? '+++ /dev/null' : `+++ b/${delta.path}`);

    if (delta.isBinary) {
      lines.push('Binary files differ');
      lines.push('');
      continue;
    }

    if (!delta.hunks || delta.hunks.length === 0) {
      // Mode change only - show empty diff
      if (delta.status === 'M' && delta.oldMode !== delta.newMode) {
        // Mode-only change - no content diff needed
        lines.push('');
        continue;
      }
    }

    // Hunks
    if (delta.hunks) {
      for (const hunk of delta.hunks) {
        const oldRange =
          hunk.oldLines === 0 && hunk.oldStart === 0
            ? '0,0'
            : `${hunk.oldStart},${hunk.oldLines}`;
        const newRange =
          hunk.newLines === 0 && hunk.newStart === 0
            ? '0,0'
            : `${hunk.newStart},${hunk.newLines}`;
        const context = hunk.context ? ' ' + hunk.context : '';
        lines.push(`@@ -${oldRange} +${newRange} @@${context}`);

        for (const line of hunk.lines) {
          lines.push(`${line.type}${line.content}`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format diff result as --name-only output
 */
export function formatNameOnly(result: DiffResult): string {
  return result.deltas.map((d) => d.path).join('\n');
}

/**
 * Format diff result as --name-status output
 */
export function formatNameStatus(result: DiffResult): string {
  return result.deltas
    .map((d) => {
      if (d.status === 'R' || d.status === 'C') {
        return `${d.status}${d.similarity || 0}\t${d.oldPath}\t${d.path}`;
      }
      return `${d.status}\t${d.path}`;
    })
    .join('\n');
}

/**
 * Format diff result as --stat output
 */
export function formatStat(result: DiffResult): string {
  if (result.deltas.length === 0) {
    return '';
  }

  const lines: string[] = [];
  let maxPathLength = 0;
  let maxChangeLength = 0;

  // Calculate column widths
  for (const delta of result.deltas) {
    maxPathLength = Math.max(maxPathLength, delta.path.length);
    const changes = (delta.addedLines || 0) + (delta.deletedLines || 0);
    maxChangeLength = Math.max(maxChangeLength, String(changes).length);
  }

  // Build stat lines
  for (const delta of result.deltas) {
    const added = delta.addedLines || 0;
    const deleted = delta.deletedLines || 0;
    const total = added + deleted;

    const pathPadded = delta.path.padEnd(maxPathLength + 2);
    const changesStr = String(total).padStart(maxChangeLength);

    // Simple bar graph
    const barLength = Math.min(50, Math.max(1, total));
    const plusBar =
      added > 0 ? '+'.repeat(Math.max(1, (added / total) * barLength)) : '';
    const minusBar =
      deleted > 0 ? '-'.repeat(Math.max(1, (deleted / total) * barLength)) : '';
    const bar = (plusBar + minusBar).slice(0, barLength) || ' ';

    lines.push(` ${pathPadded}| ${changesStr} ${bar}`);
  }

  // Summary line
  const files = result.changed;
  const insertions = result.insertions;
  const deletions = result.deletions;

  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'} changed`);
  if (insertions > 0)
    parts.push(`${insertions} insertion${insertions === 1 ? '' : 's'}(+)`);
  if (deletions > 0)
    parts.push(`${deletions} deletion${deletions === 1 ? '' : 's'}(-)`);

  lines.push('');
  lines.push(parts.join(', '));

  return lines.join('\n');
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
 * Resolve commit refs to tree OIDs for diff comparison
 */
export async function resolveCommitRef(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<{ type: 'commit' | 'tree'; oid: string; treeOid: string } | null> {
  // Try as direct commit/tree OID
  try {
    const { type, content } = await readObject(fs, gitdir, ref);
    if (type === 'commit') {
      const commit = deserializeCommit(content);
      return { type: 'commit', oid: ref, treeOid: commit.tree };
    }
    if (type === 'tree') {
      return { type: 'tree', oid: ref, treeOid: ref };
    }
  } catch {
    // Not a valid OID, continue
  }

  const oidFromRef = await readRef(fs, gitdir, ref);
  if (oidFromRef && !oidFromRef.startsWith('ref:')) {
    try {
      const { type, content } = await readObject(fs, gitdir, oidFromRef);
      if (type === 'commit') {
        const commit = deserializeCommit(content);
        return { type: 'commit', oid: oidFromRef, treeOid: commit.tree };
      }
      if (type === 'tree') {
        return { type: 'tree', oid: oidFromRef, treeOid: oidFromRef };
      }
    } catch {
      // Not a valid commit/tree
    }
  }

  if (ref === 'HEAD' || ref === 'head') {
    const commitOid = await resolveHeadCommitOid(fs, gitdir);
    if (!commitOid) {
      return null;
    }
    const { content } = await readObject(fs, gitdir, commitOid);
    const commit = deserializeCommit(content);
    return { type: 'commit', oid: commitOid, treeOid: commit.tree };
  }

  return null;
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

  // Separate refs from paths (paths after --)
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

  // Parse ref specifications
  if (refs.length === 0) {
    return null;
  }

  if (refs.length === 1) {
    const spec = refs[0];

    // Handle "A..B" syntax (equivalent to "git diff A B")
    const doubleDotMatch = spec.match(/^(.+)\.\.(.+)$/);
    if (doubleDotMatch) {
      const leftRef = doubleDotMatch[1];
      const rightRef = doubleDotMatch[2];

      const left = await resolveCommitRef(fs, gitdir, leftRef);
      const right = await resolveCommitRef(fs, gitdir, rightRef);

      if (!left || !right) {
        throw new Error(`Invalid commit range: ${spec}`);
      }

      return {
        left: { type: 'commit', ref: left.oid, treeOid: left.treeOid },
        right: { type: 'commit', ref: right.oid, treeOid: right.treeOid },
        paths,
      };
    }

    // Handle "A...B" syntax (diff from merge-base of A and B to B)
    const tripleDotMatch = spec.match(/^(.+)\.\.\.(.+)$/);
    if (tripleDotMatch) {
      // For now, treat as A..B (merge-base resolution is complex)
      // TODO: Implement proper merge-base resolution
      const leftRef = tripleDotMatch[1];
      const rightRef = tripleDotMatch[2];

      const left = await resolveCommitRef(fs, gitdir, leftRef);
      const right = await resolveCommitRef(fs, gitdir, rightRef);

      if (!left || !right) {
        throw new Error(`Invalid commit range: ${spec}`);
      }

      return {
        left: { type: 'commit', ref: left.oid, treeOid: left.treeOid },
        right: { type: 'commit', ref: right.oid, treeOid: right.treeOid },
        paths,
      };
    }

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
    // Two refs: compare first to second
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
