import { FSAdapter } from '../fs/types.js';
import { joinPaths, dirname } from '../utils/path.js';
import { NotFoundError, InvalidRefError } from '../errors.js';
import { readObject } from './objects.js';

export interface RefValue {
  name: string;
  oid: string;
}

interface PackedRefsCacheEntry {
  /** mtime/size/inode of packed-refs when parsed; null if it was absent. */
  stamp: string | null;
  refs: Map<string, string>;
}

const packedRefsCache = new Map<string, PackedRefsCacheEntry>();

async function readPackedRefs(
  fs: FSAdapter,
  gitdir: string,
): Promise<Map<string, string>> {
  const cacheKey = gitdir;
  const packedRefsPath = joinPaths(gitdir, 'packed-refs');

  // Validate the cache against the file's stat data so changes made by other
  // processes (e.g. `git pack-refs`, `git branch -d`) are picked up.
  let stamp: string | null = null;
  if (await fs.exists(packedRefsPath)) {
    const st = await fs.stat(packedRefsPath);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  }

  const cached = packedRefsCache.get(cacheKey);
  if (cached && cached.stamp === stamp) {
    return cached.refs;
  }

  const refs = new Map<string, string>();

  if (stamp === null) {
    packedRefsCache.set(cacheKey, { stamp, refs });
    return refs;
  }

  const content = await fs.readFileString(packedRefsPath);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) {
      continue;
    }

    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) continue;

    const oid = trimmed.slice(0, firstSpace);
    const refName = trimmed.slice(firstSpace + 1).trim();

    if (/^[0-9a-f]{40}$/i.test(oid) && refName) {
      refs.set(refName, oid);
    }
  }

  packedRefsCache.set(cacheKey, { stamp, refs });
  return refs;
}

export function invalidatePackedRefsCache(gitdir: string): void {
  packedRefsCache.delete(gitdir);
}

export function isSymbolicRef(ref: string): boolean {
  return ref.startsWith('ref: ');
}

export function parseSymbolicRef(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('ref: ')) {
    return trimmed.slice(5);
  }
  return null;
}

export function formatSymbolicRef(ref: string): string {
  return `ref: ${ref}`;
}

export function resolveRef(ref: string): string {
  const symbolic = parseSymbolicRef(ref);
  if (symbolic) {
    return symbolic;
  }
  return ref;
}

/**
 * Validate a reference name following `git check-ref-format` rules
 * (with one-level names such as `HEAD` or `main` allowed, since callers pass
 * both short branch names and full `refs/...` names):
 *
 * 1. no slash-separated component may begin with `.` or end with `.lock`
 * 2. no `..` anywhere
 * 3. no ASCII control characters, space, `~`, `^`, `:`
 * 4. no `?`, `*`, `[`
 * 5. may not begin or end with `/` or contain `//` (no empty components)
 * 6. may not end with `.`
 * 7. may not contain `@{`
 * 8. may not be the single character `@`
 * 9. may not contain `\`
 */
export function isValidRefName(name: string): boolean {
  if (name === '' || name === '@') return false;
  if (name.includes('..') || name.includes('@{')) return false;
  if (name.endsWith('.')) return false;

  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
    if (' ~^:?*[\\'.includes(name[i])) return false;
  }

  for (const part of name.split('/')) {
    if (part === '') return false;
    if (part.startsWith('.')) return false;
    if (part.endsWith('.lock')) return false;
  }

  return true;
}

/**
 * Validate a branch name the way `git branch` / `git check-ref-format --branch`
 * does: `refs/heads/<name>` must be a valid ref, and the name may not start
 * with `-` or be exactly `HEAD`.
 */
export function isValidBranchName(name: string): boolean {
  if (name.startsWith('-') || name === 'HEAD') return false;
  return isValidRefName(`refs/heads/${name}`);
}

export function refPath(ref: string, gitdir: string): string {
  if (ref.startsWith('refs/')) {
    return joinPaths(gitdir, ref);
  }

  if (ref === 'HEAD') {
    return joinPaths(gitdir, 'HEAD');
  }

  return joinPaths(gitdir, 'refs', 'heads', ref);
}

