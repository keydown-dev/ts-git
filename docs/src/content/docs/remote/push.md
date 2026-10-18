---
title: push
description: Update remote refs along with the objects they need.
---

Equivalent to `git push [<remote>] [<refspec>...]`.

## GitClient

```typescript
await git.push(options?: {
  remote?: string;       // name, URL or path; default: upstream remote, else 'origin'
  refspecs?: string[];   // 'main', 'main:release', '+feature', ':old-branch', 'refs/heads/*:refs/heads/*'
  force?: boolean;       // --force
  delete?: boolean;      // treat refspecs as remote refs to delete (--delete)
  tags?: boolean;        // also push all tags (--tags)
  setUpstream?: boolean; // record the upstream (-u)
  atomic?: boolean;      // all refs update or none (--atomic)
  // shared remote options: auth, onAuth, corsProxy, http, headers, onProgress, transport
}): Promise<PushResult>
```

```typescript
await git.push({ setUpstream: true });            // current branch → same name on origin
await git.push({ refspecs: ['v1.2.0'] });         // a tag
await git.push({ refspecs: [':stale-branch'] });  // delete a remote branch
```

Without `refspecs`, the current branch is pushed to its upstream branch if one is configured for that remote, otherwise to a branch of the same name.

### Results and rejections

`PushResult.refs` lists every ref with a status: `new`, `fast-forward`, `forced`, `deleted`, `up-to-date`, `rejected` (refused locally) or `remote-rejected` (refused by the server, e.g. a protected branch or a checked-out branch of a non-bare repo).

If any ref is rejected, `push` throws `PushRejectedError`; its `refs` property carries the same per-ref results so you can tell what landed:

```typescript
import { PushRejectedError } from '@keydown-app/ts-git';

try {
  await git.push();
} catch (e) {
  if (e instanceof PushRejectedError) {
    const r = e.refs[0];
    if (r.reason === 'fetch first' || r.reason === 'non-fast-forward') {
      await git.pull();
      await git.push();
    }
  }
}
```

## Behaviour

- Non-fast-forward updates are refused unless forced. If the remote ref points to a commit you have never fetched, the reason is `fetch first`, exactly as git reports.
- Existing remote tags are not moved unless forced.
- Only objects the remote is missing are sent.
- After a successful push the matching remote-tracking refs (`refs/remotes/origin/*`) are updated.

## Standalone function

```typescript
import { push } from '@keydown-app/ts-git';

await push({ fs, dir: '/repo', remote: 'origin', refspecs: ['main'], auth });
```
