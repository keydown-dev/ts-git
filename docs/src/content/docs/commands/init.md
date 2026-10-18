---
title: init
description: Initialize a new Git repository.
---

Create an empty Git repository: the `.git` directory structure, a default config, an empty index and a `HEAD` that points at the default branch.

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

### Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });

await git.init();

console.log(await fs.readFileString('/my-repo/.git/HEAD'));
// 'ref: refs/heads/main'
```

## Standalone function

```typescript
import { init, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();

await init({ fs, dir: '/my-repo', defaultBranch: 'main' });
```

| Option          | Type        | Default        | Description                                  |
| --------------- | ----------- | -------------- | -------------------------------------------- |
| `fs`            | `FSAdapter` | **required**   | Filesystem adapter                           |
| `dir`           | `string`    | **required**   | Working tree root                            |
| `gitdir`        | `string`    | `<dir>/.git`   | Git directory. Must be an absolute path      |
| `defaultBranch` | `string`    | `'master'`     | Initial branch name                          |

`init` throws `InvalidGitDirError` if `gitdir` is provided but isn't absolute.

## What gets created

```
.git/
├── HEAD              ref: refs/heads/<defaultBranch>
├── config            [core] defaults + [init] defaultBranch
├── description
├── index             empty, version 2
├── hooks/
├── info/
├── objects/{info,pack}/
└── refs/{heads,tags,remotes}/
```

The branch itself doesn't exist until the first commit, just as with the Git CLI. `listBranches()` returns an empty `branches` array until then.

## See also

- [add](/commands/add/): stage files
- [commit](/commands/commit/): create the first commit
