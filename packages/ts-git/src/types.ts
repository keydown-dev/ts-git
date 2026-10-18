import type { FSAdapter } from './fs/types.js';
import type { LineDiffAlgorithm } from './commands/diff/types.js';

export type { LineDiffEdit, LineDiffAlgorithm } from './commands/diff/types.js';

export {
  type FSAdapter,
  type FSAdapterOptions,
  type DirEntry,
  type FileStats,
} from './fs/types.js';
export { MemoryFS, createMemoryFS } from './fs/memory-adapter.js';

export interface Author {
  name: string;
  email: string;
  timestamp?: number;
  timezoneOffset?: number;
}

export type HeadStatus = 0 | 1;
export type WorkdirStatus = 0 | 1 | 2;
export type StageStatus = 0 | 1 | 2 | 3;

export type StatusRow = [
  filepath: string,
  head: HeadStatus,
  workdir: WorkdirStatus,
  stage: StageStatus,
];

export type StatusName =
  | 'ignored'
  | 'unmodified'
  | '*modified'
  | '*deleted'
  | '*added'
  | 'modified'
  | 'deleted'
  | 'added'
  | 'absent'
  | '*unmodified'
  | '*absent'
  | '*undeleted'
  | '*undeletemodified';

export interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: 'blob' | 'tree' | 'commit' | 'symlink';
}

export type TreeObject = TreeEntry[];

export interface CommitObject {
  message: string;
  tree: string;
  parent: string[];
  author: Author & { timestamp: number; timezoneOffset: number };
  committer: Author & { timestamp: number; timezoneOffset: number };
  gpgsig?: string;
}

export interface TagObject {
  object: string;
  type: 'blob' | 'tree' | 'commit' | 'tag';
  tag: string;
  tagger: Author & { timestamp: number; timezoneOffset: number };
  message: string;
  gpgsig?: string;
}

export interface BlobObject {
  oid: string;
  blob: Uint8Array;
}

export type GitObject = CommitObject | TreeObject | BlobObject | TagObject;

export interface LogEntry {
  oid: string;
  commit: CommitObject;
}

export interface BranchListResult {
  branches: string[];
  current: string | null;
}

export interface InitArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  defaultBranch?: string;
  /** Create a bare repository (gitdir defaults to `dir`, core.bare = true). */
  bare?: boolean;
}

export interface AddArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  filepath: string | string[];
  force?: boolean;
}

export interface StatusArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  filepath: string;
}

export interface StatusMatrixArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  ref?: string;
  filepaths?: string[];
  filter?: (filepath: string) => boolean;
}

export interface CommitArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  message: string;
  author: Author;
  committer?: Author;
  ref?: string;
  parent?: string[];
  dryRun?: boolean;
  noUpdateBranch?: boolean;
  /** Allow a commit with the same tree as its parent (`--allow-empty`). */
  allowEmpty?: boolean;
  /** Allow an empty message (`--allow-empty-message`). */
  allowEmptyMessage?: boolean;
  /** Message cleanup mode (default 'whitespace', like `git commit -m`). */
  cleanup?: 'whitespace' | 'strip' | 'verbatim';
}

export interface LogArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  ref?: string;
  depth?: number;
}

export interface BranchArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  ref: string;
  object?: string;
  checkout?: boolean;
  force?: boolean;
}

export interface BranchListArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
}

export interface BranchDeleteArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  ref: string;
  force?: boolean;
}

export type FileMode = '100644' | '100755' | '120000' | '160000' | '040000';

export const FileModes: Record<string, FileMode> = {
  file: '100644',
  executable: '100755',
  symlink: '120000',
  commit: '160000',
  tree: '040000',
};

export function normalizeFileMode(mode: number): FileMode {
  if ((mode & 0o170000) === 0o120000) return '120000';
  if ((mode & 0o170000) === 0o160000) return '160000';
  if ((mode & 0o170000) === 0o040000) return '040000';
  if ((mode & 0o100) !== 0) return '100755';
  return '100644';
}

export function modeToNumber(mode: FileMode): number {
  switch (mode) {
    case '100644':
      return 0o100644;
    case '100755':
      return 0o100755;
    case '120000':
      return 0o120000;
    case '160000':
      return 0o160000;
    case '040000':
      return 0o040000;
    default:
      return 0o100644;
  }
}

export function normalizeTimestamp(timestamp: number | undefined): number {
  return timestamp ?? Math.floor(Date.now() / 1000);
}

export function normalizeTimezoneOffset(offset: number | undefined): number {
  return offset ?? new Date().getTimezoneOffset();
}

// ============================================================================
// Diff Types
// ============================================================================

