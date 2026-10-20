import { FSAdapter } from '../fs/types.js';
import { readConfig, writeConfig, setConfigValue } from '../core/config.js';
import { hasObject } from '../core/objects.js';
import {
  getCurrentBranch,
  listRefs,
  resolveRefOid,
  writeRef,
  deleteRef,
  isHeadDetached,
} from '../core/refs.js';
import { createPackfile } from '../core/pack-builder.js';
import { enumerateObjects, isAncestor } from '../core/commit-graph.js';
import { createTransport } from '../remote/transport.js';
import { anonymizeUrl } from '../remote/http.js';
import { ZERO_OID } from '../remote/protocol.js';
import {
  defaultFetchRefspec,
  expandRefName,
  mapRefspecSource,
  parseRefspec,
} from '../remote/refspec.js';
import {
  DetachedHeadError,
  PushRejectedError,
  RemoteNotFoundError,
  TsGitError,
  type PushRefResult,
} from '../errors.js';
import { readRemoteFromConfig, readUpstream, requireGitdir } from './remote.js';
import { transportOptions, type RemoteOptions } from './fetch.js';

export interface PushArgs extends RemoteOptions {
  fs: FSAdapter;
  dir: string;
  gitdir?: string;
  /** Remote name or URL; defaults to the current branch's upstream remote, else "origin". */
  remote?: string;
  /**
   * What to push, as refspecs: "main", "main:release", "+feature",
   * ":old-branch" (delete), "refs/heads/*:refs/heads/*". Defaults to the
   * current branch (to its upstream branch when one is configured).
   */
  refspecs?: string[];
  /** Allow non-fast-forward updates (like --force). */
  force?: boolean;
  /** Treat refspecs as remote refs to delete (like --delete). */
  delete?: boolean;
  /** Also push all local tags (like --tags). */
  tags?: boolean;
  /** Record pushed branches' upstream (like -u / --set-upstream). */
  setUpstream?: boolean;
  /** Either every ref updates or none does (requires server support). */
  atomic?: boolean;
}

export interface PushResult {
  remote: string | null;
  url: string;
  refs: PushRefResult[];
}

interface PlannedUpdate {
  src: string | null;
  dst: string;
  newOid: string;
  force: boolean;
}

function looksLikeUrl(remote: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ||
    remote.startsWith('/') ||
    remote.startsWith('.')
  );
}

/**
 * Update remote refs and send the objects they need
 * (`git push [<remote>] [<refspec>...]`).
 *
 * Throws PushRejectedError (with per-ref results) if any ref was rejected,
 * locally (non-fast-forward, fetch first) or by the remote.
 */
