import { FSAdapter } from '../fs/types.js';
import { parseGitDir } from '../utils/path.js';
import {
  readConfig,
  writeConfig,
  getConfigValue,
  getConfigValues,
  setConfigValue,
  setConfigValues,
  removeConfigSection,
  type GitConfig,
} from '../core/config.js';
import { listRefs, deleteRef, isValidRefName } from '../core/refs.js';
import {
  AlreadyExistsError,
  InvalidRefError,
  NotAGitRepoError,
  RemoteNotFoundError,
} from '../errors.js';
import { defaultFetchRefspec, parseRefspec } from '../remote/refspec.js';

export interface RemoteInfo {
  name: string;
  url: string;
  pushUrl?: string;
  fetch: string[];
}

interface RepoArgs {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
}

export async function requireGitdir(args: RepoArgs): Promise<string> {
  const { gitdir } = parseGitDir(args.dir, args.gitdir);
  if (!(await args.fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      args.dir,
    );
  }
  return gitdir;
}

export function readRemoteFromConfig(
  config: GitConfig,
  name: string,
): RemoteInfo | null {
  const url = getConfigValue(config, 'remote', 'url', name);
  if (url === undefined) return null;
  const fetch = getConfigValues(config, 'remote', 'fetch', name);
  const pushUrl = getConfigValue(config, 'remote', 'pushurl', name);
  return { name, url, fetch, ...(pushUrl ? { pushUrl } : {}) };
}

/** `git remote -v`: all configured remotes. */
export async function listRemotes(args: RepoArgs): Promise<RemoteInfo[]> {
  const gitdir = await requireGitdir(args);
  const config = await readConfig(args.fs, gitdir);
  const remotes: RemoteInfo[] = [];
  for (const section of config.sections) {
    if (section.name !== 'remote' || !section.subsection) continue;
    const info = readRemoteFromConfig(config, section.subsection);
    if (info && !remotes.some((r) => r.name === info.name)) remotes.push(info);
  }
  return remotes;
}

export async function getRemote(
  args: RepoArgs & { name: string },
): Promise<RemoteInfo> {
  const gitdir = await requireGitdir(args);
  const info = readRemoteFromConfig(
    await readConfig(args.fs, gitdir),
    args.name,
  );
  if (!info) throw new RemoteNotFoundError(args.name);
  return info;
}

function validateRemoteName(name: string): void {
  if (
    !name ||
    name.includes('/') ||
    !isValidRefName(`refs/remotes/${name}/x`)
  ) {
    throw new InvalidRefError(`'${name}' is not a valid remote name`, name);
  }
}

/** `git remote add <name> <url>`. */
export async function addRemote(
  args: RepoArgs & {
    name: string;
    url: string;
    /** Fetch refspecs; defaults to +refs/heads/*:refs/remotes/<name>/* */
    fetch?: string[];
    force?: boolean;
  },
): Promise<RemoteInfo> {
  const gitdir = await requireGitdir(args);
  validateRemoteName(args.name);
  const config = await readConfig(args.fs, gitdir);
  if (readRemoteFromConfig(config, args.name) && !args.force) {
    throw new AlreadyExistsError(`remote ${args.name} already exists.`);
  }
  const fetch = args.fetch ?? [defaultFetchRefspec(args.name)];
  fetch.forEach((spec) => parseRefspec(spec));

  removeConfigSection(config, 'remote', args.name);
  setConfigValue(config, 'remote', 'url', args.url, args.name);
  setConfigValues(config, 'remote', 'fetch', fetch, args.name);
  await writeConfig(args.fs, gitdir, config);
  return { name: args.name, url: args.url, fetch };
}

/** `git remote set-url [--push] <name> <url>`. */
export async function setRemoteUrl(
  args: RepoArgs & { name: string; url: string; push?: boolean },
): Promise<void> {
  const gitdir = await requireGitdir(args);
  const config = await readConfig(args.fs, gitdir);
  if (!readRemoteFromConfig(config, args.name)) {
    throw new RemoteNotFoundError(args.name);
  }
  setConfigValue(
    config,
    'remote',
    args.push ? 'pushurl' : 'url',
    args.url,
    args.name,
  );
  await writeConfig(args.fs, gitdir, config);
}

/**
 * `git remote remove <name>`: drops the remote's config, its
 * remote-tracking refs and any branch upstream settings pointing at it.
 */
export async function removeRemote(
  args: RepoArgs & { name: string },
): Promise<void> {
  const gitdir = await requireGitdir(args);
  const config = await readConfig(args.fs, gitdir);
  if (!readRemoteFromConfig(config, args.name)) {
    throw new RemoteNotFoundError(args.name);
  }
  removeConfigSection(config, 'remote', args.name);
  for (const section of [...config.sections]) {
    if (section.name !== 'branch' || !section.subsection) continue;
    if (section.options.get('remote') === args.name) {
      setConfigValues(config, 'branch', 'remote', [], section.subsection);
      setConfigValues(config, 'branch', 'merge', [], section.subsection);
    }
  }
  await writeConfig(args.fs, gitdir, config);

  const prefix = `refs/remotes/${args.name}/`;
  const refsDir = `${gitdir}/refs/remotes/${args.name}`;
  // deleteRef removes loose and packed entries alike.
  for (const ref of (await listRefs(args.fs, gitdir, prefix)).keys()) {
    await deleteRef(args.fs, gitdir, ref);
  }
  // Symbolic refs (origin/HEAD) don't resolve in listRefs once targets go.
  if (await args.fs.exists(refsDir)) {
    await args.fs.rmdir(refsDir, { recursive: true });
  }
}

export interface UpstreamInfo {
  remote: string;
  /** Full ref name on the remote, e.g. refs/heads/main. */
  merge: string;
}

/** branch.<name>.remote / branch.<name>.merge */
export function readUpstream(
  config: GitConfig,
  branch: string,
): UpstreamInfo | null {
  const remote = getConfigValue(config, 'branch', 'remote', branch);
  const merge = getConfigValue(config, 'branch', 'merge', branch);
  if (!remote || !merge) return null;
  return { remote, merge };
}

/** `git branch --set-upstream-to`: record a branch's upstream. */
export async function setUpstream(
  args: RepoArgs & { branch: string; remote: string; merge: string },
): Promise<void> {
  const gitdir = await requireGitdir(args);
  const config = await readConfig(args.fs, gitdir);
  const merge = args.merge.startsWith('refs/')
    ? args.merge
    : `refs/heads/${args.merge}`;
  setConfigValue(config, 'branch', 'remote', args.remote, args.branch);
  setConfigValue(config, 'branch', 'merge', merge, args.branch);
  await writeConfig(args.fs, gitdir, config);
}