/**
 * Diff output format modes matching git diff options
 */
export type DiffOutputMode = 'patch' | 'name-only' | 'name-status' | 'stat';

/**
 * Diff comparison source types
 */
export type DiffSourceType = 'worktree' | 'index' | 'commit' | 'tree';

/**
 * A side of a diff comparison (left = "old", right = "new")
 */
export interface DiffSide {
  type: DiffSourceType;
  /** For commits/trees: the OID or ref name */
  ref?: string;
  /** For trees: the tree OID */
  treeOid?: string;
}

/**
 * Parsed diff command arguments
 */
export interface DiffArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** Comparison left side (defaults to index for worktree diffs) */
  left?: DiffSide;
  /** Comparison right side (defaults to worktree or index) */
  right?: DiffSide;
  /** Files/paths to limit the diff to */
  paths?: string[];
  /** Output format mode */
  outputMode?: DiffOutputMode;
  /** True for --cached / --staged mode */
  cached?: boolean;
  /** Context lines for unified diff (default 3) */
  contextLines?: number;
  /** Line-level diff implementation (required). Install @keydown-app/ts-git-diff-myers for a default implementation. */
  lineDiffAlgorithm: LineDiffAlgorithm;
}

/**
 * File change status codes matching git diff --name-status
 */
export type DiffFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

/**
 * A single file delta in a diff
 */
export interface FileDelta {
  /** File path (relative to repo root) */
  path: string;
  /** Old path for renames/copies */
  oldPath?: string;
  /** Change status */
  status: DiffFileStatus;
  /** Similarity score for renames/copies (0-100) */
  similarity?: number;
  /** Old file mode (e.g., '100644') */
  oldMode?: string;
  /** New file mode */
  newMode?: string;
  /** Old blob OID (short form) */
  oldOid?: string;
  /** New blob OID (short form) */
  newOid?: string;
  /** Whether the file is binary */
  isBinary?: boolean;
  /** For text files: the diff hunks */
  hunks?: Hunk[];
  /** Total added lines (for stat output) */
  addedLines?: number;
  /** Total deleted lines (for stat output) */
  deletedLines?: number;
}

/**
 * A hunk in a unified diff
 */
export interface Hunk {
  /** Old file starting line */
  oldStart: number;
  /** Old file line count */
  oldLines: number;
  /** New file starting line */
  newStart: number;
  /** New file line count */
  newLines: number;
  /** Context line shown in the hunk header */
  context?: string;
  /** The diff lines in this hunk */
  lines: DiffLine[];
}

/**
 * A single line in a diff hunk
 */
export interface DiffLine {
  /** Line type: ' ' context, '+' added, '-' removed */
  type: ' ' | '+' | '-';
  /** Line content (without the type prefix) */
  content: string;
}

/**
 * Complete diff result for a comparison
 */
export interface DiffResult {
  /** The compared sides */
  left: DiffSide;
  right: DiffSide;
  /** All file deltas (only changed files) */
  deltas: FileDelta[];
  /** Total files changed */
  changed: number;
  /** Total insertions across all files */
  insertions: number;
  /** Total deletions across all files */
  deletions: number;
}

// ============================================================================
// Word Diff Types (for prose/word-level diffing)
// ============================================================================

/**
 * Word-level diff edit types
 */
export type WordDiffType =
  | 'word-add'
  | 'word-del'
  | 'word-unchanged'
  | 'sentence-move';

/**
 * A single word-level edit
 */
export interface WordDiffEdit {
  type: WordDiffType;
  content: string;
  /** For moves: source location info */
  sourceLocation?: {
    file?: string;
    line?: number;
    index?: number;
  };
  /** For moves: destination location info */
  destLocation?: {
    file?: string;
    line?: number;
    index?: number;
  };
}

/**
 * Cross-file sentence move detection
 */
export interface CrossFileMove {
  sentence: string;
  sourceFile: string;
  sourceLine: number;
  destFile: string;
  destLine: number;
}

/**
 * Word-level diff result for a single file
 */
export interface WordDiffResult {
  path: string;
  edits: WordDiffEdit[];
  moves?: CrossFileMove[];
}

/**
 * Project-wide word diff result
 */
export interface ProjectWordDiffResult {
  files: WordDiffResult[];
  crossFileMoves: CrossFileMove[];
}

/**
 * Word-level diff algorithm interface
 */
export type WordDiffAlgorithm = (
  oldContent: string,
  newContent: string,
  options?: {
    detectCrossFileMoves?: boolean;
    allFiles?: Map<string, string>; // For cross-file analysis
  },
) => WordDiffEdit[] | Promise<WordDiffEdit[]>;
