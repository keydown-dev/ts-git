import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as nodefs from 'fs';
import { NodeFSAdapter } from '../../fs/node-adapter.js';
import { readObject } from '../../core/objects.js';
import { log } from '../../commands/log.js';
import { lsTree, formatLsTree } from '../../commands/ls-tree.js';
import { catFile } from '../../commands/cat-file.js';
import {
  extractGoldenRepo,
  cleanupGoldenRepo,
} from '../interoperability/fixture-helpers.js';

/**
 * Read side against the packed golden fixture repository (created by
 * canonical git): every object, the full log of every branch and
 * recursive ls-tree output must match git.
 */
describe('golden repository read by ts-git matches git', () => {
  let dir: string;
  let home: string;
  let fs: NodeFSAdapter;
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      maxBuffer: 64 * 1024 * 1024,
    });

  beforeAll(async () => {
    dir = await extractGoldenRepo();
    home = nodefs.mkdtempSync(path.join(os.tmpdir(), 'ts-git-golden-home-'));
    fs = new NodeFSAdapter(dir);
  });
  afterAll(async () => {
    await cleanupGoldenRepo(dir);
    nodefs.rmSync(home, { recursive: true, force: true });
  });

  it('reads every object identically (packed, with deltas)', async () => {
    const objects = git(['cat-file', '--batch-all-objects', '--batch-check'])
      .toString()
      .split('\n')
      .filter((l) => /^[0-9a-f]{40} /.test(l))
      .map((l) => l.split(' '));
    expect(objects.length).toBeGreaterThan(20);
    for (const [oid, type] of objects) {
      const obj = await readObject(fs, path.join(dir, '.git'), oid);
      expect(obj.type).toBe(type);
      expect(
        Buffer.from(obj.content).equals(git(['cat-file', type, oid])),
      ).toBe(true);
      const pretty = await catFile({ fs, dir, oid, pretty: true });
      if (type !== 'blob') {
        expect(pretty).toBe(git(['cat-file', '-p', oid]).toString());
      }
    }
  });

  it('log and ls-tree match for every branch', async () => {
    const branches = git(['for-each-ref', '--format=%(refname)', 'refs/heads'])
      .toString()
      .split('\n')
      .filter(Boolean);
    expect(branches.length).toBeGreaterThan(1);
    for (const ref of branches) {
      const expected = git(['log', '--format=%H', ref])
        .toString()
        .split('\n')
        .filter(Boolean);
      const ours = (await log({ fs, dir, ref })).map((e) => e.oid);
      expect(ours, ref).toEqual(expected);

      const tree = formatLsTree(
        await lsTree({ fs, dir, tree: ref, recursive: true, showTrees: true }),
      );
      expect(tree, ref).toBe(git(['ls-tree', '-r', '-t', ref]).toString());
    }
  });
});
