---
title: MemoryFS
description: The built-in in-memory filesystem adapter.
---

`MemoryFS` is a complete in-memory implementation of [`FSAdapter`](/filesystem/overview/), including directories, symlinks, file stats and the optional `chmod`, so executable bits work like on disk (`core.fileMode` is `true`). Nothing is persisted: data lives as long as the object does.

## Usage

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

const fs = new MemoryFS();
// or: const fs = createMemoryFS();

const git = new GitClient({ fs, dir: '/my-repo' });
await git.init();
```

## When to use it

- **Tests**: fast, isolated and free of side effects. TS-Git's own test suite uses it.
- **Demos and sandboxes**: an interactive Git playground in the browser with no setup.
- **Ephemeral work**: build commits in memory and inspect or export the objects afterwards.

## Behaviour

- Paths are POSIX-style. Leading, trailing and repeated slashes are ignored, so `/repo/a.txt` and `repo/a.txt` refer to the same file.
- `writeFile` creates missing parent directories automatically.
- `writeFile` accepts a `string` (encoded as UTF-8) or a `Uint8Array`. There is no encoding argument.
- Errors use Node-style codes in the message, e.g. `ENOENT: no such file, open '/repo/missing.txt'`.

## Extra methods

On top of the `FSAdapter` interface, `MemoryFS` provides:

| Method    | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| `clone()` | Deep copy of the whole filesystem: a cheap snapshot for tests     |
| `reset()` | Remove everything and start from an empty root                   |

```typescript
const snapshot = fs.clone();

// Experiment on the original...
await fs.writeFile('/my-repo/scratch.txt', 'temporary');
await git.add('scratch.txt');

// ...then carry on from the snapshot, as if it never happened
const restored = new GitClient({ fs: snapshot, dir: '/my-repo' });
await restored.status('scratch.txt'); // 'absent'
```

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

async function testGitOperations() {
  const fs = new MemoryFS();
  const git = new GitClient({ fs, dir: '/test-repo', defaultBranch: 'main' });

  await git.init();

  await fs.writeFile('/test-repo/README.md', '# Test\n');
  await fs.writeFile('/test-repo/src/index.ts', 'export {};\n');

  await git.add('README.md');
  await git.add('src');

  const oid = await git.commit('Initial commit', {
    name: 'Test User',
    email: 'test@example.com',
  });

  const commits = await git.log();
  console.assert(commits.length === 1);
  console.assert(commits[0].oid === oid);
  console.assert(commits[0].commit.message === 'Initial commit');
}

testGitOperations().catch(console.error);
```

## Limitations

- Not persistent across page reloads or process restarts.
- Everything is held in memory, so very large repositories aren't a good fit.

## See also

- [NodeFSAdapter](/filesystem/node/): persistent storage on disk
- [Creating custom adapters](/filesystem/custom/): build your own
