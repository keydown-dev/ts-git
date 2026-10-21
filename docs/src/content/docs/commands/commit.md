---
title: commit
description: Record the staged changes as a new commit.
---

Write a tree from the current index, create a commit object pointing at it and advance the current branch, like `git commit -m`. Commits are byte-for-byte identical to the ones the Git CLI creates for the same index, message, identities and timestamps.

## GitClient method

```typescript
await git.commit(
  message: string,
  author: Author,
  options?: {
    committer?: Author;
    allowEmpty?: boolean;
    allowEmptyMessage?: boolean;
    cleanup?: 'whitespace' | 'strip' | 'verbatim';
  },
): Promise<string>
```

| Parameter                   | Type      | Default        | Description                                                      |
| --------------------------- | --------- | -------------- | ---------------------------------------------------------------- |
| `message`                   | `string`  |                | Commit message (cleaned up, see [Message cleanup](#message-cleanup)) |
| `author`                    | `Author`  |                | Author identity                                                  |
| `options.committer`         | `Author`  | `author`       | Committer identity, if different from the author                 |
| `options.allowEmpty`        | `boolean` | `false`        | Allow a commit that changes nothing (`--allow-empty`)            |
| `options.allowEmptyMessage` | `boolean` | `false`        | Allow an empty message after cleanup (`--allow-empty-message`)   |
| `options.cleanup`           | `string`  | `'whitespace'` | Message cleanup mode (`--cleanup`)                               |

Returns the 40-character SHA-1 of the new commit.

### Author

```typescript
interface Author {
  name: string;
  email: string;
  timestamp?: number; // seconds since the Unix epoch, defaults to now
  timezoneOffset?: number; // minutes, defaults to the local offset
}
```

Like Git, leading and trailing "crud" (whitespace and characters such as `.,:;<>"'`) is trimmed from the name and email, and `<`, `>` and newlines are dropped. An empty name throws `TsGitError` ("empty ident name not allowed").

## Standalone function

```typescript
import { commit } from '@keydown-dev/ts-git';

const oid = await commit({ fs, dir, message, author });
```

| Option              | Type        | Default        | Description                                                          |
| ------------------- | ----------- | -------------- | -------------------------------------------------------------------- |
| `fs`                | `FSAdapter` | **required**   | Filesystem adapter                                                   |
| `dir`               | `string`    | **required**   | Working tree root                                                    |
| `gitdir`            | `string`    | `<dir>/.git`   | Git directory                                                        |
| `message`           | `string`    | **required**   | Commit message                                                       |
| `author`            | `Author`    | **required**   | Author identity                                                      |
| `committer`         | `Author`    | `author`       | Committer identity, if different from the author                     |
| `ref`               | `string`    | current branch | Branch to update instead, e.g. `'release'` or `'refs/heads/release'` |
| `parent`            | `string[]`  | `HEAD` commit  | Explicit parent commit OIDs                                          |
| `dryRun`            | `boolean`   | `false`        | Write the commit object but don't move any ref                       |
| `noUpdateBranch`    | `boolean`   | `false`        | Don't update the branch or `HEAD` after committing                   |
| `allowEmpty`        | `boolean`   | `false`        | Allow a commit that changes nothing                                  |
| `allowEmptyMessage` | `boolean`   | `false`        | Allow an empty message after cleanup                                 |
| `cleanup`           | `CommitCleanupMode` | `'whitespace'` | `'whitespace'`, `'strip'` or `'verbatim'`                    |

Where the commit goes:

- On a branch, the branch `HEAD` points to is advanced. This also works on an unborn branch, including nested names such as `feature/x`.
- On a detached `HEAD`, `HEAD` itself is moved and no branch is touched.
- With `ref`, that branch is updated instead and `HEAD` is left alone.

## Message cleanup

By default the message is cleaned up the way `git commit -m` does it (`--cleanup=whitespace`): trailing whitespace is stripped from every line, leading and trailing blank lines are dropped, runs of blank lines collapse to one, and the message ends with exactly one newline. So `'Initial commit'` is stored as `'Initial commit\n'`.

| Mode           | Behaviour                                                                 |
| -------------- | ------------------------------------------------------------------------- |
| `'whitespace'` | The default, described above                                              |
| `'strip'`      | Like `'whitespace'`, and also removes lines starting with `#`             |
| `'verbatim'`   | Stores the message exactly as given, like `git commit-tree`               |

A message that is empty after cleanup throws `TsGitError` ("Aborting commit due to empty commit message.") unless `allowEmptyMessage` is set.

The same function is exported as `cleanupMessage(message, mode?)` if you need to preview the stored message.

## Empty commits

Like Git, `commit` refuses to record "nothing to commit" unless `allowEmpty` is set:

- If the index tree equals the parent commit's tree, it throws `EmptyCommitError` ("nothing to commit, working tree clean").
- An initial commit with an empty index throws `EmptyCommitError` ("nothing to commit").

Passing explicit `parent` OIDs behaves like `git commit-tree` and skips the check. Concluding a merge (below) also skips it.

```typescript
import { EmptyCommitError } from '@keydown-dev/ts-git';

try {
  await git.commit('WIP', author);
} catch (err) {
  if (!(err instanceof EmptyCommitError)) throw err;
}

// Record a commit without changes on purpose
await git.commit('Trigger CI', author, { allowEmpty: true });
```

## Unmerged entries and merges

If the index has unmerged (conflicted) entries, `commit` throws `UnmergedPathsError` ("Committing is not possible because you have unmerged files") and lists them in its `paths`. Resolve them by staging the fixed files with [`add`](/commands/add/) first.

When `.git/MERGE_HEAD` exists (a merge stopped on conflicts) and no explicit `parent` is passed, the commit concludes the merge: the commits in `MERGE_HEAD` become additional parents after `HEAD`, and `MERGE_HEAD`, `MERGE_MSG` and `MERGE_MODE` are removed once the branch is updated.

## Example

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

const fs = new MemoryFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });
const author = { name: 'John Doe', email: 'john@example.com' };

await git.init();

await fs.writeFile('/my-repo/README.md', '# My Project\n');
await git.add('README.md');
const first = await git.commit('Initial commit', author);

await fs.writeFile('/my-repo/src/index.ts', 'console.log("hello");\n');
await git.add('src/index.ts');
await git.commit('Add index.ts', author);

const commits = await git.log();
console.log(commits.length); // 2
console.log(commits[1].oid === first); // true
console.log(commits[1].commit.message); // 'Initial commit\n'
```

## See also

- [add](/commands/add/): stage files
- [log](/commands/log/): read commit history
