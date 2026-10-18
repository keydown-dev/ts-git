import {
  PktLineReader,
  encodePktLine,
  pktText,
  concatBytes,
  FLUSH_PKT,
} from './pktline.js';

/**
 * Git wire protocol v0/v1 message builders and parsers
 * (gitprotocol-pack(5), gitprotocol-http(5), gitprotocol-capabilities(5)).
 */

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const AGENT = 'ts-git/0.1';

export interface RemoteRef {
  name: string;
  oid: string;
  /** For annotated tags: the object the tag ultimately points at. */
  peeled?: string;
}

export interface RefAdvertisement {
  refs: RemoteRef[];
  capabilities: Map<string, string | true>;
  /** Symbolic refs announced via `symref=` (e.g. HEAD -> refs/heads/main). */
  symrefs: Map<string, string>;
}

export function hasCapability(adv: RefAdvertisement, cap: string): boolean {
  return adv.capabilities.has(cap);
}

function parseCapabilities(text: string): Map<string, string | true> {
  const caps = new Map<string, string | true>();
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    const eq = word.indexOf('=');
    if (eq === -1) {
      caps.set(word, true);
    } else {
      const key = word.slice(0, eq);
      const value = word.slice(eq + 1);
      // symref may repeat; keep them all, space-joined.
      const prev = caps.get(key);
      caps.set(key, typeof prev === 'string' ? `${prev} ${value}` : value);
    }
  }
  return caps;
}

/**
 * Parse a v0/v1 ref advertisement. For smart HTTP the body starts with
 * "# service=<name>" and a flush packet, which are skipped.
 */
export function parseRefAdvertisement(body: Uint8Array): RefAdvertisement {
  const reader = new PktLineReader(body);
  const refs: RemoteRef[] = [];
  let capabilities = new Map<string, string | true>();
  let first = true;

  let pkt = reader.read();
  if (pkt?.type === 'data' && pktText(pkt.data).startsWith('# service=')) {
    // Skip until the flush that ends the service announcement.
    while (pkt && pkt.type !== 'flush') pkt = reader.read();
    pkt = reader.read();
  }
  if (pkt?.type === 'data' && pktText(pkt.data).startsWith('version ')) {
    const version = pktText(pkt.data).slice('version '.length);
    if (version !== '1') {
      throw new Error(`Unsupported protocol version ${version}`);
    }
    pkt = reader.read();
  }

  for (; pkt && pkt.type !== 'flush'; pkt = reader.read()) {
    if (pkt.type !== 'data') continue;
    let line = pktText(pkt.data);
    if (first) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        capabilities = parseCapabilities(line.slice(nul + 1));
        line = line.slice(0, nul);
      }
      first = false;
    }
    if (line.startsWith('ERR ')) {
      throw new Error(`Remote error: ${line.slice(4)}`);
    }
    const space = line.indexOf(' ');
    if (space !== 40) throw new Error(`Malformed ref advertisement: ${line}`);
    const oid = line.slice(0, 40);
    const name = line.slice(41);
    // Empty repositories advertise "capabilities^{}" with a zero id.
    if (name === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) {
      const target = refs.find((r) => r.name === name.slice(0, -3));
      if (target) target.peeled = oid;
      continue;
    }
    if (name.startsWith('shallow')) continue;
    refs.push({ name, oid });
  }

  const symrefs = new Map<string, string>();
  const symrefCap = capabilities.get('symref');
  if (typeof symrefCap === 'string') {
    for (const pair of symrefCap.split(' ')) {
      const colon = pair.indexOf(':');
      if (colon > 0) symrefs.set(pair.slice(0, colon), pair.slice(colon + 1));
    }
  }

  return { refs, capabilities, symrefs };
}

/** Pick the capabilities we want that the server also supports. */
export function negotiateCapabilities(
  adv: RefAdvertisement,
  wanted: string[],
): string[] {
  const chosen: string[] = [];
  for (const cap of wanted) {
    if (cap.startsWith('agent=')) {
      chosen.push(cap);
    } else if (adv.capabilities.has(cap)) {
      chosen.push(cap);
    }
  }
  // Prefer side-band-64k over side-band.
  if (chosen.includes('side-band-64k')) {
    return chosen.filter((c) => c !== 'side-band');
  }
  return chosen;
}

export interface UploadPackRequest {
  wants: string[];
  haves: string[];
  capabilities: string[];
  /** Shallow fetch depth (requires the `shallow` capability). */
  depth?: number;
  /** Commits the client already has as shallow boundaries. */
  shallows?: string[];
}

export function buildUploadPackRequest(req: UploadPackRequest): Uint8Array {
  const chunks: Uint8Array[] = [];
  req.wants.forEach((oid, i) => {
    const caps =
      i === 0 && req.capabilities.length
        ? ` ${req.capabilities.join(' ')}`
        : '';
    chunks.push(encodePktLine(`want ${oid}${caps}\n`));
  });
  for (const oid of req.shallows ?? []) {
    chunks.push(encodePktLine(`shallow ${oid}\n`));
  }
  if (req.depth !== undefined) {
    chunks.push(encodePktLine(`deepen ${req.depth}\n`));
  }
  chunks.push(FLUSH_PKT);
  for (const oid of req.haves) chunks.push(encodePktLine(`have ${oid}\n`));
  chunks.push(encodePktLine('done\n'));
  return concatBytes(chunks);
}

