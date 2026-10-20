import { FSAdapter } from '../fs/types.js';
import { parseGitDir } from '../utils/path.js';
import {
  resolveHead,
  writeRef,
  deleteRef,
  listBranches,
  getCurrentBranch,
  setHead,
  setHeadDetached,
  readRef,
  isValidBranchName,
} from '../core/refs.js';
import { readObject } from '../core/objects.js';
import { readConfig, writeConfig, getConfigValue } from '../core/config.js';
import {
  NotFoundError,
  AlreadyExistsError,
  InvalidRefError,
  NotAGitRepoError,
} from '../errors.js';
import type {
  BranchArgs,
  BranchListArgs,
  BranchDeleteArgs,
  BranchListResult,
} from '../types.js';
import {
  resolveRevision,
  peelToCommit,
  headCommitOid,
} from './tree-helpers.js';
import { checkoutTree, type CheckoutTreeResult } from './checkout-helpers.js';

function shortBranchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

async function assertRepo(fs: FSAdapter, dir: string, gitdir: string) {
  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }
}

/**
 * Create a branch (`git branch [-f] <name> [<start-point>]`), optionally
 * switching to it (`git checkout -b` / `git switch -c`).
 *
 * `object` may be any revision (commit OID, abbreviated OID, branch, tag,
 * `HEAD~1`, ...); it must resolve to a commit.
 */
export async function branch(args: BranchArgs): Promise<string> {
  const {
    fs,
    dir,
    gitdir: providedGitdir,
    ref: rawRef,
    object,
    checkout = false,
    force = false,
  } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);
  await assertRepo(fs, dir, gitdir);

  const ref = shortBranchName(rawRef);
  if (!isValidBranchName(ref)) {
    throw new InvalidRefError(`'${ref}' is not a valid branch name`, ref);
  }

  let targetOid: string;
  if (object) {
    let resolved: string;
    try {
      resolved = await resolveRevision(fs, gitdir, object);
    } catch {
      throw new InvalidRefError(`not a valid object name: '${object}'`, object);
    }
    targetOid = await peelToCommit(fs, gitdir, resolved).catch(() => {
      throw new InvalidRefError(
        `cannot create branch '${ref}': '${object}' is not a commit`,
        object,
      );
    });
  } else {
    const head = await resolveHead(fs, gitdir);
    const oid = await headCommitOid(fs, gitdir);
    if (!oid) {
      const name =
        head?.type === 'symbolic' ? shortBranchName(head.ref) : 'HEAD';
      throw new InvalidRefError(
        `Cannot create branch: HEAD is not pointing to a commit (not a valid object name: '${name}')`,
      );
    }
    targetOid = oid;
  }

  const branchRef = `refs/heads/${ref}`;
  const existingRef = await readRef(fs, gitdir, branchRef);

  if (existingRef && !force) {
    throw new AlreadyExistsError(
      `a branch named '${ref}' already exists`,
      branchRef,
    );
  }

  if (existingRef && existingRef !== targetOid) {
    const head = await resolveHead(fs, gitdir);
    if (head?.type === 'symbolic' && head.ref === branchRef) {
      throw new InvalidRefError(
        `cannot force update the branch '${ref}' used by the current worktree`,
        branchRef,
      );
    }
  }

  if (checkout) {
    // Like `git checkout -b`: update index/worktree first (refusing to
    // clobber local changes), then create the branch and point HEAD at it.
    const headOid = await headCommitOid(fs, gitdir);
    if (headOid !== targetOid) {
      await checkoutTree({ fs, dir, gitdir, to: targetOid });
    }
  }

  await writeRef(fs, gitdir, branchRef, targetOid, true);

  if (checkout) {
    await setHead(fs, gitdir, branchRef);
  }

  return targetOid;
}

export async function listBranchesCommand(
  args: BranchListArgs,
): Promise<BranchListResult> {
  const { fs, dir, gitdir: providedGitdir } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);
  await assertRepo(fs, dir, gitdir);

  const branches = await listBranches(fs, gitdir);
  const current = await getCurrentBranch(fs, gitdir);

  return {
    branches,
    current,
  };
}

/**
 * Upstream ref of a branch from `branch.<name>.remote` / `.merge`, or null.
 * (Assumes the default `refs/heads/*:refs/remotes/<remote>/*` refspec.)
 */
async function upstreamRef(
  fs: FSAdapter,
  gitdir: string,
  name: string,
): Promise<string | null> {
  try {
    const config = await readConfig(fs, gitdir);
    const remote = getConfigValue(config, 'branch', 'remote', name);
    const merge = getConfigValue(config, 'branch', 'merge', name);
    if (!remote || !merge) return null;
    if (remote === '.') return merge;
    const short = merge.startsWith('refs/heads/')
      ? merge.slice('refs/heads/'.length)
      : merge;
    return `refs/remotes/${remote}/${short}`;
  } catch {
    return null;
  }
}

