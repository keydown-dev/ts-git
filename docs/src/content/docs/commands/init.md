---
title: init
description: Initialize a new Git repository.
---

Create an empty Git repository, like `git init`: the `.git` directory structure, a default config, an empty index and a `HEAD` that points at the default branch.

Running `init` on a directory that is already a repository is safe, like Git's "Reinitialized existing Git repository": missing directories (and `info/exclude`) are recreated, but the existing `HEAD`, `config`, `index`, `description` and history are left untouched.

## GitClient method

```typescript
await git.init(options?: Partial<GitClientOptions>): Promise<void>
```

Any options you pass are merged into the client first, then the repository is created using the client's `fs`, `dir`, `gitdir` and `defaultBranch`.

| Option                  | Type             | Default            | Description                                      |
| ----------------------- | ---------------- | ------------------ | ------------------------------------------------ |
| `options.dir`           | `string \| null` | (from constructor) | Working tree root                                |
| `options.gitdir`        | `string`         | (from constructor) | Git directory (absolute). Defaults to `<dir>/.git` |
| `options.defaultBranch` | `string \| null` | (from constructor) | Initial branch name. Client default is `'master'`  |

`GitClient.init()` always creates a non-bare repository. Use the standalone function for a bare one.

### Example

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });

await git.init();

console.log(await fs.readFileString('/my-repo/.git/HEAD'));
// 'ref: refs/heads/main'
```

## Standalone function

```typescript
import { init, MemoryFS } from '@keydown-dev/ts-git';

const fs = new MemoryFS();

await init({ fs, dir: '/my-repo', defaultBranch: 'main' });
```

| Option          | Type        | Default        | Description                                  |
| --------------- | ----------- | -------------- | -------------------------------------------- |
| `fs`            | `FSAdapter` | **required**   | Filesystem adapter                           |
| `dir`           | `string`    | **required**   | Working tree root                            |
| `gitdir`        | `string`    | `<dir>/.git`   | Git directory. Must be an absolute path      |
| `defaultBranch` | `string`    | `'master'`     | Initial branch name                          |
| `bare`          | `boolean`   | `false`        | Create a bare repository (see below)         |

`init` throws `InvalidGitDirError` if `gitdir` is provided but isn't absolute, and `InvalidRefError` if `defaultBranch` isn't a valid branch name (nested names such as `'feature/x'` are fine).

### Bare repositories

With `bare: true` the repository is created directly in `dir` (unless `gitdir` is given), `core.bare` is set to `true` and no index is written:

```typescript
await init({ fs, dir: '/srv/project.git', bare: true });
// /srv/project.git/HEAD, /srv/project.git/config, /srv/project.git/objects/ ...
```

## What gets created

```
.git/
├── HEAD              ref: refs/heads/<defaultBranch>
├── config            [core] defaults + [init] defaultBranch
├── description
├── index             empty, version 2 (not created for bare repositories)
├── hooks/
├── info/exclude      Git's default template
├── objects/{info,pack}/
└── refs/{heads,tags}/
```

Like Git, `init` probes whether the filesystem keeps the executable bit (by toggling it on `.git/config` through the adapter's `chmod`) and records the result as `core.filemode`. Adapters without `chmod` get `core.filemode = false`.

The branch itself doesn't exist until the first commit, just as with the Git CLI. `listBranches()` returns an empty `branches` array until then.

## See also

- [add](/commands/add/): stage files
- [commit](/commands/commit/): create the first commit
