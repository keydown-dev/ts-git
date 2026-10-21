import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import { GitClient } from '../../client/index.js';
import { checkoutTree } from '../../commands/checkout-helpers.js';
import { readIndex } from '../../core/index.js';
import { CheckoutConflictError } from '../../errors.js';

const author = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1700000000,
  timezoneOffset: 0,
};

describe('checkout on MemoryFS via GitClient', () => {
  let fs: MemoryFS;
  let git: GitClient;

  beforeEach(async () => {
    fs = new MemoryFS();
    git = new GitClient({ fs, dir: '/repo' });
    await git.init();
    await fs.writeFile('/repo/a.txt', 'a1');
    await fs.writeFile('/repo/run.sh', 'echo');
    await fs.chmod('/repo/run.sh', 0o755);
    await fs.writeFile('/repo/gone.txt', 'gone');
    await git.addAll();
    await git.commit('base', author);
    await git.branch('feature', true);
    await fs.writeFile('/repo/a.txt', 'a2');
    await fs.writeFile('/repo/dir/new.txt', 'new');
    await fs.unlink('/repo/gone.txt');
    await git.addAll();
    await git.commit('feature', { ...author, timestamp: author.timestamp + 1 });
  });

  it('switches index and worktree, restoring modes and removed files', async () => {
    await git.checkoutBranch('master');
    expect(await fs.readFileString('/repo/a.txt')).toBe('a1');
    expect(await fs.readFileString('/repo/gone.txt')).toBe('gone');
    expect(await fs.exists('/repo/dir')).toBe(false);
    expect((await fs.stat('/repo/run.sh')).mode & 0o111).not.toBe(0);
    expect((await git.listBranches()).current).toBe('master');

    const index = await readIndex(fs, '/repo/.git');
    expect(index.entries.map((e) => e.path)).toEqual([
      'a.txt',
      'gone.txt',
      'run.sh',
    ]);
    const matrix = await git.statusMatrix();
    expect(matrix.every(([, h, w, s]) => h === 1 && w === 1 && s === 1)).toBe(
      true,
    );
  });

  it('refuses to overwrite local changes, then force-discards them', async () => {
    await fs.writeFile('/repo/a.txt', 'local');
    await expect(git.checkoutBranch('master')).rejects.toThrow(
      CheckoutConflictError,
    );
    expect(await fs.readFileString('/repo/a.txt')).toBe('local');
    expect((await git.listBranches()).current).toBe('feature');

    await git.checkoutBranch('master', { force: true });
    expect(await fs.readFileString('/repo/a.txt')).toBe('a1');
  });

  it('carries unrelated local changes across the switch', async () => {
    await fs.writeFile('/repo/run.sh', 'echo changed');
    await git.checkoutBranch('master');
    expect(await fs.readFileString('/repo/run.sh')).toBe('echo changed');
  });

  it('dryRun validates without touching anything', async () => {
    const result = await checkoutTree({
      fs,
      dir: '/repo',
      to: (await git.log())[1].oid,
      dryRun: true,
    });
    expect(result.updated.sort()).toEqual(['a.txt', 'gone.txt']);
    expect(result.removed).toEqual(['dir/new.txt']);
    expect(await fs.readFileString('/repo/a.txt')).toBe('a2');
  });

  it('reset --hard via GitClient restores tracked files', async () => {
    await fs.writeFile('/repo/a.txt', 'dirty');
    await fs.writeFile('/repo/untracked.txt', 'u');
    await git.reset(undefined, { mode: 'hard', ref: 'HEAD~1' });
    expect(await fs.readFileString('/repo/a.txt')).toBe('a1');
    expect(await fs.readFileString('/repo/untracked.txt')).toBe('u');
    expect(await fs.exists('/repo/dir/new.txt')).toBe(false);
    expect((await git.log()).length).toBe(1);
  });
});
