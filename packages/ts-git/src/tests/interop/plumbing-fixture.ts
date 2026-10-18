import * as nodefs from 'fs';
import * as path from 'path';
import { gitCommitAll, type GitSandbox } from './git-env.js';

/**
 * Populate a sandbox with a history covering the interesting object/tree
 * shapes: nested dirs, executable, symlink, gitlink, unicode and
 * special-character names, empty file, binary file, merge commit and
 * annotated tags (including a tag of a tag and a tag of a tree/blob).
 */
export function buildPlumbingRepo(sb: GitSandbox): void {
  sb.write('README.md', '# readme\n');
  sb.write('empty.txt', '');
  sb.write('src/main.js', 'console.log(1);\n');
  sb.write('src/lib/util.js', 'export const x = 1;\n');
  sb.write('src/lib/deep/er/file.txt', 'deep\n');
  sb.write('docs/guide.md', 'guide\n');
  sb.write('a-b', 'dash\n');
  sb.write('a.b', 'dot\n');
  sb.write('a/b', 'slash\n');
  sb.write('ファイル.txt', 'unicode\n');
  sb.write('tab\tname.txt', 'tab\n');
  sb.write('quote"name.txt', 'quote\n');
  sb.write('back\\slash.txt', 'backslash\n');
  sb.write('with space.txt', 'space\n');
  sb.write('bin.dat', Buffer.from([0, 1, 2, 3, 255, 254, 0, 10]));
  sb.write('run.sh', '#!/bin/sh\necho hi\n');
  nodefs.chmodSync(path.join(sb.dir, 'run.sh'), 0o755);
  nodefs.symlinkSync('src/main.js', path.join(sb.dir, 'link-to-main'));
  sb.git(['add', '-A']);
  sb.git([
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${'a'.repeat(40)},vendor/sub`,
  ]);
  gitCommitAll(sb, 'initial');

  sb.write('src/main.js', 'console.log(2);\n');
  gitCommitAll(sb, 'second');

  sb.git(['checkout', '-q', '-b', 'side', 'HEAD~1']);
  sb.write('side.txt', 'side\n');
  gitCommitAll(sb, 'side work');
  sb.git(['checkout', '-q', 'main']);
  sb.git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);

  sb.git(['tag', 'light']);
  sb.git(['tag', '-a', 'v1', '-m', 'version 1']);
  sb.git(['tag', '-a', 'v1-outer', 'v1', '-m', 'tag of tag']);
  sb.git(['tag', '-a', 'tree-tag', 'HEAD^{tree}', '-m', 'tag of tree']);
  sb.git(['tag', '-a', 'blob-tag', 'HEAD:README.md', '-m', 'tag of blob']);
}
