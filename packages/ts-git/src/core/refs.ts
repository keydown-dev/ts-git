import { FSAdapter } from '../fs/types.js';
import { joinPaths, dirname } from '../utils/path.js';
import { NotFoundError, InvalidRefError } from '../errors.js';
import { readObject } from './objects.js';

export interface RefValue {
  name: string;
  oid: string;
}

const packedRefsCache = new Map<string, Map<string, string>>();

async function readPackedRefs(
  fs: FSAdapter,
  gitdir: string,
): Promise<Map<string, string>> {
  const cacheKey = gitdir;
  if (packedRefsCache.has(cacheKey)) {
    return packedRefsCache.get(cacheKey)!;
  }

  const packedRefsPath = joinPaths(gitdir, 'packed-refs');

  if (!(await fs.exists(packedRefsPath))) {
    const empty = new Map<string, string>();
    packedRefsCache.set(cacheKey, empty);
    return empty;
  }

  const content = await fs.readFileString(packedRefsPath);
  const refs = new Map<string, string>();

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

  packedRefsCache.set(cacheKey, refs);
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

export function isValidRefName(name: string): boolean {
  if (name === '.' || name === '..') return false;
  if (name.includes('/.')) return false;
  if (name.startsWith('/')) return false;
  if (name.endsWith('/')) return false;
  if (name.includes('..')) return false;

  const parts = name.split('/');
  for (const part of parts) {
    if (part === '.' || part === '') return false;
  }

  return true;
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

  if (!(await fs.exists(dir))) {
    await fs.mkdir(dir, { recursive: true });
  }

  if (!force && (await fs.exists(path))) {
    throw new InvalidRefError(`Ref already exists: ${ref}`, ref);
  }

  await fs.writeFile(path, value);
  invalidatePackedRefsCache(gitdir);
}

export async function deleteRef(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<void> {
  const path = refPath(ref, gitdir);

  if (!(await fs.exists(path))) {
    throw new NotFoundError(`Ref not found: ${ref}`, ref);
  }

  await fs.unlink(path);
  invalidatePackedRefsCache(gitdir);
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
    const parts = head.ref.split('/');
    return parts[parts.length - 1] ?? null;
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
  await fs.writeFile(headPath, value);
}

export async function setHeadDetached(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<void> {
  const headPath = joinPaths(gitdir, 'HEAD');
  await fs.writeFile(headPath, oid);
}

/**
 * Follow a ref (possibly symbolic, e.g. HEAD or refs/remotes/origin/HEAD) to
 * the object id it ultimately names. Returns null if it doesn't resolve.
 */
export async function resolveRefOid(
  fs: FSAdapter,
  gitdir: string,
  ref: string,
): Promise<string | null> {
  let current = ref;
  for (let depth = 0; depth < 10; depth++) {
    const value = await readRef(fs, gitdir, current);
    if (!value) return null;
    const target = parseSymbolicRef(value);
    if (!target) return /^[0-9a-f]{40}$/i.test(value) ? value : null;
    current = target;
  }
  return null;
}

/**
 * List refs whose full name starts with `prefix` (loose and packed; a loose
 * ref shadows a packed one). Symbolic refs are resolved to object ids and
 * dangling ones are skipped. Returns full ref name → oid, sorted by name.
 */
export async function listRefs(
  fs: FSAdapter,
  gitdir: string,
  prefix: string = 'refs/',
): Promise<Map<string, string>> {
  const names = new Set<string>();
  const packed = await readPackedRefs(fs, gitdir);
  for (const name of packed.keys()) {
    if (name.startsWith(prefix)) names.add(name);
  }

  const refsRoot = joinPaths(gitdir, 'refs');
  if (await fs.exists(refsRoot)) {
    const loose = new Set<string>();
    await listRefsRecursive(fs, refsRoot, 'refs/', loose);
    for (const name of loose) {
      if (name.startsWith(prefix)) names.add(name);
    }
  }

  const result = new Map<string, string>();
  for (const name of Array.from(names).sort()) {
    const oid = await resolveRefOid(fs, gitdir, name);
    if (oid) result.set(name, oid);
  }
  return result;
}
