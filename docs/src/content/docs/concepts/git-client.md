---
title: GitClient
description: Reference for GitClient, the stateful convenience wrapper around TS-Git's command functions.
---

`GitClient` binds a filesystem adapter and a repository directory together so you don't have to pass `{ fs, dir, gitdir }` to every call. Each method delegates to the matching [command function](/concepts/architecture/#command-functions).

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

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
| `remote`            | `RemoteOptions`     | `{}`           | Defaults for `clone`, `fetch`, `push` and `pull`: `http`, `corsProxy`, `headers`, `auth`, `onAuth`, `onAuthFailure`, `onProgress`, `transport`. Per-call options win. See [Working with remotes](/remote/overview/) |

Every method except `init()`, `isWorkspaceReady()`, `isGitRepository()` and `getRemoteOptions()` throws `Error('Directory not set.')` if `dir` is `null`.

## Methods

| Method                                 | Returns                       | Docs                                       |
| -------------------------------------- | ----------------------------- | ------------------------------------------ |
| `init(options?)`                       | `Promise<void>`               | [init](/commands/init/)                    |
| `add(filepath, options?)`              | `Promise<void>`               | [add](/commands/add/)                      |
| `addAll()`                             | `Promise<void>`               | [add](/commands/add/#stage-all-changes)    |
| `remove(filepath, options?)`           | `Promise<void>`               | [remove](/commands/remove/)                |
| `commit(message, author, options?)`    | `Promise<string>` (commit OID) | [commit](/commands/commit/)               |
| `status(filepath)`                     | `Promise<string>`             | [status](/commands/status/)                |
| `statusMatrix()`                       | `Promise<StatusRow[]>`        | [status](/commands/status/#status-matrix)  |
| `log(depth?)`                          | `Promise<LogEntry[]>` (from `HEAD`, in `git log` order) | [log](/commands/log/) |
| `branch(ref, checkout?, options?)`     | `Promise<void>`               | [branch](/commands/branch/)                |
| `listBranches()`                       | `Promise<{ branches; current }>` | [branch](/commands/branch/)             |
| `deleteBranch(ref, force?)`            | `Promise<void>`               | [branch](/commands/branch/)                |
| `checkoutBranch(ref, options?)`        | `Promise<CheckoutTreeResult>` | [checkout](/commands/checkout/)            |
| `reset(filepath?, options?)`           | `Promise<string[]>` (changed index paths) | [reset](/commands/reset/)      |
| `diff(options?)`                       | `Promise<DiffResult>`         | [diff](/commands/diff/)                    |
| `clone(url, options?)`                 | `Promise<CloneResult>`        | [clone](/remote/clone/)                    |
| `addRemote(name, url, fetchRefspecs?)` | `Promise<RemoteInfo>`         | [remote](/remote/remote/)                  |
| `removeRemote(name)`                   | `Promise<void>`               | [remote](/remote/remote/)                  |
| `listRemotes()`                        | `Promise<RemoteInfo[]>`       | [remote](/remote/remote/)                  |
| `setRemoteUrl(name, url, push?)`       | `Promise<void>`               | [remote](/remote/remote/)                  |
| `setUpstream(branch, remote, merge)`   | `Promise<void>`               | [remote](/remote/remote/)                  |
| `fetch(options?)`                      | `Promise<FetchResult>`        | [fetch](/remote/fetch/)                    |
| `push(options?)`                       | `Promise<PushResult>`         | [push](/remote/push/)                      |
| `pull(options?)`                       | `Promise<PullResult>`         | [pull](/remote/pull/)                      |
| `merge(theirs, options?)`              | `Promise<MergeResult>`        | [merge](/remote/merge/)                    |
| `abortMerge()`                         | `Promise<void>`               | [merge](/remote/merge/)                    |
| `getRemoteOptions()`                   | `RemoteOptions`               | A copy of the constructor's `remote` defaults |
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

`GitClient` exposes the common options (`force`, `recursive`, `committer`, `allowEmpty`, `cleanup`, `object`, `detach`, `mode`, `ref`, and every remote and merge option). Reach for the command functions directly when you need, for example:

- `commit({ ..., ref, parent, dryRun, noUpdateBranch })` to commit onto another branch, with explicit parents, or without moving any ref
- `init({ ..., bare: true })` to create a bare repository
- the `AddResult` returned by `add` / `addAll` (the client methods return `void`), or `addAll({ ..., force: true })`
- the full `ResetResult` (including the new `HEAD` OID) from `reset`
- `checkoutTree({ ..., to, dryRun })` to update the index and working tree without moving `HEAD`
- [`statusPorcelain` / `statusEntries`](/commands/status/#porcelain-output) for output identical to `git status --porcelain`, including untracked modes, ignored files and unmerged codes
- `statusMatrix({ ..., filepaths, filter })` to limit which files are checked
- `log({ ..., ref, firstParent })` to walk history from another branch, tag or revision, or to follow first parents only
- [`resolveDiffSpecs`](/commands/diff/#resolvediffspecs) to turn `A..B`, `A...B` (merge base) and `-- paths` arguments into `diff` sides
- the [plumbing commands](/plumbing/cat-file/), which have no `GitClient` methods

```typescript
import { commit } from '@keydown-dev/ts-git';

// Commit the current index onto `refs/heads/import` with an explicit parent,
// without touching HEAD or the checked-out branch.
await commit({
  fs,
  dir: '/repo',
  message: 'Imported from upstream',
  author: { name: 'Ada', email: 'ada@example.com' },
  ref: 'refs/heads/import',
  parent: [oid],
});
```
