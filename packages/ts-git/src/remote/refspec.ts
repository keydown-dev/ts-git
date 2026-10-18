/**
 * Refspecs (gitrevisions / git-fetch(1) "<refspec>"):
 *   [+]<src>[:<dst>]
 * where src/dst may contain a single "*" glob. A leading "^" marks a
 * negative refspec (exclusion).
 */
export interface Refspec {
  force: boolean;
  negative: boolean;
  src: string;
  dst: string | null;
  glob: boolean;
}

export function parseRefspec(spec: string): Refspec {
  let rest = spec.trim();
  let force = false;
  let negative = false;
  if (rest.startsWith('+')) {
    force = true;
    rest = rest.slice(1);
  } else if (rest.startsWith('^')) {
    negative = true;
    rest = rest.slice(1);
  }

  const colon = rest.indexOf(':');
  const src = colon === -1 ? rest : rest.slice(0, colon);
  const dst = colon === -1 ? null : rest.slice(colon + 1);

  const srcGlobs = (src.match(/\*/g) ?? []).length;
  const dstGlobs = dst === null ? 0 : (dst.match(/\*/g) ?? []).length;
  if (srcGlobs > 1 || dstGlobs > 1) {
    throw new Error(`Invalid refspec '${spec}': more than one '*'`);
  }
  if (dst !== null && dst !== '' && srcGlobs !== dstGlobs) {
    throw new Error(`Invalid refspec '${spec}': '*' must appear on both sides`);
  }
  if (negative && dst !== null) {
    throw new Error(`Invalid refspec '${spec}': negative refspecs take no dst`);
  }

  return { force, negative, src, dst, glob: srcGlobs === 1 };
}

export function formatRefspec(r: Refspec): string {
  const prefix = r.force ? '+' : r.negative ? '^' : '';
  return r.dst === null ? `${prefix}${r.src}` : `${prefix}${r.src}:${r.dst}`;
}

function matchGlob(pattern: string, name: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === name ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (
    name.length >= prefix.length + suffix.length &&
    name.startsWith(prefix) &&
    name.endsWith(suffix)
  ) {
    return name.slice(prefix.length, name.length - suffix.length);
  }
  return null;
}

/** Does `name` match the refspec's source side? */
export function refspecMatchesSource(r: Refspec, name: string): boolean {
  return matchGlob(r.src, name) !== null;
}

/**
 * Map a source ref name through the refspec to its destination.
 * Returns null when it doesn't match or the refspec has no destination.
 */
export function mapRefspecSource(r: Refspec, name: string): string | null {
  const m = matchGlob(r.src, name);
  if (m === null || r.dst === null || r.dst === '') return null;
  return r.glob ? r.dst.replace('*', m) : r.dst;
}

/** Map a destination ref back to the source ref it would be fetched from. */
export function mapRefspecDestination(r: Refspec, name: string): string | null {
  if (r.dst === null || r.dst === '') return null;
  const m = matchGlob(r.dst, name);
  if (m === null) return null;
  return r.glob ? r.src.replace('*', m) : r.src;
}

export function defaultFetchRefspec(remote: string): string {
  return `+refs/heads/*:refs/remotes/${remote}/*`;
}

/**
 * Expand a short ref name as typed on the command line ("main", "v1.0",
 * "heads/main") to a full ref, picking the first existing candidate in git's
 * lookup order. Falls back to refs/heads/<name>.
 */
export function expandRefName(
  name: string,
  exists: (full: string) => boolean,
): string {
  if (name === 'HEAD' || name.startsWith('refs/')) return name;
  const candidates = [
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
  return candidates.find(exists) ?? `refs/heads/${name}`;
}