/**
 * Delete a branch (`git branch -d`, or `-D` with `force`).
 *
 * Without force, like git, the branch must be fully merged into its upstream
 * (if one is configured and exists) or else into HEAD; on an unborn HEAD with
 * no upstream nothing counts as merged.
 */
export async function deleteBranch(args: BranchDeleteArgs): Promise<void> {
  const { fs, dir, gitdir: providedGitdir, ref: rawRef, force = false } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);
  await assertRepo(fs, dir, gitdir);

  const ref = shortBranchName(rawRef);
  if (!isValidBranchName(ref)) {
    throw new InvalidRefError(`'${ref}' is not a valid branch name`, ref);
  }
  const branchRef = `refs/heads/${ref}`;
  const branchOid = await readRef(fs, gitdir, branchRef);

  if (!branchOid) {
    throw new NotFoundError(`branch '${ref}' not found`, branchRef);
  }

  const head = await resolveHead(fs, gitdir);
  if (head?.type === 'symbolic' && head.ref === branchRef) {
    throw new InvalidRefError(
      `Cannot delete branch '${ref}' checked out (it is the current branch)`,
    );
  }

  if (!force) {
    let referenceOid: string | null = null;
    const upstream = await upstreamRef(fs, gitdir, ref);
    if (upstream) {
      const oid = await readRef(fs, gitdir, upstream);
      if (oid && /^[0-9a-f]{40}$/i.test(oid)) referenceOid = oid;
    }
    if (!referenceOid) {
      referenceOid = await headCommitOid(fs, gitdir);
    }

    if (
      !referenceOid ||
      !(await isReachable(fs, gitdir, referenceOid, branchOid))
    ) {
      throw new InvalidRefError(
        `The branch '${ref}' is not fully merged. Use force to delete.`,
      );
    }
  }

  await deleteRef(fs, gitdir, branchRef);
  await removeBranchConfig(fs, gitdir, ref);
}

/** git branch -d also drops the `[branch "<name>"]` config section. */
async function removeBranchConfig(
  fs: FSAdapter,
  gitdir: string,
  name: string,
): Promise<void> {
  try {
    const config = await readConfig(fs, gitdir);
    const before = config.sections.length;
    config.sections = config.sections.filter(
      (s) => !(s.name === 'branch' && s.subsection === name),
    );
    if (config.sections.length !== before) {
      await writeConfig(fs, gitdir, config);
    }
  } catch {
    // Unparseable config: leave it untouched.
  }
}

/**
 * Check if target commit is reachable from source commit via parent traversal.
 */
async function isReachable(
  fs: FSAdapter,
  gitdir: string,
  sourceOid: string,
  targetOid: string,
): Promise<boolean> {
  if (sourceOid === targetOid) {
    return true;
  }

  const visited = new Set<string>();
  const queue: string[] = [sourceOid];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current === targetOid) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    try {
      const { content } = await readObject(fs, gitdir, current);
      for (const parent of parseParents(content)) {
        queue.push(parent);
      }
    } catch {
      // If we can't read the commit, skip it
    }
  }

  return false;
}

function parseParents(content: Uint8Array): string[] {
  const str = new TextDecoder().decode(content);
  const end = str.indexOf('\n\n');
  const header = end === -1 ? str : str.slice(0, end);
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('parent ')) {
      parents.push(line.slice(7).trim());
    }
  }
  return parents;
}

/**
 * Switch to a branch like `git checkout <branch>` / `git switch <branch>`:
 * the index and working tree are updated to the branch's commit (keeping
 * unrelated local modifications, refusing with CheckoutConflictError when
 * local changes or untracked files would be overwritten, unless `force`),
 * then HEAD is pointed at the branch.
 *
 * With `detach: true`, `ref` may be any revision and HEAD is detached at it
 * (`git checkout --detach <rev>`).
 */
export async function checkoutBranch(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  ref: string;
  force?: boolean;
  detach?: boolean;
}): Promise<CheckoutTreeResult> {
  const {
    fs,
    dir,
    gitdir: providedGitdir,
    ref,
    force = false,
    detach = false,
  } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);
  await assertRepo(fs, dir, gitdir);

  let targetOid: string;
  let branchRef: string | null = null;

  if (detach) {
    targetOid = await peelToCommit(
      fs,
      gitdir,
      await resolveRevision(fs, gitdir, ref),
    );
  } else {
    branchRef = `refs/heads/${shortBranchName(ref)}`;
    const oid = await readRef(fs, gitdir, branchRef);
    if (!oid) {
      throw new NotFoundError(
        `Branch '${shortBranchName(ref)}' not found`,
        branchRef,
      );
    }
    targetOid = oid;
  }

  const result = await checkoutTree({ fs, dir, gitdir, to: targetOid, force });

  if (branchRef) {
    await setHead(fs, gitdir, branchRef);
  } else {
    await setHeadDetached(fs, gitdir, targetOid);
  }

  return result;
}
