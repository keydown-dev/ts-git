import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFS } from '../../fs/memory-adapter.js';
import { walkDir } from '../../utils/walk.js';
import { parseIgnoreFile, createMatcher } from '../../utils/gitignore.js';

describe('walkDir', () => {
  let fs: MemoryFS;

  beforeEach(() => {
    fs = new MemoryFS();
  });

  it('should walk directory recursively', async () => {
    await fs.mkdir('/test/dir1', { recursive: true });
    await fs.mkdir('/test/dir2', { recursive: true });
    await fs.writeFile('/test/file1.txt', 'content');
    await fs.writeFile('/test/dir1/file2.txt', 'content');
    await fs.writeFile('/test/dir2/file3.txt', 'content');

    const files = await walkDir(fs, '/test');

    expect(files).toContain('file1.txt');
    expect(files).toContain('dir1/file2.txt');
    expect(files).toContain('dir2/file3.txt');
    expect(files).toHaveLength(3);
  });

  it('should return empty array for empty directory', async () => {
    await fs.mkdir('/test', { recursive: true });

    const files = await walkDir(fs, '/test');

    expect(files).toEqual([]);
  });

  it('should respect .gitignore patterns (simple: *.txt)', async () => {
    await fs.mkdir('/test', { recursive: true });
    await fs.writeFile('/test/.gitignore', '*.txt');
    await fs.writeFile('/test/file1.txt', 'content');
    await fs.writeFile('/test/file2.js', 'content');

    const files = await walkDir(fs, '/test');

    expect(files).not.toContain('file1.txt');
    expect(files).toContain('file2.js');
    expect(files).toContain('.gitignore');
    expect(files).toHaveLength(2);
  });

  it('should respect .gitignore patterns (directory: node_modules/)', async () => {
    await fs.mkdir('/test/node_modules', { recursive: true });
    await fs.writeFile('/test/.gitignore', 'node_modules/');
    await fs.writeFile('/test/node_modules/pkg/index.js', 'content');
    await fs.writeFile('/test/src/index.js', 'content');

    const files = await walkDir(fs, '/test');

    expect(files).not.toContain('node_modules/pkg/index.js');
    expect(files).toContain('src/index.js');
    expect(files).toContain('.gitignore');
    expect(files).toHaveLength(2);
  });

  it('should respect .gitignore with negation (!pattern)', async () => {
    await fs.mkdir('/test', { recursive: true });
    await fs.writeFile('/test/.gitignore', '*.txt\n!important.txt');
    await fs.writeFile('/test/file1.txt', 'content');
    await fs.writeFile('/test/important.txt', 'content');
    await fs.writeFile('/test/file2.js', 'content');

    const files = await walkDir(fs, '/test');

    expect(files).not.toContain('file1.txt');
    expect(files).toContain('important.txt');
    expect(files).toContain('file2.js');
    expect(files).toContain('.gitignore');
    expect(files).toHaveLength(3);
  });

  it('should apply nested .gitignore from its directory downward', async () => {
    await fs.mkdir('/test/dir1', { recursive: true });
    await fs.mkdir('/test/dir2', { recursive: true });
    await fs.writeFile('/test/.gitignore', '*.log');
    await fs.writeFile('/test/dir1/.gitignore', '!important.log');
    await fs.writeFile('/test/debug.log', 'content');
    await fs.writeFile('/test/dir1/debug.log', 'content');
    await fs.writeFile('/test/dir1/important.log', 'content');
    await fs.writeFile('/test/dir2/debug.log', 'content');

    const files = await walkDir(fs, '/test');

    expect(files).not.toContain('debug.log');
    expect(files).toContain('dir1/important.log');
    expect(files).not.toContain('dir1/debug.log');
    expect(files).not.toContain('dir2/debug.log');
    expect(files).toContain('.gitignore');
    expect(files).toContain('dir1/.gitignore');
    expect(files).toHaveLength(3);
  });

  it('should support full gitignore syntax (*, **, ?, [abc], /**/)', async () => {
    await fs.mkdir('/test', { recursive: true });
    await fs.mkdir('/test/sub/deep', { recursive: true });
    await fs.writeFile('/test/.gitignore', '**/*.tmp\nbuild/\n*.[oa]');
    await fs.writeFile('/test/file.tmp', 'content');
    await fs.writeFile('/test/sub/file.tmp', 'content');
    await fs.writeFile('/test/sub/deep/file.tmp', 'content');
    await fs.writeFile('/test/build/output.js', 'content');
    await fs.writeFile('/test/lib.a', 'content');
    await fs.writeFile('/test/lib.o', 'content');
    await fs.writeFile('/test/lib.js', 'content');

    const files = await walkDir(fs, '/test');

    expect(files).not.toContain('file.tmp');
    expect(files).not.toContain('sub/file.tmp');
    expect(files).not.toContain('sub/deep/file.tmp');
    expect(files).not.toContain('build/output.js');
    expect(files).not.toContain('lib.a');
    expect(files).not.toContain('lib.o');
    expect(files).toContain('lib.js');
    expect(files).toContain('.gitignore');
    expect(files).toHaveLength(2);
  });

  it('should handle ignoreFiles option for custom ignore file names', async () => {
    await fs.mkdir('/test', { recursive: true });
    await fs.writeFile('/test/.customignore', '*.txt');
    await fs.writeFile('/test/file1.txt', 'content');
    await fs.writeFile('/test/file2.js', 'content');

    const files = await walkDir(fs, '/test', {
      ignoreFiles: ['.customignore'],
    });

    expect(files).not.toContain('file1.txt');
    expect(files).toContain('file2.js');
    expect(files).toContain('.customignore');
    expect(files).toHaveLength(2);
  });

  it('should skip excluded directories and their children', async () => {
    await fs.mkdir('/test/dist/nested', { recursive: true });
    await fs.writeFile('/test/.gitignore', 'dist/');
    await fs.writeFile('/test/dist/output.js', 'content');
    await fs.writeFile('/test/dist/nested/more.js', 'content');
    await fs.writeFile('/test/src/index.js', 'content');

    const files = await walkDir(fs, '/test');

    expect(files).not.toContain('dist/output.js');
    expect(files).not.toContain('dist/nested/more.js');
    expect(files).toContain('src/index.js');
    expect(files).toContain('.gitignore');
    expect(files).toHaveLength(2);
  });

  it('should handle anchored patterns correctly', async () => {
    await fs.mkdir('/test', { recursive: true });
    await fs.mkdir('/test/sub', { recursive: true });
    await fs.writeFile('/test/.gitignore', '/build/');
    await fs.mkdir('/test/build', { recursive: true });
    await fs.mkdir('/test/sub/build', { recursive: true });
    await fs.writeFile('/test/build/output.js', 'content');
    await fs.writeFile('/test/sub/build/output.js', 'content');
    await fs.writeFile('/test/src/index.js', 'content');

    const files = await walkDir(fs, '/test');

    // /build/ only matches at root
    expect(files).not.toContain('build/output.js');
    expect(files).toContain('sub/build/output.js');
    expect(files).toContain('src/index.js');
    expect(files).toContain('.gitignore');
    expect(files).toHaveLength(3);
  });

  it('should use pre-parsed ignore patterns', async () => {
    await fs.mkdir('/test', { recursive: true });
    const patterns = parseIgnoreFile('*.log', '');
    await fs.writeFile('/test/debug.log', 'content');
    await fs.writeFile('/test/app.js', 'content');

    const files = await walkDir(fs, '/test', { ignorePatterns: patterns });

    expect(files).not.toContain('debug.log');
    expect(files).toContain('app.js');
    expect(files).toHaveLength(1);
  });

  it('should always ignore .git directory', async () => {
    await fs.mkdir('/test/.git/objects/3e', { recursive: true });
    await fs.writeFile('/test/.git/config', 'git config');
    await fs.writeFile('/test/.git/HEAD', 'ref: refs/heads/master');
    await fs.writeFile('/test/.git/index', 'index content');
    await fs.writeFile(
      '/test/.git/objects/3e/f6b023da5bc0b1013bb34351ccca49faa71e44',
      'object',
    );
    await fs.writeFile('/test/file.txt', 'content');
    await fs.writeFile('/test/readme.md', 'readme');

    const files = await walkDir(fs, '/test');

    // .git directory contents should not be included
    expect(files).not.toContain('.git/config');
    expect(files).not.toContain('.git/HEAD');
    expect(files).not.toContain('.git/index');
    expect(files).not.toContain(
      '.git/objects/3e/f6b023da5bc0b1013bb34351ccca49faa71e44',
    );

    // Other files should be included
    expect(files).toContain('file.txt');
    expect(files).toContain('readme.md');
    expect(files).toHaveLength(2);
  });

  it('should ignore .git directory even in subdirectories', async () => {
    await fs.mkdir('/test/subdir/.git', { recursive: true });
    await fs.writeFile('/test/subdir/.git/config', 'git config');
    await fs.writeFile('/test/subdir/file.txt', 'content');
    await fs.writeFile('/test/root.txt', 'root content');

    const files = await walkDir(fs, '/test');

    // .git directory in subdir should also be ignored
    expect(files).not.toContain('subdir/.git/config');
    expect(files).toContain('subdir/file.txt');
    expect(files).toContain('root.txt');
    expect(files).toHaveLength(2);
  });

  it('should ignore custom gitdir when provided', async () => {
    await fs.mkdir('/test/custom-git/objects', { recursive: true });
    await fs.writeFile('/test/custom-git/config', 'git config');
    await fs.writeFile('/test/custom-git/HEAD', 'ref: refs/heads/master');
    await fs.writeFile('/test/custom-git/objects/abc123', 'object');
    await fs.writeFile('/test/file.txt', 'content');
    await fs.writeFile('/test/readme.md', 'readme');

    const files = await walkDir(fs, '/test', { gitdir: '/test/custom-git' });

    // Custom gitdir contents should not be included
    expect(files).not.toContain('custom-git/config');
    expect(files).not.toContain('custom-git/HEAD');
    expect(files).not.toContain('custom-git/objects/abc123');

    // Other files should be included
    expect(files).toContain('file.txt');
    expect(files).toContain('readme.md');
    expect(files).toHaveLength(2);
  });

  it('should ignore both default .git and custom gitdir', async () => {
    await fs.mkdir('/test/.git', { recursive: true });
    await fs.mkdir('/test/custom-git', { recursive: true });
    await fs.writeFile('/test/.git/config', 'default git config');
    await fs.writeFile('/test/custom-git/config', 'custom git config');
    await fs.writeFile('/test/file.txt', 'content');

    const files = await walkDir(fs, '/test', { gitdir: '/test/custom-git' });

    // Both .git and custom-git should be ignored
    expect(files).not.toContain('.git/config');
    expect(files).not.toContain('custom-git/config');
    expect(files).toContain('file.txt');
    expect(files).toHaveLength(1);
  });
});

