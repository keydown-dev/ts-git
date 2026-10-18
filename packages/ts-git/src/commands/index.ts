export { init } from './init.js';
export {
  add,
  addAll,
  remove,
  IgnoredPathsError,
  type AddResult,
} from './add.js';
export { status, statusMatrix, classifyStatusRow } from './status.js';
export { commit, cleanupMessage, type CommitCleanupMode } from './commit.js';
export { log, readCommit } from './log.js';
export {
  branch,
  listBranchesCommand,
  deleteBranch,
  checkoutBranch,
} from './branch.js';
export { reset, type ResetMode, type ResetResult } from './reset.js';
export {
  checkoutTree,
  type CheckoutTreeArgs,
  type CheckoutTreeResult,
} from './checkout-helpers.js';
export {
  resolveRevision,
  flattenTree,
  writeTreeFromIndex,
  type FlatTreeEntry,
} from './tree-helpers.js';
export {
  diff,
  formatDiff,
  formatPatch,
  formatNameOnly,
  formatNameStatus,
  formatStat,
  resolveDiffSpecs,
} from './diff/index.js';
// Plumbing commands
export { catFile, type ReadObjectResult } from './cat-file.js';
export {
  hashObject,
  hashObjectString,
  type HashObjectResult,
} from './hash-object.js';
export { updateIndex, type UpdateIndexResult } from './update-index.js';
export { lsTree, type LsTreeResult } from './ls-tree.js';
