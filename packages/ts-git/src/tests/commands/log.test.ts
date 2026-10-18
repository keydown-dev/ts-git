import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import { init } from '../../commands/init.js';
import { add } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import { log, readCommit } from '../../commands/log.js';

describe('log', () => {
  let fs: MemoryFS;

  beforeEach(() => {
    fs = new MemoryFS();
  });

  it('should return empty array on empty repository', async () => {
    await init({ fs, dir: '/repo' });

    const result = await log({ fs, dir: '/repo' });

    expect(result).toEqual([]);
  });

  it('should return log with single commit', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });

    await commit({
      fs,
      dir: '/repo',
      message: 'Initial commit',
      author: { name: 'Test Author', email: 'test@example.com' },
    });

    const result = await log({ fs, dir: '/repo' });

    expect(result.length).toBe(1);
    expect(result[0].commit.message).toBe('Initial commit\n');
    expect(result[0].commit.author.name).toBe('Test Author');
    expect(result[0].commit.author.email).toBe('test@example.com');
  });

  it('should return log with multiple commits', async () => {
    await init({ fs, dir: '/repo' });

    await fs.writeFile('/repo/file1.txt', 'content1');
    await add({ fs, dir: '/repo', filepath: 'file1.txt' });
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
    });

    await fs.writeFile('/repo/file3.txt', 'content3');
    await add({ fs, dir: '/repo', filepath: 'file3.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Third commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    const result = await log({ fs, dir: '/repo' });

    expect(result.length).toBe(3);
    expect(result[0].commit.message).toBe('Third commit\n');
    expect(result[1].commit.message).toBe('Second commit\n');
    expect(result[2].commit.message).toBe('First commit\n');
  });

  it('should limit log depth', async () => {
    await init({ fs, dir: '/repo' });

    await fs.writeFile('/repo/file1.txt', 'content1');
    await add({ fs, dir: '/repo', filepath: 'file1.txt' });
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
    });

    await fs.writeFile('/repo/file3.txt', 'content3');
    await add({ fs, dir: '/repo', filepath: 'file3.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Third commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    const result = await log({ fs, dir: '/repo', depth: 2 });

    expect(result.length).toBe(2);
    expect(result[0].commit.message).toBe('Third commit\n');
    expect(result[1].commit.message).toBe('Second commit\n');
  });

  it('should include committer details', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    await commit({
      fs,
      dir: '/repo',
      message: 'Test commit',
      author: { name: 'Author', email: 'author@example.com' },
      committer: { name: 'Committer', email: 'committer@example.com' },
    });

    const result = await log({ fs, dir: '/repo' });

    expect(result[0].commit.committer.name).toBe('Committer');
    expect(result[0].commit.committer.email).toBe('committer@example.com');
  });

  it('should throw error for non-git repository', async () => {
    await fs.mkdir('/nonexistent', { recursive: true });

    await expect(log({ fs, dir: '/nonexistent' })).rejects.toThrow(
      'not a git repository',
    );
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

    // Detach HEAD
    await fs.writeFile('/repo/.git/HEAD', oid1);

    const result = await log({ fs, dir: '/repo' });

    expect(result.length).toBe(1);
    expect(result[0].commit.message).toBe('First commit\n');
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
    await commit({
      fs,
      dir: '/repo',
      gitdir: '/repo/custom-git',
      message: 'Test commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    const result = await log({ fs, dir: '/repo', gitdir: '/repo/custom-git' });

    expect(result.length).toBe(1);
    expect(result[0].commit.message).toBe('Test commit\n');
  });
});

describe('readCommit', () => {
  let fs: MemoryFS;

  beforeEach(() => {
    fs = new MemoryFS();
  });

  it('should read a specific commit by oid', async () => {
    await init({ fs, dir: '/repo' });
    await fs.writeFile('/repo/file.txt', 'content');
    await add({ fs, dir: '/repo', filepath: 'file.txt' });
    const commitOid = await commit({
      fs,
      dir: '/repo',
      message: 'Test commit',
      author: { name: 'Test', email: 'test@example.com' },
    });

    const result = await readCommit({ fs, dir: '/repo', oid: commitOid });

    expect(result.commit.message).toBe('Test commit\n');
    expect(result.oid).toBe(commitOid);
  });
});
