import { FSAdapter } from '../fs/types.js';
import { parseGitDir, joinPaths, normalizeRepoRelativePath } from '../utils/path.js';
import {
  readIndex,
  type IndexEntry,
  groupIndexEntriesByPath,
  pickRepresentativeIndexEntry,
} from '../core/index.js';
import { resolveHeadTreeOid } from '../core/refs.js';
import { readObject, computeOid } from '../core/objects.js';
import { walkDir } from '../utils/walk.js';
import { NotAGitRepoError } from '../errors.js';
import type {
  StatusMatrixArgs,
  StatusRow,
  StatusName,
  HeadStatus,
  WorkdirStatus,
  StageStatus,
} from '../types.js';

export async function statusMatrix(
  args: StatusMatrixArgs,
): Promise<StatusRow[]> {
  const { fs, dir, gitdir: providedGitdir, filepaths, filter } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);

  // Check if this is a git repository
  if (!(await fs.exists(gitdir))) {
    throw new NotAGitRepoError(
      `not a git repository (or any of the parent directories): ${gitdir}`,
      dir,
    );
  }

  const matrix: StatusRow[] = [];

  const headTree = await resolveHeadTreeOid(fs, gitdir);

  const index = await readIndex(fs, gitdir);
  const indexByPath = groupIndexEntriesByPath(index.entries);

  let files: string[];
  if (filepaths) {
    files = filepaths;
  } else {
    // Walk the directory to find all files, excluding the git directory
    files = await walkDir(fs, dir, { gitdir });

    // Also include files from the index that aren't in the working directory
    // This is necessary to detect deleted files
    for (const entryPath of indexByPath.keys()) {
      if (!files.includes(entryPath)) {
        files.push(entryPath);
      }
    }

    // Also include files from HEAD tree that might not be in index or workdir
    // This is necessary to detect staged deletions
    if (headTree) {
      const headFiles = await collectFilesFromTree(fs, gitdir, headTree, '');
      for (const headFile of headFiles) {
        if (!files.includes(headFile)) {
          files.push(headFile);
        }
      }
    }
  }

  for (const file of files) {
    const workdirStatus = await getWorkdirStatus(
      fs,
      dir,
      gitdir,
      file,
      headTree,
    );
    const headStatus = await getHeadStatus(fs, gitdir, headTree, file);
    const stageStatus = await getStageStatus(
      fs,
      gitdir,
      indexByPath,
      file,
      headStatus,
      dir,
      headTree,
    );

    if (filter && !filter(file)) {
      continue;
    }

    matrix.push([file, headStatus, workdirStatus, stageStatus]);
  }

  return matrix;
}

async function getWorkdirStatus(
  fs: FSAdapter,
  dir: string,
  gitdir: string,
  filepath: string,
  headTree: string | null,
): Promise<WorkdirStatus> {
  if (filepath === '.') {
    if (!(await fs.exists(dir))) {
      return 0;
    }
    const entries = await fs.readdir(dir);
    return entries.length > 0 ? 1 : 2;
  }

  const fullPath = joinPaths(dir, filepath);

  if (!(await fs.exists(fullPath))) {
    return 0;
  }

  const stats = await fs.stat(fullPath);

  if (stats.isDirectory) {
    return 2;
  }

  if (!headTree) {
    return 2;
  }

  const headOid = await getHeadFileOid(fs, gitdir, headTree, filepath);
  if (!headOid) {
    return 2;
  }

  const workdirContent = await fs.readFile(fullPath);
  const workdirOid = await computeOid('blob', workdirContent);

  return workdirOid === headOid ? 1 : 2;
}

