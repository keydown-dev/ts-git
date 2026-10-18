import * as fs from 'fs';
import * as path from 'path';
import type { FSAdapter, DirEntry, FileStats } from './types.js';

export class NodeFSAdapter implements FSAdapter {
  private baseDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
  }

  private resolvePath(filepath: string): string {
    if (path.isAbsolute(filepath)) {
      return filepath;
    }
    return path.join(this.baseDir, filepath);
  }

  async readFile(filepath: string): Promise<Uint8Array> {
    const fullPath = this.resolvePath(filepath);
    const buffer = await fs.promises.readFile(fullPath);
    return new Uint8Array(buffer);
  }

  async readFileString(filepath: string): Promise<string> {
    const fullPath = this.resolvePath(filepath);
    return fs.promises.readFile(fullPath, 'utf-8');
  }

  async writeFile(filepath: string, data: Uint8Array | string): Promise<void> {
    const fullPath = this.resolvePath(filepath);
    const buffer = typeof data === 'string' ? data : new Uint8Array(data);
    await fs.promises.writeFile(fullPath, buffer);
  }

  async mkdir(
    filepath: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void> {
    const fullPath = this.resolvePath(filepath);
    await fs.promises.mkdir(fullPath, options);
  }

  async readdir(filepath: string): Promise<DirEntry[]> {
    const fullPath = this.resolvePath(filepath);
    const entries = await fs.promises.readdir(fullPath, {
      withFileTypes: true,
    });

    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async stat(filepath: string): Promise<FileStats> {
    const fullPath = this.resolvePath(filepath);
    const stats = await fs.promises.stat(fullPath);

    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      mode: stats.mode,
      ino: stats.ino,
      dev: stats.dev,
      uid: stats.uid,
      gid: stats.gid,
    };
  }

  async lstat(filepath: string): Promise<FileStats> {
    const fullPath = this.resolvePath(filepath);
    const stats = await fs.promises.lstat(fullPath);

    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      mode: stats.mode,
      ino: stats.ino,
      dev: stats.dev,
      uid: stats.uid,
      gid: stats.gid,
    };
  }

  async exists(filepath: string): Promise<boolean> {
    const fullPath = this.resolvePath(filepath);
    try {
      await fs.promises.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async unlink(filepath: string): Promise<void> {
    const fullPath = this.resolvePath(filepath);
    await fs.promises.unlink(fullPath);
  }

  async rmdir(
    filepath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const fullPath = this.resolvePath(filepath);
    if (options?.recursive) {
      await fs.promises.rm(fullPath, { recursive: true });
    } else {
      await fs.promises.rmdir(fullPath);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const fullOldPath = this.resolvePath(oldPath);
    const fullNewPath = this.resolvePath(newPath);
    await fs.promises.rename(fullOldPath, fullNewPath);
  }

  async readlink(filepath: string): Promise<string> {
    const fullPath = this.resolvePath(filepath);
    return fs.promises.readlink(fullPath);
  }

  async symlink(
    target: string,
    filepath: string,
    type?: 'dir' | 'file' | 'junction',
  ): Promise<void> {
    // The target is stored verbatim (relative targets stay relative to the
    // link's directory), as symlink(2) and checkout of mode 120000 need.
    const fullLinkPath = this.resolvePath(filepath);
    await fs.promises.symlink(target, fullLinkPath, type);
  }

  async chmod(filepath: string, mode: number): Promise<void> {
    await fs.promises.chmod(this.resolvePath(filepath), mode);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const fullSrc = this.resolvePath(src);
    const fullDest = this.resolvePath(dest);
    await fs.promises.copyFile(fullSrc, fullDest);
  }
}

export function createNodeFSAdapter(baseDir?: string): NodeFSAdapter {
  return new NodeFSAdapter(baseDir);
}
