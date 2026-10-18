---
title: branch
description: List, create and delete branches.
---

Manage the branches under `refs/heads/`, including those stored in `packed-refs`.

## GitClient methods

### Create a branch

```typescript
await git.branch(ref: string, checkout?: boolean): Promise<void>
```

Creates `refs/heads/<ref>` pointing at the current `HEAD` commit. Pass `checkout: true` to also point `HEAD` at the new branch. Throws `AlreadyExistsError` if the branch exists, and `InvalidRefError` if there are no commits yet.

### List branches

```typescript
await git.listBranches(): Promise<{ branches: string[]; current: string | null }>
```

`branches` is sorted alphabetically. `current` is the checked-out branch name, or `null` when `HEAD` is detached.

### Delete a branch

```typescript
await git.deleteBranch(ref: string, force?: boolean): Promise<void>
```

Refuses to delete the current branch. Unless `force` is `true`, it also refuses to delete a branch whose tip isn't reachable from `HEAD` (like `git branch -d` vs `git branch -D`). Both cases throw `InvalidRefError`. A missing branch throws `NotFoundError`.

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
| `ref`      | `string`    | **required** | Branch name, without `refs/heads/`                  |
| `object`   | `string`    | `HEAD`       | Commit OID to start the branch at                   |
| `checkout` | `boolean`   | `false`      | Point `HEAD` at the new branch                      |
| `force`    | `boolean`   | `false`      | Overwrite the branch if it already exists           |

### listBranchesCommand

```typescript
await listBranchesCommand({ fs, dir }): Promise<{ branches: string[]; current: string | null }>
```

### deleteBranch

```typescript
await deleteBranch({ fs, dir, ref, force? }): Promise<void>
```

| Option  | Type      | Default      | Description                              |
| ------- | --------- | ------------ | ---------------------------------------- |
| `ref`   | `string`  | **required** | Branch name to delete                    |
| `force` | `boolean` | `false`      | Delete even if not merged into `HEAD`    |

### checkoutBranch

See [checkout](/commands/checkout/).

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-app/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });

await git.init();

await fs.writeFile('/my-repo/README.md', '# Project');
await git.add('README.md');
await git.commit('Initial commit', {
  name: 'John Doe',
  email: 'john@example.com',
});

console.log(await git.listBranches());
// { branches: ['main'], current: 'main' }

// Create a branch and switch to it
await git.branch('feature', true);

console.log(await git.listBranches());
// { branches: ['feature', 'main'], current: 'feature' }

// Switch back and delete it (merged, so no force needed)
await git.checkoutBranch('main');
await git.deleteBranch('feature');

console.log((await git.listBranches()).branches); // ['main']
```

## See also

- [checkout](/commands/checkout/): switch branches
- [commit](/commands/commit/): create commits
