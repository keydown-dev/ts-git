import { FSAdapter } from '../fs/types.js';
import { joinPaths, parseGitDir } from '../utils/path.js';
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
import {
  fetch,
  transportOptions,
  type FetchResult,
  type RemoteOptions,
} from './fetch.js';
import { createTransport } from '../remote/transport.js';
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

/** `git clone <url> <dir>`. A failed clone removes what it created. */
export async function clone(args: CloneArgs): Promise<CloneResult> {
  const { fs, dir } = args;

  const dirExisted = await fs.exists(dir);
  if (dirExisted) {
    const entries = await fs.readdir(dir);
    if (entries.length > 0) {
      throw new AlreadyExistsError(
        `destination path '${dir}' already exists and is not an empty directory.`,
        dir,
      );
    }
  }

  try {
    return await cloneInto(args);
  } catch (error) {
    // Like git, don't leave a half-initialised repository behind.
    if (dirExisted) {
      for (const entry of await fs.readdir(dir)) {
        const path = joinPaths(dir, entry.name);
        if (entry.isDirectory) await fs.rmdir(path, { recursive: true });
        else await fs.unlink(path);
      }
    } else if (await fs.exists(dir)) {
      await fs.rmdir(dir, { recursive: true });
    }
    if (args.gitdir && (await fs.exists(args.gitdir))) {
      await fs.rmdir(args.gitdir, { recursive: true });
    }
    throw error;
  }
}

async function cloneInto(args: CloneArgs): Promise<CloneResult> {
  const { fs, dir } = args;
  const remote = args.remote ?? 'origin';
  const transport =
    args.transport ?? createTransport(args.url, transportOptions(fs, args));

  // Look at the remote first so --single-branch / --branch can be set up
  // before anything is downloaded.
  const adv = await transport.listRefs('git-upload-pack');
  const advertised = new Set(adv.refs.map((r) => r.name));
  const remoteHead = adv.symrefs.get('HEAD') ?? null;
  const remoteHeadBranch = remoteHead?.startsWith('refs/heads/')
    ? remoteHead.slice('refs/heads/'.length)
    : null;

  let target: string | null = null; // full ref to check out
  if (args.ref) {
    const candidates = args.ref.startsWith('refs/')
      ? [args.ref]
      : [`refs/heads/${args.ref}`, `refs/tags/${args.ref}`];
    target = candidates.find((c) => advertised.has(c)) ?? null;
    if (!target) {
      throw new TsGitError(
        `Remote branch ${args.ref} not found in upstream ${remote}`,
      );
    }
  } else if (remoteHeadBranch && advertised.has(remoteHead!)) {
    target = remoteHead;
  }
  const targetBranch = target?.startsWith('refs/heads/')
    ? target.slice('refs/heads/'.length)
    : null;

  let fetchSpec: string[] | undefined;
  if (args.singleBranch && target) {
    fetchSpec = targetBranch
      ? [`+refs/heads/${targetBranch}:refs/remotes/${remote}/${targetBranch}`]
      : [`+${target}:${target}`];
  }

  // A provisional default branch; HEAD is repointed below.
  await init({
    fs,
    dir,
    gitdir: args.gitdir,
    defaultBranch: targetBranch ?? remoteHeadBranch ?? 'main',
  });
  const { gitdir } = parseGitDir(dir, args.gitdir);
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
    transport,
    tags: args.tags,
  });

  if (!target) {
    // Empty repository (or remote HEAD detached / unknown).
    return { fetch: result, branch: null, head: null };
  }

  // Tag checkout -> detached HEAD at the tagged commit.
  if (!targetBranch) {
    const tagRef = await resolveRefOid(fs, gitdir, target);
    const tagOid = tagRef ? (await peelToNonTag(fs, gitdir, tagRef)).oid : null;
    if (!tagOid) {
      throw new TsGitError(
        `Remote branch ${args.ref} not found in upstream ${remote}`,
      );
    }
    if (!args.noCheckout) {
      await checkoutTree({ fs, dir, gitdir, from: null, to: tagOid });
    }
    await setHeadDetached(fs, gitdir, tagOid);
    return { fetch: result, branch: null, head: tagOid };
  }

  const oid = await resolveRefOid(
    fs,
    gitdir,
    `refs/remotes/${remote}/${targetBranch}`,
  );
  if (!oid) {
    throw new TsGitError(
      `Remote branch ${targetBranch} not found in upstream ${remote}`,
    );
  }

  // origin/HEAD only when the branch it names was fetched.
  if (
    remoteHeadBranch &&
    (await resolveRefOid(
      fs,
      gitdir,
      `refs/remotes/${remote}/${remoteHeadBranch}`,
    ))
  ) {
    await writeRef(
      fs,
      gitdir,
      `refs/remotes/${remote}/HEAD`,
      `ref: refs/remotes/${remote}/${remoteHeadBranch}\n`,
      true,
    );
  }
  await writeRef(fs, gitdir, `refs/heads/${targetBranch}`, oid, true);
  const config = await readConfig(fs, gitdir);
  setConfigValue(config, 'branch', 'remote', remote, targetBranch);
  setConfigValue(
    config,
    'branch',
    'merge',
    `refs/heads/${targetBranch}`,
    targetBranch,
  );
  await writeConfig(fs, gitdir, config);
  await setHead(fs, gitdir, `refs/heads/${targetBranch}`);
  if (!args.noCheckout) {
    await checkoutTree({ fs, dir, gitdir, from: null, to: oid });
  }
  return { fetch: result, branch: targetBranch, head: oid };
}