export async function readRef(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<string | null> {
  const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const path = refPath(ref, gitdir);

  if (await fs.exists(path)) {
    const content = await fs.readFileString(path);
    return content.trim();
  }

  const packedRefs = await readPackedRefs(fs, gitdir);
  const packedOid = packedRefs.get(refName);
  if (packedOid) {
    return packedOid;
  }

  return null;
}

export async function writeRef(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
  value: string,
  force: boolean = false,
): Promise<void> {
  if (!isValidRefName(ref)) {
    throw new InvalidRefError(`Invalid ref name: ${ref}`, ref);
  }

  const path = refPath(ref, gitdir);
  const dir = dirname(path);

  if (!force && (await readRef(fs, gitdir, ref)) !== null) {
    throw new InvalidRefError(`Ref already exists: ${ref}`, ref);
  }

  await assertNoRefDirectoryConflict(fs, gitdir, ref);

  if (!(await fs.exists(dir))) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Loose refs are stored newline-terminated, like canonical git writes them.
  await fs.writeFile(path, value.endsWith('\n') ? value : `${value}\n`);
  invalidatePackedRefsCache(gitdir);
}

function fullRefName(ref: string): string {
  if (ref === 'HEAD' || ref.startsWith('refs/')) return ref;
  return `refs/heads/${ref}`;
}

/**
 * Git refuses to create `refs/heads/a/b` while `refs/heads/a` exists (and
 * vice versa), since loose refs are files in a directory hierarchy.
 */
async function assertNoRefDirectoryConflict(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<void> {
  const name = fullRefName(ref);
  if (name === 'HEAD') return;

  const packed = await readPackedRefs(fs, gitdir);
  const parts = name.split('/');
  for (let i = 2; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const prefixPath = joinPaths(gitdir, prefix);
    const isLooseFile =
      (await fs.exists(prefixPath)) && !(await fs.stat(prefixPath)).isDirectory;
    if (isLooseFile || packed.has(prefix)) {
      throw new InvalidRefError(
        `cannot lock ref '${name}': '${prefix}' exists; cannot create '${name}'`,
        name,
      );
    }
  }

  const path = joinPaths(gitdir, name);
  const hasLooseChildren =
    (await fs.exists(path)) && (await fs.stat(path)).isDirectory;
  const hasPackedChildren = [...packed.keys()].some((r) =>
    r.startsWith(`${name}/`),
  );
  if (hasLooseChildren || hasPackedChildren) {
    throw new InvalidRefError(
      `cannot lock ref '${name}': there are refs under '${name}/'`,
      name,
    );
  }
}

export async function deleteRef(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<void> {
  const path = refPath(ref, gitdir);
  const name = fullRefName(ref);

  const loose = (await fs.exists(path)) && !(await fs.stat(path)).isDirectory;
  const packed = (await readPackedRefs(fs, gitdir)).has(name);

  if (!loose && !packed) {
    throw new NotFoundError(`Ref not found: ${ref}`, ref);
  }

  // Like git, drop the ref from packed-refs too; otherwise the packed value
  // would resurface once the loose file is gone.
  if (packed) {
    await removePackedRef(fs, gitdir, name);
  }

  if (loose) {
    await fs.unlink(path);
    await pruneEmptyRefDirs(fs, gitdir, name);
  }

  invalidatePackedRefsCache(gitdir);
}

/** Rewrite packed-refs without `name` (and its `^` peeled line). */
async function removePackedRef(
  fs: FSAdapter,
  gitdir: string,
  name: string,
): Promise<void> {
  const packedRefsPath = joinPaths(gitdir, 'packed-refs');
  const content = await fs.readFileString(packedRefsPath);
  const out: string[] = [];
  let skippingPeel = false;

  for (const line of content.split('\n')) {
    if (line.startsWith('^')) {
      if (!skippingPeel) out.push(line);
      continue;
    }
    skippingPeel = false;
    const space = line.indexOf(' ');
    if (
      space !== -1 &&
      !line.startsWith('#') &&
      line.slice(space + 1).trim() === name
    ) {
      skippingPeel = true;
      continue;
    }
    out.push(line);
  }

  await fs.writeFile(packedRefsPath, out.join('\n'));
  invalidatePackedRefsCache(gitdir);
}

/** Remove now-empty directories left behind by a deleted `refs/x/y/z` ref. */
async function pruneEmptyRefDirs(
  fs: FSAdapter,
  gitdir: string,
  name: string,
): Promise<void> {
  const parts = name.split('/');
  // Never remove refs/ or refs/<category>/ themselves.
  for (let i = parts.length - 1; i > 2; i--) {
    const dirPath = joinPaths(gitdir, ...parts.slice(0, i));
    try {
      if ((await fs.readdir(dirPath)).length > 0) return;
      await fs.rmdir(dirPath);
    } catch {
      return;
    }
  }
}

function treeOidFromCommitContent(content: Uint8Array): string | null {
  const str = new TextDecoder().decode(content);
  for (const line of str.split('\n')) {
    if (line.startsWith('tree ')) {
      return line.slice(5).trim();
    }
  }
  return null;
}

/**
 * Peel symbolic HEAD to the current commit OID, or the detached OID.
 * Returns null for missing HEAD, corrupt state, or unborn branch (symbolic ref with no target).
 */
export async function resolveHeadCommitOid(
  fs: FSAdapter,
  gitdir: string,
): Promise<string | null> {
  const head = await resolveHead(fs, gitdir);
  if (!head) {
    return null;
  }
  if (head.type === 'commit') {
    return head.oid;
  }
  const oid = await readRef(fs, gitdir, head.ref);
  if (!oid || oid.startsWith('ref:')) {
    return null;
  }
  return oid;
}

/** Tree OID for the commit peeled from HEAD; null if unborn or missing. */
export async function resolveHeadTreeOid(
  fs: FSAdapter,
  gitdir: string,
): Promise<string | null> {
  const commitOid = await resolveHeadCommitOid(fs, gitdir);
  if (!commitOid) {
    return null;
  }
  try {
    const { type, content } = await readObject(fs, gitdir, commitOid);
    if (type !== 'commit') {
      return null;
    }
    return treeOidFromCommitContent(content);
  } catch {
    return null;
  }
}

export async function resolveHead(
  fs: FSAdapter,
  gitdir: string,
): Promise<
  { type: 'commit'; oid: string } | { type: 'symbolic'; ref: string } | null
> {
  const headPath = joinPaths(gitdir, 'HEAD');

  if (!(await fs.exists(headPath))) {
    return null;
  }

  const content = await fs.readFileString(headPath);
  const trimmed = content.trim();

  const symbolic = parseSymbolicRef(trimmed);
  if (symbolic) {
    if (symbolic.startsWith('refs/')) {
      const oid = await readRef(fs, gitdir, symbolic);
      if (oid) {
        return { type: 'symbolic', ref: symbolic };
      }
    }
    return { type: 'symbolic', ref: symbolic };
  }

  if (/^[0-9a-f]{40}$/i.test(trimmed)) {
    return { type: 'commit', oid: trimmed };
  }

  return null;
}

export async function getCurrentBranch(
  fs: FSAdapter,
  gitdir: string,
): Promise<string | null> {
  const head = await resolveHead(fs, gitdir);

  if (!head) return null;

  if (head.type === 'symbolic') {
    // Full short name: refs/heads/feature/foo -> feature/foo
    return head.ref.startsWith('refs/heads/')
      ? head.ref.slice('refs/heads/'.length)
      : head.ref;
  }

  return null;
}

export async function listBranches(
  fs: FSAdapter,
  gitdir: string,
): Promise<string[]> {
  const branches = new Set<string>();

  const headsPath = joinPaths(gitdir, 'refs', 'heads');

  if (await fs.exists(headsPath)) {
    await listRefsRecursive(fs, headsPath, '', branches);
  }

  const packedRefs = await readPackedRefs(fs, gitdir);
  for (const ref of packedRefs.keys()) {
    if (ref.startsWith('refs/heads/')) {
      branches.add(ref.slice('refs/heads/'.length));
    }
  }

  return Array.from(branches).sort();
}

async function listRefsRecursive(
  fs: FSAdapter,
  basePath: string,
  prefix: string,
  refs: Set<string>,
): Promise<void> {
  const entries = await fs.readdir(basePath);

  for (const entry of entries) {
    const fullPath = joinPaths(basePath, entry.name);

    if (entry.isDirectory) {
      await listRefsRecursive(fs, fullPath, `${prefix}${entry.name}/`, refs);
    } else {
      refs.add(`${prefix}${entry.name}`);
    }
  }
}

export async function listTags(
  fs: FSAdapter,
  gitdir: string,
): Promise<string[]> {
  const tags = new Set<string>();

  const tagsPath = joinPaths(gitdir, 'refs', 'tags');

  if (await fs.exists(tagsPath)) {
    await listRefsRecursive(fs, tagsPath, '', tags);
  }

  const packedRefs = await readPackedRefs(fs, gitdir);
  for (const ref of packedRefs.keys()) {
    if (ref.startsWith('refs/tags/')) {
      tags.add(ref.slice('refs/tags/'.length));
    }
  }

  return Array.from(tags).sort();
}

export async function isHeadDetached(
  fs: FSAdapter,
  gitdir: string,
): Promise<boolean> {
  const head = await resolveHead(fs, gitdir);

  if (!head) return false;

  return head.type === 'commit';
}

export async function setHead(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<void> {
  const headPath = joinPaths(gitdir, 'HEAD');
  const value = formatSymbolicRef(ref);
  await fs.writeFile(headPath, `${value}\n`);
}

export async function setHeadDetached(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<void> {
  const headPath = joinPaths(gitdir, 'HEAD');
  await fs.writeFile(headPath, `${oid}\n`);
}
