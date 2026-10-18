import type { FSAdapter } from '../fs/types.js';
import { parseIgnoreFile, IgnorePattern, createMatcher } from './gitignore.js';
import { normalizeRepoRelativePath } from './path.js';

export type WalkOptions = {
  ignoreFiles?: string[];
  ignorePatterns?: IgnorePattern[];
  /**
   * Git directory. When given (and inside `dir`) it is skipped, and its
   * `info/exclude` file is honoured like git does.
   */
  gitdir?: string;
  /** Also report symbolic links (git tracks them as mode 120000). */
  includeSymlinks?: boolean;
};

/** Read `<gitdir>/info/exclude` patterns (repo-root relative), if any. */
export async function readInfoExclude(
  fs: FSAdapter,
  gitdir: string,
): Promise<IgnorePattern[]> {
  const excludePath = `${gitdir}/info/exclude`;
  try {
    if (await fs.exists(excludePath)) {
      return parseIgnoreFile(await fs.readFileString(excludePath), '');
    }
  } catch {
    // Unreadable exclude file: ignore it, as git does.
  }
  return [];
}

/**
 * Build an `isIgnored(path, isDirectory)` predicate for repo-relative paths,
 * honouring `<gitdir>/info/exclude` and every `.gitignore` from the root down
 * to the path's directory, with git's precedence rules (deeper files win, last
 * match wins, nothing below an excluded directory can be re-included).
 */
export async function createIgnoreChecker(
  fs: FSAdapter,
  dir: string,
  gitdir?: string,
): Promise<(filepath: string, isDirectory: boolean) => Promise<boolean>> {
  const base = gitdir ? await readInfoExclude(fs, gitdir) : [];
  const perDir = new Map<string, IgnorePattern[]>();

  async function patternsFor(relDir: string): Promise<IgnorePattern[]> {
    const cached = perDir.get(relDir);
    if (cached) return cached;
    const file =
      relDir === '' ? `${dir}/.gitignore` : `${dir}/${relDir}/.gitignore`;
    let patterns: IgnorePattern[] = [];
    try {
      if (await fs.exists(file)) {
        patterns = parseIgnoreFile(await fs.readFileString(file), relDir);
      }
    } catch {
      patterns = [];
    }
    perDir.set(relDir, patterns);
    return patterns;
  }

  return async (filepath: string, isDirectory: boolean): Promise<boolean> => {
    const p = normalizeRepoRelativePath(filepath);
    if (p === '' || p === '.') return false;
    const parts = p.split('/');
    if (parts.includes('.git')) return true;
    const patterns: IgnorePattern[] = [...base];
    let relDir = '';
    patterns.push(...(await patternsFor('')));
    for (let i = 0; i < parts.length - 1; i++) {
      relDir = relDir === '' ? parts[i] : `${relDir}/${parts[i]}`;
      patterns.push(...(await patternsFor(relDir)));
    }
    return createMatcher(patterns)(p, isDirectory);
  };
}

export async function walkDir(
  fs: FSAdapter,
  dir: string,
  options?: WalkOptions,
): Promise<string[]> {
  const ignoreFiles = options?.ignoreFiles ?? ['.gitignore'];
  const basePatterns = options?.ignorePatterns ?? [];
  const providedGitdir = options?.gitdir;

  const results: string[] = [];
  const patterns: IgnorePattern[] = [];
  if (providedGitdir) {
    patterns.push(...(await readInfoExclude(fs, providedGitdir)));
  }
  patterns.push(...basePatterns);

  // Always ignore the default .git directory at any level
  patterns.push({
    pattern: '.git',
    regex: /^(?:.*\/)?\.git$/,
    negative: false,
    directoryOnly: true,
    anchoredToRoot: false,
    relativeTo: '',
  });

  // If a custom gitdir is provided and it's within the walk directory, ignore it too
  if (providedGitdir && providedGitdir.startsWith(dir + '/')) {
    const relativeGitdir = providedGitdir.slice(dir.length + 1);
    // Escape special regex characters in the path
    const escapedPath = relativeGitdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push({
      pattern: relativeGitdir,
      regex: new RegExp('^' + escapedPath + '$'),
      negative: false,
      directoryOnly: true,
      anchoredToRoot: true,
      relativeTo: '',
    });
  }

  await walkRecursive(
    fs,
    dir,
    '',
    patterns,
    ignoreFiles,
    results,
    options?.includeSymlinks ?? false,
  );

  return results;
}

async function walkRecursive(
  fs: FSAdapter,
  baseDir: string,
  relativeDir: string,
  patterns: IgnorePattern[],
  ignoreFiles: string[],
  results: string[],
  includeSymlinks: boolean,
): Promise<void> {
  const currentDir = relativeDir === '' ? baseDir : `${baseDir}/${relativeDir}`;
  // Patterns from this directory's ignore files only apply to this subtree.
  patterns = [...patterns];

  // Check for ignore files in this directory
  for (const ignoreFile of ignoreFiles) {
    const ignoreFilePath = `${currentDir}/${ignoreFile}`;
    try {
      if (await fs.exists(ignoreFilePath)) {
        const content = await fs.readFileString(ignoreFilePath);
        const newPatterns = parseIgnoreFile(content, relativeDir);
        patterns.push(...newPatterns);
      }
    } catch {
      // Ignore file doesn't exist or can't be read
    }
  }

  // Create matcher with current patterns
  // Ignored directories are pruned below, so parents never need re-checking.
  const matcher = createMatcher(patterns, { checkParents: false });

  // Read directory contents
  let entries;
  try {
    entries = await fs.readdir(currentDir);
  } catch {
    // Directory doesn't exist or can't be read
    return;
  }

  for (const entry of entries) {
    const entryRelativePath =
      relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;

    // Check if this entry should be ignored
    if (matcher(entryRelativePath, entry.isDirectory)) {
      continue;
    }

    if (entry.isDirectory) {
      // Recurse into subdirectory
      await walkRecursive(
        fs,
        baseDir,
        entryRelativePath,
        patterns,
        ignoreFiles,
        results,
        includeSymlinks,
      );
    } else if (entry.isFile || (includeSymlinks && entry.isSymbolicLink)) {
      results.push(normalizeRepoRelativePath(entryRelativePath));
    }
  }
}
