import { diffArrays } from 'diff';
import type { LineDiffAlgorithm, LineDiffEdit } from '@keydown-dev/ts-git';

/**
 * Line-level Myers diff via [jsdiff](https://github.com/kpdecker/jsdiff) (`diff` on npm).
 * Uses `diffArrays` with `oneChangePerToken` so each line is its own token, matching
 * `TextDecoder` + `split('\n')` semantics from blob content.
 *
 * This is the default line diff algorithm for ts-git. Install with:
 *   npm install @keydown-dev/ts-git-diff-myers
 *
 * Usage:
 *   import { myersLineDiff } from '@keydown-dev/ts-git-diff-myers';
 *   import { diff } from '@keydown-dev/ts-git';
 *
 *   const result = await diff({
 *     fs,
 *     dir: '/path/to/repo',
 *     lineDiffAlgorithm: myersLineDiff
 *   });
 */
export const myersLineDiff: LineDiffAlgorithm = (oldLines, newLines) => {
  const parts = diffArrays(oldLines, newLines, { oneChangePerToken: true });
  if (!parts) {
    return [];
  }

  const edits: LineDiffEdit[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  for (const part of parts) {
    const lines = part.value;
    if (part.added) {
      for (const content of lines) {
        edits.push({
          type: '+',
          oldIndex: -1,
          newIndex: newIndex++,
          content,
        });
      }
    } else if (part.removed) {
      for (const content of lines) {
        edits.push({
          type: '-',
          oldIndex: oldIndex++,
          newIndex: -1,
          content,
        });
      }
    } else {
      for (const content of lines) {
        edits.push({
          type: ' ',
          oldIndex: oldIndex++,
          newIndex: newIndex++,
          content,
        });
      }
    }
  }

  return edits;
};

export default myersLineDiff;
