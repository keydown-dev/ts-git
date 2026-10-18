import { describe, it, expect, afterEach } from 'vitest';
import * as nodefs from 'fs';
import * as path from 'path';
import { readObject, hasObject } from '../../core/objects.js';
import {
  invalidatePackCache,
  parsePackIndex,
  listPackedOids,
} from '../../core/packfile.js';
import {
  createGitSandbox,
  gitCommitAll,
  listAllObjects,
  type GitSandbox,
} from './git-env.js';

/** Build a history with plenty of similar blobs so git produces deltas. */
function buildDeltaHistory(sb: GitSandbox, commits = 30): void {
  let text = '';
  for (let i = 0; i < 200; i++) {
    text += `line ${i}: the quick brown fox jumps over the lazy dog\n`;
  }
  for (let c = 0; c < commits; c++) {
    const lines = text.split('\n');
    lines[(c * 7) % 200] = `changed in commit ${c}`;
    lines.splice((c * 13) % 180, 0, `inserted ${c}`);
    text = lines.join('\n');
    sb.write('big.txt', text);
    sb.write(`dir/file-${c % 5}.txt`, `content ${c}\n`.repeat(20 + c));
    sb.write(
      'bin.dat',
      Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * c) & 0xff)),
    );
    gitCommitAll(sb, `commit ${c}`);
  }
  sb.git(['tag', '-a', 'v1', '-m', 'annotated tag']);
}

function packFiles(sb: GitSandbox): string[] {
  const dir = path.join(sb.gitdir, 'objects', 'pack');
  return nodefs.existsSync(dir)
    ? nodefs.readdirSync(dir).map((f) => path.join(dir, f))
    : [];
}

function countLooseObjects(sb: GitSandbox): number {
  return parseInt(
    sb.git(['count-objects', '-v']).match(/^count: (\d+)/m)![1],
    10,
  );
}

/** Compare every object git knows about with what ts-git reads. */
async function expectAllObjectsMatch(sb: GitSandbox): Promise<number> {
  invalidatePackCache(sb.fs);
  const objects = listAllObjects(sb);
  expect(objects.length).toBeGreaterThan(0);
  for (const { oid, type, size } of objects) {
    const obj = await readObject(sb.fs, sb.gitdir, oid);
    expect(obj.type).toBe(type);
    expect(obj.content.length).toBe(size);
    const expected = sb.gitBytes(['cat-file', type, oid]);
    expect(Buffer.from(obj.content).equals(expected)).toBe(true);
  }
  return objects.length;
}

function verifyPackHasDeltas(sb: GitSandbox, kind: 'ofs' | 'ref') {
  const idx = packFiles(sb).find((f) => f.endsWith('.idx'))!;
  const out = sb.git(['verify-pack', '-v', idx]);
  // Delta entries have "depth base-oid" columns.
  const deltaLines = out
    .split('\n')
    .filter((l) => /^[0-9a-f]{40} \w+ +\d+ \d+ \d+ \d+ [0-9a-f]{40}/.test(l));
  expect(deltaLines.length).toBeGreaterThan(0);

  // Check the on-disk entry types (6 = OFS_DELTA, 7 = REF_DELTA).
  const parsed = parsePackIndex(new Uint8Array(nodefs.readFileSync(idx)))!;
  const pack = nodefs.readFileSync(idx.replace(/\.idx$/, '.pack'));
  const types = new Set(parsed.offsets.map((o) => (pack[o] >> 4) & 7));
  expect(types.has(kind === 'ofs' ? 6 : 7)).toBe(true);
  expect(types.has(kind === 'ofs' ? 7 : 6)).toBe(false);
  return out;
}

