import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  createPackfile,
  indexPackfile,
  storePackfile,
  crc32,
} from '../../core/pack-builder.js';
import { inflateZlib } from '../../remote/inflate.js';
import { zlibSync } from 'fflate';
import { readObject, computeOid } from '../../core/objects.js';
import { NodeFSAdapter } from '../../fs/node-adapter.js';
import { createSandbox, type GitSandbox } from './git-helpers.js';

const enc = new TextEncoder();

describe('inflate', () => {
  it('reports the end offset of back-to-back zlib streams', () => {
    const a = zlibSync(enc.encode('hello world'.repeat(100)), { level: 9 });
    const b = zlibSync(enc.encode('second'), { level: 0 });
    const buf = new Uint8Array(a.length + b.length + 3);
    buf.set(a, 0);
    buf.set(b, a.length);
    const first = inflateZlib(buf, 0);
    expect(new TextDecoder().decode(first.data)).toBe(
      'hello world'.repeat(100),
    );
    expect(first.end).toBe(a.length);
    const second = inflateZlib(buf, first.end);
    expect(new TextDecoder().decode(second.data)).toBe('second');
    expect(second.end).toBe(a.length + b.length);
  });

  it('round-trips random binary data at every compression level', () => {
    const data = new Uint8Array(50000);
    let x = 12345;
    for (let i = 0; i < data.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      data[i] = i % 7 === 0 ? x & 0xff : (i >> 3) & 0xff;
    }
    for (const level of [0, 1, 6, 9] as const) {
      const z = zlibSync(data, { level });
      const out = inflateZlib(z, 0);
      expect(out.end).toBe(z.length);
      expect(out.data).toEqual(data);
    }
  });

  it('rejects truncated streams instead of looping', () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `line ${i} of text`,
    ).join('\n');
    const z = zlibSync(enc.encode(text), { level: 9 });
    for (const cut of [3, 20, 100, Math.floor(z.length / 2), z.length - 5]) {
      expect(() => inflateZlib(z.subarray(0, cut), 0)).toThrow(/inflate/);
    }
  });

  it('computes crc32 like zlib', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('pack builder interop', () => {
  let sb: GitSandbox;
  let repo: string;

  beforeEach(() => {
    sb = createSandbox();
    repo = join(sb.root, 'repo');
    mkdirSync(repo);
    sb.git(repo, ['init', '-q']);
  });
  afterEach(() => sb.cleanup());

  it('creates packs git can index and verify', async () => {
    const objects = [
      { type: 'blob' as const, content: enc.encode('hello\n') },
      { type: 'blob' as const, content: new Uint8Array(0) },
      { type: 'blob' as const, content: new Uint8Array(70000).fill(7) },
    ];
    const pack = await createPackfile(objects);
    const packPath = join(sb.root, 'test.pack');
    writeFileSync(packPath, pack);
    sb.git(repo, ['index-pack', packPath]);
    const verify = sb.git(repo, ['verify-pack', '-v', packPath]);
    for (const o of objects) {
      expect(verify).toContain(await computeOid(o.type, o.content));
    }

    // Our idx must be byte-identical to git's.
    const indexed = await indexPackfile(pack);
    const gitIdx = readFileSync(packPath.replace(/\.pack$/, '.idx'));
    expect(Buffer.from(indexed.idx)).toEqual(gitIdx);
  });

  it('indexes git-generated delta packs (OFS and REF deltas) identically', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    for (let rev = 0; rev < 8; rev++) {
      lines[rev * 10] = `changed in rev ${rev}`;
      writeFileSync(join(repo, 'file.txt'), lines.join('\n') + '\n');
      writeFileSync(join(repo, `other-${rev % 3}.txt`), `rev ${rev}\n`);
      sb.git(repo, ['add', '-A']);
      sb.git(repo, ['commit', '-q', '-m', `rev ${rev}`]);
    }
    sb.git(repo, ['tag', '-a', 'v1', '-m', 'annotated']);

    for (const extra of [[], ['--no-reuse-delta', '--depth=50']]) {
      const revs = sb.git(repo, ['rev-list', '--objects', '--all']);
      const ofs = sb.gitBuffer(
        repo,
        ['pack-objects', '--stdout', '--delta-base-offset', ...extra],
        revs,
      );
      const ref = sb.gitBuffer(
        repo,
        ['pack-objects', '--stdout', ...extra],
        revs,
      );
      for (const pack of [ofs, ref]) {
        const indexed = await indexPackfile(new Uint8Array(pack));
        const packPath = join(sb.root, `p-${indexed.checksum}.pack`);
        writeFileSync(packPath, pack);
        sb.git(repo, ['index-pack', packPath]);
        const gitIdx = readFileSync(packPath.replace(/\.pack$/, '.idx'));
        expect(Buffer.from(indexed.idx)).toEqual(gitIdx);
      }
    }
  });

  it('stores packs so objects become readable', async () => {
    writeFileSync(join(repo, 'a.txt'), 'A\n');
    sb.git(repo, ['add', 'a.txt']);
    sb.git(repo, ['commit', '-q', '-m', 'one']);
    const revs = sb.git(repo, ['rev-list', '--objects', '--all']);
    const pack = sb.gitBuffer(repo, ['pack-objects', '--stdout'], revs);

    const target = join(sb.root, 'target');
    mkdirSync(target);
    sb.git(target, ['init', '-q']);
    const fs = new NodeFSAdapter();
    await storePackfile(fs, join(target, '.git'), new Uint8Array(pack));
    expect(readdirSync(join(target, '.git/objects/pack'))).toHaveLength(2);

    const head = sb.git(repo, ['rev-parse', 'HEAD']).trim();
    const obj = await readObject(fs, join(target, '.git'), head);
    expect(obj.type).toBe('commit');
    sb.git(target, ['cat-file', '-e', head]);
  });
});
