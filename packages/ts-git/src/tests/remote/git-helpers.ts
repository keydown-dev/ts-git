import { execFile, execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Hermetic environment for invoking canonical git from tests. */
export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: 'Test Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.com',
    GIT_AUTHOR_DATE: '1700000000 +0000',
    GIT_COMMITTER_DATE: '1700000000 +0000',
  };
}

export interface GitSandbox {
  root: string;
  git(cwd: string, args: string[], input?: Uint8Array | string): string;
  gitBuffer(cwd: string, args: string[], input?: Uint8Array | string): Buffer;
  /** Async variant: required when git talks to an in-process test server. */
  gitAsync(cwd: string, args: string[]): Promise<string>;
  cleanup(): void;
}

export function createSandbox(prefix = 'ts-git-remote-'): GitSandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = gitEnv(root);
  const gitBuffer = (
    cwd: string,
    args: string[],
    input?: Uint8Array | string,
  ): Buffer =>
    execFileSync('git', args, {
      cwd,
      env,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  return {
    root,
    gitBuffer,
    git: (cwd, args, input) => gitBuffer(cwd, args, input).toString('utf8'),
    gitAsync: (cwd, args) =>
      new Promise((resolve, reject) => {
        execFile('git', args, { cwd, env }, (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
          else resolve(stdout);
        });
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
