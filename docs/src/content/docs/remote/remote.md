---
title: remote
description: Manage the set of repositories you track.
---

Equivalent to `git remote`.

## GitClient

```typescript
await git.addRemote(name: string, url: string, fetchRefspecs?: string[]): Promise<RemoteInfo>
await git.removeRemote(name: string): Promise<void>
await git.listRemotes(): Promise<RemoteInfo[]>
await git.setRemoteUrl(name: string, url: string, push?: boolean): Promise<void>
await git.setUpstream(branch: string, remote: string, merge: string): Promise<void>
```

```typescript
await git.addRemote('origin', 'https://example.com/team/project.git');
await git.listRemotes();
// [{ name: 'origin', url: 'https://…', fetch: ['+refs/heads/*:refs/remotes/origin/*'] }]
```

```typescript
interface RemoteInfo {
  name: string;
  url: string;
  pushUrl?: string; // remote.<name>.pushurl, used by push when set
  fetch: string[];  // fetch refspecs
}
```

## Behaviour

- `addRemote` writes `[remote "<name>"]` with `url` and the default refspec `+refs/heads/*:refs/remotes/<name>/*` (or the refspecs you pass). It throws `AlreadyExistsError` if the remote exists and `InvalidRefError` for invalid names.
- `removeRemote` deletes the config section, its remote-tracking refs and any `branch.*` upstream settings pointing at it, like `git remote remove`. Unknown names throw `RemoteNotFoundError`.
- `setRemoteUrl(name, url, true)` sets `pushurl` (`git remote set-url --push`).
- `setUpstream` writes `branch.<branch>.remote` and `branch.<branch>.merge` (`git branch --set-upstream-to`).

## Standalone functions

```typescript
import {
  addRemote,
  removeRemote,
  listRemotes,
  getRemote,
  setRemoteUrl,
  setUpstream,
} from '@keydown-dev/ts-git';
```
