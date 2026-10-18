/**
 * gitignore pattern parsing and matching, following gitignore(5) and the
 * behaviour of canonical git's dir.c / wildmatch.c:
 *
 * - blank lines and lines starting with `#` are skipped (`\#` is a literal #)
 * - trailing spaces are removed unless escaped with a backslash; a trailing
 *   CR (CRLF files) is removed; leading whitespace is significant
 * - `!` negates (`\!` is a literal !)
 * - a trailing `/` makes the pattern match directories only
 * - a pattern without a `/` (other than a trailing one) matches the basename
 *   at any depth below the ignore file's directory; otherwise it is matched
 *   against the path relative to that directory (a leading `/` just anchors)
 * - wildcards use wildmatch with WM_PATHNAME: `*`, `?` and `[...]` never match
 *   `/`; `**` only has special meaning as `**​/`, `/**​/` or `/**`; any other
 *   run of asterisks behaves like a single `*`
 * - matching is case sensitive (core.ignorecase=false)
 * - within an ordered list of patterns the last match wins, and a path inside
 *   an excluded directory is excluded no matter what later patterns say
 */
export type IgnorePattern = {
  /** Pattern text with `!`, leading `/` and trailing `/` removed. */
  pattern: string;
  /** Compiled matcher; tested against the basename or the relative path. */
  regex: RegExp;
  negative: boolean;
  directoryOnly: boolean;
  /**
   * True when the pattern contains a slash (other than a trailing one), i.e.
   * it is matched against the path relative to `relativeTo` rather than
   * against the basename.
   */
  anchoredToRoot: boolean;
  /** Directory (repo-relative) of the ignore file the pattern came from. */
  relativeTo: string;
};

export function parseIgnoreFile(
  content: string,
  basePath: string,
): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];

  for (let line of content.split('\n')) {
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    line = trimTrailingSpaces(line);
    if (line === '') {
      continue;
    }

    let pattern = line;
    let negative = false;
    if (pattern.startsWith('!')) {
      negative = true;
      pattern = pattern.slice(1);
    }

    let directoryOnly = false;
    if (pattern.endsWith('/')) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    const anchoredToRoot = pattern.includes('/');
    if (pattern.startsWith('/')) {
      pattern = pattern.slice(1);
    }

    if (pattern === '') {
      continue;
    }

    patterns.push({
      pattern,
      regex: wildmatchToRegex(pattern),
      negative,
      directoryOnly,
      anchoredToRoot,
      relativeTo: basePath,
    });
  }

  return patterns;
}

/** Remove unescaped trailing spaces (git's trim_trailing_spaces). */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    // Count the backslashes immediately before this space.
    let backslashes = 0;
    for (let k = end - 2; k >= 0 && line[k] === '\\'; k--) {
      backslashes++;
    }
    if (backslashes % 2 === 1) {
      break; // escaped space: keep it (and everything before it)
    }
    end--;
  }
  return line.slice(0, end);
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '\\x21-\\x7e',
  lower: 'a-z',
  print: '\\x20-\\x7e',
  punct: '!-\\/:-@\\[-`{-~',
  space: ' \\t\\n\\r\\f\\v',
  upper: 'A-Z',
  xdigit: '0-9A-Fa-f',
};

function escapeRegexChar(c: string): string {
  return /[.*+?^${}()|[\]\\/-]/.test(c) ? '\\' + c : c;
}

/**
 * Translate a wildmatch pattern (WM_PATHNAME semantics) into an anchored
 * regular expression.
 */
export function wildmatchToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const c = pattern[i];

    if (c === '*') {
      let j = i;
      while (j < n && pattern[j] === '*') j++;
      const run = j - i;
      const atSegmentStart = i === 0 || pattern[i - 1] === '/';
      const atSegmentEnd = j === n || pattern[j] === '/';

      if (run >= 2 && atSegmentStart && atSegmentEnd) {
        if (j === n) {
          // Trailing "**" (or a bare "**"): everything below.
          re += '.*';
          i = j;
        } else {
          // "**/" : zero or more leading directories.
          re += '(?:.*/)?';
          i = j + 1;
        }
      } else {
        re += '[^/]*';
        i = j;
      }
      continue;
    }

    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }

    if (c === '[') {
      const cls = parseBracket(pattern, i);
      if (cls) {
        re += cls.regex;
        i = cls.end;
      } else {
        // Unterminated bracket expression: git never matches it.
        return /(?!)/;
      }
      continue;
    }

    if (c === '\\') {
      if (i + 1 < n) {
        re += escapeRegexChar(pattern[i + 1]);
        i += 2;
      } else {
        // A trailing backslash makes the pattern invalid (never matches).
        return /(?!)/;
      }
      continue;
    }

    re += escapeRegexChar(c);
    i++;
  }

  return new RegExp('^' + re + '$');
}