export interface SideBandHandlers {
  onProgress?: (message: string) => void;
}

/**
 * Demultiplex side-band data starting at the reader's position until a flush
 * packet (or end of input). Band 1 is returned; band 2 goes to onProgress;
 * band 3 raises.
 */
export function readSideBand(
  reader: PktLineReader,
  handlers: SideBandHandlers = {},
): Uint8Array {
  const data: Uint8Array[] = [];
  const decoder = new TextDecoder();
  for (let pkt = reader.read(); pkt; pkt = reader.read()) {
    if (pkt.type === 'flush') break;
    if (pkt.type !== 'data' || pkt.data.length === 0) continue;
    const band = pkt.data[0];
    const payload = pkt.data.subarray(1);
    if (band === 1) {
      data.push(payload);
    } else if (band === 2) {
      handlers.onProgress?.(decoder.decode(payload));
    } else if (band === 3) {
      throw new Error(`Remote error: ${decoder.decode(payload).trim()}`);
    } else {
      throw new Error(`Invalid side-band channel ${band}`);
    }
  }
  return concatBytes(data);
}

export interface UploadPackResponse {
  acks: string[];
  shallows: string[];
  unshallows: string[];
  packfile: Uint8Array;
}

export function parseUploadPackResponse(
  body: Uint8Array,
  sideBand: boolean,
  handlers: SideBandHandlers = {},
): UploadPackResponse {
  const reader = new PktLineReader(body);
  const acks: string[] = [];
  const shallows: string[] = [];
  const unshallows: string[] = [];

  // Negotiation lines precede the pack: shallow/unshallow (ending in a
  // flush), then ACK/NAK lines.
  while (!reader.done && reader.peekIsPktLine()) {
    const start = reader.offset;
    const pkt = reader.read()!;
    if (pkt.type === 'flush') continue;
    if (pkt.type !== 'data') continue;
    const text = pktText(pkt.data);
    if (text.startsWith('shallow ')) {
      shallows.push(text.slice(8, 48));
    } else if (text.startsWith('unshallow ')) {
      unshallows.push(text.slice(10, 50));
    } else if (text.startsWith('ACK ')) {
      acks.push(text.slice(4, 44));
    } else if (text === 'NAK') {
      // nothing in common, pack follows
    } else if (text.startsWith('ERR ')) {
      throw new Error(`Remote error: ${text.slice(4)}`);
    } else {
      // Start of the pack data (side-band packet or raw "PACK").
      reader.seek(start);
      break;
    }
  }

  let packfile: Uint8Array;
  if (sideBand) {
    packfile = readSideBand(reader, handlers);
  } else {
    packfile = reader.rest();
  }
  return { acks, shallows, unshallows, packfile };
}

export interface PushCommand {
  ref: string;
  oldOid: string;
  newOid: string;
}

export function buildReceivePackRequest(
  commands: PushCommand[],
  capabilities: string[],
  packfile: Uint8Array | null,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  commands.forEach((cmd, i) => {
    const line = `${cmd.oldOid} ${cmd.newOid} ${cmd.ref}`;
    chunks.push(
      encodePktLine(
        i === 0 && capabilities.length
          ? `${line}\0${capabilities.join(' ')}\n`
          : `${line}\n`,
      ),
    );
  });
  chunks.push(FLUSH_PKT);
  if (packfile) chunks.push(packfile);
  return concatBytes(chunks);
}

export interface PushReport {
  /** null when the remote unpacked successfully. */
  unpackError: string | null;
  refs: Map<string, { ok: boolean; error?: string }>;
}

export function parseReportStatus(data: Uint8Array): PushReport {
  const reader = new PktLineReader(data);
  let unpackError: string | null = null;
  const refs = new Map<string, { ok: boolean; error?: string }>();
  for (let pkt = reader.read(); pkt; pkt = reader.read()) {
    if (pkt.type === 'flush') break;
    if (pkt.type !== 'data') continue;
    const line = pktText(pkt.data);
    if (line.startsWith('unpack ')) {
      const status = line.slice(7);
      unpackError = status === 'ok' ? null : status;
    } else if (line.startsWith('ok ')) {
      refs.set(line.slice(3), { ok: true });
    } else if (line.startsWith('ng ')) {
      const rest = line.slice(3);
      const space = rest.indexOf(' ');
      const ref = space === -1 ? rest : rest.slice(0, space);
      refs.set(ref, {
        ok: false,
        error: space === -1 ? 'rejected' : rest.slice(space + 1),
      });
    }
  }
  return { unpackError, refs };
}

export function parseReceivePackResponse(
  body: Uint8Array,
  sideBand: boolean,
  handlers: SideBandHandlers = {},
): PushReport {
  if (body.length === 0) {
    return { unpackError: null, refs: new Map() };
  }
  const status = sideBand
    ? readSideBand(new PktLineReader(body), handlers)
    : body;
  return parseReportStatus(status);
}
