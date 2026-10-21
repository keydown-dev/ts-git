import type { FSAdapter } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';

/** Files git uses to record a merge in progress. */
export const MERGE_STATE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE'];

export async function isMergeInProgress(
  fs: FSAdapter,
  gitdir: string,
): Promise<boolean> {
  return fs.exists(joinPaths(gitdir, 'MERGE_HEAD'));
}

/** Forget a merge in progress (git's remove_branch_state). */
export async function clearMergeState(
  fs: FSAdapter,
  gitdir: string,
): Promise<void> {
  for (const name of MERGE_STATE_FILES) {
    const path = joinPaths(gitdir, name);
    if (await fs.exists(path)) await fs.unlink(path);
  }
}
