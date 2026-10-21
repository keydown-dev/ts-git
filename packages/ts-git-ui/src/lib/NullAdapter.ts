import type { FSAdapter, DirEntry, FileStats } from '@keydown-dev/ts-git';

/**
 * A null/no-op filesystem adapter that throws errors for all operations.
 * Useful for initialization before a real filesystem is selected.
 */
export class NullAdapter implements FSAdapter {
  private throwError(operation: string): never {
    throw new Error(
      `No folder selected. Cannot perform operation: ${operation}`,
    );
  }

  async readdir(_path: string): Promise<DirEntry[]> {
    this.throwError('readdir');
  }

  async readFile(_path: string): Promise<Uint8Array> {
    this.throwError('readFile');
  }

  async readFileString(_path: string): Promise<string> {
    this.throwError('readFileString');
  }

  async writeFile(_path: string, _data: string | Uint8Array): Promise<void> {
    this.throwError('writeFile');
  }

  async mkdir(
    _path: string,
    _options?: { recursive?: boolean; mode?: number },
  ): Promise<void> {
    this.throwError('mkdir');
  }

  async rmdir(
    _path: string,
    _options?: { recursive?: boolean },
  ): Promise<void> {
    this.throwError('rmdir');
  }

  async unlink(_path: string): Promise<void> {
    this.throwError('unlink');
  }

  async stat(_path: string): Promise<FileStats> {
    this.throwError('stat');
  }

  async lstat(_path: string): Promise<FileStats> {
    this.throwError('lstat');
  }

  async exists(_path: string): Promise<boolean> {
    this.throwError('exists');
  }

  async rename(_oldPath: string, _newPath: string): Promise<void> {
    this.throwError('rename');
  }

  async readlink(_path: string): Promise<string> {
    this.throwError('readlink');
  }

  async symlink(
    _target: string,
    _path: string,
    _type?: 'dir' | 'file' | 'junction',
  ): Promise<void> {
    this.throwError('symlink');
  }

  async copyFile(_src: string, _dest: string): Promise<void> {
    this.throwError('copyFile');
  }
}
