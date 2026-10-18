---
title: Quick Start
description: Create a repository, commit, branch and inspect history with TS-Git in a few minutes.
---

This guide walks through a first repository using the in-memory filesystem, so you can paste it into a browser console, a Node.js script or a test.

## 1. Create a filesystem and client

TS-Git does all of its I/O through a [filesystem adapter](/filesystem/overview/). `MemoryFS` keeps everything in memory:

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();

const git = new GitClient({
  fs,
  dir: '/my-repo',
  defaultBranch: 'main', // defaults to 'master'
});
```

## 2. Initialize the repository

```typescript
await git.init();
```

This creates `/my-repo/.git` with `HEAD` pointing at `refs/heads/main`, an empty index and a default config.

## 3. Write and stage a file

Working-tree files are written through the same adapter. Paths you pass to `fs` are full adapter paths, while paths you pass to `git` are **relative to `dir`**:

```typescript
await fs.writeFile('/my-repo/README.md', '# My Project\n\nHello World!\n');

await git.add('README.md');
```

`MemoryFS.writeFile` creates missing parent directories for you. To stage everything that changed, use `await git.addAll()`.

## 4. Commit

```typescript
const oid = await git.commit('Initial commit', {
  name: 'John Doe',
  email: 'john@example.com',
});

console.log('Created commit:', oid); // 40-character SHA-1
```

## 5. Check status

```typescript
console.log(await git.status('README.md')); // 'unmodified'

await fs.writeFile('/my-repo/README.md', '# My Project\n\nUpdated!\n');
console.log(await git.status('README.md')); // '*modified' (changed, not staged)

// Every file at once, as [filepath, head, workdir, stage] rows
console.log(await git.statusMatrix()); // [['README.md', 1, 2, 1]]
```

See [status](/commands/status/) for what each status string and matrix value means.

## 6. Branch

```typescript
await git.branch('feature', true); // create and switch to 'feature'

const { branches, current } = await git.listBranches();
console.log(branches, current); // ['feature', 'main'] 'feature'
```

## 7. View history

```typescript
const commits = await git.log();

for (const { oid, commit } of commits) {
  console.log(oid.slice(0, 7), commit.message);
}
```

## Complete example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

async function main() {
  const fs = new MemoryFS();
  const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });

  await git.init();

  await fs.writeFile('/my-repo/README.md', '# My Project\n');
  await git.add('README.md');

  const oid = await git.commit('Initial commit', {
    name: 'John Doe',
    email: 'john@example.com',
  });
  console.log('Created commit:', oid);

  const history = await git.log();
  console.log('History:', history.map((e) => e.commit.message));
}

main().catch(console.error);
```

## Next steps

- [Commands](/commands/init/): everything `GitClient` and the command functions can do
- [Filesystem adapters](/filesystem/overview/): persist repositories on disk or in the browser
- [diff](/commands/diff/): compare the worktree, index and commits
