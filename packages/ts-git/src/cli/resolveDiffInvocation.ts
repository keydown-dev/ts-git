import type { FSAdapter } from '../fs/types.js';
import type { DiffSide } from '../types.js';
import { parseGitDir } from '../utils/path.js';
import { resolveHeadCommitOid, resolveHeadTreeOid } from '../core/refs.js';
import { resolveCommitRef, resolveRangeSpec } from '../commands/diff/index.js';

export interface ResolvedDiffInvocation {
  left: DiffSide;
  right: DiffSide;
  paths: string[];
  /** True when argv included `--cached` / `--staged` (passed separately because handleDiff strips them from diffArgs). */
  cached: boolean;
}

/**
 * Map `git diff`-style argv (after output flags and `--cached`/`--staged` are stripped from args)
 * to typed diff sides. Pass `cliCached` when the user requested `--cached` or `--staged`.
 */
export async function resolveDiffInvocation(
  fs: FSAdapter,
  dir: string,
  gitdir: string | undefined,
  args: string[],
  cliCached: boolean,
): Promise<ResolvedDiffInvocation> {
  const { gitdir: resolvedGitdir } = parseGitDir(dir, gitdir);

  const refs: string[] = [];
  const paths: string[] = [];
  let foundSeparator = false;

  for (const arg of args) {
    if (arg === '--') {
      foundSeparator = true;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    if (foundSeparator) {
      paths.push(arg);
    } else {
      refs.push(arg);
    }
  }

  if (refs.length === 0) {
    if (cliCached) {
      const commitOid = await resolveHeadCommitOid(fs, resolvedGitdir);
      const treeOid = await resolveHeadTreeOid(fs, resolvedGitdir);
      return {
        left: {
          type: 'commit',
          ref: commitOid ?? undefined,
          treeOid: treeOid ?? undefined,
        },
        right: { type: 'index' },
        paths,
        cached: true,
      };
    }
    return {
      left: { type: 'index' },
      right: { type: 'worktree' },
      paths,
      cached: false,
    };
  }

  if (refs.length === 1) {
    const spec = refs[0];

    const range = await resolveRangeSpec(fs, resolvedGitdir, spec);
    if (range) {
      return { ...range, paths, cached: false };
    }

    const resolved = await resolveCommitRef(fs, resolvedGitdir, spec);
    if (resolved) {
      return {
        left: {
          type: 'commit',
          ref: resolved.oid,
          treeOid: resolved.treeOid,
        },
        // git diff --cached <commit>: commit vs index
        right: cliCached ? { type: 'index' } : { type: 'worktree' },
        paths,
        cached: cliCached,
      };
    }

    // Single token is not a revision: treat as pathspec (git diff <path>)
    if (cliCached) {
      const commitOid = await resolveHeadCommitOid(fs, resolvedGitdir);
      const treeOid = await resolveHeadTreeOid(fs, resolvedGitdir);
      return {
        left: {
          type: 'commit',
          ref: commitOid ?? undefined,
          treeOid: treeOid ?? undefined,
        },
        right: { type: 'index' },
        paths: [...paths, spec],
        cached: true,
      };
    }
    return {
      left: { type: 'index' },
      right: { type: 'worktree' },
      paths: [...paths, spec],
      cached: false,
    };
  }

  if (refs.length === 2) {
    const leftResolved = await resolveCommitRef(fs, resolvedGitdir, refs[0]);
    const rightResolved = await resolveCommitRef(fs, resolvedGitdir, refs[1]);

    if (!leftResolved || !rightResolved) {
      throw new Error(`Invalid refs: ${refs.join(', ')}`);
    }

    return {
      left: {
        type: 'commit',
        ref: leftResolved.oid,
        treeOid: leftResolved.treeOid,
      },
      right: {
        type: 'commit',
        ref: rightResolved.oid,
        treeOid: rightResolved.treeOid,
      },
      paths,
      cached: false,
    };
  }

  throw new Error(`Too many refs specified: ${refs.join(' ')}`);
}
