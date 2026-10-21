import type {
  LineDiffAlgorithm,
  ProjectWordDiffResult,
} from '@keydown-dev/ts-git';

/**
 * Word-level diff for prose across files.
 * Detects word additions/removals and sentence moves between files.
 *
 * This package provides both:
 * 1. A line diff algorithm interface (wordsLineDiff) for use with ts-git's diff command
 * 2. A project-wide diff function (diffProject) for analyzing changes across multiple files
 *
 * Install with:
 *   npm install @keydown-dev/ts-git-diff-words
 *
 * Planned features:
 * - Word-level tokenization and diffing
 * - Sentence/paragraph move detection within a file
 * - Cross-file sentence/paragraph move detection
 * - Smart handling of reordered content (not counting as add/delete)
 *
 * @throws Error Not yet implemented
 */

/**
 * Line-level diff algorithm that provides word-level granularity.
 *
 * TODO: Implement word-level tokenization and diffing
 * TODO: Implement sentence/paragraph move detection
 * TODO: Return structured word diff with move information
 */
export const wordsLineDiff: LineDiffAlgorithm = (_oldLines, _newLines) => {
  throw new Error(
    'wordsLineDiff is not yet implemented. ' +
      'This will provide word-level diffing with sentence/paragraph move detection.',
  );
};

/**
 * Options for project-wide word diffing
 */
export interface DiffProjectOptions {
  /** Enable detection of sentences/paragraphs moved between files */
  detectCrossFileMoves?: boolean;
  /** Minimum similarity threshold for considering content as "moved" (0-100) */
  similarityThreshold?: number;
}

/**
 * Perform a project-wide word diff across multiple files.
 *
 * This function analyzes changes across all files in a commit to detect:
 * - Word additions and deletions
 * - Sentences/paragraphs moved within a file
 * - Sentences/paragraphs moved between files
 *
 * When content is detected as "moved" rather than deleted+added, it will be
 * marked appropriately to avoid counting it as both a deletion and an addition.
 *
 * @param _oldFiles Map of file paths to content before changes
 * @param _newFiles Map of file paths to content after changes
 * @param options Configuration options
 * @returns Project-wide diff result with cross-file move information
 *
 * @throws Error Not yet implemented
 */
export async function diffProject(
  _oldFiles: Map<string, string>,
  _newFiles: Map<string, string>,
  options: DiffProjectOptions = {},
): Promise<ProjectWordDiffResult> {
  throw new Error(
    'diffProject is not yet implemented. ' +
      'This will provide project-wide word diffing with cross-file move detection. ' +
      'Options provided: ' +
      JSON.stringify(options),
  );
}

export { wordsLineDiff as default };
