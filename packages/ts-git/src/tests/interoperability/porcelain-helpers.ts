/**
 * Hermetic helpers for porcelain interop tests: canonical git runs with an
 * isolated HOME, no system config, fixed identities and dates, so object IDs
 * produced by git and ts-git can be compared byte for byte.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { NodeFSAdapter } from '../../fs/node-adapter.js';
import type { Author } from '../../types.js';

const execFileAsync = promisify(execFile);

export const AUTHOR: Required<Author> = {
  name: 'Test Author',
  email: 'test@example.com',
  timestamp: 1700000000,
  timezoneOffset: -120, // +0200
};

/** git-style date string for an Author (`<seconds> +HHMM`). */
export function gitDate(a: Required<Author>): string {
  const off = -a.timezoneOffset;
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${a.timestamp} ${sign}${hh}${mm}`;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const tempDirs: string[] = [];

export async function makeTempDir(
  prefix = 'ts-git-porcelain-',
): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

export async function cleanupTempDirs(): Promise<void> {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    await fsp.rm(d, { recursive: true, force: true });
  }
}

let homeDir: string | null = null;

async function hermeticEnv(
  author: Required<Author> = AUTHOR,
): Promise<NodeJS.ProcessEnv> {
  if (!homeDir) {
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ts-git-home-'));
  }
  return {
    PATH: process.env.PATH,
    HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(homeDir, 'nonexistent-gitconfig'),
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: gitDate(author),
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: gitDate(author),
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
}

/** Run git; never throws (inspect `code`). */
export async function git(
  cwd: string,
  args: string[],
  options: { author?: Required<Author>; input?: string } = {},
): Promise<GitResult> {
  const env = await hermeticEnv(options.author);
  const fullArgs = [
    '-c',
    'init.defaultBranch=master',
    '-c',
    'core.quotepath=false',
    '-c',
    'advice.detachedHead=false',
    ...args,
  ];
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      fullArgs,
      { cwd, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** Run git and return trimmed stdout; throws on a non-zero exit. */
export async function gitOk(
  cwd: string,
  args: string[],
  options: { author?: Required<Author>; input?: string } = {},
): Promise<string> {
  const r = await git(cwd, args, options);
  if (r.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${r.code}):\n${r.stderr}${r.stdout}`,
    );
  }
  return r.stdout.replace(/\n$/, '');
}

export type FileSpec =
  | string
  | { content: string; mode?: number }
  | { symlink: string };

/** Write files into a working tree (creating directories as needed). */
export async function writeFiles(
  dir: string,
  files: Record<string, FileSpec>,
): Promise<void> {
  for (const [rel, spec] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.rm(full, { force: true, recursive: true });
    if (typeof spec === 'string') {
      await fsp.writeFile(full, spec);
    } else if ('symlink' in spec) {
      await fsp.symlink(spec.symlink, full);
    } else {
      await fsp.writeFile(full, spec.content);
      if (spec.mode !== undefined) await fsp.chmod(full, spec.mode);
    }
  }
}

export async function readText(dir: string, rel: string): Promise<string> {
  return fsp.readFile(path.join(dir, rel), 'utf8');
}

export async function pathExists(dir: string, rel: string): Promise<boolean> {
  try {
    await fsp.lstat(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

export interface Repo {
  dir: string;
  gitdir: string;
  fs: NodeFSAdapter;
}

/** A fresh empty directory with a NodeFSAdapter (no repository yet). */
export async function emptyRepoDir(): Promise<Repo> {
  const dir = await makeTempDir();
  return { dir, gitdir: path.join(dir, '.git'), fs: new NodeFSAdapter(dir) };
}

/** A repository initialised by canonical git. */
export async function gitInitRepo(): Promise<Repo> {
  const repo = await emptyRepoDir();
  await gitOk(repo.dir, ['init', '-q']);
  return repo;
}

/**
 * Snapshot of the working tree (excluding .git): path -> content, with
 * "[x]" / "[link]" markers for executables and symlinks.
 */
export async function snapshotWorktree(
  dir: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(rel: string) {
    const entries = await fsp.readdir(path.join(dir, rel), {
      withFileTypes: true,
    });
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (p === '.git') continue;
      const full = path.join(dir, p);
      if (e.isSymbolicLink()) {
        out[p] = `[link] ${await fsp.readlink(full)}`;
      } else if (e.isDirectory()) {
        await walk(p);
      } else {
        const st = await fsp.stat(full);
        const exec = (st.mode & 0o111) !== 0 ? '[x] ' : '';
        out[p] = exec + (await fsp.readFile(full, 'utf8'));
      }
    }
  }
  await walk('');
  return out;
}

/** Ensure git is available; interop tests require it. */
export async function assertGitAvailable(): Promise<void> {
  await execFileAsync('git', ['--version']);
}
