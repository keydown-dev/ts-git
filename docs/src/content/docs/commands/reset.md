---
title: reset
description: Unstage paths, or move the current branch with soft, mixed or hard resets.
---

`reset` follows `git reset` and has two forms.

**With paths** (`git reset [<ref>] -- <pathspec>...`), index entries matching the pathspecs are set to their version in `ref` (default `HEAD`). `HEAD` and the working tree are untouched. This is how you unstage changes:

- Tracked files with staged modifications go back to their `HEAD` version in the index.
- Staged new files are removed from the index (they become untracked again).
- Staged deletions are restored from `HEAD`.
- Unmerged (conflicted) entries for the path are replaced by the `HEAD` version.
- On an unborn branch (no commits yet), matching entries are simply removed.

Pathspecs can be exact paths, directories (everything below them), `'.'` or globs (`*`, `?`, `[...]`).

**Without paths** (`git reset [--soft | --mixed | --hard] [<ref>]`), the current branch (or a detached `HEAD`) is moved to `ref` (default `HEAD`), and the previous commit is recorded in `.git/ORIG_HEAD`:

| Mode                | Moves the branch | Resets the index | Resets the working tree |
| ------------------- | :--------------: | :--------------: | :---------------------: |
| `'soft'`            | yes              | no               | no                      |
| `'mixed'` (default) | yes              | yes              | no                      |
| `'hard'`            | yes              | yes              | yes (tracked files only) |

A hard reset overwrites and removes tracked files (anything in the index, including staged new files) to match the target commit, discarding local changes, but leaves untracked files alone. On an unborn branch the index is reset to the empty tree and no ref is moved.

## GitClient method

```typescript
await git.reset(
  filepath?: string | string[],
  options?: { ref?: string; mode?: 'soft' | 'mixed' | 'hard' },
): Promise<string[]>
```

| Parameter      | Type                 | Default   | Description                                                                 |
| -------------- | -------------------- | --------- | --------------------------------------------------------------------------- |
| `filepath`     | `string \| string[]` | (none)    | Pathspec(s) to reset. Omit (or pass `undefined`) for a whole-tree reset      |
| `options.ref`  | `string`             | `HEAD`    | Revision to reset to: a commit for whole-tree resets, any tree-ish with paths |
| `options.mode` | `ResetMode`          | `'mixed'` | `'soft'`, `'mixed'` or `'hard'`                                             |

Returns the paths whose index entries changed (empty for a soft reset).

Revisions are resolved like Git's `rev-parse`: OIDs (full or abbreviated), branch and tag names, `HEAD~1`, `main^2` and so on. Passing `mode: 'soft'` or `'hard'` together with paths throws `TsGitError` ("Cannot do soft reset with paths."), as in Git.

## Standalone function

```typescript
import { reset } from '@keydown-dev/ts-git';

await reset({ fs, dir, filepath?, ref?, mode? }): Promise<ResetResult>
```

| Option     | Type                 | Default      | Description                      |
| ---------- | -------------------- | ------------ | -------------------------------- |
| `fs`       | `FSAdapter`          | **required** | Filesystem adapter               |
| `dir`      | `string`             | **required** | Working tree root                |
| `gitdir`   | `string`             | `<dir>/.git` | Git directory                    |
| `filepath` | `string \| string[]` | (none)       | Pathspec(s) to reset             |
| `ref`      | `string`             | `HEAD`       | Revision to reset to             |
| `mode`     | `ResetMode`          | `'mixed'`    | `'soft'`, `'mixed'` or `'hard'`  |

```typescript
interface ResetResult {
  unstaged: string[]; // paths whose index entry changed
  oid?: string | null; // commit HEAD points to afterwards (null on an unborn branch)
}
```

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });
const author = { name: 'John Doe', email: 'john@example.com' };

await git.init();

await fs.writeFile('/my-repo/README.md', '# Project');
await git.add('README.md');
await git.commit('Initial commit', author);

// Stage a modification and a new file
await fs.writeFile('/my-repo/README.md', '# Updated Project');
await fs.writeFile('/my-repo/new.txt', 'new file');
await git.add(['README.md', 'new.txt']);

console.log(await git.status('README.md')); // 'modified'

// Unstage one file
console.log(await git.reset('README.md')); // ['README.md']
console.log(await git.status('README.md')); // '*modified'
console.log(await git.status('new.txt')); // 'added' (still staged)

// Unstage everything
await git.reset();
console.log(await git.status('new.txt')); // '*added'

// Commit, then undo the commit but keep its changes staged
await git.add(['README.md', 'new.txt']);
await git.commit('Second commit', author);
await git.reset(undefined, { mode: 'soft', ref: 'HEAD~1' });
console.log(await git.status('new.txt')); // 'added'

// Throw away all local changes to tracked files
await git.reset(undefined, { mode: 'hard' });
console.log(await fs.readFileString('/my-repo/README.md')); // '# Project'
console.log(await fs.exists('/my-repo/new.txt')); // false (it was staged, so it's removed)
```

## See also

- [add](/commands/add/): stage files
- [remove](/commands/remove/): stop tracking a path
- [checkout](/commands/checkout/): switch branches
