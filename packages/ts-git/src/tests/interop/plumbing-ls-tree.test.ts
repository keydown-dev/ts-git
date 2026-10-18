import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { lsTree, formatLsTree } from '../../commands/ls-tree.js';
import { createGitSandbox, type GitSandbox } from './git-env.js';
import { buildPlumbingRepo } from './plumbing-fixture.js';

interface Flags {
  r?: boolean;
  t?: boolean;
  d?: boolean;
  l?: boolean;
  nameOnly?: boolean;
  z?: boolean;
}

const FLAG_SETS: Flags[] = [
  {},
  { r: true },
  { t: true },
  { d: true },
  { r: true, t: true },
  { r: true, d: true },
  { l: true },
  { r: true, l: true },
  { nameOnly: true },
  { r: true, nameOnly: true },
  { z: true },
  { r: true, z: true, nameOnly: true },
];

const PATHSPECS: string[][] = [
  [],
  ['src'],
  ['src/'],
  ['src/lib'],
  ['src/lib/'],
  ['src/lib/util.js'],
  ['src/lib/deep/er/file.txt'],
  ['src/main.js', 'docs'],
  ['sr'], // literal: no prefix match
  ['src/*'], // literal: no globbing in ls-tree
  ['a'],
  ['a/'],
  ['README.md/'], // trailing slash on a file
  ['vendor/sub'],
  ['vendor'],
  ['.'],
  ['nonexistent'],
];

function gitArgs(flags: Flags): string[] {
  const args: string[] = [];
  if (flags.r) args.push('-r');
  if (flags.t) args.push('-t');
  if (flags.d) args.push('-d');
  if (flags.l) args.push('-l');
  if (flags.nameOnly) args.push('--name-only');
  if (flags.z) args.push('-z');
  return args;
}

describe('ls-tree vs git ls-tree', () => {
  let sb: GitSandbox;

  beforeAll(() => {
    sb = createGitSandbox();
    buildPlumbingRepo(sb);
  });
  afterAll(() => sb.cleanup());

  it('matches for every flag combination and pathspec', async () => {
    let compared = 0;
    for (const treeish of ['HEAD', 'v1-outer']) {
      for (const flags of FLAG_SETS) {
        for (const paths of PATHSPECS) {
          const expected = sb.git([
            'ls-tree',
            ...gitArgs(flags),
            treeish,
            ...(paths.length ? ['--', ...paths] : []),
          ]);
          const result = await lsTree({
            fs: sb.fs,
            dir: sb.dir,
            tree: treeish,
            recursive: flags.r,
            showTrees: flags.t,
            treesOnly: flags.d,
            long: flags.l,
            paths,
          });
          const actual = formatLsTree(result, {
            nameOnly: flags.nameOnly,
            long: flags.l,
            zeroTerminated: flags.z,
          });
          expect(
            actual,
            `git ls-tree ${gitArgs(flags).join(' ')} ${treeish} ${paths.join(' ')}`,
          ).toBe(expected);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(300);
  }, 60000);

  it('accepts abbreviated OIDs and subtree OIDs', async () => {
    const sub = sb.git(['rev-parse', 'HEAD:src']).trim();
    for (const name of [sub, sub.slice(0, 8), 'HEAD:src/lib']) {
      const expected = sb.git(['ls-tree', '-r', '-t', name]);
      const actual = formatLsTree(
        await lsTree({
          fs: sb.fs,
          dir: sb.dir,
          tree: name,
          recursive: true,
          showTrees: true,
        }),
      );
      expect(actual).toBe(expected);
    }
  });

  it('rejects non-tree objects like git', async () => {
    const blob = sb.git(['rev-parse', 'HEAD:README.md']).trim();
    expect(sb.gitTry(['ls-tree', blob]).status).not.toBe(0);
    await expect(
      lsTree({ fs: sb.fs, dir: sb.dir, tree: blob }),
    ).rejects.toThrow();
    await expect(
      lsTree({ fs: sb.fs, dir: sb.dir, tree: 'does-not-exist' }),
    ).rejects.toThrow();
  });
});
