---
title: Creating Custom Adapters
description: Implement the FSAdapter interface to run TS-Git on any storage backend.
---

Any object that implements `FSAdapter` can back a TS-Git repository: IndexedDB, the Origin Private File System, a remote API, a database, an Electron IPC bridge and so on.

## The interface

```typescript
import type { FSAdapter, DirEntry, FileStats } from '@keydown-app/ts-git';

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
}

interface DirEntry {
  name: string; // base name, not a full path
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number; // e.g. 0o100644 for files, 0o040000 for directories
  ino: number;
  dev: number;
  uid: number;
  gid: number;
  blksize?: number;
  blocks?: number;
}
```

Note that `isFile`, `isDirectory` and `isSymbolicLink` are **booleans**, not methods as in Node's `fs.Stats`.

## What TS-Git relies on

- **`readFile` / `writeFile`** carry all object, index and ref data. Binary data must round-trip exactly, so don't store `Uint8Array`s as text without an encoding such as base64.
- **`mkdir(path, { recursive: true })`** is called during `init` and when writing objects. It must not fail if the directory already exists.
- **`exists`** is used heavily, for example to detect a repository (`<dir>/.git`) and loose objects. Make it cheap.
- **`readdir`** drives working-tree walks for `status`, `addAll` and `diff`, and branch listing under `refs/heads/`.
- **`stat`** feeds index entries (`mode`, `size`, `mtimeMs`, `ctimeMs`, `ino`, `dev`, `uid`, `gid`). If your backend has no such concept, return stable placeholder values (for example `0`), and set `mode` to `0o100644` for regular files or `0o100755` for executables.
- **Errors**: throw when a path doesn't exist (`readFile`, `stat`, `readdir`). Including Node-style codes such as `ENOENT` in the message helps debugging.

`lstat`, `readlink`, `symlink`, `rename` and `copyFile` are required by the type but are rarely used by the core commands. Simple backends can implement them in terms of the other methods.

## Example: a localStorage adapter

A compact adapter that keeps files as base64 in `localStorage` and tracks directories explicitly. It's fine for demos and small repositories, though `localStorage` quotas (around 5 MB) rule it out for anything big.

```typescript title="local-storage-fs.ts"
import type { FSAdapter, DirEntry, FileStats } from '@keydown-app/ts-git';

const enoent = (op: string, p: string) =>
  new Error(`ENOENT: no such file or directory, ${op} '${p}'`);

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export class LocalStorageFS implements FSAdapter {
  constructor(private prefix = 'ts-git:') {}

  private norm(p: string) {
    return '/' + p.split('/').filter(Boolean).join('/');
  }
  private fileKey(p: string) {
    return `${this.prefix}f:${this.norm(p)}`;
  }
  private dirKey(p: string) {
    return `${this.prefix}d:${this.norm(p)}`;
  }
  private isDir(p: string) {
    return this.norm(p) === '/' || localStorage.getItem(this.dirKey(p)) !== null;
  }
  private parent(p: string) {
    return this.norm(p).replace(/\/[^/]+$/, '') || '/';
  }
  private keys(): string[] {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
  }

  async readFile(p: string) {
    const b64 = localStorage.getItem(this.fileKey(p));
    if (b64 === null) throw enoent('open', p);
    return fromB64(b64);
  }
  async readFileString(p: string) {
    return new TextDecoder().decode(await this.readFile(p));
  }
  async writeFile(p: string, data: Uint8Array | string) {
    await this.mkdir(this.parent(p), { recursive: true });
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    localStorage.setItem(this.fileKey(p), toB64(bytes));
  }
  async mkdir(p: string, options?: { recursive?: boolean }) {
    if (this.isDir(p)) return;
    if (!this.isDir(this.parent(p))) {
      if (!options?.recursive) throw enoent('mkdir', p);
      await this.mkdir(this.parent(p), options);
    }
    localStorage.setItem(this.dirKey(p), '1');
  }
  async readdir(p: string): Promise<DirEntry[]> {
    if (!this.isDir(p)) throw enoent('scandir', p);
    const base = this.norm(p) === '/' ? '/' : this.norm(p) + '/';
    const entries = new Map<string, DirEntry>();
    for (const key of this.keys()) {
      for (const [tag, isDirectory] of [['f:', false], ['d:', true]] as const) {
        const head = this.prefix + tag + base;
        if (!key.startsWith(head)) continue;
        const rest = key.slice(head.length);
        if (!rest || rest.includes('/')) continue;
        entries.set(rest, { name: rest, isFile: !isDirectory, isDirectory, isSymbolicLink: false });
      }
    }
    return [...entries.values()];
  }
  async stat(p: string): Promise<FileStats> {
    const isDirectory = this.isDir(p);
    const b64 = localStorage.getItem(this.fileKey(p));
    if (!isDirectory && b64 === null) throw enoent('stat', p);
    return {
      isFile: !isDirectory,
      isDirectory,
      isSymbolicLink: false,
      size: b64 ? fromB64(b64).length : 0,
      mtimeMs: 0,
      ctimeMs: 0,
      mode: isDirectory ? 0o040755 : 0o100644,
      ino: 0,
      dev: 0,
      uid: 0,
      gid: 0,
    };
  }
  async lstat(p: string) {
    return this.stat(p);
  }
  async exists(p: string) {
    return this.isDir(p) || localStorage.getItem(this.fileKey(p)) !== null;
  }
  async unlink(p: string) {
    localStorage.removeItem(this.fileKey(p));
  }
  async rmdir(p: string) {
    const base = this.norm(p);
    for (const key of this.keys()) {
      const path = key.slice(this.prefix.length + 2);
      if (key.startsWith(this.prefix) && (path === base || path.startsWith(base + '/'))) {
        localStorage.removeItem(key);
      }
    }
  }
  async rename(from: string, to: string) {
    await this.copyFile(from, to);
    await this.unlink(from);
  }
  async copyFile(src: string, dest: string) {
    await this.writeFile(dest, await this.readFile(src));
  }
  async readlink(p: string): Promise<string> {
    throw new Error(`EINVAL: symlinks not supported, readlink '${p}'`);
  }
  async symlink(_target: string, p: string): Promise<void> {
    throw new Error(`EPERM: symlinks not supported, symlink '${p}'`);
  }
}
```

