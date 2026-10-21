import {
  readFile,
  readDir,
  stat,
  lstat,
  exists,
  writeFile,
  mkdir,
  remove,
  rename,
  copyFile,
} from '@tauri-apps/plugin-fs';
import type { FSAdapter, DirEntry, FileStats } from '@keydown-dev/ts-git';

/**
 * TauriFSAdapter implements the FSAdapter interface for ts-git using Tauri's native filesystem APIs.
 *
 * This adapter bridges Tauri's asynchronous fs API with ts-git's async FSAdapter.
 * It allows ts-git to work with the user's actual local filesystem.
 */
export class TauriFSAdapter implements FSAdapter {
  private baseDir: string;

  constructor(baseDir: string = '') {
    this.baseDir = baseDir;
  }

  private resolvePath(path: string): string {
    // Handle root path - resolve to baseDir
    if (path === '/') {
      return this.baseDir || path;
    }

    // For other absolute paths, resolve relative to baseDir
    if (path.startsWith('/')) {
      if (this.baseDir) {
        // Path is relative to baseDir, strip leading /
        const relativePath = path.slice(1);
        const separator = this.baseDir.endsWith('/') ? '' : '/';
        return `${this.baseDir}${separator}${relativePath}`;
      }
      return path;
    }

    if (this.baseDir) {
      // Join relative path with baseDir
      const separator = this.baseDir.endsWith('/') ? '' : '/';
      return `${this.baseDir}${separator}${path}`;
    }
    return path;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const fullPath = this.resolvePath(path);
    try {
      return await readFile(fullPath);
    } catch (error) {
      throw new Error(`Failed to read file ${path}: ${error}`);
    }
  }

  async readFileString(path: string): Promise<string> {
    const data = await this.readFile(path);
    return new TextDecoder().decode(data);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const fullPath = this.resolvePath(path);
    try {
      const encodedData =
        typeof data === 'string' ? new TextEncoder().encode(data) : data;
      await writeFile(fullPath, encodedData);
    } catch (error) {
      throw new Error(`Failed to write file ${path}: ${error}`);
    }
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void> {
    const fullPath = this.resolvePath(path);
    try {
      await mkdir(fullPath, { recursive: options?.recursive });
    } catch (error) {
      // If directory already exists and recursive is true, don't throw
      if (options?.recursive) {
        const exists_check = await this.exists(path);
        if (exists_check) return;
      }
      throw new Error(`Failed to create directory ${path}: ${error}`);
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const fullPath = this.resolvePath(path);
    try {
      const entries = await readDir(fullPath);
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymlink,
      }));
    } catch (error) {
      throw new Error(`Failed to read directory ${path}: ${error}`);
    }
  }

  async stat(path: string): Promise<FileStats> {
    const fullPath = this.resolvePath(path);
    try {
      const fileStat = await stat(fullPath);
      return {
        isFile: fileStat.isFile,
        isDirectory: fileStat.isDirectory,
        isSymbolicLink: fileStat.isSymlink,
        size: Number(fileStat.size),
        mtimeMs: Number(fileStat.mtime?.getTime() || 0),
        ctimeMs: Number(fileStat.mtime?.getTime() || 0),
        mode: fileStat.mode || 0,
        ino: 0,
        dev: 0,
        uid: 0,
        gid: 0,
      };
    } catch (error) {
      throw new Error(`Failed to stat ${path}: ${error}`);
    }
  }

  async lstat(path: string): Promise<FileStats> {
    const fullPath = this.resolvePath(path);
    try {
      const fileStat = await lstat(fullPath);
      return {
        isFile: fileStat.isFile,
        isDirectory: fileStat.isDirectory,
        isSymbolicLink: fileStat.isSymlink,
        size: Number(fileStat.size),
        mtimeMs: Number(fileStat.mtime?.getTime() || 0),
        ctimeMs: Number(fileStat.mtime?.getTime() || 0),
        mode: fileStat.mode || 0,
        ino: 0,
        dev: 0,
        uid: 0,
        gid: 0,
      };
    } catch (error) {
      throw new Error(`Failed to lstat ${path}: ${error}`);
    }
  }

  async exists(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);
    try {
      return await exists(fullPath);
    } catch {
      return false;
    }
  }

  async unlink(path: string): Promise<void> {
    const fullPath = this.resolvePath(path);
    try {
      await remove(fullPath);
    } catch (error) {
      throw new Error(`Failed to delete file ${path}: ${error}`);
    }
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const fullPath = this.resolvePath(path);
    try {
      await remove(fullPath, { recursive: options?.recursive });
    } catch (error) {
      throw new Error(`Failed to remove directory ${path}: ${error}`);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const fullOldPath = this.resolvePath(oldPath);
    const fullNewPath = this.resolvePath(newPath);
    try {
      await rename(fullOldPath, fullNewPath);
    } catch (error) {
      throw new Error(`Failed to rename ${oldPath} to ${newPath}: ${error}`);
    }
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`Symlinks not supported in Tauri: ${path}`);
  }

  async symlink(
    _target: string,
    _path: string,
    _type?: 'dir' | 'file' | 'junction',
  ): Promise<void> {
    throw new Error('Symlinks not supported in Tauri filesystem');
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const fullSrc = this.resolvePath(src);
    const fullDest = this.resolvePath(dest);
    try {
      await copyFile(fullSrc, fullDest);
    } catch (error) {
      throw new Error(`Failed to copy file ${src} to ${dest}: ${error}`);
    }
  }

  /**
   * Check if a path is a git repository by looking for .git directory
   */
  async isGitRepo(path: string): Promise<boolean> {
    try {
      const gitPath = path.endsWith('/') ? `${path}.git` : `${path}/.git`;
      const gitStat = await this.stat(gitPath);
      return gitStat.isDirectory;
    } catch {
      return false;
    }
  }

  setBaseDir(baseDir: string) {
    this.baseDir = baseDir;
  }

  getBaseDir(): string {
    return this.baseDir;
  }
}

export function createTauriFSAdapter(baseDir?: string): TauriFSAdapter {
  return new TauriFSAdapter(baseDir);
}
