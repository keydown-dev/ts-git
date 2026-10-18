---
title: merge
description: Join another line of history into the current branch.
---

Equivalent to `git merge <commit>`.

## GitClient

```typescript
await git.merge(theirs: string, options?: {
  fastForward?: 'auto' | 'only' | 'never'; // --ff (default) / --ff-only / --no-ff
  message?: string;                        // default: "Merge branch 'feature'" etc.
  theirsLabel?: string;                    // name in conflict markers (default: theirs as given)
  author?: Author;                         // default: user.name / user.email from config
  committer?: Author;
}): Promise<MergeResult>

await git.abortMerge(); // git merge --abort
```

`theirs` can be a branch (`feature`), remote-tracking branch (`origin/main`), tag or commit id.

```typescript
type MergeResult =
  | { type: 'up-to-date'; oid: string }
  | { type: 'fast-forward'; oid: string; previous: string | null }
  | { type: 'merge'; oid: string; previous: string; mergeBase: string | null };
```

## Behaviour

- **Fast-forward** when the current branch is an ancestor of `theirs` (unless `fastForward: 'never'`). `fastForward: 'only'` throws `NonFastForwardError` otherwise.
- **Three-way merge**: files changed on one side are taken as-is; files changed on both sides are merged line by line using git's rules (changes touching adjacent lines conflict, identical changes merge cleanly). The resulting tree, default message and commit are identical to what `git merge` produces.
- **Local changes**: staged changes make the merge refuse (`UncommittedChangesError`). Unstaged changes are kept unless the merge needs to touch those files, in which case `CheckoutConflictError` is thrown and nothing is modified.

### Conflicts

On conflicts the repository is left exactly as git leaves it, and `MergeConflictError` is thrown with the conflicted `paths`:

- conflicted files contain `<<<<<<< HEAD` / `=======` / `>>>>>>> feature` markers;
- the index holds stages 1 (base), 2 (ours) and 3 (theirs), so `statusMatrix` / `git status` show them as unmerged;
- `.git/MERGE_HEAD` and `.git/MERGE_MSG` are written.

Resolve the files, `add` them and `commit` — the commit gets both parents automatically — or call `abortMerge()` to go back.

```typescript
import { MergeConflictError } from '@keydown-app/ts-git';

try {
  await git.merge('feature');
} catch (e) {
  if (!(e instanceof MergeConflictError)) throw e;
  for (const path of e.paths) await resolveInEditor(path);
  for (const path of e.paths) await git.add(path);
  await git.commit("Merge branch 'feature'", author);
}
```

Binary files and symlinks changed on both sides can't be merged line by line; they conflict with "ours" left in the working tree.

## Standalone functions

```typescript
import { merge, abortMerge, isMerging } from '@keydown-app/ts-git';
```
