---
title: NodeFSAdapter
description: Using TS-Git with the real filesystem in Node.js.
---

`NodeFSAdapter` implements [`FSAdapter`](/filesystem/overview/) on top of Node's `fs.promises`, so repositories live on disk and stay compatible with the regular Git CLI.

:::caution[Not exported yet]
`NodeFSAdapter` exists in the TS-Git source ([`packages/ts-git/src/fs/node-adapter.ts`](https://github.com/keydown-dev/ts-git/blob/master/packages/ts-git/src/fs/node-adapter.ts)), but the published package doesn't expose it from `@keydown-app/ts-git` or any subpath yet. Until it does, copy the adapter into your project. It is about 150 lines with no dependencies beyond Node itself. A condensed version is below.
:::

## A Node.js adapter

```typescript title="node-fs-adapter.ts"
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FSAdapter, DirEntry, FileStats } from '@keydown-app/ts-git';

const toStats = (s: fs.Stats): FileStats => ({
  isFile: s.isFile(),
  isDirectory: s.isDirectory(),
  isSymbolicLink: s.isSymbolicLink(),
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
  mode: s.mode,
  ino: s.ino,
  dev: s.dev,
  uid: s.uid,
  gid: s.gid,
});

export class NodeFSAdapter implements FSAdapter {
  constructor(private baseDir: string = process.cwd()) {}

  /** Absolute paths are used as-is; relative paths resolve against baseDir. */
  private resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.baseDir, p);
  }

  async readFile(p: string) {
    return new Uint8Array(await fs.promises.readFile(this.resolve(p)));
  }
  async readFileString(p: string) {
    return fs.promises.readFile(this.resolve(p), 'utf-8');
  }
  async writeFile(p: string, data: Uint8Array | string) {
    await fs.promises.writeFile(this.resolve(p), data);
  }
  async mkdir(p: string, options?: { recursive?: boolean; mode?: number }) {
    await fs.promises.mkdir(this.resolve(p), options);
  }
  async readdir(p: string): Promise<DirEntry[]> {
    const entries = await fs.promises.readdir(this.resolve(p), { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymbolicLink: e.isSymbolicLink(),
    }));
  }
  async stat(p: string) {
    return toStats(await fs.promises.stat(this.resolve(p)));
  }
  async lstat(p: string) {
    return toStats(await fs.promises.lstat(this.resolve(p)));
  }
  async exists(p: string) {
    try {
      await fs.promises.access(this.resolve(p));
      return true;
    } catch {
      return false;
    }
  }
  async unlink(p: string) {
    await fs.promises.unlink(this.resolve(p));
  }
  async rmdir(p: string, options?: { recursive?: boolean }) {
    if (options?.recursive) await fs.promises.rm(this.resolve(p), { recursive: true });
    else await fs.promises.rmdir(this.resolve(p));
  }
  async rename(from: string, to: string) {
    await fs.promises.rename(this.resolve(from), this.resolve(to));
  }
  async readlink(p: string) {
    return fs.promises.readlink(this.resolve(p));
  }
  async symlink(target: string, p: string, type?: 'dir' | 'file' | 'junction') {
    await fs.promises.symlink(target, this.resolve(p), type);
  }
  async copyFile(src: string, dest: string) {
    await fs.promises.copyFile(this.resolve(src), this.resolve(dest));
  }
  // Optional: lets init detect executable-bit support and checkout create 100755 files
  async chmod(p: string, mode: number) {
    await fs.promises.chmod(this.resolve(p), mode);
  }
}
```

## Usage

```typescript
import { GitClient } from '@keydown-app/ts-git';
import { NodeFSAdapter } from './node-fs-adapter';

const fs = new NodeFSAdapter();
const git = new GitClient({ fs, dir: '/absolute/path/to/my-project', defaultBranch: 'main' });

await fs.mkdir('/absolute/path/to/my-project', { recursive: true });
await git.init();

await fs.writeFile('/absolute/path/to/my-project/README.md', '# My Project\n');
await git.add('README.md');
await git.commit('Initial commit', { name: 'Developer', email: 'dev@example.com' });
```

Prefer absolute `dir` values (for example from `path.resolve()`), since TS-Git joins paths with forward slashes.

## Working with existing repositories

Because the on-disk format is standard Git, you can open repositories created by the Git CLI, including ones whose objects are in packfiles:

```typescript
import * as path from 'node:path';
import { GitClient } from '@keydown-app/ts-git';
import { NodeFSAdapter } from './node-fs-adapter';

const git = new GitClient({
  fs: new NodeFSAdapter(),
  dir: path.resolve('./existing-repo'),
});

if (!(await git.isGitRepository())) {
  throw new Error('Not a git repository');
}

for (const { oid, commit } of await git.log(5)) {
  console.log(`${oid.slice(0, 7)} ${commit.message.trim()}`);
}

const changed = (await git.statusMatrix()).filter(
  ([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1),
);
console.log(`Changed files: ${changed.length}`);
```

See the [roadmap](/roadmap/#known-limitations) for index format limits when sharing a repository with the Git CLI (for example, index version 4 isn't supported).

## See also

- [MemoryFS](/filesystem/memory/): in-memory storage
- [Creating custom adapters](/filesystem/custom/): build your own
