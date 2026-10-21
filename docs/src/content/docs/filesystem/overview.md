---
title: Overview
description: How TS-Git's pluggable filesystem adapters work, and which one to use.
---

TS-Git never touches storage directly. Every read and write goes through an object implementing the `FSAdapter` interface, which you pass to `GitClient` or to any command function. This is what lets the same Git code run in memory, on disk, in the browser or inside a desktop app.

```typescript
import { GitClient, MemoryFS } from '@keydown-dev/ts-git';

const git = new GitClient({ fs: new MemoryFS(), dir: '/my-repo' });
```

## The FSAdapter interface

```typescript
import type { FSAdapter, DirEntry, FileStats } from '@keydown-dev/ts-git';

interface FSAdapter {
  readFile(path: string): Promise<Uint8Array>;
  readFileString(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStats>;
  lstat(path: string): Promise<FileStats>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string, type?: 'dir' | 'file' | 'junction'): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>; // optional
}
```

`chmod` is optional. When present, `init` probes whether the executable bit survives a round trip and records the answer as `core.fileMode`, and checkout sets the executable bit on mode `100755` files. Without it, `init` records `core.fileMode = false`, so executable-bit changes are ignored (as Git does on filesystems without permissions) and files are checked out without the executable bit.

`DirEntry` and `FileStats` are plain data objects (booleans, not methods). See [Creating custom adapters](/filesystem/custom/) for their full shape and implementation tips.

## Available adapters

| Adapter                         | Where it lives                                      | Environment       | Persistent |
| ------------------------------- | --------------------------------------------------- | ----------------- | ---------- |
| [`MemoryFS`](/filesystem/memory/) | Exported from `@keydown-dev/ts-git`               | Anywhere          | No         |
| [`NodeFSAdapter`](/filesystem/node/) | In the source tree, not exported yet           | Node.js           | Yes        |
| `FileSystemAccessAdapter`       | Example app: `examples/with-zen-fs`                 | Chromium browsers | Yes        |
| `TauriFSAdapter`                | Example app: `examples/with-tauri-fs`               | Tauri desktop     | Yes        |
| Your own                        | [Creating custom adapters](/filesystem/custom/)     | Anything          | Up to you  |

The example adapters in the [GitHub repository](https://github.com/keydown-dev/ts-git/tree/master/examples) are complete implementations you can copy into your project:

- **`FileSystemAccessAdapter`** wraps the browser's [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_API), so users can open a real folder from their disk with `showDirectoryPicker()`.
- **`TauriFSAdapter`** uses Tauri's filesystem plugin to work with native folders from a desktop app.

## Choosing an adapter

| Scenario                         | Suggested adapter                             |
| -------------------------------- | --------------------------------------------- |
| Unit tests, demos, sandboxes     | `MemoryFS`                                    |
| Node.js scripts, servers, CLIs   | A Node `fs` adapter (see [NodeFSAdapter](/filesystem/node/)) |
| Browser, user picks a folder     | `FileSystemAccessAdapter` (example app)       |
| Browser, app-managed storage     | A custom adapter over IndexedDB or OPFS       |
| Tauri desktop app                | `TauriFSAdapter` (example app)                |

## Paths

Adapters receive the paths TS-Git builds from `dir`/`gitdir` joined with repository-relative paths, using forward slashes, for example `/my-repo/.git/objects/ab/cdef...`. Your adapter decides what those paths mean: a key in a `Map`, a path relative to a chosen folder handle, or a real OS path.

## Next steps

- [MemoryFS](/filesystem/memory/): the built-in in-memory adapter
- [NodeFSAdapter](/filesystem/node/): using TS-Git on disk with Node.js
- [Creating custom adapters](/filesystem/custom/): implement `FSAdapter` yourself