describe('parseIgnoreFile', () => {
  it('should parse simple patterns', () => {
    const patterns = parseIgnoreFile('*.txt\n*.log', '/root');

    expect(patterns).toHaveLength(2);
    expect(patterns[0].pattern).toBe('*.txt');
    expect(patterns[0].negative).toBe(false);
    expect(patterns[0].directoryOnly).toBe(false);
    expect(patterns[0].relativeTo).toBe('/root');
  });

  it('should parse negation patterns', () => {
    const patterns = parseIgnoreFile('*.txt\n!important.txt', '/root');

    expect(patterns[0].negative).toBe(false);
    expect(patterns[1].negative).toBe(true);
    expect(patterns[1].pattern).toBe('important.txt');
  });

  it('should parse directory-only patterns', () => {
    const patterns = parseIgnoreFile('build/', '/root');

    expect(patterns[0].directoryOnly).toBe(true);
    expect(patterns[0].pattern).toBe('build');
  });

  it('should parse anchored patterns', () => {
    const patterns = parseIgnoreFile('/build/', '/root');

    expect(patterns[0].anchoredToRoot).toBe(true);
    expect(patterns[0].pattern).toBe('build');
  });

  it('should handle comments', () => {
    // Only a '#' in the first column starts a comment (gitignore(5)); a line
    // with leading whitespace is a pattern, and '\#' is a literal '#'.
    const patterns = parseIgnoreFile(
      '# comment\n*.txt\n  # not a comment\n\\#hash\n*.log',
      '/root',
    );

    expect(patterns.map((p) => p.pattern)).toEqual([
      '*.txt',
      '  # not a comment',
      '\\#hash',
      '*.log',
    ]);
  });

  it('should handle empty lines', () => {
    const patterns = parseIgnoreFile('*.txt\n\n\n*.log', '/root');

    expect(patterns).toHaveLength(2);
  });

  it('should handle complex patterns', () => {
    const patterns = parseIgnoreFile('**/node_modules/**', '/root');

    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe('**/node_modules/**');
  });
});

