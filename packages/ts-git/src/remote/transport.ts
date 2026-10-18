import { FSAdapter } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';
import { HttpError } from '../errors.js';
import { readObject } from '../core/objects.js';
import { createPackfile, storePackfile } from '../core/pack-builder.js';
import { enumerateObjects, peelToNonTag } from '../core/commit-graph.js';
import {
  listRefs,
  readRef,
  parseSymbolicRef,
  resolveRefOid,
  writeRef,
  deleteRef,
} from '../core/refs.js';
import { readConfig, getConfigValue } from '../core/config.js';
import {
  AGENT,
  ZERO_OID,
  type GitService,
  type RefAdvertisement,
  type RemoteRef,
  type PushCommand,
  type PushReport,
  buildReceivePackRequest,
  buildUploadPackRequest,
  negotiateCapabilities,
  parseReceivePackResponse,
  parseRefAdvertisement,
  parseUploadPackResponse,
} from './protocol.js';
import {
  type AuthCallback,
  type AuthFailureCallback,
  type GitAuth,
  type HttpClient,
  authHeaders,
  corsProxify,
  createFetchHttpClient,
  extractUrlAuth,
} from './http.js';

export interface FetchPackRequest {
  wants: string[];
  haves: string[];
  /** Ask the server to include annotated tags pointing into the pack. */
  includeTags?: boolean;
  onProgress?: (message: string) => void;
}

export interface FetchPackResult {
  /** Raw packfile, or null if the server sent no objects. */
  packfile: Uint8Array | null;
  /** Commits the server reported as new shallow boundaries. */
  shallows: string[];
  unshallows: string[];
}

export interface PushPackRequest {
  commands: PushCommand[];
  packfile: Uint8Array | null;
  atomic?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * A way of talking to a remote repository. Implementations exist for smart
 * HTTP(S) and for repositories reachable through an FSAdapter; supply your
 * own to plug in other channels (e.g. a WebSocket bridge).
 */
export interface GitTransport {
  readonly url: string;
  /** Ref advertisement for fetching (upload-pack) or pushing (receive-pack). */
  listRefs(service: GitService): Promise<RefAdvertisement>;
  fetchPack(
    adv: RefAdvertisement,
    req: FetchPackRequest,
  ): Promise<FetchPackResult>;
  pushPack(adv: RefAdvertisement, req: PushPackRequest): Promise<PushReport>;
}

export interface HttpTransportOptions {
  url: string;
  http?: HttpClient;
  /** CORS proxy prefix for browsers, e.g. https://cors.isomorphic-git.org */
  corsProxy?: string;
  headers?: Record<string, string>;
  auth?: GitAuth;
  onAuth?: AuthCallback;
  onAuthFailure?: AuthFailureCallback;
}

/** Smart HTTP transport (gitprotocol-http(5)), protocol v0/v1. */
export class HttpTransport implements GitTransport {
  readonly url: string;
  private http: HttpClient;
  private auth?: GitAuth;

