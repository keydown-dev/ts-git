import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import { init } from '../../commands/init.js';
import { add } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import { deleteBranch, checkoutBranch } from '../../commands/branch.js';
import { deleteRef, readRef, listBranches, listRefs } from '../../core/refs.js';
import { InvalidRefError } from '../../errors.js';

const author = {
  name: 'A',
  email: 'a@example.com',
  timestamp: 1700000000,
  timezoneOffset: 0,
};

describe('ref names cannot escape refs/', () => {
  let fs: MemoryFS;
  beforeEach(async () => {
    fs = new MemoryFS();
    await init({ fs, dir: '/r', defaultBranch: 'main' });
    await fs.writeFile('/r/a.txt', 'a\n');
    await add({ fs, dir: '/r', filepath: 'a.txt' });
    await commit({ fs, dir: '/r', message: 'one', author });
  });

  it('deleteBranch rejects names with ".." and leaves HEAD alone', async () => {
    for (const name of ['../../HEAD', '../tags/v1', 'a/../../config']) {
      await expect(
        deleteBranch({ fs, dir: '/r', ref: name, force: true }),
      ).rejects.toBeInstanceOf(InvalidRefError);
    }
    expect(await fs.exists('/r/.git/HEAD')).toBe(true);
    expect(await fs.exists('/r/.git/config')).toBe(true);
  });

  it('deleteRef refuses invalid names', async () => {
    await expect(
      deleteRef(fs, '/r/.git', 'refs/heads/../../HEAD'),
    ).rejects.toBeInstanceOf(InvalidRefError);
    expect(await fs.exists('/r/.git/HEAD')).toBe(true);
  });

  it('readRef treats invalid names as missing', async () => {
    expect(await readRef(fs, '/r/.git', '../../HEAD')).toBeNull();
    expect(await readRef(fs, '/r/.git', 'refs/heads/../../config')).toBeNull();
    await expect(
      checkoutBranch({ fs, dir: '/r', ref: '../../HEAD' }),
    ).rejects.toThrow();
    expect(await fs.readFileString('/r/.git/HEAD')).toContain(
      'refs/heads/main',
    );
  });

  it('does not list stale .lock files as refs', async () => {
    const head = await readRef(fs, '/r/.git', 'refs/heads/main');
    await fs.writeFile('/r/.git/refs/heads/main.lock', `${head}\n`);
    expect(await listBranches(fs, '/r/.git')).toEqual(['main']);
    expect([...(await listRefs(fs, '/r/.git')).keys()]).toEqual([
      'refs/heads/main',
    ]);
  });
});
