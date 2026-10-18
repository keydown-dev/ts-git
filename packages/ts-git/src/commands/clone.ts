import { FSAdapter } from '../fs/types.js';
import { parseGitDir } from '../utils/path.js';
import { readConfig, writeConfig, setConfigValue } from '../core/config.js';
import {
  resolveRefOid,
  setHead,
  setHeadDetached,
  writeRef,
} from '../core/refs.js';
import { AlreadyExistsError, TsGitError } from '../errors.js';
import { init } from './init.js';
import { addRemote } from './remote.js';
import { fetch, type FetchResult, type RemoteOptions } from './fetch.js';
import { checkoutTree } from './checkout-helpers.js';
import { peelToNonTag } from '../core/commit-graph.js';

export interface CloneArgs extends RemoteOptions {
  fs: FSAdapter;
  /** Directory to clone into; must not exist or be empty. */
  dir: string;
  gitdir?: string;
  url: string;
  /** Name for the remote (default "origin"). */
  remote?: string;
  /** Branch or tag to check out instead of the remote's HEAD. */
  ref?: string;
  /** Only fetch the branch being checked out. */
  singleBranch?: boolean;
  /** Skip checking out files (like --no-checkout). */
  noCheckout?: boolean;
  tags?: 'auto' | boolean;
}

export interface CloneResult {
  fetch: FetchResult;
  /** Checked-out branch, or null for a detached tag checkout / empty repo. */
  branch: string | null;
  /** Commit checked out, or null when the remote is empty. */
  head: string | null;
}

/** `git clone <url> <dir>`. */
export async function clone(args: CloneArgs): Promise<CloneResult> {
  const { fs, dir } = args;
  const remote = args.remote ?? 'origin';

  if (await fs.exists(dir)) {
    const entries = await fs.readdir(dir);
    if (entries.length > 0) {
      throw new AlreadyExistsError(
        `destination path '${dir}' already exists and is not an empty directory.`,
        dir,
      );
    }
  }

  // A provisional default branch; HEAD is repointed once we know the remote's.
  await init({ fs, dir, gitdir: args.gitdir, defaultBranch: 'main' });
  const { gitdir } = parseGitDir(dir, args.gitdir);

  let wantBranch =
    args.ref && !args.ref.startsWith('refs/tags/') ? args.ref : null;
  const fetchSpec =
    args.singleBranch && wantBranch
      ? [`+refs/heads/${wantBranch}:refs/remotes/${remote}/${wantBranch}`]
      : undefined;
  await addRemote({
    fs,
    dir,
    gitdir: args.gitdir,
    name: remote,
    url: args.url,
    fetch: fetchSpec,
  });

  const result = await fetch({
    ...args,
    gitdir: args.gitdir,
    remote,
    tags: args.tags,
  });

  const remoteHeadBranch = result.remoteHead?.startsWith('refs/heads/')
    ? result.remoteHead.slice('refs/heads/'.length)
    : null;

  // --single-branch without --branch: narrow to the remote's HEAD branch.
  if (args.singleBranch && !wantBranch && remoteHeadBranch) {
    const config = await readConfig(fs, gitdir);
    setConfigValue(
      config,
      'remote',
      'fetch',
      `+refs/heads/${remoteHeadBranch}:refs/remotes/${remote}/${remoteHeadBranch}`,
      remote,
    );
    await writeConfig(fs, gitdir, config);
  }

  // Tag checkout → detached HEAD.
  if (args.ref && !wantBranch) {
    const tagRef = await resolveRefOid(fs, gitdir, args.ref);
    const tagOid = tagRef ? (await peelToNonTag(fs, gitdir, tagRef)).oid : null;
    if (!tagOid)
      throw new TsGitError(
        `Remote branch ${args.ref} not found in upstream ${remote}`,
      );
    if (!args.noCheckout)
      await checkoutTree({ fs, dir, gitdir, from: null, to: tagOid });
    await setHeadDetached(fs, gitdir, tagOid);
    return { fetch: result, branch: null, head: tagOid };
  }

  wantBranch ??= remoteHeadBranch;
  if (!wantBranch) {
    // Empty repository (or remote HEAD detached / unknown).
    return { fetch: result, branch: null, head: null };
  }

  const oid = await resolveRefOid(
    fs,
    gitdir,
    `refs/remotes/${remote}/${wantBranch}`,
  );
  if (!oid) {
    // Tags given as plain names (e.g. "v1.0").
    const tagRef = await resolveRefOid(fs, gitdir, `refs/tags/${wantBranch}`);
    const tagOid = tagRef ? (await peelToNonTag(fs, gitdir, tagRef)).oid : null;
    if (tagOid && args.ref) {
      if (!args.noCheckout)
        await checkoutTree({ fs, dir, gitdir, from: null, to: tagOid });
      await setHeadDetached(fs, gitdir, tagOid);
      return { fetch: result, branch: null, head: tagOid };
    }
    throw new TsGitError(
      `Remote branch ${wantBranch} not found in upstream ${remote}`,
    );
  }

  if (remoteHeadBranch) {
    await writeRef(
      fs,
      gitdir,
      `refs/remotes/${remote}/HEAD`,
      `ref: refs/remotes/${remote}/${remoteHeadBranch}\n`,
      true,
    );
  }
  await writeRef(fs, gitdir, `refs/heads/${wantBranch}`, oid, true);
  const config = await readConfig(fs, gitdir);
  setConfigValue(config, 'branch', 'remote', remote, wantBranch);
  setConfigValue(
    config,
    'branch',
    'merge',
    `refs/heads/${wantBranch}`,
    wantBranch,
  );
  await writeConfig(fs, gitdir, config);
  await setHead(fs, gitdir, `refs/heads/${wantBranch}`);
  if (!args.noCheckout) {
    await checkoutTree({ fs, dir, gitdir, from: null, to: oid });
  }
  return { fetch: result, branch: wantBranch, head: oid };
}
