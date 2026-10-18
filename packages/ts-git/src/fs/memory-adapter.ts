import type { DirEntry, FileStats, FSAdapter } from './types.js';

interface MemoryFile {
  type: 'file';
  content: Uint8Array;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface MemoryDirectory {
  type: 'directory';
  entries: Map<string, MemoryNode>;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface MemorySymlink {
  type: 'symlink';
  target: string;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

type MemoryNode = MemoryFile | MemoryDirectory | MemorySymlink;

function createStats(node: MemoryNode, dev: number = 1): FileStats {
  return {
    isFile: node.type === 'file',
    isDirectory: node.type === 'directory',
    isSymbolicLink: node.type === 'symlink',
    size: node.type === 'file' ? node.content.length : 0,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.ctimeMs,
    mode: node.mode,
    ino: node.ino,
    dev,
    uid: 0,
    gid: 0,
    blksize: 4096,
    blocks: Math.ceil((node.type === 'file' ? node.content.length : 0) / 4096),
  };
}

function createDirEntry(name: string, node: MemoryNode): DirEntry {
  return {
    name,
    isFile: node.type === 'file',
    isDirectory: node.type === 'directory',
    isSymbolicLink: node.type === 'symlink',
  };
}

let nextIno = 1;

export class MemoryFS implements FSAdapter {
  private root: MemoryDirectory;
  private inoMap: Map<number, MemoryNode>;

  constructor() {
    this.root = {
      type: 'directory',
      entries: new Map(),
      mode: 0o755,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      ino: nextIno++,
    };
    this.inoMap = new Map();
    this.inoMap.set(this.root.ino, this.root);
  }

  private getNode(path: string): MemoryNode | null {
    if (path === '' || path === '/') {
      return this.root;
    }

    const parts = path.split('/').filter(Boolean);
    let current: MemoryNode = this.root;

    for (const part of parts) {
      if (current.type !== 'directory') {
        return null;
      }
      const entry = current.entries.get(part);
      if (!entry) {
        return null;
      }
      current = entry;
    }

    return current;
  }

  private getParent(
    path: string,
  ): { parent: MemoryDirectory; name: string } | null {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1);
    let current: MemoryNode = this.root;

    for (const part of parentPath) {
      if (current.type !== 'directory') {
        return null;
      }
      const entry = current.entries.get(part);
      if (!entry) {
        return null;
      }
      current = entry;
    }

    if (current.type !== 'directory') {
      return null;
    }

    return { parent: current, name };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const node = this.getNode(path);
    if (!node || node.type !== 'file') {
      throw new Error(`ENOENT: no such file, open '${path}'`);
    }
    return new Uint8Array(node.content);
  }

  async readFileString(path: string): Promise<string> {
    const buffer = await this.readFile(path);
    return new TextDecoder().decode(buffer);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const now = Date.now();
    const content =
      typeof data === 'string' ? new TextEncoder().encode(data) : data;

    const parentInfo = this.getParent(path);
    if (!parentInfo) {
      const parts = path.split('/').filter(Boolean);
      let current: MemoryNode = this.root;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (current.type !== 'directory') {
          throw new Error(`ENOTDIR: not a directory, mkdir '${path}'`);
        }
        const entry = current.entries.get(part);
        if (!entry) {
          const newDir: MemoryDirectory = {
            type: 'directory',
            entries: new Map(),
            mode: 0o755,
            mtimeMs: now,
            ctimeMs: now,
            ino: nextIno++,
          };
          current.entries.set(part, newDir);
          this.inoMap.set(newDir.ino, newDir);
          current = newDir;
        } else if (entry.type === 'directory') {
          current = entry;
        } else {
          throw new Error(`ENOTDIR: not a directory, mkdir '${path}'`);
        }
      }

      const finalName = parts[parts.length - 1];
      const file: MemoryFile = {
        type: 'file',
        content: new Uint8Array(content),
        mode: 0o644,
        mtimeMs: now,
        ctimeMs: now,
        ino: nextIno++,
      };
      current.entries.set(finalName, file);
      this.inoMap.set(file.ino, file);
      return;
    }

    const { parent, name } = parentInfo;
    const existing = parent.entries.get(name);

    if (existing && existing.type === 'directory') {
      throw new Error(`EISDIR: is a directory, write '${path}'`);
    }

    const file: MemoryFile = {
      type: 'file',
      content: new Uint8Array(content),
      // Overwriting keeps the permission bits, as on a real filesystem.
      mode: existing && existing.type === 'file' ? existing.mode : 0o644,
      mtimeMs: now,
      ctimeMs: now,
      ino: nextIno++,
    };

    parent.entries.set(name, file);
    this.inoMap.set(file.ino, file);
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void> {
    const now = Date.now();
    const mode = options?.mode ?? 0o755;

    const existing = this.getNode(path);
    if (existing) {
      if (options?.recursive && existing.type === 'directory') {
        return;
      }
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }

    const parentInfo = this.getParent(path);
    if (!parentInfo) {
      if (!options?.recursive) {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
      const parts = path.split('/').filter(Boolean);
      let currentPath = '';
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!(await this.exists(currentPath))) {
          await this.mkdir(currentPath, { recursive: false, mode });
        }
      }
      return;
    }

    const { parent, name } = parentInfo;
    const dir: MemoryDirectory = {
      type: 'directory',
      entries: new Map(),
      mode,
      mtimeMs: now,
      ctimeMs: now,
      ino: nextIno++,
    };
    parent.entries.set(name, dir);
    this.inoMap.set(dir.ino, dir);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const dirNode = this.getNode(path);
    if (!dirNode || dirNode.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory, readdir '${path}'`);
    }

    const entries: DirEntry[] = [];
    for (const [name, childNode] of dirNode.entries) {
      entries.push(createDirEntry(name, childNode));
    }
    return entries;
  }

  async stat(path: string): Promise<FileStats> {
    const node = this.getNode(path);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }
    return createStats(node);
  }

  async lstat(path: string): Promise<FileStats> {
    return this.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    const node = this.getNode(path);
    return node !== null;
  }

  async unlink(path: string): Promise<void> {
    const node = this.getNode(path);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    }
    if (node.type === 'directory') {
      throw new Error(`EISDIR: is a directory, unlink '${path}'`);
    }

    const parentInfo = this.getParent(path);
    if (!parentInfo) {
      throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    }

    parentInfo.parent.entries.delete(parentInfo.name);
    this.inoMap.delete(node.ino);
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const node = this.getNode(path);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, rmdir '${path}'`);
    }
    if (node.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory, rmdir '${path}'`);
    }

    const parentInfo = this.getParent(path);
    if (!parentInfo) {
      throw new Error(`ENOENT: no such file or directory, rmdir '${path}'`);
    }

    if (node.entries.size > 0) {
      if (!options?.recursive) {
        throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
      }
      await this.rmdirRecursive(node);
    }

    parentInfo.parent.entries.delete(parentInfo.name);
    this.inoMap.delete(node.ino);
  }

  private async rmdirRecursive(dir: MemoryDirectory): Promise<void> {
    for (const [name, node] of dir.entries) {
      if (node.type === 'directory') {
        await this.rmdirRecursive(node);
      } else {
        dir.entries.delete(name);
        this.inoMap.delete(node.ino);
      }
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNode = this.getNode(oldPath);
    if (!oldNode) {
      throw new Error(`ENOENT: no such file or directory, rename '${oldPath}'`);
    }

    const newParentInfo = this.getParent(newPath);
    if (!newParentInfo) {
      throw new Error(`ENOENT: no such file or directory, rename '${newPath}'`);
    }

    if (newParentInfo.parent.entries.has(newParentInfo.name)) {
      throw new Error(`EEXIST: file already exists, rename '${newPath}'`);
    }

    const oldParentInfo = this.getParent(oldPath);
    if (oldParentInfo) {
      oldParentInfo.parent.entries.delete(oldParentInfo.name);
    }

    newParentInfo.parent.entries.set(newParentInfo.name, oldNode);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const node = this.getNode(path);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }
    node.mode = (node.mode & ~0o7777) | (mode & 0o7777);
    node.ctimeMs = Date.now();
  }

  async readlink(path: string): Promise<string> {
    const node = this.getNode(path);
    if (!node || node.type !== 'symlink') {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }
    return node.target;
  }

  async symlink(
    target: string,
    path: string,
    _type?: 'dir' | 'file' | 'junction',
  ): Promise<void> {
    const now = Date.now();
    const parentInfo = this.getParent(path);
    if (!parentInfo) {
      throw new Error(`ENOENT: no such file or directory, symlink '${path}'`);
    }

    if (parentInfo.parent.entries.has(parentInfo.name)) {
      throw new Error(`EEXIST: file already exists, symlink '${path}'`);
    }

    const symlink: MemorySymlink = {
      type: 'symlink',
      target,
      mode: 0o777,
      mtimeMs: now,
      ctimeMs: now,
      ino: nextIno++,
    };
    parentInfo.parent.entries.set(parentInfo.name, symlink);
    this.inoMap.set(symlink.ino, symlink);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const srcNode = this.getNode(src);
    if (!srcNode || srcNode.type !== 'file') {
      throw new Error(`ENOENT: no such file, copyfile '${src}'`);
    }

    await this.writeFile(dest, new Uint8Array(srcNode.content));
  }

  clone(): MemoryFS {
    const cloned = new MemoryFS();
    const clonedRoot = this.cloneNode(this.root) as MemoryDirectory;
    cloned.root = clonedRoot;
    cloned.rebuildInoMap(clonedRoot);
    return cloned;
  }

  private cloneFile(node: MemoryFile): MemoryFile {
    return {
      type: 'file',
      content: new Uint8Array(node.content),
      mode: node.mode,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      ino: nextIno++,
    };
  }

  private cloneDirectory(node: MemoryDirectory): MemoryDirectory {
    const clonedDir: MemoryDirectory = {
      type: 'directory',
      entries: new Map(),
      mode: node.mode,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      ino: nextIno++,
    };

    for (const [name, child] of node.entries) {
      clonedDir.entries.set(name, this.cloneNode(child));
    }

    return clonedDir;
  }

  private cloneSymlink(node: MemorySymlink): MemorySymlink {
    return {
      type: 'symlink',
      target: node.target,
      mode: node.mode,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      ino: nextIno++,
    };
  }

  private cloneNode(node: MemoryNode): MemoryNode {
    switch (node.type) {
      case 'file': {
        return this.cloneFile(node);
      }
      case 'directory': {
        return this.cloneDirectory(node);
      }
      case 'symlink': {
        return this.cloneSymlink(node);
      }
    }
  }

  private rebuildInoMap(node: MemoryNode): void {
    this.inoMap.set(node.ino, node);
    if (node.type === 'directory') {
      for (const child of node.entries.values()) {
        this.rebuildInoMap(child);
      }
    }
  }

  reset(): void {
    this.root = {
      type: 'directory',
      entries: new Map(),
      mode: 0o755,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      ino: nextIno++,
    };
    this.inoMap.clear();
    this.inoMap.set(this.root.ino, this.root);
  }
}

export function createMemoryFS(): MemoryFS {
  return new MemoryFS();
}
