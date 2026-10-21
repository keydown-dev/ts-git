---
title: pull
description: Fetch from a remote and merge its branch into the current one.
---

Equivalent to `git pull --no-rebase [<remote>] [<branch>]`: a [fetch](/remote/fetch/) followed by a [merge](/remote/merge/) of the upstream branch.

## GitClient

```typescript
await git.pull(options?: {
  remote?: string;                         // default: the branch's upstream remote, else 'origin'
  ref?: string;                            // remote branch to merge; default: the upstream branch
  fastForward?: 'auto' | 'only' | 'never'; // default: pull.ff config, else 'auto'
  prune?: boolean;
  tags?: 'auto' | boolean;
  author?: Author;                         // for merge commits; default: user.name / user.email
  committer?: Author;
  // shared remote options: auth, onAuth, onAuthFailure, corsProxy, http, headers, onProgress, transport
}): Promise<{ fetch: FetchResult; merge: MergeResult }>
```

```typescript
const { merge } = await git.pull();
if (merge.type === 'fast-forward') console.log('now at', merge.oid);
```

## Behaviour

- The branch to merge comes from `branch.<name>.remote` / `branch.<name>.merge` (set by `clone` and `push({ setUpstream: true })`), or from `ref`. Without either, pull throws, explaining there is no tracking information.
- Merge commits get git's message: `Merge branch 'main' of https://host/repo`.
- Conflicts behave exactly like [merge](/remote/merge/): the repository is left mid-merge and `MergeConflictError` is thrown.
- `pull.ff = only` / `false` in the config are honoured. `pull.rebase` is not supported; pulls always merge.
