export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  ino: number;
  dev: number;
  uid: number;
  gid: number;
  blksize?: number;
  blocks?: number;
}

export interface FSAdapter {
  readFile(path: string): Promise<Uint8Array>;
  readFileString(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStats>;
  lstat(path: string): Promise<FileStats>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  symlink(
    target: string,
    path: string,
    type?: 'dir' | 'file' | 'junction',
  ): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  /**
   * Optional: change permission bits. Used to set the executable bit when
   * checking out mode 100755 files; adapters without it get 100644 files.
   */
  chmod?(path: string, mode: number): Promise<void>;
}

export type FSAdapterOptions = {
  baseDir?: string;
};
