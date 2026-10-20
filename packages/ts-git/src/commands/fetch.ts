import { FSAdapter } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';
import { readConfig } from '../core/config.js';
import { hasObject, readObject } from '../core/objects.js';
import {
  listRefs,
  readRef,
  resolveRefOid,
  writeRef,
  deleteRef,
  getCurrentBranch,
  parseSymbolicRef,
} from '../core/refs.js';
import { storePackfile } from '../core/pack-builder.js';
import { isAncestor, recentCommits } from '../core/commit-graph.js';
import {
  createTransport,
  type GitTransport,
  type TransportOptions,
} from '../remote/transport.js';
import type { RefAdvertisement, RemoteRef } from '../remote/protocol.js';
import { anonymizeUrl, shortDisplayUrl } from '../remote/http.js';
import type {
  AuthCallback,
  AuthFailureCallback,
  GitAuth,
  HttpClient,
} from '../remote/http.js';
import {
  type Refspec,
  defaultFetchRefspec,
  expandRefName,
  mapRefspecDestination,
  mapRefspecSource,
  parseRefspec,
  refspecMatchesSource,
} from '../remote/refspec.js';
import { RemoteNotFoundError } from '../errors.js';
import { readRemoteFromConfig, readUpstream, requireGitdir } from './remote.js';

export interface ProgressEvent {
  phase: string;
  message: string;
}

/** Options shared by every command that talks to a remote. */
export interface RemoteOptions {
  /** HTTP client; defaults to one built on global fetch. */
  http?: HttpClient;
  /** CORS proxy prefix for browser use (isomorphic-git convention). */
  corsProxy?: string;
  /** Extra HTTP headers sent with every request. */
  headers?: Record<string, string>;
  /** Credentials (HTTP basic auth or custom headers). */
  auth?: GitAuth;
  /** Asked for credentials when the server answers 401. */
  onAuth?: AuthCallback;
  /** Told when credentials were rejected. */
  onAuthFailure?: AuthFailureCallback;
  /** Server progress messages (side-band channel 2) and local phases. */
  onProgress?: (event: ProgressEvent) => void;
  /** Use this transport instead of choosing one from the URL. */
  transport?: GitTransport;
}

export interface FetchArgs extends RemoteOptions {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /**
   * Remote name. Defaults to the current branch's upstream remote, else
   * "origin". A URL or path is accepted too (fetches into FETCH_HEAD only).
   */
  remote?: string;
  /** Refspecs overriding remote.<name>.fetch, e.g. ['main'] or ['+refs/heads/*:refs/remotes/origin/*']. */
  refspecs?: string[];
  /**
   * Tag handling: 'auto' (default) follows tags that point at fetched
   * history, true fetches all tags, false fetches none.
   */
  tags?: 'auto' | boolean;
  /** Remove remote-tracking refs whose source no longer exists. */
  prune?: boolean;
}

export type RefUpdateStatus =
  | 'new'
  | 'fast-forward'
  | 'forced'
  | 'up-to-date'
  | 'rejected'
  | 'pruned';

export interface RefUpdate {
  /** Ref name on the remote (null when pruned). */
  remoteRef: string | null;
  /** Local ref that was (or would have been) updated. */
  localRef: string;
  oldOid: string | null;
  newOid: string | null;
  status: RefUpdateStatus;
  reason?: string;
}

export interface FetchHeadEntry {
  oid: string;
  remoteRef: string;
  notForMerge: boolean;
}

export interface FetchResult {
  remote: string | null;
  url: string;
  /** Branch the remote's HEAD points at (e.g. "refs/heads/main"), if advertised. */
  remoteHead: string | null;
  updates: RefUpdate[];
  fetchHead: FetchHeadEntry[];
  /** Number of objects received (0 when already up to date). */
  objectCount: number;
}

interface Mapping {
  src: string;
  oid: string;
  dst: string | null;
  force: boolean;
  /** Came from a refspec given explicitly by the caller. */
  explicit: boolean;
}

function looksLikeUrl(remote: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ||
    remote.startsWith('/') ||
    remote.startsWith('.')
  );
}

export function transportOptions(
  fs: FSAdapter,
  opts: RemoteOptions,
): TransportOptions {
  return {
    fs,
    http: opts.http,
    corsProxy: opts.corsProxy,
    headers: opts.headers,
    auth: opts.auth,
    onAuth: opts.onAuth,
    onAuthFailure: opts.onAuthFailure,
  };
}

/** Resolve the source side of an explicit refspec against advertised refs. */
function resolveExplicitSource(spec: Refspec, adv: RefAdvertisement): Refspec {
  if (spec.glob || spec.src.startsWith('refs/') || spec.src === 'HEAD')
    return spec;
  const names = new Set(adv.refs.map((r) => r.name));
  return { ...spec, src: expandRefName(spec.src, (n) => names.has(n)) };
}