function parseBracket(
  pattern: string,
  start: number,
): { regex: string; end: number } | null {
  let i = start + 1;
  const n = pattern.length;
  let negate = false;
  if (pattern[i] === '!' || pattern[i] === '^') {
    negate = true;
    i++;
  }

  let body = '';
  let first = true;
  while (i < n) {
    const c = pattern[i];
    if (c === ']' && !first) {
      // With WM_PATHNAME a bracket expression never matches '/'.
      const regex = negate ? `[^/${body}]` : `(?!/)[${body}]`;
      return { regex, end: i + 1 };
    }
    first = false;

    if (c === '[' && pattern[i + 1] === ':') {
      const close = pattern.indexOf(':]', i + 2);
      if (close !== -1) {
        const name = pattern.slice(i + 2, close);
        const posix = POSIX_CLASSES[name];
        if (posix === undefined) {
          return null;
        }
        body += posix;
        i = close + 2;
        continue;
      }
    }

    if (c === '\\' && i + 1 < n) {
      body += escapeRegexChar(pattern[i + 1]);
      i += 2;
      continue;
    }

    if (c === '-' && body !== '' && pattern[i + 1] !== ']' && i + 1 < n) {
      body += '-';
      i++;
      continue;
    }

    body += escapeRegexChar(c);
    i++;
  }

  return null;
}

function normalizeBase(base: string): string {
  return base.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Does a single pattern match `path` (repo-relative, no trailing slash)?
 * Returns false when the path is outside the pattern's directory.
 */
export function patternMatches(
  pattern: IgnorePattern,
  path: string,
  isDirectory: boolean,
): boolean {
  if (pattern.directoryOnly && !isDirectory) {
    return false;
  }

  const base = normalizeBase(pattern.relativeTo);
  let relative = path;
  if (base !== '') {
    if (!path.startsWith(base + '/')) {
      return false;
    }
    relative = path.slice(base.length + 1);
  }
  if (relative === '') {
    return false;
  }

  if (!pattern.anchoredToRoot) {
    const slash = relative.lastIndexOf('/');
    const basename = slash === -1 ? relative : relative.slice(slash + 1);
    return pattern.regex.test(basename);
  }

  return pattern.regex.test(relative);
}

/** Last-match-wins evaluation of `patterns` for `path` itself (no parent check). */
export function lastMatchExcludes(
  patterns: IgnorePattern[],
  path: string,
  isDirectory: boolean,
): boolean | undefined {
  for (let k = patterns.length - 1; k >= 0; k--) {
    if (patternMatches(patterns[k], path, isDirectory)) {
      return !patterns[k].negative;
    }
  }
  return undefined;
}

export interface MatcherOptions {
  /**
   * When true (the default) a path is also reported as ignored if any of its
   * parent directories is ignored, as git does. Walkers that already prune
   * ignored directories can turn this off.
   */
  checkParents?: boolean;
}

export function createMatcher(
  patterns: IgnorePattern[],
  options: MatcherOptions = {},
): (path: string, isDirectory: boolean) => boolean {
  const checkParents = options.checkParents ?? true;

  return (path: string, isDirectory: boolean): boolean => {
    const normalized = path
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    if (normalized === '') {
      return false;
    }

    if (checkParents) {
      let slash = normalized.indexOf('/');
      while (slash !== -1) {
        const parent = normalized.slice(0, slash);
        if (lastMatchExcludes(patterns, parent, true) === true) {
          return true;
        }
        slash = normalized.indexOf('/', slash + 1);
      }
    }

    return lastMatchExcludes(patterns, normalized, isDirectory) === true;
  };
}