## Using it

```typescript
import { GitClient } from '@keydown-app/ts-git';
import { LocalStorageFS } from './local-storage-fs';

const fs = new LocalStorageFS();
const git = new GitClient({ fs, dir: '/my-repo', defaultBranch: 'main' });

if (!(await git.isGitRepository())) {
  await git.init();
}
```

## Testing your adapter

The quickest end-to-end check is to run a full Git workflow against it and compare the results with `MemoryFS`:

```typescript
import { GitClient, MemoryFS, type FSAdapter } from '@keydown-app/ts-git';

async function smokeTest(fs: FSAdapter) {
  const git = new GitClient({ fs, dir: '/smoke', defaultBranch: 'main' });
  await git.init();

  await fs.writeFile('/smoke/a.txt', 'hello\n');
  await fs.mkdir('/smoke/dir', { recursive: true });
  await fs.writeFile('/smoke/dir/b.bin', new Uint8Array([0, 255, 1, 254]));
  await git.addAll();
  const oid = await git.commit('smoke', {
    name: 'Test',
    email: 'test@example.com',
    timestamp: 0,
    timezoneOffset: 0,
  });

  console.assert((await fs.readFile('/smoke/dir/b.bin'))[1] === 255, 'binary round-trip');
  console.assert((await git.status('a.txt')) === 'unmodified', 'status after commit');
  return oid;
}

// With fixed timestamps the commit OIDs must match
console.assert((await smokeTest(new MemoryFS())) === (await smokeTest(myAdapter)));
```

## Tips

1. **Normalize paths**: collapse duplicate slashes and strip trailing ones, so `/repo//a` and `/repo/a/` behave like `/repo/a`.
2. **Keep binary data binary**: object files are zlib-compressed bytes.
3. **Make `exists` and `stat` fast**: they're called for many paths during `status`.
4. **Directories**: if your backend only has keys (like object storage), track directories explicitly so `readdir` and `exists` work for empty directories such as `.git/refs/tags`.
5. **Everything is async**: every method must return a `Promise`.

## See also

- [MemoryFS](/filesystem/memory/): the reference implementation shipped with TS-Git
- [NodeFSAdapter](/filesystem/node/): a thin wrapper over Node's `fs`
