import { describe, it, expect, afterEach } from 'vitest';
import * as nodefs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  readObject,
  writeObject,
  computeOid,
  serializeCommit,
  deserializeCommit,
  serializeTag,
  deserializeTag,
  serializeTree,
  deserializeTree,
  parseTimezone,
  formatTimezone,
} from '../../core/objects.js';
import { createGitSandbox, gitCommitAll, type GitSandbox } from './git-env.js';

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // empty tree

function hashRaw(
  sb: GitSandbox,
  type: string,
  raw: string,
  literally = false,
): string {
  return sb
    .git(
      [
        'hash-object',
        '-t',
        type,
        '-w',
        '--stdin',
        ...(literally ? ['--literally'] : []),
      ],
      { input: raw },
    )
    .trim();
}

async function expectCommitRoundTrip(sb: GitSandbox, oid: string) {
  const { type, content } = await readObject(sb.fs, sb.gitdir, oid);
  expect(type).toBe('commit');
  const parsed = deserializeCommit(content);
  const reserialized = serializeCommit(parsed);
  expect(Buffer.from(reserialized).toString('utf8')).toBe(
    Buffer.from(content).toString('utf8'),
  );
  expect(await computeOid('commit', reserialized)).toBe(oid);
  return parsed;
}

describe('commit object format vs canonical git', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('round-trips commits with extra headers, multi-line values and odd messages', async () => {
    sb = createGitSandbox();
    const ident = 'A U Thor <a@example.com> 1700000000 +0130';
    const cases: { raw: string; literally?: boolean }[] = [
      { raw: `tree ${TREE}\nauthor ${ident}\ncommitter ${ident}\n\nmsg\n` },
      // No trailing newline on message
      {
        raw: `tree ${TREE}\nauthor ${ident}\ncommitter ${ident}\n\nno newline`,
      },
      // Message starting with blank lines must be preserved verbatim
      {
        raw: `tree ${TREE}\nauthor ${ident}\ncommitter ${ident}\n\n\n\nleading\n`,
      },
      // Empty message
      { raw: `tree ${TREE}\nauthor ${ident}\ncommitter ${ident}\n\n` },
      // Encoding header and an unknown multi-line header
      {
        raw: `tree ${TREE}\nauthor ${ident}\ncommitter ${ident}\nencoding ISO-8859-1\nx-custom first\n second\n third\n\nbody\n`,
      },
      // -0000 timezone and non-integer-hour offsets
      {
        raw: `tree ${TREE}\nauthor A <a@b> 0 -0000\ncommitter B <b@c> 1234567890 -0945\n\nm\n`,
      },
      // Empty name / empty email (only possible via --literally)
      {
        raw: `tree ${TREE}\nauthor  <> 1 +0000\ncommitter  <c@d> 2 +0000\n\nm\n`,
        literally: true,
      },
      // Fake gpgsig in git's position (after committer), multi-line with a
      // blank continuation line (" ")
      {
        raw:
          `tree ${TREE}\nauthor ${ident}\ncommitter ${ident}\n` +
          'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iHUEABYKAB0WIQ\n =abcd\n -----END PGP SIGNATURE-----\n\nsigned\n',
      },
    ];

    for (const { raw, literally } of cases) {
      const oid = hashRaw(sb, 'commit', raw, literally);
      await expectCommitRoundTrip(sb, oid);
    }

    // Spot-check parsed fields
    const enc = deserializeCommit(new TextEncoder().encode(cases[4].raw));
    expect(enc.extraHeaders).toEqual([
      { key: 'encoding', value: 'ISO-8859-1' },
      { key: 'x-custom', value: 'first\nsecond\nthird' },
    ]);
    const lead = deserializeCommit(new TextEncoder().encode(cases[2].raw));
    expect(lead.message).toBe('\n\nleading\n');
    const tz = deserializeCommit(new TextEncoder().encode(cases[5].raw));
    expect(Object.is(tz.author.timezoneOffset, -0)).toBe(true);
    expect(tz.committer.timezoneOffset).toBe(585);
    const empty = deserializeCommit(new TextEncoder().encode(cases[6].raw));
    expect(empty.author).toEqual({
      name: '',
      email: '',
      timestamp: 1,
      timezoneOffset: 0,
    });
    const sig = deserializeCommit(new TextEncoder().encode(cases[7].raw));
    expect(sig.gpgsig).toBe(
      '-----BEGIN PGP SIGNATURE-----\n\niHUEABYKAB0WIQ\n=abcd\n-----END PGP SIGNATURE-----',
    );
    expect(sig.message).toBe('signed\n');
  });

  it('serializeCommit produces the same OID as git commit-tree', async () => {
    sb = createGitSandbox();
    sb.env.GIT_AUTHOR_DATE = '1700000000 +0530';
    sb.env.GIT_COMMITTER_DATE = '1700000100 -0800';
    const parent = sb.git(['commit-tree', TREE, '-m', 'root']).trim();
    const expected = sb
      .git(['commit-tree', TREE, '-p', parent, '-m', 'child'])
      .trim();

    const ours = serializeCommit({
      tree: TREE,
      parent: [parent],
      author: {
        name: 'A U Thor',
        email: 'author@example.com',
        timestamp: 1700000000,
        timezoneOffset: -330,
      },
      committer: {
        name: 'C O Mitter',
        email: 'committer@example.com',
        timestamp: 1700000100,
        timezoneOffset: 480,
      },
      message: 'child\n',
    });
    expect(await computeOid('commit', ours)).toBe(expected);
    const written = await writeObject(sb.fs, sb.gitdir, 'commit', ours);
    expect(sb.git(['cat-file', '-t', written]).trim()).toBe('commit');
    sb.git(['fsck', '--strict', '--no-dangling']);
  });

  it('timezone helpers handle +0000 vs -0000', () => {
    expect(formatTimezone(parseTimezone('+0000'))).toBe('+0000');
    expect(formatTimezone(parseTimezone('-0000'))).toBe('-0000');
    expect(formatTimezone(0)).toBe('+0000');
    expect(formatTimezone(parseTimezone('+1345'))).toBe('+1345');
    expect(formatTimezone(parseTimezone('-0130'))).toBe('-0130');
  });
});

