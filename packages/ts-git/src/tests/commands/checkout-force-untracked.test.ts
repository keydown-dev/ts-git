import { describe, it, expect } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import { init } from '../../commands/init.js';
import { add, remove } from '../../commands/add.js';
import { commit } from '../../commands/commit.js';
import { reset } from '../../commands/reset.js';

const author = {
  name: 'A',
  email: 'a@example.com',
  timestamp: 1700000000,
  timezoneOffset: 0,
};

describe('force checkout keeps untracked files', () => {
  it('reset --hard does not delete a file untracked with rm --cached', async () => {
    const fs = new MemoryFS();
    await init({ fs, dir: '/r', defaultBranch: 'main' });
    await fs.writeFile('/r/keep.txt', 'k\n');
    await add({ fs, dir: '/r', filepath: 'keep.txt' });
    const first = await commit({ fs, dir: '/r', message: 'one', author });
    await fs.writeFile('/r/other.txt', 'tracked\n');
    await add({ fs, dir: '/r', filepath: 'other.txt' });
    await commit({
      fs,
      dir: '/r',
      message: 'two',
      author: { ...author, timestamp: 1700000001 },
    });

    await remove({ fs, dir: '/r', filepath: 'other.txt' });
    await fs.writeFile('/r/other.txt', 'my local edits\n');
    await reset({ fs, dir: '/r', mode: 'hard', ref: first });

    expect(await fs.readFileString('/r/other.txt')).toBe('my local edits\n');
  });
});
