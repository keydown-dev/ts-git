export type IgnorePattern = {
  /** Pattern text with `!`, leading `/` and trailing `/` removed. */
  pattern: string;
  /**
   * Compiled matcher. For anchored patterns it matches the path relative to
   * `relativeTo`; otherwise it matches the basename only.
   */
  regex: RegExp;
  negative: boolean;
  directoryOnly: boolean;
  /** True when the pattern contains a `/` (other than a trailing one). */
  anchoredToRoot: boolean;
  /** Directory (repo-relative) containing the ignore file. */
  relativeTo: string;
};

export interface IgnoreParseOptions {
  /** core.ignorecase: match case-insensitively (default false). */
  ignoreCase?: boolean;
}

/**
 * Parse a .gitignore-style file following gitignore(5):
 * blank lines and `#` comments are skipped (`\#` is a literal `#`), trailing
 * unescaped spaces are removed, `!` negates (`\!` is literal), a trailing
 * `/` matches directories only, and a pattern containing any other `/` is
 * anchored to the directory of the ignore file. There is no line
 * continuation in ignore files.
 */
export function parseIgnoreFile(
  content: string,
  basePath: string,
  options: IgnoreParseOptions = {},
): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  const relativeTo = basePath;

  for (const rawLine of content.split('\n')) {
    let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    line = trimTrailingSpaces(line);
    if (line === '') continue;

    let negative = false;
    if (line.startsWith('!')) {
      negative = true;
      line = line.slice(1);
    }

    let directoryOnly = false;
    if (line.endsWith('/') && !line.endsWith('\\/')) {
      directoryOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (line === '') continue;

    const anchoredToRoot = line.includes('/');
    if (line.startsWith('/')) {
      line = line.slice(1);
    }

    patterns.push({
      pattern: line,
      regex: wildmatchToRegex(line, options.ignoreCase ?? false),
      negative,
      directoryOnly,
      anchoredToRoot,
      relativeTo,
    });
  }

  return patterns;
}

/** Remove trailing spaces unless escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    // Count backslashes before this space.
    let bs = 0;
    for (let k = end - 2; k >= 0 && line[k] === '\\'; k--) bs++;
    if (bs % 2 === 1) break; // escaped space: keep it
    end--;
  }
  return line.slice(0, end);
}

/**
 * Convert a gitignore glob into a regex with git's wildmatch (WM_PATHNAME)
 * semantics: `*` and `?` never match `/`, `[...]` classes (with `!`/`^`
 * negation), backslash escapes, and `**` only special as a full path
 * component (leading, trailing or between two slashes); any other `**`
 * acts like `*`.
 */
function wildmatchToRegex(pattern: string, ignoreCase: boolean): RegExp {
  let re = '';
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atStart = i === 0 || pattern[i - 1] === '/';
        let j = i;
        while (pattern[j] === '*') j++;
        const atEnd = j === n || pattern[j] === '/';
        if (atStart && atEnd) {
          if (j === n) {
            // Trailing "**" (or whole pattern "**"): match everything.
            re += '.*';
            i = j;
          } else {
            // "**/": zero or more leading directories.
            re += '(?:.*/)?';
            i = j + 1;
          }
          continue;
        }
        re += '[^/]*';
        i = j;
        continue;
      }
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      const cls = parseCharClass(pattern, i);
      if (cls) {
        re += cls.regex;
        i = cls.end;
      } else {
        re += '\\[';
        i++;
      }
    } else if (c === '\\') {
      if (i + 1 < n) {
        re += escapeRegex(pattern[i + 1]);
        i += 2;
      } else {
        // A trailing backslash never matches.
        re += '(?!)';
        i++;
      }
    } else {
      re += escapeRegex(c);
      i++;
    }
  }

  return new RegExp('^' + re + '$', ignoreCase ? 'i' : '');
}

function parseCharClass(
  pattern: string,
  start: number,
): { regex: string; end: number } | null {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === '!' || pattern[i] === '^') {
    negate = true;
    i++;
  }
  let body = '';
  let first = true;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === ']' && !first) {
      // Character classes never match '/'.
      return {
        regex: negate ? `[^/${body}]` : `(?!/)[${body}]`,
        end: i + 1,
      };
    }
    if (c === '\\' && i + 1 < pattern.length) {
      body += escapeClassChar(pattern[i + 1]);
      i += 2;
    } else if (c === '[' && pattern[i + 1] === ':') {
      const close = pattern.indexOf(':]', i + 2);
      if (close === -1) return null;
      const name = pattern.slice(i + 2, close);
      const posix: Record<string, string> = {
        alnum: 'A-Za-z0-9',
        alpha: 'A-Za-z',
        blank: ' \\t',
        cntrl: '\\x00-\\x1f\\x7f',
        digit: '0-9',
        graph: '!-~',
        lower: 'a-z',
        print: ' -~',
        punct: '!-\\/:-@\\[-`{-~',
        space: ' \\t\\n\\r\\f\\v',
        upper: 'A-Z',
        xdigit: '0-9A-Fa-f',
      };
      if (!(name in posix)) return null;
      body += posix[name];
      i = close + 2;
    } else {
      body += c === '-' ? '-' : escapeClassChar(c);
      i++;
    }
    first = false;
  }
  return null;
}

function escapeClassChar(c: string): string {
  return '\\^]['.includes(c) || c === '-' ? '\\' + c : c;
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? '\\' + char : char;
}

/**
 * Build a matcher answering "is this path excluded by the patterns?" for a
 * single path component level: the last matching pattern wins (negation
 * re-includes). Exclusion of parent directories is not considered here —
 * use {@link isPathIgnored} for that.
 */
export function createMatcher(
  patterns: IgnorePattern[],
): (path: string, isDirectory: boolean) => boolean {
  return (path: string, isDirectory: boolean): boolean => {
    const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    let isIgnored = false;
    for (const pattern of patterns) {
      if (matchesPattern(pattern, normalizedPath, isDirectory)) {
        isIgnored = !pattern.negative;
      }
    }
    return isIgnored;
  };
}

/**
 * gitignore semantics for an arbitrary path: if any parent directory is
 * excluded the path is excluded (it cannot be re-included), otherwise the
 * path's own patterns decide.
 */
export function isPathIgnored(
  matcher: (path: string, isDirectory: boolean) => boolean,
  path: string,
  isDirectory: boolean,
): boolean {
  const parts = path.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    if (matcher(parts.slice(0, i).join('/'), true)) return true;
  }
  return matcher(parts.join('/'), isDirectory);
}

function matchesPattern(
  pattern: IgnorePattern,
  path: string,
  isDirectory: boolean,
): boolean {
  if (pattern.directoryOnly && !isDirectory) {
    return false;
  }

  let relativePath: string;
  const base = pattern.relativeTo.replace(/^\/+|\/+$/g, '');
  if (base === '') {
    relativePath = path;
  } else if (path.startsWith(base + '/')) {
    relativePath = path.slice(base.length + 1);
  } else {
    return false;
  }
  if (relativePath === '') return false;

  if (pattern.anchoredToRoot) {
    return pattern.regex.test(relativePath);
  }
  const slash = relativePath.lastIndexOf('/');
  return pattern.regex.test(relativePath.slice(slash + 1));
}
