/**
 * Decorative diff hunks for the homepage background.
 *
 * Each hunk is a list of lines in unified-diff form: the first character is
 * the line type (`+` added, `-` removed, ` ` context). Content is
 * TS-Git-flavoured TypeScript so the backdrop reads as "this library, mid-edit".
 */
export interface Hunk {
  /** Text after the `@@ ... @@` range, like git's function context. */
  context: string;
  lines: string[];
}

export const hunks: Hunk[] = [
  {
    context: "import { GitClient } from '@keydown-app/ts-git';",
    lines: [
      "-import { GitClient, MemoryFSAdapter } from '@keydown-app/ts-git';",
      "+import { GitClient, MemoryFS } from '@keydown-app/ts-git';",
      ' ',
      '-const fs = new MemoryFSAdapter();',
      '+const fs = new MemoryFS();',
      " const git = new GitClient({ fs, dir: '/repo' });",
      '-await git.init();',
      "+await git.init({ defaultBranch: 'main' });",
    ],
  },
  {
    context: 'async function commitAll(git: GitClient) {',
    lines: [
      '   const matrix = await git.statusMatrix();',
      '-  for (const row of matrix) await git.add(row[0]);',
      '+  await git.addAll();',
      '   return git.commit(message, {',
      "-    name: 'Anonymous',",
      "+    name: 'Ada Lovelace',",
      "+    email: 'ada@example.com',",
      '   });',
      ' }',
    ],
  },
  {
    context: 'export async function diff(args: DiffArgs) {',
    lines: [
      '   const { left, right } = await resolveComparisonSides(args);',
      '-  const deltas = compareSnapshots(left, right);',
      '+  const deltas = compareSnapshots(left, right, {',
      '+    paths: args.paths,',
      '+    lineDiffAlgorithm: args.lineDiffAlgorithm,',
      '+    contextLines: args.contextLines ?? 3,',
      '+  });',
      '   return { left, right, deltas };',
    ],
  },
  {
    context: 'class LocalStorageFS implements FSAdapter {',
    lines: [
      '   async readFile(path: string): Promise<Uint8Array> {',
      '-    return localStorage.getItem(path);',
      '+    const b64 = localStorage.getItem(this.key(path));',
      '+    if (b64 === null) throw enoent(path);',
      '+    return decode(b64);',
      '   }',
      ' ',
      '   async exists(path: string) {',
    ],
  },
  {
    context: 'const result = await git.diff({ cached: true });',
    lines: [
      "-console.log(formatDiff(result, 'patch'));",
      "+console.log(formatDiff(result, 'stat'));",
      ' // README.md | 3 ++-',
      ' //  1 file changed, 2 insertions(+), 1 deletion(-)',
      '-await git.reset();',
      "+await git.reset(['README.md']);",
    ],
  },
  {
    context: 'export async function branch(args: BranchArgs) {',
    lines: [
      '   const branchRef = `refs/heads/${ref}`;',
      '-  await writeRef(fs, gitdir, branchRef, oid);',
      '+  const existing = await readRef(fs, gitdir, branchRef);',
      '+  if (existing && !force) {',
      '+    throw new AlreadyExistsError(`Branch ${ref} exists`);',
      '+  }',
      '+  await writeRef(fs, gitdir, branchRef, targetOid, force);',
      '   if (checkout) await setHead(fs, gitdir, branchRef);',
    ],
  },
  {
    context: "const { oid } = await hashObjectString({ fs, dir,",
    lines: [
      "-  content: 'hello world',",
      "+  content: 'hello world\\n',",
      '+  write: true,',
      ' });',
      "-const type = await catFile({ fs, dir, oid });",
      "+const type = await catFile({ fs, dir, oid, typeOnly: true });",
      " // 'blob'",
    ],
  },
  {
    context: 'const log = await git.log(10);',
    lines: [
      ' for (const { oid, commit } of log) {',
      '-  console.log(oid, commit.message);',
      '+  const short = oid.slice(0, 7);',
      '+  console.log(`${short} ${commit.message.trim()}`);',
      ' }',
      "-await git.checkoutBranch('master');",
      "+await git.branch('feature/remote', true);",
    ],
  },
  {
    context: 'export interface FSAdapter {',
    lines: [
      '   readFile(path: string): Promise<Uint8Array>;',
      '+  readFileString(path: string): Promise<string>;',
      '   writeFile(path: string, data: Uint8Array | string): Promise<void>;',
      '-  stat(path: string): Promise<Stats>;',
      '+  stat(path: string): Promise<FileStats>;',
      '+  lstat(path: string): Promise<FileStats>;',
      '   exists(path: string): Promise<boolean>;',
    ],
  },
  {
    context: "const status = await git.status('src/index.ts');",
    lines: [
      "-if (status === 'untracked') {",
      "+if (status === '*added') {",
      "   await git.add('src/index.ts');",
      ' }',
      '-const { branches } = await git.listBranches();',
      '+const { branches, current } = await git.listBranches();',
    ],
  },
];

/** Count old/new lines so hunk headers look plausible. */
export function hunkHeader(h: Hunk, start: number): string {
  const oldLines = h.lines.filter((l) => l[0] !== '+').length;
  const newLines = h.lines.filter((l) => l[0] !== '-').length;
  return `@@ -${start},${oldLines} +${start},${newLines} @@ ${h.context}`;
}