describe('tag objects vs canonical git', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('parses and round-trips annotated tags (including tag-of-tag)', async () => {
    sb = createGitSandbox();
    sb.write('f.txt', 'x\n');
    const commit = gitCommitAll(sb, 'c');
    sb.git(['tag', '-a', 'v1', '-m', 'release 1\n\nbody']);
    sb.git(['tag', '-a', 'v1-outer', 'v1', '-m', 'outer']);
    const tagOid = sb.git(['rev-parse', 'v1']).trim();
    const outerOid = sb.git(['rev-parse', 'v1-outer']).trim();

    const { type, content } = await readObject(sb.fs, sb.gitdir, tagOid);
    expect(type).toBe('tag');
    const tag = deserializeTag(content);
    expect(tag.object).toBe(commit);
    expect(tag.type).toBe('commit');
    expect(tag.tag).toBe('v1');
    expect(tag.tagger?.name).toBe('C O Mitter');
    expect(tag.message).toBe('release 1\n\nbody\n');
    expect(await computeOid('tag', serializeTag(tag))).toBe(tagOid);

    const outer = deserializeTag(
      (await readObject(sb.fs, sb.gitdir, outerOid)).content,
    );
    expect(outer.type).toBe('tag');
    expect(outer.object).toBe(tagOid);

    // A tag without tagger (old-style) round-trips too
    const raw = `object ${commit}\ntype commit\ntag old\n\nold tag\n`;
    const oldOid = hashRaw(sb, 'tag', raw, true);
    const old = deserializeTag(
      (await readObject(sb.fs, sb.gitdir, oldOid)).content,
    );
    expect(old.tagger).toBeUndefined();
    expect(await computeOid('tag', serializeTag(old))).toBe(oldOid);
  });
});

function haveGpg(): boolean {
  return spawnSync('gpg', ['--version']).status === 0;
}

