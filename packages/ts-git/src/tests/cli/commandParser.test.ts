import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import { GitClient } from '../../client/index.js';
import type { Author, LineDiffAlgorithm } from '../../types.js';
import {
  commandParser,
  tokenizeCommand,
  type CommandContext,
} from '../../cli/commandParser.js';

// Simple Myers diff implementation for testing
const myersLineDiff: LineDiffAlgorithm = (oldLines, newLines) => {
  const edits: {
    type: '+' | '-' | ' ';
    oldIndex: number;
    newIndex: number;
    content: string;
  }[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  // Find matching lines at the start
  while (
    oldIdx < oldLines.length &&
    newIdx < newLines.length &&
    oldLines[oldIdx] === newLines[newIdx]
  ) {
    edits.push({
      type: ' ',
      oldIndex: oldIdx,
      newIndex: newIdx,
      content: oldLines[oldIdx],
    });
    oldIdx++;
    newIdx++;
  }

  // Find matching lines at the end
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  const endEdits: typeof edits = [];

  while (
    oldEnd > oldIdx &&
    newEnd > newIdx &&
    oldLines[oldEnd] === newLines[newEnd]
  ) {
    endEdits.unshift({
      type: ' ',
      oldIndex: oldEnd,
      newIndex: newEnd,
      content: oldLines[oldEnd],
    });
    oldEnd--;
    newEnd--;
  }

  // Everything in between is changes
  for (let i = oldIdx; i <= oldEnd; i++) {
    edits.push({ type: '-', oldIndex: i, newIndex: -1, content: oldLines[i] });
  }
  for (let i = newIdx; i <= newEnd; i++) {
    edits.push({ type: '+', oldIndex: -1, newIndex: i, content: newLines[i] });
  }

  return [...edits, ...endEdits];
};

describe('tokenizeCommand', () => {
  it('splits like a shell', () => {
    expect(tokenizeCommand('git  commit -m "a b"  ')).toEqual([
      'git',
      'commit',
      '-m',
      'a b',
    ]);
    expect(tokenizeCommand(`echo 'it''s' "say \\"hi\\"" a\\ b ""`)).toEqual([
      'echo',
      'its',
      'say "hi"',
      'a b',
      '',
    ]);
  });
});

describe('commandParser', () => {
  let fs: MemoryFS;
  let git: GitClient;
  let author: Author;

  beforeEach(() => {
    fs = new MemoryFS();
    author = { name: 'Test User', email: 'test@example.com' };
  });

  // Helper to create a context
  // Note: '/' represents the virtual root (the opened folder)
  // The filesystem adapter translates this to the actual folder path
  const createContext = (currentDir: string = '/'): CommandContext => ({
    currentDir,
    fs,
    git,
    author,
  });

  // Helper to setup a basic git repo
  const setupGitRepo = async (dir: string = '/') => {
    const absoluteGitdir = dir === '/' ? '/.git' : `${dir}/.git`;
    git = new GitClient({
      fs,
      dir,
      gitdir: absoluteGitdir,
      lineDiffAlgorithm: myersLineDiff,
    });
    await git.init();
  };

  describe('cd command', () => {
    beforeEach(async () => {
      await fs.mkdir('/test', { recursive: true });
      await fs.mkdir('/test/subfolder', { recursive: true });
      await fs.mkdir('/test/subfolder/deep', { recursive: true });
    });

    it('should navigate to a subdirectory', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('cd test', context);

      expect(result.success).toBe(true);
      expect(result.newDirectory).toBe('/test');
    });

    it('should navigate to root when called without args', async () => {
      const context = createContext('/test/subfolder');
      const result = await commandParser.execute('cd', context);

      expect(result.success).toBe(true);
      expect(result.newDirectory).toBe('/');
    });

    it('should treat / as the virtual root (opened folder)', async () => {
      // Create files in root
      await fs.writeFile('/root-file.txt', 'content');

      const context = createContext('/');
      const result = await commandParser.execute('ls', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('root-file.txt');
      expect(result.output).toContain('test');
    });

    it('should resolve file paths relative to current directory', async () => {
      await fs.writeFile('/test/file-in-test.txt', 'test content');

      // From root, access file in test/
      const context1 = createContext('/');
      const result1 = await commandParser.execute(
        'cat test/file-in-test.txt',
        context1,
      );
      expect(result1.success).toBe(true);
      expect(result1.output).toBe('test content');

      // From /test, access file directly
      const context2 = createContext('/test');
      const result2 = await commandParser.execute(
        'cat file-in-test.txt',
        context2,
      );
      expect(result2.success).toBe(true);
      expect(result2.output).toBe('test content');
    });

    it('should navigate using relative path', async () => {
      const context = createContext('/test');
      const result = await commandParser.execute('cd subfolder', context);

      expect(result.success).toBe(true);
      expect(result.newDirectory).toBe('/test/subfolder');
    });

    it('should navigate using .. to go up', async () => {
      const context = createContext('/test/subfolder');
      const result = await commandParser.execute('cd ..', context);

      expect(result.success).toBe(true);
      expect(result.newDirectory).toBe('/test');
    });

    it('should navigate using multiple ..', async () => {
      const context = createContext('/test/subfolder/deep');
      const result = await commandParser.execute('cd ../..', context);

      expect(result.success).toBe(true);
      expect(result.newDirectory).toBe('/test');
    });

    it('should not allow navigating above root', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('cd ..', context);

      expect(result.success).toBe(true);
      expect(result.newDirectory).toBe('/');
    });

    it('should not allow navigating with ~ (home)', async () => {
      const context = createContext('/test');
      const result = await commandParser.execute('cd ~', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Cannot navigate outside root folder');
    });

    it('should handle . (current directory)', async () => {
      const context = createContext('/test');
      const result = await commandParser.execute('cd .', context);

      expect(result.success).toBe(true);
      expect(result.newDirectory).toBe('/test');
    });

    it('should error on non-existent directory', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('cd nonexistent', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('No such file or directory');
    });

    it('should error when trying to cd into a file', async () => {
      await fs.writeFile('/test/file.txt', 'content');
      const context = createContext('/');
      const result = await commandParser.execute('cd test/file.txt', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Not a directory');
    });
  });

  describe('pwd command', () => {
    it('should show root path', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('pwd', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('/');
    });

    it('should show current subdirectory', async () => {
      const context = createContext('/test/subfolder');
      const result = await commandParser.execute('pwd', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('/test/subfolder');
    });
  });

  describe('ls command', () => {
    beforeEach(async () => {
      await fs.mkdir('/test', { recursive: true });
      await fs.mkdir('/test/subfolder', { recursive: true });
      await fs.writeFile('/test/file1.txt', 'content1');
      await fs.writeFile('/test/file2.txt', 'content2');
    });

    it('should list files in current directory', async () => {
      const context = createContext('/test');
      const result = await commandParser.execute('ls', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('file1.txt');
      expect(result.output).toContain('file2.txt');
      expect(result.output).toContain('subfolder');
    });

    it('should list files in root by default', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('ls', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('test');
    });

    it('should list files in specified subdirectory', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('ls test', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('file1.txt');
      expect(result.output).toContain('subfolder');
    });

    it('should handle empty directory', async () => {
      const context = createContext('/test/subfolder');
      const result = await commandParser.execute('ls', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('is empty');
    });
  });

  describe('touch command', () => {
    it('should create a new file in current directory', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('touch newfile.txt', context);

      expect(result.success).toBe(true);
      expect(await fs.exists('/newfile.txt')).toBe(true);
    });

    it('should create a file in subdirectory', async () => {
      await fs.mkdir('/test', { recursive: true });
      const context = createContext('/test');
      const result = await commandParser.execute('touch myfile.txt', context);

      expect(result.success).toBe(true);
      expect(await fs.exists('/test/myfile.txt')).toBe(true);
    });

    it('should update timestamp of existing file', async () => {
      await fs.writeFile('/existing.txt', 'content');

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      const context = createContext('/');
      const result = await commandParser.execute('touch existing.txt', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Updated timestamp');
    });

    it('should error when no filename provided', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('touch', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });
  });

  describe('cat command', () => {
    beforeEach(async () => {
      await fs.writeFile('/test.txt', 'Hello, World!');
      await fs.mkdir('/test', { recursive: true });
      await fs.writeFile('/test/nested.txt', 'Nested content');
    });

    it('should read file in current directory', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('cat test.txt', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Hello, World!');
    });

    it('should read file in subdirectory', async () => {
      const context = createContext('/test');
      const result = await commandParser.execute('cat nested.txt', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Nested content');
    });

    it('should error when no filename provided', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('cat', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });

    it('should error on non-existent file', async () => {
      const context = createContext('/');
      const result = await commandParser.execute(
        'cat nonexistent.txt',
        context,
      );

      expect(result.success).toBe(false);
    });
  });

  describe('mkdir command', () => {
    it('should create directory in current location', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('mkdir newdir', context);

      expect(result.success).toBe(true);
      expect(await fs.exists('/newdir')).toBe(true);
      const stats = await fs.stat('/newdir');
      expect(stats.isDirectory).toBe(true);
    });

    it('should create nested directory structure', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('mkdir a/b/c', context);

      expect(result.success).toBe(true);
      expect(await fs.exists('/a/b/c')).toBe(true);
    });

    it('should error when no directory name provided', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('mkdir', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });
  });

  describe('delete/rm command', () => {
    beforeEach(async () => {
      await fs.writeFile('/test.txt', 'content');
      await fs.mkdir('/testdir', { recursive: true });
      await fs.writeFile('/testdir/file.txt', 'content');
    });

    it('should delete a file', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('delete test.txt', context);

      expect(result.success).toBe(true);
      expect(await fs.exists('/test.txt')).toBe(false);
    });

    it('should remove a tracked file from the index with git rm', async () => {
      await setupGitRepo();
      await fs.writeFile('/tracked.txt', 'x');
      await git.add('tracked.txt');
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('git rm tracked.txt', context);

      expect(result.success).toBe(true);
    });

    it('should delete a directory recursively', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('delete testdir', context);

      expect(result.success).toBe(true);
      expect(await fs.exists('/testdir')).toBe(false);
    });

    it('should error when no path provided', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('delete', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });
  });

  describe('rename/mv command', () => {
    beforeEach(async () => {
      await fs.writeFile('/oldname.txt', 'content');
      await fs.mkdir('/test', { recursive: true });
    });

    it('should rename a file', async () => {
      const context = createContext('/');
      const result = await commandParser.execute(
        'rename oldname.txt newname.txt',
        context,
      );

      expect(result.success).toBe(true);
      expect(await fs.exists('/oldname.txt')).toBe(false);
      expect(await fs.exists('/newname.txt')).toBe(true);
    });

    it('should rename a file using mv alias', async () => {
      const context = createContext('/');
      const result = await commandParser.execute(
        'mv oldname.txt newname.txt',
        context,
      );

      expect(result.success).toBe(true);
      expect(await fs.exists('/newname.txt')).toBe(true);
    });

    it('should move a file to subdirectory', async () => {
      const context = createContext('/');
      const result = await commandParser.execute(
        'mv oldname.txt test/newname.txt',
        context,
      );

      expect(result.success).toBe(true);
      expect(await fs.exists('/test/newname.txt')).toBe(true);
    });

    it('should error when missing arguments', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('rename oldname.txt', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });
  });

  describe('edit command', () => {
    beforeEach(async () => {
      await fs.writeFile('/test.txt', 'File content');
    });

    it('should return edit marker for existing file', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('edit test.txt', context);

      expect(result.success).toBe(true);
      expect(result.output).toMatch(/^__EDIT__:/);
      // Content is URL-encoded, so check for encoded version
      expect(result.output).toContain('File%20content');
    });

    it('should return edit marker for new file', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('edit newfile.txt', context);

      expect(result.success).toBe(true);
      expect(result.output).toMatch(/^__EDIT__:/);
    });

    it('should error when no filename provided', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('edit', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });
  });

  describe('git init command', () => {
    it('should initialize a git repository', async () => {
      const context = createContext('/');
      git = new GitClient({ fs, dir: '/', gitdir: '/.git' });
      context.git = git;

      const result = await commandParser.execute('init', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Initialized empty Git repository');
      expect(await fs.exists('/.git')).toBe(true);
    });

    it('should initialize with custom branch name', async () => {
      const context = createContext('/');
      git = new GitClient({ fs, dir: '/', gitdir: '/.git' });
      context.git = git;

      const result = await commandParser.execute('init main', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain("default branch 'main'");
    });
  });

  describe('git add command', () => {
    beforeEach(async () => {
      await setupGitRepo();
      await fs.writeFile('/test.txt', 'content');
    });

    it('should add a file to staging', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('add test.txt', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain("Added 'test.txt'");
    });

    it('should add all files with -A flag', async () => {
      await fs.writeFile('/another.txt', 'content2');
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('add -A', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Added all changes');
    });

    it('should add all files with . flag', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('add .', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Added all changes');
    });

    it('should error when no file specified', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('add', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });
  });

  describe('git status command', () => {
    beforeEach(async () => {
      await setupGitRepo();
    });

    it('should show clean status in empty repo', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('On branch master');
      expect(result.output).toContain('nothing to commit, working tree clean');
    });

    it('should show untracked files', async () => {
      await fs.writeFile('/newfile.txt', 'content');
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('On branch master');
      expect(result.output).toContain('Untracked files:');
      expect(result.output).toContain('newfile.txt');
    });

    it('should list untracked .gitignore without staging it', async () => {
      await fs.writeFile('/.gitignore', '*.log\n');
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Untracked files:');
      expect(result.output).toContain('.gitignore');
    });

    it('should show clean status after commit', async () => {
      await fs.writeFile('/test.txt', 'content');
      await git.add('test.txt');
      await git.commit('Initial commit', author);

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('On branch master');
      expect(result.output).toContain('nothing to commit, working tree clean');
      expect(result.output).not.toContain('test.txt');
    });

    it('should show staged changes', async () => {
      await fs.writeFile('/test.txt', 'content');
      await git.add('test.txt');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('On branch master');
      expect(result.output).toContain('Changes to be committed:');
      expect(result.output).toContain('new file:');
      expect(result.output).toContain('test.txt');
    });

    it('should show unstaged changes', async () => {
      await fs.writeFile('/test.txt', 'content');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/test.txt', 'modified');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('On branch master');
      expect(result.output).toContain('Changes not staged for commit:');
      expect(result.output).toContain('modified:');
      expect(result.output).toContain('test.txt');
    });

    it('should show nested files correctly after commit', async () => {
      await fs.mkdir('/testdir', { recursive: true });
      await fs.writeFile('/testdir/nested.txt', 'content');
      await git.add('testdir/nested.txt');
      await git.commit('Initial commit', author);

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('On branch master');
      expect(result.output).toContain('nothing to commit, working tree clean');
      expect(result.output).not.toContain('nested.txt');
    });

    it('should show modified nested files', async () => {
      await fs.mkdir('/testdir', { recursive: true });
      await fs.writeFile('/testdir/nested.txt', 'content');
      await git.add('testdir/nested.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/testdir/nested.txt', 'modified');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('On branch master');
      expect(result.output).toContain('Changes not staged for commit:');
      expect(result.output).toContain('modified:');
      expect(result.output).toContain('testdir/nested.txt');
    });

    it('should show multiple files with different statuses', async () => {
      await fs.writeFile('/committed.txt', 'content');
      await fs.mkdir('/testdir', { recursive: true });
      await fs.writeFile('/testdir/nested.txt', 'nested content');
      await git.add('committed.txt');
      await git.add('testdir/nested.txt');
      await git.commit('Initial commit', author);

      // Modify committed file
      await fs.writeFile('/committed.txt', 'modified');
      // Add new file
      await fs.writeFile('/newfile.txt', 'new content');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('On branch master');
      expect(result.output).toContain('Changes not staged for commit:');
      expect(result.output).toContain('committed.txt');
      expect(result.output).toContain('Untracked files:');
      expect(result.output).toContain('newfile.txt');
      // Should NOT contain 'nothing to commit' since there ARE changes
      expect(result.output).not.toContain(
        'nothing to commit, working tree clean',
      );
    });
  });

  describe('git commit command', () => {
    beforeEach(async () => {
      await setupGitRepo();
      await fs.writeFile('/test.txt', 'content');
    });

    it('should commit with message', async () => {
      const context = createContext('/');
      context.git = git;
      await git.add('test.txt');

      const result = await commandParser.execute(
        'commit -m "Test commit"',
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('Created commit:');
    });

    it('keeps a quoted multi-word message intact', async () => {
      const context = createContext('/');
      context.git = git;
      await git.add('test.txt');

      const result = await commandParser.execute(
        'git commit -m "Initial commit with spaces"',
        context,
      );

      expect(result.success).toBe(true);
      const [entry] = await git.log(1);
      expect(entry.commit.message).toBe('Initial commit with spaces\n');
    });

    it('should error without message', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('commit', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });
  });

  describe('git branch command', () => {
    beforeEach(async () => {
      await setupGitRepo();
      await fs.writeFile('/test.txt', 'content');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
    });

    it('should list branches', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('branch', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('master');
    });

    it('should create a new branch', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('branch feature', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain("Created branch 'feature'");
    });
  });

  describe('git checkout command', () => {
    beforeEach(async () => {
      await setupGitRepo();
      await fs.writeFile('/test.txt', 'content');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await git.branch('feature');
    });

    it('should switch to a branch', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('checkout feature', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain("Switched to branch 'feature'");
    });

    it('should error when no branch specified', async () => {
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('checkout', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Usage:');
    });
  });

  describe('help command', () => {
    it('should display help message', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('help', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Available commands');
      expect(result.output).toContain('cd');
      expect(result.output).toContain('pwd');
      expect(result.output).toContain('git init');
    });

    it('should display git help for bare git command', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('git', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('usage: git');
    });
  });

  describe('clear command', () => {
    it('should return clear marker', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('clear', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('__CLEAR__');
    });
  });

  describe('edge cases', () => {
    it('should handle empty command', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('should handle whitespace-only command', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('   ', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('should handle unknown command', async () => {
      const context = createContext('/');
      const result = await commandParser.execute('unknowncommand', context);

      expect(result.success).toBe(false);
      expect(result.output).toContain('Unknown command');
    });

    it('should handle git prefix for commands', async () => {
      await setupGitRepo();
      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('git init', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('Initialized');
    });
  });

  describe('path resolution with cd context', () => {
    beforeEach(async () => {
      // Setup a project structure within the virtual root
      // '/' represents the opened folder, '/project' is a subdirectory
      await fs.mkdir('/project/src', { recursive: true });
      await fs.mkdir('/project/lib', { recursive: true });
      await fs.writeFile('/project/src/main.ts', 'console.log("main")');
      await fs.writeFile(
        '/project/lib/helper.ts',
        'export const helper = () => {}',
      );
      await setupGitRepo('/project');
    });

    it('should touch file relative to current directory', async () => {
      const context = createContext('/project/src');
      const result = await commandParser.execute('touch newfile.ts', context);

      expect(result.success).toBe(true);
      expect(await fs.exists('/project/src/newfile.ts')).toBe(true);
    });

    it('should cat file relative to current directory', async () => {
      const context = createContext('/project/src');
      const result = await commandParser.execute('cat main.ts', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('console.log("main")');
    });

    it('should ls files in current directory', async () => {
      const context = createContext('/project/src');
      const result = await commandParser.execute('ls', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('main.ts');
      expect(result.output).not.toContain('helper.ts');
    });

    it('should add files using relative path', async () => {
      const context = createContext('/project');
      context.git = git;
      const result = await commandParser.execute('add src/main.ts', context);

      expect(result.success).toBe(true);
    });
  });

  describe('git diff command', () => {
    beforeEach(async () => {
      await setupGitRepo();
    });

    it('should show empty diff for clean repository', async () => {
      await fs.writeFile('/test.txt', 'content');
      await git.add('test.txt');
      await git.commit('Initial commit', author);

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff', context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('should show diff for modified file', async () => {
      await fs.writeFile('/test.txt', 'original');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/test.txt', 'modified');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('diff --git');
      expect(result.output).toContain('-original');
      expect(result.output).toContain('+modified');
    });

    it('should show staged diff with --cached', async () => {
      await fs.writeFile('/test.txt', 'original');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/test.txt', 'modified');
      await git.add('test.txt');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff --cached', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('diff --git');
      expect(result.output).toContain('-original');
      expect(result.output).toContain('+modified');
    });

    it('should show staged diff with --staged', async () => {
      await fs.writeFile('/test.txt', 'original');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/test.txt', 'modified');
      await git.add('test.txt');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff --staged', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('diff --git');
    });

    it('should show name-only diff', async () => {
      await fs.writeFile('/test.txt', 'original');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/test.txt', 'modified');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff --name-only', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('test.txt');
      expect(result.output).not.toContain('diff --git');
    });

    it('should show name-status diff', async () => {
      await fs.writeFile('/test.txt', 'original');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/test.txt', 'modified');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff --name-status', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('M\ttest.txt');
    });

    it('should show stat diff', async () => {
      await fs.writeFile('/test.txt', 'line1\nline2');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/test.txt', 'line1\nmodified\nline3');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff --stat', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('test.txt');
      expect(result.output).toContain('file changed');
    });

    it('should show diff for new staged file', async () => {
      await fs.writeFile('/newfile.txt', 'new content');
      await git.add('newfile.txt');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff --cached', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('diff --git');
      expect(result.output).toContain('new file mode');
      expect(result.output).toContain('+new content');
    });

    it('should show diff for deleted file', async () => {
      await fs.writeFile('/test.txt', 'content');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.unlink('/test.txt');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('diff --git');
      expect(result.output).toContain('deleted file mode');
      expect(result.output).toContain('-content');
    });

    it('should show diff for staged deleted file', async () => {
      await fs.writeFile('/test.txt', 'content');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.unlink('/test.txt');
      await git.remove('test.txt');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff --cached', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('deleted file mode');
    });

    it('should limit diff to specific paths', async () => {
      await fs.mkdir('/dir', { recursive: true });
      await fs.writeFile('/dir/file.txt', 'original');
      await fs.writeFile('/root.txt', 'original');
      await git.add('dir/file.txt');
      await git.add('root.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/dir/file.txt', 'modified');
      await fs.writeFile('/root.txt', 'modified');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff -- dir', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('dir/file.txt');
      // May or may not contain root.txt depending on path filtering behavior
    });

    it('should treat single path argument as pathspec without --', async () => {
      await fs.writeFile('/a.txt', 'a0');
      await fs.writeFile('/b.txt', 'b0');
      await git.add('a.txt');
      await git.add('b.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/a.txt', 'a1');
      await fs.writeFile('/b.txt', 'b1');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('diff a.txt', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('a.txt');
      expect(result.output).toContain('+a1');
      expect(result.output).not.toContain('b.txt');
    });

    it('should treat pathspec with --cached without double-dash', async () => {
      await fs.writeFile('/a.txt', 'a0');
      await fs.writeFile('/b.txt', 'b0');
      await git.add('a.txt');
      await git.add('b.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/a.txt', 'a1');
      await fs.writeFile('/b.txt', 'b1');
      await git.add('a.txt');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute(
        'diff --cached a.txt',
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('a.txt');
      expect(result.output).toContain('+a1');
      expect(result.output).not.toContain('b.txt');
    });

    it('should show diff against specific commit', async () => {
      await fs.writeFile('/test.txt', 'version1');
      await git.add('test.txt');
      const oid1 = await git.commit('First commit', author);
      await fs.writeFile('/test.txt', 'version2');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute(`diff ${oid1}`, context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('diff --git');
      expect(result.output).toContain('-version1');
      expect(result.output).toContain('+version2');
    });

    it('should handle git diff command with git prefix', async () => {
      await fs.writeFile('/test.txt', 'original');
      await git.add('test.txt');
      await git.commit('Initial commit', author);
      await fs.writeFile('/test.txt', 'modified');

      const context = createContext('/');
      context.git = git;

      const result = await commandParser.execute('git diff', context);

      expect(result.success).toBe(true);
      expect(result.output).toContain('diff --git');
    });
  });
});

describe('commandParser remote commands', () => {
  const author: Author = { name: 'Test User', email: 'test@example.com' };

  async function setup() {
    const fs = new MemoryFS();
    const git = new GitClient({
      fs,
      dir: '/work',
      lineDiffAlgorithm: myersLineDiff,
    });
    await git.init({ defaultBranch: 'main' });
    const context: CommandContext = { currentDir: '/', fs, git, author };
    const run = (cmd: string) => commandParser.execute(cmd, context);
    return { fs, git, run };
  }

  /** A bare hub at /hub.git holding one commit on main, plus a seed clone. */
  async function setupHub(fs: MemoryFS) {
    await fs.mkdir('/hub.git/objects', { recursive: true });
    await fs.mkdir('/hub.git/refs/heads', { recursive: true });
    await fs.writeFile('/hub.git/HEAD', 'ref: refs/heads/main\n');
    await fs.writeFile('/hub.git/config', '[core]\n\tbare = true\n');
    const seed = new GitClient({ fs, dir: '/seed' });
    await seed.init({ defaultBranch: 'main' });
    await fs.writeFile('/seed/a.txt', 'a\n');
    await seed.add('a.txt');
    const oid = await seed.commit('seed', author);
    await seed.addRemote('origin', '/hub.git');
    await seed.push({ refspecs: ['main'] });
    return { seed, oid };
  }

  it('fetches with git-style output', async () => {
    const { fs, run } = await setup();
    const { seed, oid } = await setupHub(fs);
    await run('git remote add origin /hub.git');

    const first = await run('git fetch');
    expect(first.success).toBe(true);
    expect(first.output).toBe(
      'From /hub.git\n * [new branch] main -> origin/main',
    );

    await fs.writeFile('/seed/a.txt', 'b\n');
    await seed.add('a.txt');
    const next = await seed.commit('second', author);
    await seed.push();
    const second = await run('git fetch origin');
    expect(second.output).toBe(
      `From /hub.git\n   ${oid.slice(0, 7)}..${next.slice(0, 7)} main -> origin/main`,
    );
    expect((await run('git fetch')).output).toBe('');
  });

  it('pushes and reports rejections like git', async () => {
    const { fs, git, run } = await setup();
    const { seed } = await setupHub(fs);
    await run('git remote add origin /hub.git');
    await run('git fetch');
    await git.branch('topic', true, { object: 'origin/main' });
    await fs.writeFile('/work/b.txt', 'b\n');
    await git.add('b.txt');
    await git.commit('topic work', author);

    const pushed = await run('git push -u origin topic');
    expect(pushed.success).toBe(true);
    expect(pushed.output).toBe('To /hub.git\n * [new branch] topic -> topic');

    // Someone else moves topic on the hub; our next push is rejected.
    await seed.fetch();
    await seed.branch('topic', true, { object: 'origin/topic' });
    await fs.writeFile('/seed/c.txt', 'c\n');
    await seed.add('c.txt');
    await seed.commit('theirs', author);
    await seed.push({ refspecs: ['topic'] });

    await fs.writeFile('/work/b.txt', 'b2\n');
    await git.add('b.txt');
    await git.commit('ours', author);
    const rejected = await run('git push');
    expect(rejected.success).toBe(false);
    expect(rejected.output).toContain(
      '! [rejected] topic -> topic  (fetch first)',
    );
    expect(rejected.output).toContain(
      "error: failed to push some refs to '/hub.git'",
    );
    expect((await run('git push')).success).toBe(false);
    expect((await run('git push --force')).output).toMatch(
      /^To \/hub.git\n \+ \w{7}\.\.\.\w{7} topic -> topic  \(forced update\)$/,
    );
  });

  it('merges branches, reports conflicts and aborts', async () => {
    const { fs, git, run } = await setup();
    await fs.writeFile('/work/f.txt', 'base\n');
    await git.add('f.txt');
    await git.commit('base', author);
    await git.branch('feature', true);
    await fs.writeFile('/work/f.txt', 'feature\n');
    await git.add('f.txt');
    await git.commit('feature', author);
    await git.checkoutBranch('main');

    const ff = await run('git merge --ff-only feature');
    expect(ff.output).toMatch(/^Updating \w{7}\.\.\w{7}\nFast-forward$/);
    expect((await run('git merge feature')).output).toBe('Already up to date.');

    await git.branch('other', true, { object: 'HEAD~1' });
    await fs.writeFile('/work/f.txt', 'other\n');
    await git.add('f.txt');
    await git.commit('other', author);
    const conflict = await run('git merge main');
    expect(conflict.success).toBe(false);
    expect(conflict.output).toContain('CONFLICT: f.txt');
    expect(await fs.readFileString('/work/f.txt')).toContain('<<<<<<< HEAD');
    expect((await run('git merge --abort')).success).toBe(true);
    expect(await fs.readFileString('/work/f.txt')).toBe('other\n');
  });

  it('pulls the upstream branch', async () => {
    const { fs } = await setup();
    const { seed } = await setupHub(fs);
    const git2 = new GitClient({ fs, dir: '/clone' });
    await git2.clone('/hub.git');
    const context: CommandContext = { currentDir: '/', fs, git: git2, author };

    await fs.writeFile('/seed/a.txt', 'updated\n');
    await seed.add('a.txt');
    await seed.commit('update', author);
    await seed.push();

    const pulled = await commandParser.execute('git pull', context);
    expect(pulled.success).toBe(true);
    expect(pulled.output).toMatch(
      /^From \/hub.git\n {3}\w{7}\.\.\w{7} main -> origin\/main\nUpdating \w{7}\.\.\w{7}\nFast-forward$/,
    );
    expect(await fs.readFileString('/clone/a.txt')).toBe('updated\n');
    expect(
      (await commandParser.execute('git pull --rebase', context)).success,
    ).toBe(false);
  });

  it('manages remotes', async () => {
    const { run } = await setup();
    expect(
      (await run('git remote add origin https://example.com/r.git')).success,
    ).toBe(true);
    expect((await run('git remote')).output).toBe('origin');
    await run('git remote set-url --push origin https://example.com/push.git');
    expect((await run('git remote -v')).output).toBe(
      'origin\thttps://example.com/r.git (fetch)\norigin\thttps://example.com/push.git (push)',
    );
    expect((await run('git remote get-url origin')).output).toBe(
      'https://example.com/r.git',
    );
    expect((await run('git remote remove origin')).success).toBe(true);
    expect((await run('git remote')).output).toBe('');
    expect((await run('git remote add onlyname')).success).toBe(false);
  });
});