describe('createMatcher', () => {
  it('should match simple patterns', () => {
    const patterns = parseIgnoreFile('*.txt', '');
    const matcher = createMatcher(patterns);

    expect(matcher('file.txt', false)).toBe(true);
    expect(matcher('file.js', false)).toBe(false);
  });

  it('should match negation patterns', () => {
    const patterns = parseIgnoreFile('*.txt\n!important.txt', '');
    const matcher = createMatcher(patterns);

    expect(matcher('file.txt', false)).toBe(true);
    expect(matcher('important.txt', false)).toBe(false);
  });

  it('should match directory-only patterns', () => {
    const patterns = parseIgnoreFile('build/', '');
    const matcher = createMatcher(patterns);

    expect(matcher('build', true)).toBe(true);
    expect(matcher('build', false)).toBe(false);
  });

  it('should match anchored patterns', () => {
    const patterns = parseIgnoreFile('/build/', '');
    const matcher = createMatcher(patterns);

    expect(matcher('build', true)).toBe(true);
    expect(matcher('sub/build', true)).toBe(false);
  });

  it('should match ** patterns', () => {
    const patterns = parseIgnoreFile('**/*.tmp', '');
    const matcher = createMatcher(patterns);

    expect(matcher('file.tmp', false)).toBe(true);
    expect(matcher('deep/nested/file.tmp', false)).toBe(true);
  });

  it('should match character class patterns', () => {
    const patterns = parseIgnoreFile('*.[oa]', '');
    const matcher = createMatcher(patterns);

    expect(matcher('file.o', false)).toBe(true);
    expect(matcher('file.a', false)).toBe(true);
    expect(matcher('file.x', false)).toBe(false);
  });
});
