import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as nodefs from 'fs';
import * as path from 'path';
import { hashObject, hashObjectString } from '../../commands/hash-object.js';
import type { GitObjectType } from '../../core/objects.js';
import { createGitSandbox, gitCommitAll, type GitSandbox } from './git-env.js';

const BLOBS: (string | Uint8Array)[] = [
  '',
  'hello world\n',
  'no trailing newline',
  'crlf\r\nline\r\n',
  'unicode ✓ ファイル\n',
  new Uint8Array([0, 1, 2, 255, 0, 128]),
  'x'.repeat(100_000),
];

describe('hash-object vs git hash-object', () => {
  let sb: GitSandbox;
  beforeEach(() => {
    sb = createGitSandbox();
  });
  afterEach(() => sb.cleanup());

  it('computes the same blob ids for stdin content and files', async () => {
    for (const [i, blob] of BLOBS.entries()) {
      const bytes =
        typeof blob === 'string' ? new TextEncoder().encode(blob) : blob;
      const expected = sb
        .git(['hash-object', '--stdin'], { input: bytes })
        .trim();
      const r = await hashObject({ fs: sb.fs, dir: sb.dir, object: bytes });
      expect(r).toEqual({ oid: expected, written: false });

      const file = `f${i}.bin`;
      sb.write(file, bytes);
      expect(sb.git(['hash-object', file]).trim()).toBe(expected);
      const fromFile = await hashObject({
        fs: sb.fs,
        dir: sb.dir,
        filepath: file,
      });
      expect(fromFile.oid).toBe(expected);
    }
    // Nothing was written without -w.
    expect(nodefs.readdirSync(path.join(sb.gitdir, 'objects')).sort()).toEqual([
      'info',
      'pack',
    ]);
  });

  it('-w writes objects git can read, and leaves the index alone', async () => {
    sb.write('tracked.txt', 'tracked\n');
    gitCommitAll(sb, 'base');
    const indexBefore = sb.read('.git/index');

    sb.write('new.txt', 'new content\n');
    const r = await hashObject({
      fs: sb.fs,
      dir: sb.dir,
      filepath: 'new.txt',
      write: true,
    });
    expect(r.written).toBe(true);
    expect(r.oid).toBe(sb.git(['hash-object', 'new.txt']).trim());
    expect(sb.git(['cat-file', '-p', r.oid])).toBe('new content\n');
    expect(sb.read('.git/index').equals(indexBefore)).toBe(true);
    expect(sb.git(['status', '--porcelain'])).toBe('?? new.txt\n');

    // Writing an object git already wrote (read-only file) is a no-op.
    const existing = sb.git(['rev-parse', 'HEAD:tracked.txt']).trim();
    const again = await hashObjectString({
      fs: sb.fs,
      dir: sb.dir,
      content: 'tracked\n',
      write: true,
    });
    expect(again.oid).toBe(existing);
    sb.git(['fsck', '--strict']);
  });

  it('hashes and writes tree, commit and tag objects with -t', async () => {
    sb.write('a.txt', 'a\n');
    gitCommitAll(sb, 'base');
    sb.git(['tag', '-a', 'v1', '-m', 'tag']);

    for (const [type, rev] of [
      ['tree', 'HEAD^{tree}'],
      ['commit', 'HEAD'],
      ['tag', 'v1'],
      ['blob', 'HEAD:a.txt'],
    ] as [GitObjectType, string][]) {
      const content = sb.gitBytes(['cat-file', type, rev]);
      const expected = sb
        .git(['hash-object', '-t', type, '--stdin'], { input: content })
        .trim();
      expect(expected).toBe(sb.git(['rev-parse', rev]).trim());
      const r = await hashObject({
        fs: sb.fs,
        dir: sb.dir,
        object: new Uint8Array(content),
        type,
      });
      expect(r.oid).toBe(expected);
    }

    // Write a brand-new commit object and let git verify it.
    const tree = sb.git(['rev-parse', 'HEAD^{tree}']).trim();
    const raw = `tree ${tree}\nauthor X <x@y> 1 +0000\ncommitter X <x@y> 1 +0000\n\nmanual\n`;
    const written = await hashObjectString({
      fs: sb.fs,
      dir: sb.dir,
      content: raw,
      type: 'commit',
      write: true,
    });
    expect(written.oid).toBe(
      sb.git(['hash-object', '-t', 'commit', '--stdin'], { input: raw }).trim(),
    );
    expect(sb.git(['cat-file', '-t', written.oid]).trim()).toBe('commit');
    sb.git(['fsck', '--strict', '--no-dangling']);
  });

  it('rejects malformed objects unless --literally, like git', async () => {
    const bad: [GitObjectType, string][] = [
      ['commit', 'not a commit\n'],
      ['commit', `tree ${'0'.repeat(40)}\n\nmissing author\n`],
      ['tag', 'object nope\n'],
      ['tree', 'garbage'],
    ];
    for (const [type, content] of bad) {
      expect(
        sb.gitTry(['hash-object', '-t', type, '--stdin'], { input: content })
          .status,
      ).not.toBe(0);
      await expect(
        hashObjectString({ fs: sb.fs, dir: sb.dir, content, type }),
      ).rejects.toThrow();

      const expected = sb
        .git(['hash-object', '-t', type, '--stdin', '--literally'], {
          input: content,
        })
        .trim();
      const r = await hashObjectString({
        fs: sb.fs,
        dir: sb.dir,
        content,
        type,
        literally: true,
      });
      expect(r.oid).toBe(expected);
    }
  });
});
