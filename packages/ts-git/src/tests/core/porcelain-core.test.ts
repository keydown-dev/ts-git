import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import {
  isValidRefName,
  isValidBranchName,
  getCurrentBranch,
  setHead,
  writeRef,
  readRef,
  deleteRef,
  listBranches,
} from '../../core/refs.js';
import {
  parseIndex,
  serializeIndex,
  createFlags,
  type IndexEntry,
} from '../../core/index.js';
import { cleanupMessage } from '../../commands/commit.js';
import { matchesPathspec } from '../../commands/tree-helpers.js';
import { InvalidRefError, NotFoundError } from '../../errors.js';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

describe('isValidRefName (git check-ref-format rules)', () => {
  it.each([
    'refs/heads/main',
    'refs/heads/feature/foo',
    'main',
    'HEAD',
    'refs/tags/v1.0',
    'refs/heads/a@b',
    'refs/heads/ünïcödé',
  ])('accepts %j', (name) => {
    expect(isValidRefName(name)).toBe(true);
  });

  it.each([
    '',
    '@',
    'refs/heads/a..b',
    'refs/heads/.hidden',
    'refs/heads/x/.y',
    'refs/heads/x.lock',
    'refs/heads/x.lock/y',
    'refs/heads/trailing.',
    'refs/heads/trailing/',
    '/refs/heads/x',
    'refs//heads/x',
    'refs/heads/a b',
    'refs/heads/a~b',
    'refs/heads/a^b',
    'refs/heads/a:b',
    'refs/heads/a?b',
    'refs/heads/a*b',
    'refs/heads/a[b',
    'refs/heads/a\\b',
    'refs/heads/a@{b',
    'refs/heads/ctrl\u0007',
    'refs/heads/del\u007f',
  ])('rejects %j', (name) => {
    expect(isValidRefName(name)).toBe(false);
  });

  it('applies the extra branch-name rules', () => {
    expect(isValidBranchName('feature/x')).toBe(true);
    expect(isValidBranchName('-x')).toBe(false);
    expect(isValidBranchName('HEAD')).toBe(false);
  });
});

