/**
 * Hermetic helpers for running canonical git next to ts-git on the same
 * on-disk repository (via NodeFSAdapter).
 *
 * Every git invocation runs with GIT_CONFIG_NOSYSTEM=1, HOME pointing at a
 * private temp dir and fixed identity/dates, so results never depend on the
 * machine's global configuration.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeFSAdapter } from '../../fs/node-adapter.js';

export interface GitSandbox {
  /** Root temp dir (removed by cleanup). */
  root: string;
  /** Working tree of the repository. */
  dir: string;
  gitdir: string;
  fs: NodeFSAdapter;
  env: NodeJS.ProcessEnv;
  /** Run git and return stdout as a string (throws on non-zero exit). */
  git: (args: string[], opts?: { input?: string | Uint8Array }) => string;
  /** Run git and return stdout as raw bytes. */
  gitBytes: (args: string[], opts?: { input?: string | Uint8Array }) => Buffer;
  /** Run git and return status + stdout + stderr without throwing. */
  gitTry: (
    args: string[],
    opts?: { input?: string | Uint8Array },
  ) => { status: number; stdout: string; stderr: string };
  write: (relPath: string, content: string | Uint8Array) => void;
  read: (relPath: string) => Buffer;
  rm: (relPath: string) => void;
  cleanup: () => void;
}

let dateCounter = 0;

export function createGitSandbox(
  options: { init?: boolean; initArgs?: string[] } = {},
): GitSandbox {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ts-git-interop-')),
  );
  const home = path.join(root, 'home');
  const dir = path.join(root, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(dir);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'A U Thor',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: 'C O Mitter',
    GIT_COMMITTER_EMAIL: 'committer@example.com',
    GIT_AUTHOR_DATE: '1700000000 +0000',
    GIT_COMMITTER_DATE: '1700000000 +0000',
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
  };

  const baseArgs = [
    '-c',
    'user.name=A U Thor',
    '-c',
    'user.email=author@example.com',
    '-c',
    'init.defaultBranch=main',
    '-c',
    'core.autocrlf=false',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'tag.gpgsign=false',
  ];

  const gitBytes = (
    args: string[],
    opts: { input?: string | Uint8Array } = {},
  ): Buffer =>
    execFileSync('git', [...baseArgs, ...args], {
      cwd: dir,
      env,
      input: opts.input,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  const git = (args: string[], opts?: { input?: string | Uint8Array }) =>
    gitBytes(args, opts).toString('utf8');

  const gitTry = (
    args: string[],
    opts: { input?: string | Uint8Array } = {},
  ) => {
    const r = spawnSync('git', [...baseArgs, ...args], {
      cwd: dir,
      env,
      input: opts.input,
      maxBuffer: 256 * 1024 * 1024,
    });
    return {
      status: r.status ?? -1,
      stdout: r.stdout?.toString('utf8') ?? '',
      stderr: r.stderr?.toString('utf8') ?? '',
    };
  };

  const write = (relPath: string, content: string | Uint8Array) => {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const read = (relPath: string) => fs.readFileSync(path.join(dir, relPath));

  const rm = (relPath: string) =>
    fs.rmSync(path.join(dir, relPath), { recursive: true, force: true });

  const sandbox: GitSandbox = {
    root,
    dir,
    gitdir: path.join(dir, '.git'),
    fs: new NodeFSAdapter(dir),
    env,
    git,
    gitBytes,
    gitTry,
    write,
    read,
    rm,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };

  if (options.init !== false) {
    git(['init', '-q', ...(options.initArgs ?? [])]);
  }

  return sandbox;
}

/**
 * Commit everything in the working tree with git, using a distinct,
 * monotonically increasing date so commit order is deterministic.
 */
export function gitCommitAll(sb: GitSandbox, message: string): string {
  dateCounter++;
  sb.git(['add', '-A']);
  return gitCommitAt(sb, message, 1700000000 + dateCounter * 60);
}

/** Commit with an explicit date (both author and committer). */
export function gitCommitAt(
  sb: GitSandbox,
  message: string,
  epochSeconds: number,
  args: string[] = [],
): string {
  const saved = { a: sb.env.GIT_AUTHOR_DATE, c: sb.env.GIT_COMMITTER_DATE };
  sb.env.GIT_AUTHOR_DATE = `${epochSeconds} +0000`;
  sb.env.GIT_COMMITTER_DATE = `${epochSeconds} +0000`;
  try {
    sb.git(['commit', '-q', '--allow-empty', '-m', message, ...args]);
  } finally {
    sb.env.GIT_AUTHOR_DATE = saved.a;
    sb.env.GIT_COMMITTER_DATE = saved.c;
  }
  return sb.git(['rev-parse', 'HEAD']).trim();
}

/** Parse `git cat-file --batch-all-objects --batch-check` output. */
export function listAllObjects(
  sb: GitSandbox,
): { oid: string; type: string; size: number }[] {
  return sb
    .git(['cat-file', '--batch-all-objects', '--batch-check'])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [oid, type, size] = line.split(' ');
      return { oid, type, size: parseInt(size, 10) };
    });
}
