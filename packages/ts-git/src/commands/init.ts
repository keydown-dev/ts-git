import {
  joinPaths,
  parseGitDir,
  isAbsolute,
  normalizeDir,
} from '../utils/path.js';
import {
  createDefaultConfig,
  writeConfig,
  setDefaultBranch,
  getConfigSection,
} from '../core/config.js';
import { setHead, isValidBranchName } from '../core/refs.js';
import { serializeIndex } from '../core/index.js';
import { InvalidGitDirError, InvalidRefError } from '../errors.js';
import type { FSAdapter } from '../fs/types.js';
import type { InitArgs } from '../types.js';

const INFO_EXCLUDE_TEMPLATE = `# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
# For a project mostly in C, the following would be a good set of
# exclude patterns (uncomment them if you want to use them):
# *.[oa]
# *~
`;

/**
 * `git init`. Creates the repository layout git expects (HEAD, config,
 * description, objects/{info,pack}, refs/{heads,tags}, hooks, info/exclude)
 * plus an empty index. Running it on an existing repository is safe, like
 * git's "Reinitialized existing Git repository": existing HEAD, config,
 * index and description are left untouched.
 *
 * With `bare: true` the repository is created directly in `dir` (unless
 * `gitdir` is given) with `core.bare = true` and no index.
 */
export async function init(args: InitArgs): Promise<void> {
  const {
    fs,
    dir,
    gitdir: providedGitdir,
    defaultBranch = 'master',
    bare = false,
  } = args;

  // Validate that gitdir is absolute if provided
  if (providedGitdir && !isAbsolute(providedGitdir)) {
    throw new InvalidGitDirError('gitdir must be an absolute path');
  }

  if (!isValidBranchName(defaultBranch)) {
    throw new InvalidRefError(
      `invalid initial branch name: '${defaultBranch}'`,
      defaultBranch,
    );
  }

  const gitdir =
    bare && !providedGitdir
      ? normalizeDir(dir)
      : parseGitDir(dir, providedGitdir).gitdir;

  const reinit = await fs.exists(joinPaths(gitdir, 'HEAD'));

  const dirs = [
    joinPaths(gitdir, 'objects', 'info'),
    joinPaths(gitdir, 'objects', 'pack'),
    joinPaths(gitdir, 'refs', 'heads'),
    joinPaths(gitdir, 'refs', 'tags'),
    joinPaths(gitdir, 'hooks'),
    joinPaths(gitdir, 'info'),
  ];

  for (const dirPath of dirs) {
    await fs.mkdir(dirPath, { recursive: true });
  }

  const excludePath = joinPaths(gitdir, 'info', 'exclude');
  if (!(await fs.exists(excludePath))) {
    await fs.writeFile(excludePath, INFO_EXCLUDE_TEMPLATE);
  }

  if (reinit) {
    return;
  }

  const config = createDefaultConfig();
  const core = getConfigSection(config, 'core');
  if (core) {
    core.options.set('bare', bare ? 'true' : 'false');
    if (bare) {
      core.options.delete('logallrefupdates');
    }
  }
  setDefaultBranch(config, defaultBranch);
  await writeConfig(fs, gitdir, config);

  // Like git, probe whether the filesystem keeps the executable bit and
  // record it as core.filemode.
  if (core) {
    core.options.set(
      'filemode',
      (await probeFilemode(fs, joinPaths(gitdir, 'config'))) ? 'true' : 'false',
    );
    await writeConfig(fs, gitdir, config);
  }

  await fs.writeFile(
    joinPaths(gitdir, 'description'),
    "Unnamed repository; edit this file 'description' to name the repository.\n",
  );

  await setHead(fs, gitdir, `refs/heads/${defaultBranch}`);

  if (!bare) {
    const emptyIndex = await serializeIndex({ version: 2, entries: [] });
    await fs.writeFile(joinPaths(gitdir, 'index'), emptyIndex);
  }
}

async function probeFilemode(fs: FSAdapter, path: string): Promise<boolean> {
  if (!fs.chmod) return false;
  try {
    const before = (await fs.lstat(path)).mode;
    await fs.chmod(path, (before ^ 0o100) & 0o7777);
    const after = (await fs.lstat(path)).mode;
    await fs.chmod(path, before & 0o7777);
    return (before & 0o100) !== (after & 0o100);
  } catch {
    return false;
  }
}