function computeMappings(
  adv: RefAdvertisement,
  refspecs: Refspec[],
  explicit: boolean,
): Mapping[] {
  const negatives = refspecs.filter((r) => r.negative);
  const out: Mapping[] = [];
  for (const spec of refspecs) {
    if (spec.negative) continue;
    for (const ref of adv.refs) {
      if (ref.name === 'HEAD' && spec.src !== 'HEAD') continue;
      if (!refspecMatchesSource(spec, ref.name)) continue;
      if (negatives.some((n) => refspecMatchesSource(n, ref.name))) continue;
      out.push({
        src: ref.name,
        oid: ref.oid,
        dst: mapRefspecSource(spec, ref.name),
        force: spec.force,
        explicit,
      });
    }
  }
  return out;
}

function describeRef(ref: string): string {
  if (ref.startsWith('refs/heads/')) return `branch '${ref.slice(11)}' of `;
  if (ref.startsWith('refs/tags/')) return `tag '${ref.slice(10)}' of `;
  if (ref === 'HEAD') return '';
  return `'${ref}' of `;
}

async function objectExists(
  fs: FSAdapter,
  gitdir: string,
  oid: string,
): Promise<boolean> {
  try {
    return await hasObject(fs, gitdir, oid);
  } catch {
    return false;
  }
}

/**
 * Download objects and refs from another repository
 * (`git fetch [<remote>] [<refspec>...]`).
 */
