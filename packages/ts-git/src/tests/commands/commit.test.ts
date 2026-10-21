import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import { init } from '../../commands/init.js';
import { add } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import { log } from '../../commands/log.js';
import {
  listBranchesCommand,
  branch,
  deleteBranch,
} from '../../commands/branch.js';
import { readRef } from '../../core/refs.js';

describe('commit', () => {
  let fs: MemoryFS;

  beforeEach(() => {
    fs = new MemoryFS();
  });

  it('should create a commit', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'hello world');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    const oid = await commit({
      fs,
      dir: '/repo',
      message: 'Initial commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    expect(oid).toHaveLength(40);

    const commits = await log({ fs, dir: '/repo' });
    expect(commits).toHaveLength(1);
    expect(commits[0].commit.message).toBe('Initial commit\n');
  });

  it('should create commit with explicit parent', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    const oid1 = await commit({
      fs,
      dir: '/repo',
      message: 'First commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await fs.writeFile('/repo/file2.txt', 'content2');
    await add({ fs, dir: '/repo', filepath: 'file2.txt' });

    await commit({
      fs,
      dir: '/repo',
      message: 'Second commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    const commits = await log({ fs, dir: '/repo' });
    expect(commits).toHaveLength(2);
    expect(commits[0].commit.parent).toContain(oid1);
  });

  it('should track author with timestamp', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    const timestamp = Math.floor(Date.now() / 1000);

    await commit({
      fs,
      dir: '/repo',
      message: 'Test commit',
      author: { name: 'Test', email: 'test@example.com', timestamp },
    });

    const commits = await log({ fs, dir: '/repo' });
    expect(commits[0].commit.author.timestamp).toBe(timestamp);
  });

  it('should throw error for empty commit', async () => {
    await init({ fs, dir: '/repo' });

    await expect(
      commit({
        fs,
        dir: '/repo',
        message: 'Empty commit',
        author: { name: 'Test', email: 'test@example.com' },
      }),
    ).rejects.toThrow();
  });

  it('should throw error for same-tree commit (nothing changed)', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    await commit({
      fs,
      dir: '/repo',
      message: 'First commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    // Try to commit again without any changes
    await expect(
      commit({
        fs,
        dir: '/repo',
        message: 'Second commit with no changes',
        author: { name: 'Test', email: 'test@example.com' },
      }),
    ).rejects.toThrow('nothing to commit');
  });

  it('should work with detached HEAD', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content1');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    const oid1 = await commit({
      fs,
      dir: '/repo',
      message: 'First commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    // Detach HEAD by writing commit OID directly
    await fs.writeFile('/repo/.git/HEAD', oid1);

    // Add new content
    await fs.writeFile('/repo/file2.txt', 'content2');
    await add({ fs, dir: '/repo', filepath: 'file2.txt' });
    const oid2 = await commit({
      fs,
      dir: '/repo',
      message: 'Second commit in detached HEAD',
      author: { name: 'Test', email: 'test@example.com' },
    });

    // Verify HEAD was updated to new commit OID
    const headContent = await fs.readFileString('/repo/.git/HEAD');
    expect(headContent.trim()).toBe(oid2);

    // Verify log shows both commits
    const commits = await log({ fs, dir: '/repo' });
    expect(commits).toHaveLength(2);
  });

  it('should handle full ref path', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    const oid = await commit({
      fs,
      dir: '/repo',
      message: 'Initial commit',
      author: { name: 'Test', email: 'test@example.com' },
      ref: 'refs/heads/feature', // Full ref path
    });

    // Verify the branch was created
    const ref = await readRef(fs, '/repo/.git', 'refs/heads/feature');
    expect(ref).toBe(oid);
  });

  it('should work with custom gitdir', async () => {
    await init({ fs, dir: '/repo', gitdir: '/repo/custom-git' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({
      fs,
      dir: '/repo',
      filepath: 'file.txt',
      gitdir: '/repo/custom-git',
    });

    const oid = await commit({
      fs,
      dir: '/repo',
      gitdir: '/repo/custom-git',
      message: 'Initial commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    expect(oid).toHaveLength(40);

    const { log: logFn } = await import('../../commands/log.js');
    const commits = await logFn({
      fs,
      dir: '/repo',
      gitdir: '/repo/custom-git',
    });
    expect(commits).toHaveLength(1);
    expect(commits[0].commit.message).toBe('Initial commit\n');
  });

  it('should support dry run mode', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    const oid = await commit({
      fs,
      dir: '/repo',
      message: 'Dry run commit',
      author: { name: 'Test', email: 'test@example.com' },
      dryRun: true,
    });

    expect(oid).toHaveLength(40);

    const commits = await log({ fs, dir: '/repo' });
    expect(commits).toHaveLength(0);
  });

  it('should support noUpdateBranch mode', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    await commit({
      fs,
      dir: '/repo',
      message: 'First commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await fs.writeFile('/repo/file2.txt', 'content2');
    await add({ fs, dir: '/repo', filepath: 'file2.txt' });

    await commit({
      fs,
      dir: '/repo',
      message: 'Second commit',
      author: { name: 'Test', email: 'test@example.com' },
      noUpdateBranch: true,
    });

    const commits = await log({ fs, dir: '/repo' });
    expect(commits).toHaveLength(1);
  });
});

describe('branch', () => {
  let fs: MemoryFS;

  beforeEach(() => {
    fs = new MemoryFS();
  });

  it('should create a branch', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Initial commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await branch({ fs, dir: '/repo', ref: 'feature' });

    const ref = await readRef(fs, '/repo/.git', 'refs/heads/feature');
    expect(ref).toHaveLength(40);
  });

  it('should list branches', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Initial commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await branch({ fs, dir: '/repo', ref: 'feature' });

    const result = await listBranchesCommand({ fs, dir: '/repo' });

    expect(result.branches).toContain('master');
    expect(result.branches).toContain('feature');
    expect(result.current).toBe('master');
  });

  it('should delete a branch', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Initial commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await branch({ fs, dir: '/repo', ref: 'feature' });
    await deleteBranch({ fs, dir: '/repo', ref: 'feature' });

    const result = await listBranchesCommand({ fs, dir: '/repo' });
    expect(result.branches).not.toContain('feature');
  });

  it('should create and checkout a new branch', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Initial commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await branch({ fs, dir: '/repo', ref: 'feature', checkout: true });

    const head = await fs.readFileString('/repo/.git/HEAD');
    expect(head.trim()).toBe('ref: refs/heads/feature');
  });

  it('should force overwrite existing branch', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    await commit({
      fs,
      dir: '/repo',
      message: 'First commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await branch({ fs, dir: '/repo', ref: 'feature' });

    await fs.writeFile('/repo/file2.txt', 'content2');
    await add({ fs, dir: '/repo', filepath: 'file2.txt' });
    const oid2 = await commit({
      fs,
      dir: '/repo',
      message: 'Second commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await branch({
      fs,
      dir: '/repo',
      ref: 'feature',
      object: oid2,
      force: true,
    });

    const ref = await readRef(fs, '/repo/.git', 'refs/heads/feature');
    expect(ref).toBe(oid2);
  });

  it('should throw error when deleting current branch', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Initial commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await expect(
      deleteBranch({ fs, dir: '/repo', ref: 'master' }),
    ).rejects.toThrow();
  });

  it('should create branch at specific commit', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    const commitOid = await commit({
      fs,
      dir: '/repo',
      message: 'First commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await fs.writeFile('/repo/file2.txt', 'content2');
    await add({ fs, dir: '/repo', filepath: 'file2.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Second commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    await branch({ fs, dir: '/repo', ref: 'at-first', object: commitOid });

    const ref = await readRef(fs, '/repo/.git', 'refs/heads/at-first');
    expect(ref).toBe(commitOid);
  });
});