async function getHeadFileOid(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string,
  filepath: string,
): Promise<string | null> {
  try {
    const pathParts = filepath.split('/');
    let currentOid = treeOid;

    for (let i = 0; i < pathParts.length; i++) {
      const { content } = await readObject(fs, gitdir, currentOid);
      const entries = parseTree(content);
      const part = pathParts[i];
      const entry = entries.find((e) => e.path === part);

      if (!entry) {
        return null;
      }

      if (i === pathParts.length - 1) {
        // Last part - should be a blob
        return entry.oid;
      } else {
        // Not the last part - should be a tree
        currentOid = entry.oid;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function getHeadStatus(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string | null,
  filepath: string,
): Promise<HeadStatus> {
  if (filepath === '.') {
    return treeOid ? 1 : 0;
  }

  if (!treeOid) {
    return 0;
  }

  try {
    const pathParts = filepath.split('/');
    let currentOid = treeOid;

    for (let i = 0; i < pathParts.length; i++) {
      const { content } = await readObject(fs, gitdir, currentOid);
      const entries = parseTree(content);
      const part = pathParts[i];
      const entry = entries.find((e) => e.path === part);

      if (!entry) {
        return 0;
      }

      if (i === pathParts.length - 1) {
        // Last part - found the file
        return 1;
      } else {
        // Not the last part - should be a tree, continue traversal
        currentOid = entry.oid;
      }
    }

    return 0;
  } catch {
    return 0;
  }
}

function parseTree(
  content: Uint8Array,
): { mode: string; path: string; oid: string }[] {
  const entries: { mode: string; path: string; oid: string }[] = [];
  let offset = 0;

  while (offset < content.length) {
    const spaceIndex = content.indexOf(0x20, offset);
    if (spaceIndex === -1) break;

    const mode = new TextDecoder().decode(content.slice(offset, spaceIndex));
    const nullIndex = content.indexOf(0, spaceIndex);
    if (nullIndex === -1) break;

    const path = new TextDecoder().decode(
      content.slice(spaceIndex + 1, nullIndex),
    );
    const oid = Array.from(content.slice(nullIndex + 1, nullIndex + 21))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    entries.push({ mode, path, oid });
    offset = nullIndex + 21;
  }

  return entries;
}

async function collectFilesFromTree(
  fs: FSAdapter,
  gitdir: string,
  treeOid: string,
  prefix: string,
): Promise<string[]> {
  const files: string[] = [];

  try {
    const { content } = await readObject(fs, gitdir, treeOid);
    const entries = parseTree(content);

    for (const entry of entries) {
      const fullPath = normalizeRepoRelativePath(
        prefix ? `${prefix}/${entry.path}` : entry.path,
      );

      if (entry.mode === '040000' || entry.mode === '40000') {
        // It's a directory (tree), recurse into it
        const subFiles = await collectFilesFromTree(
          fs,
          gitdir,
          entry.oid,
          fullPath,
        );
        files.push(...subFiles);
      } else {
        // It's a file (blob)
        files.push(fullPath);
      }
    }
  } catch {
    // If we can't read the tree, return empty array
  }

  return files;
}

async function getStageStatus(
  fs: FSAdapter,
  gitdir: string,
  indexByPath: Map<string, IndexEntry[]>,
  filepath: string,
  headStatus: HeadStatus,
  dir: string,
  headTree: string | null,
): Promise<StageStatus> {
  const list = indexByPath.get(normalizeRepoRelativePath(filepath));
  const indexEntry = list ? pickRepresentativeIndexEntry(list) : undefined;

  if (!indexEntry) {
    return 0;
  }

  const fullPath = joinPaths(dir, filepath);
  const workdirExists = await fs.exists(fullPath);

  if (!workdirExists) {
    if (headStatus === 1) {
      return 1;
    }
    // File is in index but deleted from workdir (and not in HEAD)
    // Return 1 to indicate it's staged
    return 1;
  }

  const headOid = headTree
    ? await getHeadFileOid(fs, gitdir, headTree, filepath)
    : null;

  if (headOid === indexEntry.oid) {
    return 1;
  }

  const workdirContent = await fs.readFile(fullPath);
  const workdirOid = await computeOid('blob', workdirContent);

  if (workdirOid === indexEntry.oid) {
    return 2;
  }

  return 3;
}

export async function status(args: {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  filepath: string;
}): Promise<StatusName> {
  const { fs, dir, gitdir: providedGitdir, filepath } = args;
  const { gitdir } = parseGitDir(dir, providedGitdir);

  const matrix = await statusMatrix({
    fs,
    dir,
    gitdir,
    filepaths: [filepath],
  });

  const row = matrix[0];
  if (!row) {
    return 'absent';
  }

  const [, head, workdir, stage] = row;

  return translateStatus(head, workdir, stage);
}

function translateStatus(
  head: HeadStatus,
  workdir: WorkdirStatus,
  stage: StageStatus,
): StatusName {
  if (head === 0 && workdir === 2 && stage === 0) return '*added';
  if (head === 0 && workdir === 2 && stage === 2) return 'added';
  if (head === 0 && workdir === 2 && stage === 3) return '*added';

  if (head === 1 && workdir === 0 && stage === 0) return 'deleted';
  if (head === 1 && workdir === 0 && stage === 1) return '*deleted';
  if (head === 1 && workdir === 0 && stage === 3) return '*deleted';

  if (head === 1 && workdir === 2 && stage === 1) return '*modified';
  if (head === 1 && workdir === 2 && stage === 2) return 'modified';
  if (head === 1 && workdir === 2 && stage === 3) return '*modified';

  if (head === 1 && workdir === 1 && stage === 1) return 'unmodified';
  if (head === 1 && workdir === 1 && stage === 2) return '*unmodified';

  if (head === 0 && workdir === 0 && stage === 0) return 'absent';
  if (head === 0 && workdir === 0 && stage === 1) return '*absent';
  if (head === 0 && workdir === 0 && stage === 2) return '*absent';

  if (head === 0 && workdir === 1 && stage === 0) return 'absent';

  return 'absent';
}

/**
 * Classify a status row into categories for Git-style output
 */
export function classifyStatusRow(row: StatusRow): {
  isStaged: boolean;
  isUnstaged: boolean;
  isUntracked: boolean;
  isClean: boolean;
  stagedStatus: string;
  unstagedStatus: string;
} {
  const [, head, workdir, stage] = row;

  // Clean file: head=1, workdir=1, stage=1
  const isClean = head === 1 && workdir === 1 && stage === 1;

  // Untracked: head=0, workdir=2, stage=0
  const isUntracked = head === 0 && workdir === 2 && stage === 0;

  // Staged changes (index differs from HEAD)
  // stage=2 means staged content differs from HEAD
  // stage=3 means staged content differs from HEAD AND workdir differs from staged
  const isStaged = stage === 2 || stage === 3;

  // Unstaged changes (workdir differs from index)
  // stage=1 and workdir=2 means workdir changed since staging
  // stage=1 and workdir=0 means file deleted from workdir
  // stage=3 means workdir differs from staged content
  const isUnstaged =
    (stage === 1 && (workdir === 2 || workdir === 0)) || stage === 3;

  // Determine staged status code
  let stagedStatus = ' ';
  if (isStaged) {
    if (head === 0)
      stagedStatus = 'A'; // Added
    else if (workdir === 0)
      stagedStatus = 'D'; // Deleted
    else stagedStatus = 'M'; // Modified
  }

  // Determine unstaged status code
  let unstagedStatus = ' ';
  if (isUnstaged) {
    if (head === 1 && workdir === 0)
      unstagedStatus = 'D'; // Deleted
    else unstagedStatus = 'M'; // Modified
  } else if (isUntracked) {
    unstagedStatus = '?';
  }

  return {
    isStaged,
    isUnstaged,
    isUntracked,
    isClean,
    stagedStatus,
    unstagedStatus,
  };
}