  constructor(private options: HttpTransportOptions) {
    const { url, auth } = extractUrlAuth(options.url);
    this.url = url.replace(/\/+$/, '');
    this.auth = options.auth ?? auth;
    this.http = options.http ?? createFetchHttpClient();
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Uint8Array> {
    let url = `${this.url}${path}`;
    if (this.options.corsProxy) url = corsProxify(this.options.corsProxy, url);

    for (let attempt = 0; ; attempt++) {
      const res = await this.http.request({
        url,
        method,
        headers: {
          'User-Agent': `git/${AGENT}`,
          ...this.options.headers,
          ...authHeaders(this.auth),
          ...headers,
        },
        body,
      });
      if (res.statusCode === 401 && this.options.onAuth && attempt < 3) {
        const next = await this.options.onAuth(this.url, this.auth);
        if (next) {
          this.auth = next;
          continue;
        }
      }
      if (res.statusCode === 401 || res.statusCode === 403) {
        if (this.auth && this.options.onAuthFailure) {
          await this.options.onAuthFailure(this.url, this.auth);
        }
        throw new HttpError(
          `Authentication failed for '${this.url}' (HTTP ${res.statusCode})`,
          res.statusCode,
          this.url,
        );
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = new TextDecoder().decode(res.body.subarray(0, 512)).trim();
        throw new HttpError(
          `HTTP ${res.statusCode} ${res.statusMessage} for ${url}${text ? `: ${text}` : ''}`,
          res.statusCode,
          this.url,
        );
      }
      const contentType = res.headers['content-type'] ?? '';
      const expected = headers['Accept'];
      if (expected && !contentType.startsWith(expected)) {
        throw new HttpError(
          `Remote '${this.url}' does not speak the smart HTTP protocol ` +
            `(got content-type '${contentType || 'none'}'). Dumb HTTP is not supported.`,
          res.statusCode,
          this.url,
        );
      }
      return res.body;
    }
  }

  async listRefs(service: GitService): Promise<RefAdvertisement> {
    const body = await this.request('GET', `/info/refs?service=${service}`, {
      Accept: `application/x-${service}-advertisement`,
    });
    return parseRefAdvertisement(body);
  }

  async fetchPack(
    adv: RefAdvertisement,
    req: FetchPackRequest,
  ): Promise<FetchPackResult> {
    const caps = negotiateCapabilities(adv, [
      'side-band-64k',
      'side-band',
      'ofs-delta',
      ...(req.includeTags ? ['include-tag'] : []),
      ...(req.onProgress ? [] : ['no-progress']),
      `agent=${AGENT}`,
    ]);
    const body = buildUploadPackRequest({
      wants: req.wants,
      haves: req.haves,
      capabilities: caps,
    });
    const res = await this.request(
      'POST',
      '/git-upload-pack',
      {
        'Content-Type': 'application/x-git-upload-pack-request',
        Accept: 'application/x-git-upload-pack-result',
      },
      body,
    );
    const sideBand = caps.some((c) => c.startsWith('side-band'));
    const parsed = parseUploadPackResponse(res, sideBand, {
      onProgress: req.onProgress,
    });
    return {
      packfile: parsed.packfile.length > 0 ? parsed.packfile : null,
      shallows: parsed.shallows,
      unshallows: parsed.unshallows,
    };
  }

  async pushPack(
    adv: RefAdvertisement,
    req: PushPackRequest,
  ): Promise<PushReport> {
    const caps = negotiateCapabilities(adv, [
      'report-status',
      'side-band-64k',
      'side-band',
      'delete-refs',
      ...(req.atomic ? ['atomic'] : []),
      ...(req.onProgress ? [] : ['quiet']),
      `agent=${AGENT}`,
    ]);
    const body = buildReceivePackRequest(req.commands, caps, req.packfile);
    const res = await this.request(
      'POST',
      '/git-receive-pack',
      {
        'Content-Type': 'application/x-git-receive-pack-request',
        Accept: 'application/x-git-receive-pack-result',
      },
      body,
    );
    const sideBand = caps.some((c) => c.startsWith('side-band'));
    return parseReceivePackResponse(res, sideBand, {
      onProgress: req.onProgress,
    });
  }
}

/** Locate the git directory of a (bare or non-bare) repository at `path`. */
export async function findGitDir(
  fs: FSAdapter,
  path: string,
): Promise<{ gitdir: string; bare: boolean } | null> {
  const dotGit = joinPaths(path, '.git');
  if (await fs.exists(joinPaths(dotGit, 'HEAD'))) {
    return { gitdir: dotGit, bare: false };
  }
  if (
    (await fs.exists(joinPaths(path, 'HEAD'))) &&
    (await fs.exists(joinPaths(path, 'objects')))
  ) {
    return { gitdir: path, bare: true };
  }
  return null;
}

export interface LocalTransportOptions {
  /** Filesystem holding the remote repository. */
  fs: FSAdapter;
  /** Path of the remote repository (working tree or bare git dir). */
  path: string;
  /** Display URL; defaults to `path`. */
  url?: string;
}

/**
 * Transport for a repository reachable through an FSAdapter: another
 * directory on disk, a second in-memory repo, a mounted OPFS volume…
 * Objects are exchanged as packfiles exactly as over the network, but
 * upload-pack / receive-pack run in-process.
 */
export class LocalTransport implements GitTransport {
  readonly url: string;
  private fs: FSAdapter;
  private path: string;

  constructor(options: LocalTransportOptions) {
    this.fs = options.fs;
    this.path = options.path;
    this.url = options.url ?? options.path;
  }

  private async repo(): Promise<{ gitdir: string; bare: boolean }> {
    const found = await findGitDir(this.fs, this.path);
    if (!found) {
      throw new Error(`'${this.url}' does not appear to be a git repository`);
    }
    if (!found.bare) {
      const config = await readConfig(this.fs, found.gitdir);
      if (getConfigValue(config, 'core', 'bare') === 'true') found.bare = true;
    }
    return found;
  }

  async listRefs(service: GitService): Promise<RefAdvertisement> {
    const { gitdir } = await this.repo();
    const refs: RemoteRef[] = [];
    const symrefs = new Map<string, string>();

    if (service === 'git-upload-pack') {
      const head = await readRef(this.fs, gitdir, 'HEAD');
      const headOid = await resolveRefOid(this.fs, gitdir, 'HEAD');
      if (head) {
        const target = parseSymbolicRef(head);
        if (target) symrefs.set('HEAD', target);
      }
      if (headOid) refs.push({ name: 'HEAD', oid: headOid });
    }

    for (const [name, oid] of await listRefs(this.fs, gitdir)) {
      const ref: RemoteRef = { name, oid };
      if (name.startsWith('refs/tags/')) {
        try {
          const peeled = await peelToNonTag(this.fs, gitdir, oid);
          if (peeled.oid !== oid) ref.peeled = peeled.oid;
        } catch {
          // Dangling tag: advertise as-is.
        }
      }
      refs.push(ref);
    }

    const capabilities = new Map<string, string | true>([
      ['ofs-delta', true],
      ['side-band-64k', true],
      ['report-status', true],
      ['delete-refs', true],
      ['atomic', true],
      ['include-tag', true],
      ['agent', AGENT],
    ]);
    return { refs, capabilities, symrefs };
  }