export async function fetch(args: FetchArgs): Promise<FetchResult> {
  const { fs } = args;
  const gitdir = await requireGitdir(args);
  const config = await readConfig(fs, gitdir);
  const progress = (phase: string, message: string) =>
    args.onProgress?.({ phase, message });

  // 1. Which remote?
  let remoteName: string | null = args.remote ?? null;
  if (!remoteName) {
    const branch = await getCurrentBranch(fs, gitdir);
    remoteName = (branch && readUpstream(config, branch)?.remote) || 'origin';
  }
  let url: string;
  let configured: Refspec[] = [];
  const remoteInfo = readRemoteFromConfig(config, remoteName);
  if (remoteInfo) {
    url = remoteInfo.url;
    configured = (
      remoteInfo.fetch.length
        ? remoteInfo.fetch
        : [defaultFetchRefspec(remoteName)]
    ).map(parseRefspec);
  } else if (looksLikeUrl(remoteName) || args.transport) {
    url = args.transport?.url ?? remoteName;
    remoteName = null;
  } else {
    throw new RemoteNotFoundError(
      remoteName,
      `'${remoteName}' does not appear to be a git repository`,
    );
  }

  const transport =
    args.transport ?? createTransport(url, transportOptions(fs, args));
  const adv = await transport.listRefs('git-upload-pack');

  // 2. Map advertised refs through refspecs.
  let mappings: Mapping[];
  if (args.refspecs && args.refspecs.length > 0) {
    const explicit = args.refspecs.map((s) =>
      resolveExplicitSource(parseRefspec(s), adv),
    );
    mappings = computeMappings(adv, explicit, true);
    for (const spec of explicit) {
      if (
        !spec.glob &&
        !spec.negative &&
        !adv.refs.some((r) => r.name === spec.src)
      ) {
        throw new Error(`couldn't find remote ref ${spec.src}`);
      }
    }
    // Opportunistically update remote-tracking refs for fetched sources.
    for (const m of [...mappings]) {
      for (const spec of configured) {
        const dst = mapRefspecSource(spec, m.src);
        if (dst && !mappings.some((x) => x.dst === dst)) {
          mappings.push({ ...m, dst, force: spec.force, explicit: false });
        }
      }
    }
  } else if (remoteName) {
    mappings = computeMappings(adv, configured, false);
  } else {
    mappings = computeMappings(adv, [parseRefspec('HEAD')], true);
  }
  const tagMode = args.tags ?? 'auto';
  if (tagMode === true) {
    for (const m of computeMappings(
      adv,
      [parseRefspec('refs/tags/*:refs/tags/*')],
      false,
    )) {
      if (!mappings.some((x) => x.dst === m.dst)) mappings.push(m);
    }
  }

  // 3. Negotiate and download.
  const wants: string[] = [];
  for (const m of mappings) {
    if (!wants.includes(m.oid) && !(await objectExists(fs, gitdir, m.oid))) {
      wants.push(m.oid);
    }
  }

  const localRefs = await listRefs(fs, gitdir);
  const headOid = await resolveRefOid(fs, gitdir, 'HEAD');
  const tips = [
    ...new Set([...(headOid ? [headOid] : []), ...localRefs.values()]),
  ];

  let objectCount = 0;
  const download = async (
    want: string[],
    includeTags: boolean,
  ): Promise<void> => {
    if (want.length === 0) return;
    const common: string[] = [];
    for (const ref of adv.refs) {
      if (
        !common.includes(ref.oid) &&
        (await objectExists(fs, gitdir, ref.oid))
      ) {
        common.push(ref.oid);
      }
    }
    const haves = [
      ...new Set([...common, ...(await recentCommits(fs, gitdir, tips, 256))]),
    ];
    progress('negotiate', `want ${want.length}, have ${haves.length}`);
    const res = await transport.fetchPack(adv, {
      wants: want,
      haves,
      includeTags,
      onProgress: args.onProgress ? (m) => progress('remote', m) : undefined,
    });
    if (res.packfile) {
      progress('index', 'Indexing received objects');
      const indexed = await storePackfile(
        fs,
        gitdir,
        res.packfile,
        async (oid) => {
          try {
            return await readObject(fs, gitdir, oid);
          } catch {
            return null;
          }
        },
      );
      objectCount += indexed.objects.length;
    }
  };
  await download(wants, tagMode === 'auto');

  // 4. Follow tags pointing into history we now have.
  if (tagMode === 'auto') {
    const followed: RemoteRef[] = [];
    for (const ref of adv.refs) {
      if (!ref.name.startsWith('refs/tags/') || ref.name.endsWith('^{}'))
        continue;
      if (mappings.some((m) => m.dst === ref.name)) continue;
      if (localRefs.has(ref.name)) continue;
      const target = ref.peeled ?? ref.oid;
      if (await objectExists(fs, gitdir, target)) followed.push(ref);
    }
    const missing = [];
    for (const ref of followed) {
      if (!(await objectExists(fs, gitdir, ref.oid))) missing.push(ref.oid);
    }
    await download(missing, false);
    for (const ref of followed) {
      mappings.push({
        src: ref.name,
        oid: ref.oid,
        dst: ref.name,
        force: false,
        explicit: false,
      });
    }
  }

  // 5. Update local refs.
  const updates: RefUpdate[] = [];
  const updatedDst = new Set<string>();
  for (const m of mappings) {
    if (!m.dst || updatedDst.has(m.dst)) continue;
    updatedDst.add(m.dst);
    const oldOid = await resolveRefOid(fs, gitdir, m.dst);
    const update: RefUpdate = {
      remoteRef: m.src,
      localRef: m.dst,
      oldOid,
      newOid: m.oid,
      status: 'new',
    };
    if (oldOid === m.oid) {
      update.status = 'up-to-date';
    } else if (oldOid) {
      if (m.dst.startsWith('refs/tags/')) {
        update.status = m.force ? 'forced' : 'rejected';
        if (!m.force) update.reason = 'would clobber existing tag';
      } else {
        let ff = false;
        try {
          ff = await isAncestor(fs, gitdir, oldOid, m.oid);
        } catch {
          ff = false;
        }
        update.status = ff ? 'fast-forward' : m.force ? 'forced' : 'rejected';
        if (update.status === 'rejected') update.reason = 'non-fast-forward';
      }
    }
    if (update.status !== 'up-to-date' && update.status !== 'rejected') {
      await writeRef(fs, gitdir, m.dst, m.oid, true);
    }
    updates.push(update);
  }

  // 6. Prune stale remote-tracking refs. As in git (get_stale_heads), a
  // ref is stale only if no configured refspec maps it back to a ref the
  // remote still advertises.
  if (args.prune && remoteName) {
    const advertised = new Set(adv.refs.map((r) => r.name));
    const specs = configured.filter((spec) => spec.dst && !spec.negative);
    const candidates = new Map<string, string>();
    for (const spec of specs) {
      const prefix = spec.glob
        ? spec.dst!.slice(0, spec.dst!.indexOf('*'))
        : spec.dst!;
      for (const [local, oid] of await listRefs(fs, gitdir, prefix)) {
        candidates.set(local, oid);
      }
    }
    for (const [local, oid] of candidates) {
      const sources = specs
        .map((spec) => mapRefspecDestination(spec, local))
        .filter((src): src is string => src !== null);
      if (sources.length === 0 || sources.some((src) => advertised.has(src))) {
        continue;
      }
      const raw = await readRef(fs, gitdir, local);
      if (raw && parseSymbolicRef(raw)) continue; // e.g. origin/HEAD
      await deleteRef(fs, gitdir, local);
      updates.push({
        remoteRef: null,
        localRef: local,
        oldOid: oid,
        newOid: null,
        status: 'pruned',
      });
    }
  }

  // 7. FETCH_HEAD.
  const branch = await getCurrentBranch(fs, gitdir);
  const upstream = branch ? readUpstream(config, branch) : null;
  const fetchHead: FetchHeadEntry[] = [];
  const anyExplicit = mappings.some((m) => m.explicit);
  for (const m of mappings) {
    if (fetchHead.some((e) => e.remoteRef === m.src)) continue;
    const forMerge = anyExplicit
      ? m.explicit
      : !!upstream &&
        upstream.remote === remoteName &&
        upstream.merge === m.src;
    fetchHead.push({ oid: m.oid, remoteRef: m.src, notForMerge: !forMerge });
  }
  fetchHead.sort((a, b) => Number(a.notForMerge) - Number(b.notForMerge));
  const lines = fetchHead.map(
    (e) =>
      `${e.oid}\t${e.notForMerge ? 'not-for-merge' : ''}\t${describeRef(e.remoteRef)}${shortDisplayUrl(url)}\n`,
  );
  await fs.writeFile(joinPaths(gitdir, 'FETCH_HEAD'), lines.join(''));

  return {
    remote: remoteName,
    url: anonymizeUrl(url),
    remoteHead: adv.symrefs.get('HEAD') ?? null,
    updates,
    fetchHead,
    objectCount,
  };
}
