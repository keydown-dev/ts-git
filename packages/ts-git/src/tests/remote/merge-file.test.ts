import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mergeFile, diffLineHunks, splitLines } from '../../core/merge-file.js';
import { createSandbox, gitEnv, type GitSandbox } from './git-helpers.js';

const L = (...lines: string[]) => lines.map((l) => `${l}\n`).join('');
const base = L('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');

const cases: Array<[string, string, string, string]> = [
  ['identical', base, base, base],
  ['ours only', base, base.replace('c\n', 'C\n'), base],
  ['theirs only', base, base, base.replace('h\n', 'H\n')],
  [
    'disjoint edits',
    base,
    base.replace('b\n', 'B\n'),
    base.replace('i\n', 'I\n'),
  ],
  [
    'adjacent edits conflict',
    base,
    base.replace('c\n', 'C\n'),
    base.replace('d\n', 'D\n'),
  ],
  [
    'same edit both sides',
    base,
    base.replace('e\n', 'E\n'),
    base.replace('e\n', 'E\n'),
  ],
  [
    'overlapping edits',
    base,
    base.replace('d\ne\n', 'X\nY\n'),
    base.replace('e\nf\n', 'P\nQ\n'),
  ],
  [
    'zealous trimming',
    base,
    base.replace('d\ne\nf\n', 'd\nOURS\nf\n'),
    base.replace('d\ne\nf\n', 'd\nTHEIRS\nf\n'),
  ],
  ['insert at start vs end', base, 'top\n' + base, base + 'bottom\n'],
  [
    'delete vs edit',
    base,
    base.replace('c\nd\n', ''),
    base.replace('d\n', 'DD\n'),
  ],
  ['both append different', base, base + 'x\n', base + 'y\n'],
  ['no trailing newline', 'a\nb\nc', 'a\nB\nc', 'a\nb\nC'],
  ['empty base', '', 'ours\n', 'theirs\n'],
  ['ours deletes all', base, '', base.replace('j\n', 'J\n')],
  [
    'multiple conflicts',
    base,
    base.replace('b\n', 'B1\n').replace('h\n', 'H1\n'),
    base.replace('b\n', 'B2\n').replace('h\n', 'H2\n'),
  ],
  ['conflict missing eol', 'a\nb', 'a\nours', 'a\ntheirs'],
  ['crlf conflict', 'a\r\nb\r\nc\r\n', 'a\r\nB1\r\nc\r\n', 'a\r\nB2\r\nc\r\n'],
  ['crlf conflict at start', 'x\r\ny\r\n', 'o\r\ny\r\n', 't\r\ny\r\n'],
  [
    'crlf clean merge',
    'a\r\nb\r\nc\r\nd\r\ne\r\n',
    'A\r\nb\r\nc\r\nd\r\ne\r\n',
    'a\r\nb\r\nc\r\nd\r\nE\r\n',
  ],
];

describe('mergeFile matches git merge-file', () => {
  let sb: GitSandbox;
  beforeAll(() => {
    sb = createSandbox();
  });
  afterAll(() => sb.cleanup());

  for (const [name, o, a, b] of cases) {
    it(name, () => {
      const dir = sb.root;
      writeFileSync(join(dir, 'base'), o);
      writeFileSync(join(dir, 'ours'), a);
      writeFileSync(join(dir, 'theirs'), b);
      const res = spawnSync(
        'git',
        [
          'merge-file',
          '-p',
          '-L',
          'HEAD',
          '-L',
          'base',
          '-L',
          'feature',
          'ours',
          'base',
          'theirs',
        ],
        { cwd: dir, env: gitEnv(dir), encoding: 'utf8' },
      );
      const ours = mergeFile(o, a, b, {
        oursLabel: 'HEAD',
        theirsLabel: 'feature',
      });
      expect(ours.content).toBe(res.stdout);
      expect(ours.conflicts).toBe(res.status);
    });
  }
});

describe('diffLineHunks', () => {
  it('produces a minimal edit script', () => {
    const a = splitLines(L('a', 'b', 'c', 'a', 'b', 'b', 'a'));
    const b = splitLines(L('c', 'b', 'a', 'b', 'a', 'c'));
    const hunks = diffLineHunks(a, b);
    const deleted = hunks.reduce((n, h) => n + h.aEnd - h.aStart, 0);
    const inserted = hunks.reduce((n, h) => n + h.bEnd - h.bStart, 0);
    expect(deleted + inserted).toBe(5); // classic Myers example: D = 5
  });
});
