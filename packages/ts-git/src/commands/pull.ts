import { FSAdapter } from '../fs/types.js';
import { readConfig, getConfigValue } from '../core/config.js';
import { getCurrentBranch, isHeadDetached } from '../core/refs.js';
import { TsGitError } from '../errors.js';
import type { Author } from '../types.js';
import { fetch, type FetchResult, type RemoteOptions } from './fetch.js';
import { merge, mergeIntoSuffix, type MergeResult } from './merge.js';
import { readUpstream, requireGitdir } from './remote.js';

export interface PullArgs extends RemoteOptions {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** Remote to pull from; defaults to the current branch's upstream remote. */
  remote?: string;
  /** Remote branch to merge; defaults to the current branch's upstream. */
  ref?: string;
  /**
   * 'auto' fast-forwards when possible and merges otherwise, 'only' refuses
   * to create a merge (--ff-only), 'never' always merges (--no-ff).
   * Defaults to the pull.ff config, else 'auto'.
   */
  fastForward?: 'auto' | 'only' | 'never';
  prune?: boolean;
  tags?: 'auto' | boolean;
  author?: Author;
  committer?: Author;
}

export interface PullResult {
  fetch: FetchResult;
  merge: MergeResult;
}

/** URL as git shows it in merge messages (no credentials or ".git"). */
function displayUrl(url: string): string {
  let out = url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')
    .replace(/\/+$/, '');
  if (out.endsWith('.git')) out = out.slice(0, -4);
  return out;
}

/**
 * Fetch from a remote and integrate its branch into the current one
 * (`git pull`, merge mode). Rebase pulls are not supported.
 */
export async function pull(args: PullArgs): Promise<PullResult> {
  const { fs } = args;
  const gitdir = await requireGitdir(args);
  const config = await readConfig(fs, gitdir);
  const branch = (await isHeadDetached(fs, gitdir))
    ? null
    : await getCurrentBranch(fs, gitdir);
  const upstream = branch ? readUpstream(config, branch) : null;

  const remote = args.remote ?? upstream?.remote ?? 'origin';
  let mergeRef: string | null = null;
  if (args.ref) {
    mergeRef = args.ref.startsWith('refs/')
      ? args.ref
      : `refs/heads/${args.ref}`;
  } else if (upstream && upstream.remote === remote) {
    mergeRef = upstream.merge;
  }
  if (!mergeRef) {
    throw new TsGitError(
      'There is no tracking information for the current branch. ' +
        'Pass `ref` (the remote branch to merge) or set an upstream with setUpstream().',
    );
  }

  const fetched = await fetch({
    ...args,
    remote,
    refspecs: args.ref ? [args.ref] : undefined,
  });
  const entry =
    fetched.fetchHead.find((e) => e.remoteRef === mergeRef && !e.notForMerge) ??
    fetched.fetchHead.find((e) => e.remoteRef === mergeRef);
  if (!entry) {
    throw new TsGitError(`couldn't find remote ref ${mergeRef}`);
  }

  const pullFf = getConfigValue(config, 'pull', 'ff');
  const fastForward =
    args.fastForward ??
    (pullFf === 'only' ? 'only' : pullFf === 'false' ? 'never' : 'auto');
  const short = mergeRef.replace(/^refs\/heads\//, '');
  const what = mergeRef.startsWith('refs/heads/')
    ? `branch '${short}'`
    : `'${mergeRef}'`;
  const message =
    `Merge ${what} of ${displayUrl(fetched.url)}` +
    (await mergeIntoSuffix(fs, gitdir, branch));

  const merged = await merge({
    fs,
    dir: args.dir,
    gitdir: args.gitdir,
    theirs: entry.oid,
    theirsLabel: entry.oid,
    fastForward,
    message,
    author: args.author,
    committer: args.committer,
  });
  return { fetch: fetched, merge: merged };
}
