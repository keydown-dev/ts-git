---
title: branch
description: List, create and delete branches.
---

Manage the branches under `refs/heads/`, including those stored in `packed-refs`.

## GitClient methods

### Create a branch

```typescript
await git.branch(
  ref: string,
  checkout?: boolean,
  options?: { object?: string; force?: boolean },
): Promise<void>
```

Creates `refs/heads/<ref>`, like `git branch <ref> [<start-point>]`.

| Parameter        | Type      | Default | Description                                                                 |
| ---------------- | --------- | ------- | --------------------------------------------------------------------------- |
| `ref`            | `string`  |         | Branch name (a leading `refs/heads/` is accepted and stripped)             |
| `checkout`       | `boolean` | `false` | Also switch to the new branch, like `git checkout -b` / `git switch -c`     |
| `options.object` | `string`  | `HEAD`  | Start point: any revision that resolves to a commit (see below)             |
| `options.force`  | `boolean` | `false` | Reset an existing branch to the start point (`git branch -f`)               |

With `checkout: true` and a start point other than the current commit, the index and working tree are updated exactly as in [`checkoutBranch`](/commands/checkout/): unrelated local changes are kept, and a `CheckoutConflictError` is thrown (before the branch is created) if local changes would be overwritten.

### List branches

```typescript
await git.listBranches(): Promise<{ branches: string[]; current: string | null }>
```

`branches` is sorted alphabetically and includes loose and packed branches. `current` is the full name of the checked-out branch (for example `'feature/login'`), or `null` when `HEAD` is detached.

### Delete a branch

```typescript
await git.deleteBranch(ref: string, force?: boolean): Promise<void>
```

Like `git branch -d` (or `-D` with `force`). The branch's `[branch "<name>"]` config section (upstream settings) is removed along with the ref, and a branch that is both loose and packed is removed from both places.

## Branch names

Names are validated like `git check-ref-format --branch`, using the exported `isValidBranchName(name)` helper. Names that start with `-`, equal `HEAD`, contain `..`, `@{`, spaces, control characters or any of `~^:?*[\`, end in `.`, have a path component that starts with `.` or ends in `.lock`, or contain empty components (`a//b`, a trailing `/`) are rejected with `InvalidRefError`. Nested names such as `feature/login` are fine, but a branch can't be created where it would clash with an existing one as a file/directory (`feature` vs `feature/login`); that also throws `InvalidRefError`.

```typescript
import { isValidBranchName } from '@keydown-app/ts-git';

isValidBranchName('feature/login'); // true
isValidBranchName('bad..name'); // false
```

## Start points

The start point (`object`) can be anything Git's `rev-parse` would resolve to a commit: a full or unique abbreviated OID, a branch, tag or remote-tracking branch name (`main`, `v1.0`, `origin/main`), a full ref name, `HEAD`, or a revision with `~N` / `^N` suffixes such as `HEAD~2`. Annotated tags are peeled to their commit.

## Errors

| Situation                                                        | Error                |
| ---------------------------------------------------------------- | -------------------- |
| Invalid branch name                                              | `InvalidRefError`    |
| Start point doesn't resolve, or isn't a commit                   | `InvalidRefError`    |
| No start point and `HEAD` has no commit yet (unborn branch)      | `InvalidRefError`    |
| Branch exists and `force` isn't set                              | `AlreadyExistsError` |
| `force` would move the currently checked-out branch              | `InvalidRefError`    |
| `checkout: true` and local changes would be overwritten          | `CheckoutConflictError` |
| Deleting a branch that doesn't exist                             | `NotFoundError`      |
| Deleting the current branch                                      | `InvalidRefError`    |
| Deleting an unmerged branch without `force`                      | `InvalidRefError`    |

### When is a branch "merged"?

Without `force`, `deleteBranch` follows `git branch -d`: the branch tip must be reachable from

1. its upstream (`branch.<name>.remote` / `branch.<name>.merge`), if one is configured and the remote-tracking ref exists, or otherwise
2. the current `HEAD` commit.

On an unborn `HEAD` with no upstream, nothing counts as merged, so `force` is required.

## Standalone functions

```typescript
import {
  branch,
  listBranchesCommand,
  deleteBranch,
  checkoutBranch,
} from '@keydown-app/ts-git';
```

### branch

```typescript
await branch({ fs, dir, ref, object?, checkout?, force? }): Promise<string>
```

Returns the OID the new branch points at.

| Option     | Type        | Default      | Description                                         |
| ---------- | ----------- | ------------ | --------------------------------------------------- |
| `fs`       | `FSAdapter` | **required** | Filesystem adapter                                  |
| `dir`      | `string`    | **required** | Working tree root                                   |
| `gitdir`   | `string`    | `<dir>/.git` | Git directory                                       |
| `ref`      | `string`    | **required** | Branch name                                         |
| `object`   | `string`    | `HEAD`       | Start point revision                                |
| `checkout` | `boolean`   | `false`      | Switch to the new branch (index and working tree too) |
| `force`    | `boolean`   | `false`      | Reset the branch if it already exists               |

### listBranchesCommand

```typescript
await listBranchesCommand({ fs, dir }): Promise<{ branches: string[]; current: string | null }>
```

### deleteBranch

```typescript
await deleteBranch({ fs, dir, ref, force? }): Promise<void>
```

| Option  | Type      | Default      | Description                                         |
| ------- | --------- | ------------ | --------------------------------------------------- |
| `ref`   | `string`  | **required** | Branch name to delete                               |
| `force` | `boolean` | `false`      | Delete even if not merged into its upstream or `HEAD` |

### checkoutBranch

See [checkout](/commands/checkout/).

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });
const author = { name: 'John Doe', email: 'john@example.com' };

await git.init();

await fs.writeFile('/my-repo/README.md', '# Project');
await git.add('README.md');
await git.commit('Initial commit', author);

console.log(await git.listBranches());
// { branches: ['main'], current: 'main' }

// Create a branch and switch to it
await git.branch('feature', true);

console.log(await git.listBranches());
// { branches: ['feature', 'main'], current: 'feature' }

// Start a branch at an earlier commit without switching
await fs.writeFile('/my-repo/README.md', '# Project v2');
await git.add('README.md');
await git.commit('Update README', author);
await git.branch('hotfix', false, { object: 'HEAD~1' });

// Switch back. 'feature' has a commit main doesn't, so it needs force
await git.checkoutBranch('main');
await git.deleteBranch('feature', true);
await git.deleteBranch('hotfix'); // merged into main: no force needed

console.log((await git.listBranches()).branches); // ['main']
```

## See also

- [checkout](/commands/checkout/): switch branches
- [commit](/commands/commit/): create commits
