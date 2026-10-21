---
title: How TS-Git Works
description: The building blocks of TS-Git, from filesystem adapters and the .git layout to GitClient and the standalone command functions.
---

TS-Git is a re-implementation of Git's on-disk formats and core commands in TypeScript. It has no native code and does not shell out to `git`. Every operation is a sequence of reads and writes through a filesystem adapter you provide.

## The layers

```
CommandParser       optional, @keydown-dev/ts-git/cli       "git commit -m msg"
      │
GitClient           remembers fs, dir and defaults           git.add('README.md')
      │
Command functions   init, add, commit, status, log,          add({ fs, dir, filepath })
      │             branch, checkout, reset, diff, merge,
      │             clone, fetch, push, pull, catFile, ...
      │
Core + remote       objects (zlib + SHA-1), refs, index,      smart HTTP / local
      │             config, packfiles, .gitignore             transports
      │
FSAdapter           MemoryFS, or your own Node / Tauri / browser adapter
```

### FSAdapter

All I/O goes through the [`FSAdapter`](/filesystem/overview/) interface: about fifteen async methods such as `readFile`, `writeFile`, `readdir`, `stat` and `mkdir`. TS-Git doesn't care whether the bytes end up in memory, on disk, in IndexedDB or behind a Tauri command. The package ships [`MemoryFS`](/filesystem/memory/) and you can [write your own adapter](/filesystem/custom/) for anything else.

### Core

The core modules implement Git's data formats:

- **Objects**: blobs, trees and commits are serialized in Git's format, hashed with SHA-1 (via the Web Crypto API, `crypto.subtle`) and stored zlib-compressed (via [`fflate`](https://github.com/101arrowz/fflate)) under `.git/objects/`. Objects can be read from loose files or from packfiles, so repositories created or cloned by the regular Git CLI can be read.
- **Refs**: `HEAD`, branches under `refs/heads/`, and `packed-refs`.
- **Index**: the binary staging-area file (`.git/index`), versions 2 and 3.
- **Config**: `.git/config` is parsed and written in Git's INI-like format.
- **Ignore rules**: `.gitignore` files are honoured when walking the working tree.
- **Remote transports**: Git's smart HTTP protocol over `fetch` (`HttpTransport`) and repositories reachable through an adapter (`LocalTransport`), plus pack building and indexing for push and fetch. See [Working with remotes](/remote/overview/).

Many of these primitives (`readObject`, `writeObject`, `readRef`, `readIndex`, `parseConfig` and so on) are exported from the package entry point if you need lower-level access.

### Command functions

Each Git command is a plain async function that takes a single options object. They are stateless: you pass the adapter and repository location every time.

```typescript
import { MemoryFS, init, add, commit } from '@keydown-dev/ts-git';

const fs = new MemoryFS();
const dir = '/repo';

await init({ fs, dir, defaultBranch: 'main' });
await fs.writeFile(`${dir}/hello.txt`, 'hello\n');
await add({ fs, dir, filepath: 'hello.txt' });
await commit({
  fs,
  dir,
  message: 'Add hello.txt',
  author: { name: 'Ada', email: 'ada@example.com' },
});
```

Every command accepts these common options:

| Option   | Type        | Description                                                                   |
| -------- | ----------- | ----------------------------------------------------------------------------- |
| `fs`     | `FSAdapter` | The filesystem adapter to read and write through.                             |
| `dir`    | `string`    | The working tree root.                                                        |
| `gitdir` | `string`    | Optional. The Git directory. Defaults to `<dir>/.git`. Must be absolute for `init`. |

### GitClient

[`GitClient`](/concepts/git-client/) wraps the command functions and remembers `fs`, `dir`, `gitdir`, the default branch and your diff algorithm, so calls stay short:

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

const git = new GitClient({ fs: new MemoryFS(), dir: '/repo' });
await git.init();
```

`GitClient` covers the everyday and remote porcelain commands. The [plumbing commands](/plumbing/cat-file/) and some advanced options (such as committing onto another ref with explicit parents, bare repositories or `log` from another revision) are only available as standalone functions. See [When to use the standalone functions](/concepts/git-client/#when-to-use-the-standalone-functions-instead).

### CommandParser

The optional [`CommandParser`](/cli/command-parser/) in `@keydown-dev/ts-git/cli` parses command strings such as `git diff --cached --stat` and runs them against a `GitClient`. It's intended for embedded terminals and REPL-style UIs.

## Paths

- `dir` and `gitdir` are paths **as understood by your adapter**. With `MemoryFS` that means POSIX-style absolute paths such as `/repo`.
- `filepath` arguments to commands like `add`, `remove`, `status` and `reset` are **relative to `dir`**, for example `src/index.ts`, not `/repo/src/index.ts`.
- When you write files yourself, use the full adapter path: `fs.writeFile('/repo/src/index.ts', ...)`.

## The working tree

TS-Git manages the `.git` directory and, like git, updates the working tree when a command calls for it. Creating and editing your own files is up to you, through the same adapter. Some consequences:

- [`checkout`](/commands/checkout/), [`reset`](/commands/reset/) with `mode: 'hard'`, [`merge`](/remote/merge/), [`pull`](/remote/pull/) and [`clone`](/remote/clone/) write working-tree files. They refuse to overwrite local changes (throwing `CheckoutConflictError`) unless forced.
- [`remove`](/commands/remove/) removes a path from the index only (like `git rm --cached`). It doesn't delete the file.
- [`reset`](/commands/reset/) with paths, or in `soft` / `mixed` mode, only touches `HEAD` and the index.

## Errors

Commands throw typed errors that extend `TsGitError`, so you can branch on them with `instanceof`:

```typescript
import { NotAGitRepoError, AlreadyExistsError } from '@keydown-dev/ts-git';

try {
  await git.branch('main');
} catch (err) {
  if (err instanceof AlreadyExistsError) {
    // branch already exists
  } else if (err instanceof NotAGitRepoError) {
    // dir has no .git directory
  } else {
    throw err;
  }
}
```

Other exported error classes include `NotFoundError`, `ObjectNotFoundError`, `InvalidRefError`, `EmptyCommitError`, `CheckoutConflictError`, `UnmergedPathsError`, `MergeConflictError`, `NonFastForwardError`, `PushRejectedError`, `HttpError` and `IndexParseError`.

## Next steps

- [GitClient](/concepts/git-client/): the full method reference
- [Filesystem adapters](/filesystem/overview/): choose or build a storage backend
- [Roadmap & limitations](/roadmap/): what is and isn't implemented yet
