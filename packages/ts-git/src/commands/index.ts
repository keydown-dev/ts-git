export { init } from './init.js';
export { add, addAll, remove } from './add.js';
export { status, statusMatrix, classifyStatusRow } from './status.js';
export { commit } from './commit.js';
export { log, readCommit } from './log.js';
export {
  branch,
  listBranchesCommand,
  deleteBranch,
  checkoutBranch,
} from './branch.js';
export { reset } from './reset.js';
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
export {
  catFile,
  catFileRaw,
  type CatFileArgs,
  type ReadObjectResult,
} from './cat-file.js';
export {
  hashObject,
  hashObjectString,
  validateObject,
  type HashObjectArgs,
  type HashObjectResult,
} from './hash-object.js';
export {
  updateIndex,
  type UpdateIndexArgs,
  type UpdateIndexResult,
  type CacheInfo,
} from './update-index.js';
export {
  lsTree,
  formatLsTree,
  quoteGitPath,
  type LsTreeArgs,
  type LsTreeResult,
} from './ls-tree.js';
export {
  resolveRevision,
  resolveRefName,
  expandOid,
  peelTo,
} from './resolve-revision.js';
