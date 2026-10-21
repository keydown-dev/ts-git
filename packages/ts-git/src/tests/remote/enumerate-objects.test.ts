import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { NodeFSAdapter } from '../../fs/node-adapter.js';
import { enumerateObjects } from '../../core/commit-graph.js';
import { createSandbox, type GitSandbox } from './git-helpers.js';

describe('enumerateObjects matches git rev-list --objects', () => {
  let sb: GitSandbox;
  let repo: string;
  const fs = new NodeFSAdapter();
  const rev = (r: string) => sb.git(repo, ['rev-parse', r]).trim();

  beforeAll(() => {
    sb = createSandbox();
    repo = join(sb.root, 'repo');
    sb.git(sb.root, ['init', '-q', '-b', 'main', repo]);
    let t = 1700000000;
    const commit = (file: string, content: string, msg: string, date = t++) => {
      mkdirSync(join(repo, file, '..'), { recursive: true });
      writeFileSync(join(repo, file), content);
      sb.git(repo, ['add', '-A']);
      sb.git(repo, [
        '-c',
        `user.name=T`,
        '-c',
        'user.email=t@e',
        'commit',
        '-q',
        '-m',
        msg,
        `--date=${date} +0000`,
      ]);
    };
    for (let i = 0; i < 30; i++)
      commit(`dir${i % 3}/f${i % 5}.txt`, `v${i}\n`, `c${i}`);
    sb.git(repo, ['branch', 'side', 'HEAD~10']);
    sb.git(repo, ['checkout', '-q', 'side']);
    for (let i = 0; i < 5; i++) commit(`side/s${i}.txt`, `s${i}\n`, `s${i}`);
    // Clock skew: a commit dated far in the past on top of side.
    commit('side/old.txt', 'old\n', 'skewed', 1600000000);
    sb.git(repo, ['checkout', '-q', 'main']);
    sb.git(repo, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@e',
      'merge',
      '-q',
      '--no-edit',
      'side',
    ]);
    commit('after.txt', 'after\n', 'after merge');
    sb.git(repo, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@e',
      'tag',
      '-a',
      'v1',
      '-m',
      'v1',
      'side',
    ]);
  });
  afterAll(() => sb.cleanup());

  const cases: Array<[string, string[], string[]]> = [
    ['one new commit', ['main'], ['main~1']],
    ['merge with skewed side', ['main'], ['main~3']],
    ['side only', ['side'], ['main~12']],
    ['nothing new', ['main~5'], ['main']],
    ['full history', ['main'], []],
    ['annotated tag', ['v1'], ['main~15']],
    ['have unrelated to want', ['side'], ['main']],
  ];

  for (const [name, wants, haves] of cases) {
    it(name, async () => {
      const w = wants.map((x) => (x === 'v1' ? rev('v1') : rev(x)));
      const h = haves.map(rev);
      const expected = sb
        .git(repo, [
          'rev-list',
          '--objects',
          ...w,
          ...(h.length ? ['--not', ...h] : []),
        ])
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(0, 40));
      const got = await enumerateObjects(fs, join(repo, '.git'), w, h);
      expect(new Set(got.map((o) => o.oid))).toEqual(new Set(expected));
    });
  }
});