describe.runIf(haveGpg())('GPG-signed objects created by git', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('round-trips signed commits, signed tags and mergetag headers byte-for-byte', async () => {
    sb = createGitSandbox();
    const gnupg = path.join(sb.root, 'gnupg');
    nodefs.mkdirSync(gnupg, { mode: 0o700 });
    sb.env.GNUPGHOME = gnupg;
    const gen = spawnSync(
      'gpg',
      [
        '--batch',
        '--passphrase',
        '',
        '--quick-gen-key',
        'Signer <signer@example.com>',
        'ed25519',
        'sign',
        'never',
      ],
      { env: sb.env },
    );
    expect(gen.status).toBe(0);
    sb.git(['config', 'user.signingkey', 'signer@example.com']);

    sb.write('a.txt', 'a\n');
    sb.git(['add', '-A']);
    sb.git(['commit', '-q', '-S', '-m', 'signed commit']);
    const signed = sb.git(['rev-parse', 'HEAD']).trim();

    const parsed = await expectCommitRoundTrip(sb, signed);
    expect(parsed.gpgsig).toMatch(/^-----BEGIN PGP SIGNATURE-----\n/);
    expect(parsed.gpgsig).toMatch(/-----END PGP SIGNATURE-----$/);
    expect(parsed.message).toBe('signed commit\n');

    // Signed tag merged with --no-ff creates a `mergetag` header.
    sb.git(['checkout', '-q', '-b', 'side']);
    sb.write('b.txt', 'b\n');
    sb.git(['add', '-A']);
    sb.git(['commit', '-q', '-m', 'side']);
    sb.git(['tag', '-s', 'side-tag', '-m', 'signed tag']);
    sb.git(['checkout', '-q', 'main']);
    sb.write('c.txt', 'c\n');
    sb.git(['add', '-A']);
    sb.git(['commit', '-q', '-m', 'main']);
    sb.git([
      'merge',
      '-q',
      '--no-ff',
      '-S',
      '-m',
      'merge signed tag',
      'side-tag',
    ]);
    const merge = sb.git(['rev-parse', 'HEAD']).trim();
    const mergeParsed = await expectCommitRoundTrip(sb, merge);
    expect(mergeParsed.parent).toHaveLength(2);
    expect(mergeParsed.extraHeaders?.map((h) => h.key)).toEqual(['mergetag']);
    expect(mergeParsed.gpgsig).toBeDefined();

    const tagOid = sb.git(['rev-parse', 'side-tag']).trim();
    const tag = deserializeTag(
      (await readObject(sb.fs, sb.gitdir, tagOid)).content,
    );
    expect(tag.gpgsig).toMatch(/^-----BEGIN PGP SIGNATURE-----/);
    expect(await computeOid('tag', serializeTag(tag))).toBe(tagOid);
  }, 30000);
});

describe('tree object format', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('round-trips git trees (40000 dir mode, symlink, exec, gitlink)', async () => {
    sb = createGitSandbox();
    sb.write('dir/sub/f.txt', 'f\n');
    sb.write('exe.sh', '#!/bin/sh\n');
    nodefs.chmodSync(path.join(sb.dir, 'exe.sh'), 0o755);
    nodefs.symlinkSync('exe.sh', path.join(sb.dir, 'link'));
    sb.write('a-b', 'x\n');
    sb.write('a.b', 'x\n');
    sb.git(['add', '-A']);
    sb.git([
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'1'.repeat(40)},sub`,
    ]);
    const tree = sb.git(['write-tree']).trim();
    const { content } = await readObject(sb.fs, sb.gitdir, tree);
    const entries = deserializeTree(content);
    expect(entries.find((e) => e.path === 'dir')?.mode).toBe('40000');
    expect(entries.find((e) => e.path === 'link')?.mode).toBe('120000');
    expect(entries.find((e) => e.path === 'exe.sh')?.mode).toBe('100755');
    expect(entries.find((e) => e.path === 'sub')?.mode).toBe('160000');
    expect(await computeOid('tree', serializeTree(entries))).toBe(tree);
  });
});
