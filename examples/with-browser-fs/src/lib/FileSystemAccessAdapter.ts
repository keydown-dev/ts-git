import type { FSAdapter, DirEntry, FileStats } from '@keydown-app/ts-git';

/**
 * FileSystemAccessAdapter implements the FSAdapter interface using the Browser File System Access API.
 *
 * This adapter allows users to select a folder from their local file system and use it
 * as the backend for ts-git operations.
 */
export class FileSystemAccessAdapter implements FSAdapter {
  private rootHandle: FileSystemDirectoryHandle;
  private pathCache: Map<string, FileSystemDirectoryHandle>;

  constructor(rootHandle: FileSystemDirectoryHandle) {
    this.rootHandle = rootHandle;
    this.pathCache = new Map();
    this.pathCache.set('/', rootHandle);
  }

  getRootHandle(): FileSystemDirectoryHandle {
    return this.rootHandle;
  }

  getRootName(): string {
    return this.rootHandle.name;
  }

  private async resolvePath(path: string): Promise<{
    parentHandle: FileSystemDirectoryHandle;
    name: string;
    isRoot: boolean;
  }> {
    // Normalize the path
    let normalizedPath = path.startsWith('/') ? path : '/' + path;

    // Handle special paths
    if (normalizedPath === '/.' || normalizedPath === '/') {
      return { parentHandle: this.rootHandle, name: '', isRoot: true };
    }

    // Remove trailing slashes and handle ./ prefix
    normalizedPath = normalizedPath.replace(/\/+$/, '').replace(/^\//, '');
    if (normalizedPath === '.' || normalizedPath === '') {
      return { parentHandle: this.rootHandle, name: '', isRoot: true };
    }

    const parts = normalizedPath
      .split('/')
      .filter((p) => p.length > 0 && p !== '.');
    const name = parts[parts.length - 1];
    const parentParts = parts.slice(0, -1);

    const parentPath =
      parentParts.length > 0 ? '/' + parentParts.join('/') : '/';
    const parentHandle = await this.getDirectoryHandle(parentPath);

    return { parentHandle, name, isRoot: false };
  }

  private async getDirectoryHandle(
    path: string,
  ): Promise<FileSystemDirectoryHandle> {
    // Normalize the path
    let normalizedPath = path.startsWith('/') ? path : '/' + path;

    // Handle special paths
    if (normalizedPath === '/.' || normalizedPath === '/') {
      return this.rootHandle;
    }

    // Remove trailing slashes and handle ./ prefix
    normalizedPath = normalizedPath.replace(/\/+$/, '').replace(/^\//, '');
    if (normalizedPath === '.' || normalizedPath === '') {
      return this.rootHandle;
    }

    // Check cache first
    const cachePath = '/' + normalizedPath;
    if (this.pathCache.has(cachePath)) {
      return this.pathCache.get(cachePath)!;
    }

    const parts = normalizedPath
      .split('/')
      .filter((p) => p.length > 0 && p !== '.');
    let currentHandle = this.rootHandle;
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;

      if (this.pathCache.has(currentPath)) {
        currentHandle = this.pathCache.get(currentPath)!;
      } else {
        try {
          currentHandle = await currentHandle.getDirectoryHandle(part);
          this.pathCache.set(currentPath, currentHandle);
        } catch (error) {
          throw new Error(`Directory not found: ${currentPath}`);
        }
      }
    }

    return currentHandle;
  }

  private async getFileHandle(
    path: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle> {
    const { parentHandle, name, isRoot } = await this.resolvePath(path);

    if (isRoot) {
      throw new Error('Cannot get file handle for root directory');
    }

    try {
      return await parentHandle.getFileHandle(name, options);
    } catch (error) {
      if ((error as Error).name === 'NotFoundError' && !options?.create) {
        throw new Error(`File not found: ${path}`);
      }
      throw error;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      const fileHandle = await this.getFileHandle(path);
      const file = await fileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch (error) {
      throw new Error(`Failed to read file ${path}: ${error}`);
    }
  }

  async readFileString(path: string): Promise<string> {
    try {
      const fileHandle = await this.getFileHandle(path);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (error) {
      throw new Error(`Failed to read file ${path}: ${error}`);
    }
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    try {
      const fileHandle = await this.getFileHandle(path, { create: true });
      const writable = await fileHandle.createWritable();

      if (typeof data === 'string') {
        await writable.write(data);
      } else {
        // Convert Uint8Array to ArrayBuffer for proper typing
        const arrayBuffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer;
        await writable.write(arrayBuffer);
      }

      await writable.close();
    } catch (error) {
      throw new Error(`Failed to write file ${path}: ${error}`);
    }
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void> {
    try {
      let normalizedPath = path.startsWith('/') ? path : '/' + path;

      // Handle special paths
      if (
        normalizedPath === '/' ||
        normalizedPath === '/.' ||
        normalizedPath === ''
      ) {
        return; // Root always exists
      }

      // Remove trailing slashes and handle ./ prefix
      normalizedPath = normalizedPath.replace(/\/+$/, '').replace(/^\//, '');
      if (normalizedPath === '.' || normalizedPath === '') {
        return; // Root always exists
      }

      const parts = normalizedPath
        .split('/')
        .filter((p) => p.length > 0 && p !== '.');

      if (options?.recursive) {
        let currentHandle = this.rootHandle;
        let currentPath = '';

        for (const part of parts) {
          currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;

          try {
            currentHandle = await currentHandle.getDirectoryHandle(part, {
              create: true,
            });
            this.pathCache.set(currentPath, currentHandle);
          } catch (error) {
            throw new Error(
              `Failed to create directory ${currentPath}: ${error}`,
            );
          }
        }
      } else {
        const { parentHandle, name } = await this.resolvePath(path);
        const newHandle = await parentHandle.getDirectoryHandle(name, {
          create: true,
        });
        this.pathCache.set('/' + normalizedPath, newHandle);
      }
    } catch (error) {
      throw new Error(`Failed to create directory ${path}: ${error}`);
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    try {
      // Normalize path - handle '.' and empty paths
      let normalizedPath = path;
      if (path === '.' || path === '') {
        normalizedPath = '/';
      }

      const dirHandle = await this.getDirectoryHandle(normalizedPath);
      const entries: DirEntry[] = [];

      // Use the async iterator on the directory handle
      for await (const [name, handle] of dirHandle.entries()) {
        entries.push({
          name,
          isFile: handle.kind === 'file',
          isDirectory: handle.kind === 'directory',
          isSymbolicLink: false, // File System Access API doesn't expose symlinks
        });
      }

      return entries;
    } catch (error) {
      throw new Error(`Failed to read directory ${path}: ${error}`);
    }
  }

  async stat(path: string): Promise<FileStats> {
    try {
      // Handle root directory
      if (path === '/' || path === '.' || path === '') {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          size: 0,
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          mode: 0o755,
          ino: 0,
          dev: 0,
          uid: 0,
          gid: 0,
        };
      }

      // Try as file first
      try {
        const fileHandle = await this.getFileHandle(path);
        const file = await fileHandle.getFile();
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          size: file.size,
          mtimeMs: file.lastModified,
          ctimeMs: file.lastModified,
          mode: 0o644,
          ino: 0,
          dev: 0,
          uid: 0,
          gid: 0,
        };
      } catch {
        // Try as directory
        await this.getDirectoryHandle(path);
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          size: 0,
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          mode: 0o755,
          ino: 0,
          dev: 0,
          uid: 0,
          gid: 0,
        };
      }
    } catch (error) {
      throw new Error(`Failed to stat ${path}: ${error}`);
    }
  }

  async lstat(path: string): Promise<FileStats> {
    // File System Access API doesn't support symlinks, so lstat is same as stat
    return this.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async unlink(path: string): Promise<void> {
    try {
      const { parentHandle, name, isRoot } = await this.resolvePath(path);

      if (isRoot) {
        throw new Error('Cannot remove root directory');
      }

      await parentHandle.removeEntry(name);

      // Remove from cache if present
      const normalizedPath = path.startsWith('/') ? path : '/' + path;
      this.pathCache.delete(normalizedPath);
    } catch (error) {
      throw new Error(`Failed to delete file ${path}: ${error}`);
    }
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    try {
      const { parentHandle, name, isRoot } = await this.resolvePath(path);

      if (isRoot) {
        throw new Error('Cannot remove root directory');
      }

      await parentHandle.removeEntry(name, { recursive: options?.recursive });

      // Remove from cache if present
      const normalizedPath = path.startsWith('/') ? path : '/' + path;
      this.pathCache.delete(normalizedPath);

      // Also remove any cached children
      for (const cachedPath of this.pathCache.keys()) {
        if (cachedPath.startsWith(normalizedPath + '/')) {
          this.pathCache.delete(cachedPath);
        }
      }
    } catch (error) {
      throw new Error(`Failed to remove directory ${path}: ${error}`);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    try {
      // File System Access API doesn't have native rename
      // We need to copy and delete
      const stats = await this.stat(oldPath);

      if (stats.isFile) {
        const content = await this.readFile(oldPath);
        await this.writeFile(newPath, content);
        await this.unlink(oldPath);
      } else {
        throw new Error('Renaming directories is not fully supported');
      }
    } catch (error) {
      throw new Error(`Failed to rename ${oldPath} to ${newPath}: ${error}`);
    }
  }

  async readlink(_path: string): Promise<string> {
    throw new Error(
      'Symbolic links are not supported in File System Access API',
    );
  }

  async symlink(
    _target: string,
    _path: string,
    _type?: 'dir' | 'file' | 'junction',
  ): Promise<void> {
    throw new Error(
      'Symbolic links are not supported in File System Access API',
    );
  }

  async copyFile(src: string, dest: string): Promise<void> {
    try {
      const content = await this.readFile(src);
      await this.writeFile(dest, content);
    } catch (error) {
      throw new Error(`Failed to copy file from ${src} to ${dest}: ${error}`);
    }
  }
}

export function createFileSystemAccessAdapter(
  rootHandle: FileSystemDirectoryHandle,
): FileSystemAccessAdapter {
  return new FileSystemAccessAdapter(rootHandle);
}
