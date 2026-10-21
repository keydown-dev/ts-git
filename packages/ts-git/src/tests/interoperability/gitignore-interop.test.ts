import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createIgnoreChecker, walkDir } from '../../utils/walk.js';
import {
  assertGitAvailable,
  cleanupTempDirs,
  gitInitRepo,
  gitOk,
  writeFiles,
  type Repo,
} from './porcelain-helpers.js';

beforeAll(assertGitAvailable);
afterEach(cleanupTempDirs);

/** Paths git considers ignored, via `git check-ignore --stdin`. */
async function gitIgnored(repo: Repo, paths: string[]): Promise<string[]> {
  const out = await gitOk(repo.dir, ['check-ignore', '--stdin', '--no-index'], {
    input: paths.join('\n') + '\n',
  }).catch(() => '');
  return out.split('\n').filter(Boolean).sort();
}

async function tsIgnored(repo: Repo, paths: string[]): Promise<string[]> {
  const isIgnored = await createIgnoreChecker(repo.fs, repo.dir, repo.gitdir);
  const out: string[] = [];
  for (const p of paths) {
    let isDir = false;
    try {
      isDir = (await fsp.stat(path.join(repo.dir, p))).isDirectory();
    } catch {
      isDir = false;
    }
    if (await isIgnored(p, isDir)) out.push(p);
  }
  return out.sort();
}

const FILES = [
  'a.log',
  'deep/dir/b.log',
  'keep.log',
  'deep/keep.log',
  'build/out.js',
  'build',
  'src/build/x.js',
  'src/build',
  'root.txt',
  'sub/root.txt',
  'doc/x.pdf',
  'doc/server/arch.pdf',
  'foo/bar/baz.c',
  'foo/x.c',
  'abc/x/y/z',
  'abc/x',
  'a/b',
  'a/x/b',
  'a/x/y/b',
  'case.TXT',
  'case.txt',
  'file.o',
  'file.a',
  'file.b',
  'q1.c',
  'q12.c',
  'trailing space ',
  'hash#name',
  '#hashstart',
  '!bang',
  'star*lit',
  'nested/.gitignore',
  'nested/n.tmp',
  'nested/keep.tmp',
  'nested/deeper/n.tmp',
  'vendor/lib/keep.js',
  'vendor/lib/other.js',
  'only-dir',
  'only-dir-file',
  'x/only-dir/inner',
  'node_modules/pkg/index.js',
  'sub/node_modules/pkg/index.js',
  'logs/today/app.log',
  'logs/keep/app.log',
  'CRLF.txt',
  'ws-lead',
  ' ws-lead',
];

const GITIGNORE = [
  '# comment line',
  '*.log',
  '!keep.log',
  'build/',
  '/root.txt',
  'doc/*.pdf',
  'foo/**/*.c',
  'abc/**',
  'a/**/b',
  '*.[oa]',
  'q?.c',
  'case.txt',
  'trailing\\ ',
  'hash#name',
  '\\#hashstart',
  '\\!bang',
  'star\\*lit',
  'vendor/',
  '!vendor/lib/keep.js',
  'only-dir/',
  '**/node_modules/',
  'logs/*/',
  '!logs/keep/',
  'CRLF.txt\r',
  ' ws-lead',
  'trailing-spaces-stripped   ',
].join('\n');

describe('gitignore matching agrees with git check-ignore', () => {
  it('matches a broad set of patterns', async () => {
    const repo = await gitInitRepo();
    const files: Record<string, string> = {};
    for (const f of FILES) {
      if (['build', 'src/build', 'abc/x', 'only-dir'].includes(f)) continue; // dirs
      files[f] = 'x\n';
    }
    files['.gitignore'] = GITIGNORE + '\n';
    files['nested/.gitignore'] = '*.tmp\n!keep.tmp\n/deeper/\n';
    await writeFiles(repo.dir, files);
    await fsp.mkdir(path.join(repo.dir, 'only-dir'), { recursive: true });
    await fsp.writeFile(path.join(repo.dir, 'only-dir', 'f'), 'x');
    const paths = [...FILES, 'only-dir/f', 'trailing-spaces-stripped'];

    const expected = await gitIgnored(repo, paths);
    expect(expected.length).toBeGreaterThan(20); // sanity: git ran
    expect(await tsIgnored(repo, paths)).toEqual(expected);
  });

  it('walkDir yields the same untracked set as git ls-files --others --exclude-standard', async () => {
    const repo = await gitInitRepo();
    const files: Record<string, string> = {};
    for (const f of FILES) {
      if (['build', 'src/build', 'abc/x'].includes(f)) continue;
      files[f] = 'x\n';
    }
    files['.gitignore'] = GITIGNORE + '\n';
    files['nested/.gitignore'] = '*.tmp\n!keep.tmp\n/deeper/\n';
    await writeFiles(repo.dir, files);
    await fsp.appendFile(path.join(repo.gitdir, 'info', 'exclude'), 'file.b\n');

    const ours = (
      await walkDir(repo.fs, repo.dir, { gitdir: repo.gitdir })
    ).sort();
    const theirs = (
      await gitOk(repo.dir, [
        '-c',
        'core.quotepath=false',
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
      ])
    )
      .split('\0')
      .filter(Boolean)
      .sort();
    expect(ours).toEqual(theirs);
  });

  it('is case sensitive like git (core.ignorecase=false)', async () => {
    const repo = await gitInitRepo();
    await writeFiles(repo.dir, {
      '.gitignore': 'Makefile.local\n',
      'makefile.local': 'x',
      'Makefile.local': 'x',
    });
    const paths = ['makefile.local', 'Makefile.local'];
    expect(await tsIgnored(repo, paths)).toEqual(await gitIgnored(repo, paths));
  });
});