  async fetchPack(
    adv: RefAdvertisement,
    req: FetchPackRequest,
  ): Promise<FetchPackResult> {
    const { gitdir } = await this.repo();
    const objects = await enumerateObjects(
      this.fs,
      gitdir,
      req.wants,
      req.haves,
    );
    if (req.includeTags) {
      const included = new Set(objects.map((o) => o.oid));
      for (const ref of adv.refs) {
        if (!ref.name.startsWith('refs/tags/') || !ref.peeled) continue;
        if (included.has(ref.oid) || !included.has(ref.peeled)) continue;
        const tag = await readObject(this.fs, gitdir, ref.oid);
        objects.unshift({ oid: ref.oid, type: tag.type, content: tag.content });
        included.add(ref.oid);
      }
    }
    if (objects.length === 0) {
      return { packfile: null, shallows: [], unshallows: [] };
    }
    req.onProgress?.(`Enumerating objects: ${objects.length}, done.\n`);
    return {
      packfile: await createPackfile(objects),
      shallows: [],
      unshallows: [],
    };
  }

  async pushPack(
    _adv: RefAdvertisement,
    req: PushPackRequest,
  ): Promise<PushReport> {
    const { gitdir, bare } = await this.repo();
    const refs = new Map<string, { ok: boolean; error?: string }>();

    if (req.packfile) {
      try {
        await storePackfile(this.fs, gitdir, req.packfile, async (oid) => {
          try {
            return await readObject(this.fs, gitdir, oid);
          } catch {
            return null;
          }
        });
      } catch (e) {
        return {
          unpackError: e instanceof Error ? e.message : String(e),
          refs,
        };
      }
    }

    const headTarget = parseSymbolicRef(
      (await readRef(this.fs, gitdir, 'HEAD')) ?? '',
    );

    // Validate everything first so atomic pushes are all-or-nothing.
    for (const cmd of req.commands) {
      const current =
        (await resolveRefOid(this.fs, gitdir, cmd.ref)) ?? ZERO_OID;
      if (current !== cmd.oldOid) {
        refs.set(cmd.ref, { ok: false, error: 'stale info' });
      } else if (!bare && cmd.ref === headTarget) {
        refs.set(cmd.ref, {
          ok: false,
          error:
            cmd.newOid === ZERO_OID
              ? 'deletion of the current branch prohibited'
              : 'branch is currently checked out',
        });
      } else {
        refs.set(cmd.ref, { ok: true });
      }
    }
    if (req.atomic && [...refs.values()].some((r) => !r.ok)) {
      for (const [ref, r] of refs) {
        if (r.ok) refs.set(ref, { ok: false, error: 'atomic push failed' });
      }
      return { unpackError: null, refs };
    }

    for (const cmd of req.commands) {
      if (!refs.get(cmd.ref)?.ok) continue;
      if (cmd.newOid === ZERO_OID) {
        await deleteRef(this.fs, gitdir, cmd.ref);
      } else {
        await writeRef(this.fs, gitdir, cmd.ref, cmd.newOid, true);
      }
    }
    return { unpackError: null, refs };
  }
}

export interface TransportOptions {
  /** FS used to reach local (path / file://) remotes. */
  fs: FSAdapter;
  http?: HttpClient;
  corsProxy?: string;
  headers?: Record<string, string>;
  auth?: GitAuth;
  onAuth?: AuthCallback;
  onAuthFailure?: AuthFailureCallback;
}

/** Pick a transport for a remote URL. */
export function createTransport(
  url: string,
  options: TransportOptions,
): GitTransport {
  if (/^https?:\/\//i.test(url)) {
    return new HttpTransport({
      url,
      http: options.http,
      corsProxy: options.corsProxy,
      headers: options.headers,
      auth: options.auth,
      onAuth: options.onAuth,
      onAuthFailure: options.onAuthFailure,
    });
  }
  if (url.startsWith('file://')) {
    return new LocalTransport({
      fs: options.fs,
      path: decodeURIComponent(url.slice('file://'.length)),
      url,
    });
  }
  if (/^(ssh|git):\/\//i.test(url) || /^[^/:]+@[^/:]+:/.test(url)) {
    throw new Error(
      `Unsupported remote URL '${url}': only http(s):// and local paths are supported ` +
        `(ssh and git:// need raw sockets, which browsers don't provide)`,
    );
  }
  return new LocalTransport({ fs: options.fs, path: url, url });
}