describe('packfile reading vs canonical git', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('reads every object after git gc --aggressive (OFS_DELTA chains)', async () => {
    sb = createGitSandbox();
    buildDeltaHistory(sb);
    sb.git(['gc', '-q', '--aggressive']);
    expect(countLooseObjects(sb)).toBe(0);
    verifyPackHasDeltas(sb, 'ofs');
    await expectAllObjectsMatch(sb);
  });

  it('reads deep delta chains from git repack -adf --depth=50', async () => {
    sb = createGitSandbox();
    buildDeltaHistory(sb, 60);
    sb.git(['repack', '-q', '-adf', '--depth=50', '--window=250']);
    const out = verifyPackHasDeltas(sb, 'ofs');
    const maxDepth = Math.max(
      ...out
        .split('\n')
        .map((l) => l.match(/^chain length = (\d+):/))
        .filter(Boolean)
        .map((m) => parseInt(m![1], 10)),
    );
    expect(maxDepth).toBeGreaterThan(10);
    await expectAllObjectsMatch(sb);
  });

  it('reads REF_DELTA packs (repack.useDeltaBaseOffset=false)', async () => {
    sb = createGitSandbox();
    buildDeltaHistory(sb);
    sb.git(['-c', 'repack.useDeltaBaseOffset=false', 'repack', '-q', '-adf']);
    verifyPackHasDeltas(sb, 'ref');
    await expectAllObjectsMatch(sb);
  });

  it('reads packs indexed with a version 1 .idx', async () => {
    sb = createGitSandbox();
    buildDeltaHistory(sb, 10);
    sb.git(['repack', '-q', '-adf']);
    const pack = packFiles(sb).find((f) => f.endsWith('.pack'))!;
    const idx = pack.replace(/\.pack$/, '.idx');
    nodefs.rmSync(idx);
    sb.git(['index-pack', '--index-version=1', '-o', idx, pack]);
    const data = nodefs.readFileSync(idx);
    // v1 has no magic header.
    expect(data.readUInt32BE(0)).not.toBe(0xff744f63);
    expect(parsePackIndex(new Uint8Array(data))?.version).toBe(1);
    await expectAllObjectsMatch(sb);
  });

  it('uses the 64-bit offset table of v2 .idx files', async () => {
    sb = createGitSandbox();
    buildDeltaHistory(sb, 10);
    sb.git(['repack', '-q', '-adf']);
    const pack = packFiles(sb).find((f) => f.endsWith('.pack'))!;
    const idx = pack.replace(/\.pack$/, '.idx');
    nodefs.rmSync(idx);
    // Force every object after the first (offset 12) into the large-offset
    // table (git rejects an .idx where all N objects use it).
    sb.git(['index-pack', '--index-version=2,12', '-o', idx, pack]);
    const data = new Uint8Array(nodefs.readFileSync(idx));
    const view = new DataView(data.buffer, data.byteOffset);
    const n = view.getUint32(8 + 255 * 4);
    const offsetsStart = 8 + 1024 + n * 24;
    let large = 0;
    for (let i = 0; i < n; i++) {
      if (view.getUint32(offsetsStart + i * 4) & 0x80000000) large++;
    }
    expect(large).toBe(n - 1);
    // Offsets resolved through the 64-bit table match git's own view.
    const parsed = parsePackIndex(data)!;
    const verify = sb.git(['verify-pack', '-v', idx]);
    for (let i = 0; i < n; i++) {
      const re = new RegExp(`^${parsed.oids[i]} \\w+ +\\d+ \\d+ (\\d+)`, 'm');
      expect(parsed.offsets[i]).toBe(parseInt(verify.match(re)![1], 10));
    }
    await expectAllObjectsMatch(sb);
  });

  it('picks up packs added after the cache was populated', async () => {
    sb = createGitSandbox();
    sb.write('a.txt', 'a\n');
    gitCommitAll(sb, 'one');
    sb.git(['repack', '-q', '-ad']);
    await expectAllObjectsMatch(sb);

    sb.write('b.txt', 'b\n');
    gitCommitAll(sb, 'two');
    const head = sb.git(['rev-parse', 'HEAD']).trim();
    // New pack containing only the new objects; loose copies removed.
    sb.git(['repack', '-q', '-d']);
    sb.git(['prune-packed']);
    expect(countLooseObjects(sb)).toBe(0);
    // No invalidatePackCache: lookup miss must rescan the pack directory.
    expect(await hasObject(sb.fs, sb.gitdir, head)).toBe(true);
    const obj = await readObject(sb.fs, sb.gitdir, head);
    expect(obj.type).toBe('commit');
    const oids = await listPackedOids(sb.fs, sb.gitdir);
    expect(oids).toContain(head);
  });

  it('ignores junk .idx files (e.g. AppleDouble ._ files)', async () => {
    sb = createGitSandbox();
    sb.write('a.txt', 'a\n');
    gitCommitAll(sb, 'one');
    sb.git(['repack', '-q', '-ad']);
    const idx = packFiles(sb).find((f) => f.endsWith('.idx'))!;
    nodefs.writeFileSync(
      path.join(path.dirname(idx), 'junk.idx'),
      Buffer.from('not an index'),
    );
    await expectAllObjectsMatch(sb);
  });
});