describe('refs', () => {
  let fs: MemoryFS;
  const gitdir = '/repo/.git';

  beforeEach(async () => {
    fs = new MemoryFS();
    await fs.mkdir(`${gitdir}/refs/heads`, { recursive: true });
  });

  it('getCurrentBranch returns the full short name for nested branches', async () => {
    await setHead(fs, gitdir, 'refs/heads/feature/foo');
    expect(await getCurrentBranch(fs, gitdir)).toBe('feature/foo');
  });

  it('writes loose refs and HEAD newline-terminated, like git', async () => {
    await writeRef(fs, gitdir, 'refs/heads/main', OID_A);
    await setHead(fs, gitdir, 'refs/heads/main');
    expect(await fs.readFileString(`${gitdir}/refs/heads/main`)).toBe(
      `${OID_A}\n`,
    );
    expect(await fs.readFileString(`${gitdir}/HEAD`)).toBe(
      'ref: refs/heads/main\n',
    );
  });

  it('refuses directory/file conflicts between refs', async () => {
    await writeRef(fs, gitdir, 'refs/heads/foo', OID_A);
    await expect(
      writeRef(fs, gitdir, 'refs/heads/foo/bar', OID_A),
    ).rejects.toThrow(InvalidRefError);
    await writeRef(fs, gitdir, 'refs/heads/dir/child', OID_A);
    await expect(
      writeRef(fs, gitdir, 'refs/heads/dir', OID_A, true),
    ).rejects.toThrow(InvalidRefError);
  });

  it('deletes packed-only refs by rewriting packed-refs', async () => {
    await fs.writeFile(
      `${gitdir}/packed-refs`,
      `# pack-refs with: peeled fully-peeled sorted \n${OID_A} refs/heads/gone\n${OID_B} refs/heads/stay\n${OID_A} refs/tags/v1\n^${OID_B}\n`,
    );
    expect(await listBranches(fs, gitdir)).toEqual(['gone', 'stay']);
    await deleteRef(fs, gitdir, 'refs/heads/gone');
    expect(await readRef(fs, gitdir, 'refs/heads/gone')).toBeNull();
    expect(await listBranches(fs, gitdir)).toEqual(['stay']);
    const packed = await fs.readFileString(`${gitdir}/packed-refs`);
    expect(packed).toContain(`${OID_A} refs/tags/v1\n^${OID_B}`);
    await expect(deleteRef(fs, gitdir, 'refs/heads/gone')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('removing a packed tag also drops its peeled line', async () => {
    await fs.writeFile(
      `${gitdir}/packed-refs`,
      `${OID_A} refs/tags/v1\n^${OID_B}\n${OID_B} refs/heads/main\n`,
    );
    await deleteRef(fs, gitdir, 'refs/tags/v1');
    expect(await fs.readFileString(`${gitdir}/packed-refs`)).toBe(
      `${OID_B} refs/heads/main\n`,
    );
  });

  it('prunes empty directories left by deleted nested refs', async () => {
    await writeRef(fs, gitdir, 'refs/heads/a/b/c', OID_A);
    await deleteRef(fs, gitdir, 'refs/heads/a/b/c');
    expect(await fs.exists(`${gitdir}/refs/heads/a`)).toBe(false);
    expect(await fs.exists(`${gitdir}/refs/heads`)).toBe(true);
  });

  it('sees packed-refs changes made after the first read', async () => {
    expect(await readRef(fs, gitdir, 'refs/heads/late')).toBeNull();
    await fs.writeFile(`${gitdir}/packed-refs`, `${OID_A} refs/heads/late\n`);
    expect(await readRef(fs, gitdir, 'refs/heads/late')).toBe(OID_A);
  });
});

function entry(path: string, stage = 0): IndexEntry {
  return {
    ctimeSeconds: 1,
    ctimeNanoseconds: 2,
    mtimeSeconds: 3,
    mtimeNanoseconds: 0xfffffff0, // > 2^31: must round-trip unsigned
    dev: 5,
    ino: 0x90000000,
    mode: 0o100644,
    uid: 0,
    gid: 0,
    size: 10,
    oid: OID_A,
    flags: createFlags(path, stage),
    path,
  };
}

describe('index format', () => {
  it('sorts entries by path bytes then stage (not locale order)', async () => {
    const paths = ['b', 'a/b', 'a.b', 'B', 'a0', 'ä', 'z'];
    const data = await serializeIndex({
      version: 2,
      entries: [...paths.map((p) => entry(p)), entry('c', 3), entry('c', 1)],
    });
    const parsed = parseIndex(data);
    expect(
      parsed.entries.map((e) => `${e.path}:${(e.flags >> 12) & 3}`),
    ).toEqual([
      'B:0',
      'a.b:0',
      'a/b:0',
      'a0:0',
      'b:0',
      'c:1',
      'c:3',
      'z:0',
      'ä:0',
    ]);
  });

  it('stores the UTF-8 byte length in flags and pads by bytes', async () => {
    const name = '日本語/ファイル.md';
    const parsed = parseIndex(
      await serializeIndex({ version: 2, entries: [entry(name), entry('x')] }),
    );
    expect(parsed.entries[0].path).toBe('x');
    expect(parsed.entries[1].path).toBe(name);
    expect(parsed.entries[1].flags & 0xfff).toBe(
      new TextEncoder().encode(name).length,
    );
  });

  it('round-trips unsigned 32-bit stat fields', async () => {
    const parsed = parseIndex(
      await serializeIndex({ version: 2, entries: [entry('f')] }),
    );
    expect(parsed.entries[0].mtimeNanoseconds).toBe(0xfffffff0);
    expect(parsed.entries[0].ino).toBe(0x90000000);
  });

  it('handles paths longer than 0xfff bytes', async () => {
    const long = 'p/'.repeat(2100) + 'file';
    const parsed = parseIndex(
      await serializeIndex({ version: 2, entries: [entry(long), entry('zz')] }),
    );
    expect(parsed.entries.map((e) => e.path)).toEqual([long, 'zz']);
    expect(parsed.entries[0].flags & 0xfff).toBe(0xfff);
  });
});

describe('cleanupMessage (git stripspace)', () => {
  it.each([
    ['msg', 'msg\n'],
    ['msg\n\n\n', 'msg\n'],
    ['\n\nsubject  \n\n\n\nbody\t\n', 'subject\n\nbody\n'],
    ['  indented', '  indented\n'],
    ['', ''],
    ['  \n \n', ''],
  ])('whitespace mode: %j', (input, expected) => {
    expect(cleanupMessage(input)).toBe(expected);
  });

  it('strip mode removes comment lines', () => {
    expect(cleanupMessage('subject\n# comment\nbody', 'strip')).toBe(
      'subject\nbody\n',
    );
  });

  it('verbatim keeps the message', () => {
    expect(cleanupMessage(' raw  ', 'verbatim')).toBe(' raw  ');
  });
});

describe('matchesPathspec', () => {
  it('matches exact paths, directories, globs and the root', () => {
    expect(matchesPathspec('a/b.txt', ['a'])).toBe(true);
    expect(matchesPathspec('a/b.txt', ['a/'])).toBe(true);
    expect(matchesPathspec('ab/c', ['a'])).toBe(false);
    expect(matchesPathspec('x/y.txt', ['*.txt'])).toBe(true);
    expect(matchesPathspec('x/y.md', ['*.txt'])).toBe(false);
    expect(matchesPathspec('anything', ['.'])).toBe(true);
    expect(matchesPathspec('f', ['./f'])).toBe(true);
  });
});
