import { describe, it, expect, afterEach } from 'vitest';
import {
  parseIgnoreFile,
  createMatcher,
  isPathIgnored,
  type IgnorePattern,
} from '../../utils/gitignore.js';
import { createGitSandbox, type GitSandbox } from './git-env.js';

interface Case {
  ignore: Record<string, string>;
  /** [path, isDirectory] */
  paths: [string, boolean][];
}

const CASES: Case[] = [
  {
    ignore: {
      '.gitignore': [
        '*.log',
        '!keep.log',
        'build/',
        '/root-only.txt',
        'doc/*.txt',
        '**/deep/**',
        'foo/**/bar',
        '\\#hash',
        '\\!bang',
        ' leading-space',
        'trailing   ',
        'escaped\\ ',
        'UPPER',
        '*.[oa]',
        'file?.c',
        '[!x]y.z',
        'cls[[:digit:]].q',
        'a**b',
        'end/**',
        '',
      ].join('\n'),
    },
    paths: [
      ['a.log', false],
      ['keep.log', false],
      ['sub/a.log', false],
      ['sub/keep.log', false],
      ['build', true],
      ['build', false],
      ['sub/build', true],
      ['root-only.txt', false],
      ['sub/root-only.txt', false],
      ['doc/a.txt', false],
      ['doc/sub/a.txt', false],
      ['x/doc/a.txt', false],
      ['a/deep/b', false],
      ['deep/x', false],
      ['foo/bar', false],
      ['foo/a/b/bar', false],
      ['xfoo/bar', false],
      ['#hash', false],
      ['!bang', false],
      [' leading-space', false],
      ['leading-space', false],
      ['trailing', false],
      ['trailing   ', false],
      ['escaped ', false],
      ['escaped', false],
      ['upper', false],
      ['UPPER', false],
      ['x.o', false],
      ['x.a', false],
      ['x.c', false],
      ['file1.c', false],
      ['file12.c', false],
      ['ay.z', false],
      ['xy.z', false],
      ['cls5.q', false],
      ['clsx.q', false],
      ['ab', false],
      ['axxb', false],
      ['a/b', false],
      ['end/x', false],
      ['end/x/y', false],
    ],
  },
  {
    ignore: {
      '.gitignore': 'dir/\n!dir/keep\n*.tmp\n',
      'sub/.gitignore': '!important.tmp\n/local\nnested/deeper/\n',
      'sub/nested/.gitignore': '*\n!*.keep\n!*/\n',
    },
    paths: [
      ['dir/keep', false],
      ['dir/other', false],
      ['sub/a.tmp', false],
      ['sub/important.tmp', false],
      ['important.tmp', false],
      ['sub/x/important.tmp', false],
      ['sub/local', false],
      ['local', false],
      ['sub/x/local', false],
      ['sub/nested/a.txt', false],
      ['sub/nested/a.keep', false],
      ['sub/nested/inner/b.keep', false],
      ['sub/nested/inner/b.txt', false],
    ],
  },
];

function loadPatterns(sb: GitSandbox, c: Case): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  // Root first, deeper files later (later patterns take precedence).
  const files = Object.keys(c.ignore).sort(
    (a, b) => a.split('/').length - b.split('/').length,
  );
  for (const file of files) {
    sb.write(file, c.ignore[file]);
    const base = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    patterns.push(...parseIgnoreFile(c.ignore[file], base));
  }
  return patterns;
}

describe('gitignore matching vs git check-ignore', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  for (const [i, c] of CASES.entries()) {
    it(`case ${i + 1}`, () => {
      sb = createGitSandbox();
      const matcher = createMatcher(loadPatterns(sb, c));
      const input = c.paths
        .map(([p, isDir]) => (isDir ? p + '/' : p))
        .join('\n');
      const r = sb.gitTry(
        ['check-ignore', '--no-index', '--stdin', '-v', '-n'],
        {
          input,
        },
      );
      // -v -n prints every path; non-matching (or negated) have "::" source.
      const gitIgnored = new Map<string, boolean>();
      for (const line of r.stdout.split('\n').filter(Boolean)) {
        const tab = line.indexOf('\t');
        const source = line.slice(0, tab);
        const path = line.slice(tab + 1);
        const patternText = source.split(':').slice(2).join(':');
        gitIgnored.set(path, source !== '::' && !patternText.startsWith('!'));
      }
      const mismatches: string[] = [];
      for (const [p, isDir] of c.paths) {
        const key = isDir ? p + '/' : p;
        const expected = gitIgnored.get(key);
        expect(expected, `git output for ${key}`).not.toBeUndefined();
        const ours = isPathIgnored(matcher, p, isDir);
        if (ours !== expected) {
          mismatches.push(`${key}: git=${expected} ours=${ours}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
