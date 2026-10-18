import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { catFile, catFileRaw } from '../../commands/cat-file.js';
import { invalidatePackCache } from '../../core/packfile.js';
import {
  createGitSandbox,
  listAllObjects,
  type GitSandbox,
} from './git-env.js';
import { buildPlumbingRepo } from './plumbing-fixture.js';

const REVISIONS = [
  'HEAD',
  'main',
  'refs/heads/side',
  'HEAD~1',
  'HEAD^2',
  'HEAD^1~1',
  'HEAD^{tree}',
  'HEAD^{commit}',
  'HEAD:src',
  'HEAD:src/lib/util.js',
  'side:side.txt',
  ':README.md',
  'light',
  'v1',
  'v1^{}',
  'v1^{commit}',
  'v1-outer',
  'v1-outer^{tag}',
  'v1-outer^{}',
  'v1-outer^{tree}',
  'tree-tag',
  'tree-tag^{}',
  'blob-tag^{blob}',
  'tags/v1',
];

for (const packed of [false, true]) {
  describe(`cat-file vs git cat-file (${packed ? 'packed' : 'loose'} objects)`, () => {
    let sb: GitSandbox;

    beforeAll(() => {
      sb = createGitSandbox();
      buildPlumbingRepo(sb);
      if (packed) {
        sb.git(['gc', '-q', '--aggressive']);
        sb.git(['prune-packed']);
      }
      invalidatePackCache(sb.fs);
    });
    afterAll(() => sb.cleanup());

    const cat = (oid: string, flags: Record<string, boolean>) =>
      catFile({ fs: sb.fs, dir: sb.dir, oid, ...flags });

    it('-t, -s and -p match for every object in the repository', async () => {
      const objects = listAllObjects(sb);
      expect(new Set(objects.map((o) => o.type))).toEqual(
        new Set(['blob', 'tree', 'commit', 'tag']),
      );
      for (const { oid, type, size } of objects) {
        expect(await cat(oid, { typeOnly: true })).toBe(type);
        expect(await cat(oid, { sizeOnly: true })).toBe(String(size));
        const gitPretty = sb.gitBytes(['cat-file', '-p', oid]);
        if (type === 'blob') {
          const raw = await catFileRaw({ fs: sb.fs, dir: sb.dir, oid });
          expect(Buffer.from(raw.content).equals(gitPretty)).toBe(true);
        } else {
          expect(await cat(oid, { pretty: true })).toBe(
            gitPretty.toString('utf8'),
          );
        }
      }
    });

    it('resolves revisions like git rev-parse / cat-file', async () => {
      for (const rev of REVISIONS) {
        const expected = sb.git(['rev-parse', '--verify', '-q', rev]).trim();
        const raw = await catFileRaw({ fs: sb.fs, dir: sb.dir, oid: rev });
        expect(raw.oid, rev).toBe(expected);
        expect(await cat(rev, { typeOnly: true }), rev).toBe(
          sb.git(['cat-file', '-t', rev]).trim(),
        );
      }
    });

    it('accepts abbreviated object names', async () => {
      const head = sb.git(['rev-parse', 'HEAD']).trim();
      for (const len of [4, 7, 12]) {
        const abbrev = head.slice(0, len);
        const r = sb.gitTry(['rev-parse', '--verify', '-q', abbrev]);
        if (r.status !== 0) continue; // ambiguous in git too
        const raw = await catFileRaw({ fs: sb.fs, dir: sb.dir, oid: abbrev });
        expect(raw.oid).toBe(head);
      }
    });

    it('-e reports existence like git', async () => {
      const head = sb.git(['rev-parse', 'HEAD']).trim();
      expect(await cat(head, { exists: true })).toBe('true');
      const missing = 'f'.repeat(40);
      expect(sb.gitTry(['cat-file', '-e', missing]).status).not.toBe(0);
      expect(await cat(missing, { exists: true })).toBe('false');
      expect(await cat('no-such-ref', { exists: true })).toBe('false');
      await expect(cat(missing, {})).rejects.toThrow();
    });

    it('returns parsed commit, tree and tag objects', async () => {
      const head = sb.git(['rev-parse', 'HEAD']).trim();
      const commit = await cat(head, {});
      expect(typeof commit).toBe('object');
      if (typeof commit !== 'object' || commit.type !== 'commit') {
        throw new Error('expected commit');
      }
      expect(commit.tree).toBe(sb.git(['rev-parse', 'HEAD^{tree}']).trim());
      expect(commit.parent).toEqual(
        sb.git(['rev-parse', 'HEAD^1', 'HEAD^2']).trim().split('\n'),
      );
      expect(commit.message).toBe('merge side\n');
      expect(commit.author.name).toBe('A U Thor');

      const tree = await cat('HEAD^{tree}', {});
      if (typeof tree !== 'object' || tree.type !== 'tree') {
        throw new Error('expected tree');
      }
      const gitTree = sb
        .git(['ls-tree', '-z', 'HEAD^{tree}'])
        .split('\0')
        .filter(Boolean)
        .map((l) => {
          const tab = l.indexOf('\t');
          const [meta, name] = [l.slice(0, tab), l.slice(tab + 1)];
          const [mode, type, oid] = meta.split(' ');
          return { mode, type, oid, path: name };
        });
      expect(tree.entries).toEqual(gitTree);

      const tag = await cat('v1-outer', {});
      if (typeof tag !== 'object' || tag.type !== 'tag') {
        throw new Error('expected tag');
      }
      expect(tag.objectType).toBe('tag');
      expect(tag.object).toBe(sb.git(['rev-parse', 'v1']).trim());
      expect(tag.tag).toBe('v1-outer');
      expect(tag.message).toBe('tag of tag\n');
    });
  });
}
