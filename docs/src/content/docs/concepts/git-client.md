---
title: GitClient
description: Reference for GitClient, the stateful convenience wrapper around TS-Git's command functions.
---

`GitClient` binds a filesystem adapter and a repository directory together so you don't have to pass `{ fs, dir, gitdir }` to every call. Each method delegates to the matching [command function](/concepts/architecture/#command-functions).

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const git = new GitClient({ fs: new MemoryFS(), dir: '/repo' });
```

## Constructor

```typescript
new GitClient(options: GitClientOptions)
```

| Option              | Type                | Default        | Description                                                                                       |
| ------------------- | ------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `fs`                | `FSAdapter`         | **required**   | Filesystem adapter used for all reads and writes                                                  |
| `dir`               | `string \| null`    | `null`         | Working tree root. Can be set later via `init({ dir })`                                           |
| `gitdir`            | `string`            | `<dir>/.git`   | Git directory                                                                                     |
| `defaultBranch`     | `string \| null`    | `'master'`     | Initial branch used by `init()`                                                                   |
| `lineDiffAlgorithm` | `LineDiffAlgorithm` | `undefined`    | Default algorithm for `diff()`. See [diff](/commands/diff/#line-diff-algorithm)                    |

Every method except `init()`, `isWorkspaceReady()` and `isGitRepository()` throws `Error('Directory not set.')` if `dir` is `null`.

## Methods

| Method                                 | Returns                       | Docs                                       |
| -------------------------------------- | ----------------------------- | ------------------------------------------ |
| `init(options?)`                       | `Promise<void>`               | [init](/commands/init/)                    |
| `add(filepath)`                        | `Promise<void>`               | [add](/commands/add/)                      |
| `addAll()`                             | `Promise<void>`               | [add](/commands/add/#stage-all-changes)    |
| `remove(filepath)`                     | `Promise<void>`               | [remove](/commands/remove/)                |
| `commit(message, author)`              | `Promise<string>` (commit OID) | [commit](/commands/commit/)               |
| `status(filepath)`                     | `Promise<string>`             | [status](/commands/status/)                |
| `statusMatrix()`                       | `Promise<StatusRow[]>`        | [status](/commands/status/#status-matrix)  |
| `log(depth?)`                          | `Promise<LogEntry[]>`         | [log](/commands/log/)                      |
| `branch(ref, checkout?)`               | `Promise<void>`               | [branch](/commands/branch/)                |
| `listBranches()`                       | `Promise<{ branches; current }>` | [branch](/commands/branch/)             |
| `deleteBranch(ref, force?)`            | `Promise<void>`               | [branch](/commands/branch/)                |
| `checkoutBranch(ref)`                  | `Promise<void>`               | [checkout](/commands/checkout/)            |
| `reset(filepath?)`                     | `Promise<string[]>` (unstaged paths) | [reset](/commands/reset/)           |
| `diff(options?)`                       | `Promise<DiffResult>`         | [diff](/commands/diff/)                    |
| `isGitRepository()`                    | `Promise<boolean>`            | Whether `gitdir` exists                    |
| `isWorkspaceReady()`                   | `boolean`                     | Whether `dir` is set                       |
| `requireRepository()`                  | `{ dir; gitdir? }`            | Returns paths or throws if `dir` is unset  |

## Late-bound directories

In apps where the user picks a folder after startup, create the client without a `dir` and supply it later. `init()` merges any options you pass into the client before running:

```typescript
const git = new GitClient({ fs });

git.isWorkspaceReady(); // false

await git.init({ dir: '/projects/notes', defaultBranch: 'main' });

git.isWorkspaceReady(); // true
await git.isGitRepository(); // true
```

## Opening an existing repository

There is no separate "open" step. Point `dir` at a folder that already contains `.git` and start calling methods:

```typescript
const git = new GitClient({ fs: myAdapter, dir: '/existing-repo' });

if (await git.isGitRepository()) {
  const [latest] = await git.log(1);
  console.log(latest?.commit.message);
}
```

## When to use the standalone functions instead

`GitClient` exposes the common options only. Reach for the command functions directly when you need, for example:

- `commit({ ..., committer, ref, parent, dryRun, noUpdateBranch })`
- `branch({ ..., object, force })` to create a branch at a specific commit
- `add({ ..., filepath: ['a.ts', 'b.ts'] })` or `remove` with several paths at once
- `statusMatrix({ ..., filepaths, filter })` to limit which files are checked
- `log({ ..., gitdir })` with a non-default Git directory per call
- the [plumbing commands](/plumbing/cat-file/), which have no `GitClient` methods

```typescript
import { commit } from '@keydown-app/ts-git';

await commit({
  fs,
  dir: '/repo',
  message: 'Imported from upstream',
  author: { name: 'Ada', email: 'ada@example.com' },
  committer: { name: 'Import Bot', email: 'bot@example.com' },
});
```