export async function push(args: PushArgs): Promise<PushResult> {
  const { fs } = args;
  const gitdir = await requireGitdir(args);
  const config = await readConfig(fs, gitdir);
  const currentBranch = (await isHeadDetached(fs, gitdir))
    ? null
    : await getCurrentBranch(fs, gitdir);
  const upstream = currentBranch ? readUpstream(config, currentBranch) : null;
  const progress = (phase: string, message: string) =>
    args.onProgress?.({ phase, message });

  let remoteName: string | null = args.remote ?? upstream?.remote ?? 'origin';
  let url: string;
  const remoteInfo = readRemoteFromConfig(config, remoteName);
  if (remoteInfo) {
    url = remoteInfo.pushUrl ?? remoteInfo.url;
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
  const adv = await transport.listRefs('git-receive-pack');
  if (args.atomic && !adv.capabilities.has('atomic')) {
    throw new TsGitError('the receiving end does not support --atomic push');
  }
  const remoteRefs = new Map(adv.refs.map((r) => [r.name, r.oid]));
  const localRefs = await listRefs(fs, gitdir);
  const localExists = (name: string) => localRefs.has(name);

  // 1. Plan the updates.
  const planned: PlannedUpdate[] = [];
  const plan = (p: PlannedUpdate) => {
    if (!planned.some((x) => x.dst === p.dst)) planned.push(p);
  };
  const specs =
    args.refspecs && args.refspecs.length > 0 ? args.refspecs : null;

  if (args.delete) {
    for (const name of specs ?? []) {
      const dst = name.startsWith('refs/')
        ? name
        : expandRefName(name, (n) => remoteRefs.has(n));
      plan({ src: null, dst, newOid: ZERO_OID, force: true });
    }
  } else if (!specs) {
    if (!currentBranch) {
      throw new DetachedHeadError(
        'You are not currently on a branch. Specify what to push, e.g. push({ refspecs: ["HEAD:refs/heads/<name>"] }).',
      );
    }
    const src = `refs/heads/${currentBranch}`;
    const dst =
      upstream && upstream.remote === remoteName ? upstream.merge : src;
    const oid = await resolveRefOid(fs, gitdir, src);
    if (!oid)
      throw new Error(`src refspec ${currentBranch} does not match any`);
    plan({ src, dst, newOid: oid, force: !!args.force });
  } else {
    for (const raw of specs) {
      const spec = parseRefspec(raw);
      if (spec.negative) continue;
      const force = spec.force || !!args.force;
      if (spec.src === '') {
        const name = spec.dst ?? '';
        const dst = name.startsWith('refs/')
          ? name
          : expandRefName(name, (n) => remoteRefs.has(n));
        plan({ src: null, dst, newOid: ZERO_OID, force: true });
        continue;
      }
      if (spec.glob) {
        for (const [name, oid] of localRefs) {
          const dst = mapRefspecSource(
            { ...spec, dst: spec.dst ?? spec.src },
            name,
          );
          if (dst) plan({ src: name, dst, newOid: oid, force });
        }
        continue;
      }
      let src: string;
      let oid: string | null;
      if (/^[0-9a-f]{40}$/i.test(spec.src)) {
        src = spec.src;
        oid = spec.src.toLowerCase();
      } else if (spec.src === 'HEAD') {
        src = 'HEAD';
        oid = await resolveRefOid(fs, gitdir, 'HEAD');
      } else {
        src = expandRefName(spec.src, localExists);
        oid = localRefs.get(src) ?? null;
      }
      if (!oid) throw new Error(`src refspec ${spec.src} does not match any`);

      let dst: string;
      const dstName =
        spec.dst ??
        (src === 'HEAD' && currentBranch ? `refs/heads/${currentBranch}` : src);
      if (dstName.startsWith('refs/')) {
        dst = dstName;
      } else if (remoteRefs.has(`refs/heads/${dstName}`)) {
        dst = `refs/heads/${dstName}`;
      } else if (remoteRefs.has(`refs/tags/${dstName}`)) {
        dst = `refs/tags/${dstName}`;
      } else if (src.startsWith('refs/tags/')) {
        dst = `refs/tags/${dstName}`;
      } else if (src.startsWith('refs/heads/') || src === 'HEAD') {
        dst = `refs/heads/${dstName}`;
      } else {
        throw new Error(
          `The destination you provided is not a full refname (i.e., starting with "refs/"): ${dstName}`,
        );
      }
      plan({ src, dst, newOid: oid, force });
    }
  }
  if (args.tags) {
    for (const [name, oid] of localRefs) {
      if (name.startsWith('refs/tags/'))
        plan({ src: name, dst: name, newOid: oid, force: !!args.force });
    }
  }

  // 2. Classify each update.
  const results: PushRefResult[] = [];
  for (const p of planned) {
    const oldOid = remoteRefs.get(p.dst) ?? ZERO_OID;
    const r: PushRefResult = {
      src: p.src,
      ref: p.dst,
      oldOid,
      newOid: p.newOid,
      status: 'new',
    };
    if (p.newOid === ZERO_OID) {
      if (oldOid === ZERO_OID) {
        r.status = 'rejected';
        r.reason = 'remote ref does not exist';
      } else {
        r.status = 'deleted';
      }
    } else if (oldOid === p.newOid) {
      r.status = 'up-to-date';
    } else if (oldOid !== ZERO_OID) {
      if (p.dst.startsWith('refs/tags/')) {
        r.status = p.force ? 'forced' : 'rejected';
        if (!p.force) r.reason = 'already exists';
      } else if (!(await hasObject(fs, gitdir, oldOid))) {
        r.status = p.force ? 'forced' : 'rejected';
        if (!p.force) r.reason = 'fetch first';
      } else {
        let ff = false;
        try {
          ff = await isAncestor(fs, gitdir, oldOid, p.newOid);
        } catch {
          ff = false;
        }
        r.status = ff ? 'fast-forward' : p.force ? 'forced' : 'rejected';
        if (r.status === 'rejected') r.reason = 'non-fast-forward';
      }
    }
    results.push(r);
  }

  const toSend = results.filter(
    (r) => r.status !== 'up-to-date' && r.status !== 'rejected',
  );
  const locallyRejected = results.some((r) => r.status === 'rejected');
  if (args.atomic && locallyRejected) {
    for (const r of toSend) {
      r.status = 'rejected';
      r.reason = 'atomic push failed';
    }
    toSend.length = 0;
  }

  // 3. Send.
  if (toSend.length > 0) {
    const updates = toSend.filter((r) => r.newOid !== ZERO_OID);
    let packfile: Uint8Array | null = null;
    if (updates.length > 0) {
      const haves: string[] = [];
      for (const oid of remoteRefs.values()) {
        if (oid !== ZERO_OID && (await hasObject(fs, gitdir, oid)))
          haves.push(oid);
      }
      const objects = await enumerateObjects(
        fs,
        gitdir,
        updates.map((r) => r.newOid),
        haves,
      );
      progress('pack', `Writing objects: ${objects.length}`);
      packfile = await createPackfile(objects);
    }
    const report = await transport.pushPack(adv, {
      commands: toSend.map((r) => ({
        ref: r.ref,
        oldOid: r.oldOid,
        newOid: r.newOid,
      })),
      packfile,
      atomic: args.atomic,
      onProgress: args.onProgress ? (m) => progress('remote', m) : undefined,
    });
    if (report.unpackError) {
      throw new Error(`remote unpack failed: ${report.unpackError}`);
    }
    for (const r of toSend) {
      const status = report.refs.get(r.ref);
      if (status && !status.ok) {
        r.status = 'remote-rejected';
        r.reason = status.error;
      }
    }
  }

  // 4. Update remote-tracking refs and upstream config for what landed.
  if (remoteName) {
    const fetchSpecs = (
      remoteInfo?.fetch.length
        ? remoteInfo.fetch
        : [defaultFetchRefspec(remoteName)]
    ).map(parseRefspec);
    for (const r of results) {
      if (r.status === 'rejected' || r.status === 'remote-rejected') continue;
      for (const spec of fetchSpecs) {
        const tracking = mapRefspecSource(spec, r.ref);
        if (!tracking) continue;
        if (r.newOid === ZERO_OID) {
          if (await resolveRefOid(fs, gitdir, tracking)) {
            await deleteRef(fs, gitdir, tracking).catch(() => undefined);
          }
        } else {
          await writeRef(fs, gitdir, tracking, r.newOid, true);
        }
      }
    }
    if (args.setUpstream) {
      const cfg = await readConfig(fs, gitdir);
      let changed = false;
      for (const r of results) {
        if (r.status === 'rejected' || r.status === 'remote-rejected') continue;
        if (
          !r.src?.startsWith('refs/heads/') ||
          !r.ref.startsWith('refs/heads/')
        )
          continue;
        const branch = r.src.slice('refs/heads/'.length);
        setConfigValue(cfg, 'branch', 'remote', remoteName, branch);
        setConfigValue(cfg, 'branch', 'merge', r.ref, branch);
        changed = true;
      }
      if (changed) await writeConfig(fs, gitdir, cfg);
    }
  }

  const shownUrl = anonymizeUrl(url);
  const result: PushResult = {
    remote: remoteName,
    url: shownUrl,
    refs: results,
  };
  const failed = results.filter(
    (r) => r.status === 'rejected' || r.status === 'remote-rejected',
  );
  if (failed.length > 0) {
    const detail = failed
      .map((r) => `  ! [rejected] ${r.ref} (${r.reason ?? 'rejected'})`)
      .join('\n');
    throw new PushRejectedError(
      `failed to push some refs to '${shownUrl}'\n${detail}`,
      results,
    );
  }
  return result;
}
