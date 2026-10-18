import { FSAdapter } from '../fs/types.js';
import { joinPaths } from '../utils/path.js';
import { ConfigParseError } from '../errors.js';

export interface ConfigSection {
  /** Section name, lowercased (section names are case-insensitive). */
  name: string;
  /** Subsection name; case-sensitive (lowercased for `[a.b]` old syntax). */
  subsection?: string;
  /**
   * Variables in this section, keyed by lowercased name (variable names are
   * case-insensitive). A variable given without `=` is boolean true and is
   * stored as `'true'`. Repeated keys keep the last value.
   */
  options: Map<string, string>;
}

export interface GitConfig {
  sections: ConfigSection[];
}

const isSpace = (c: string) =>
  c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f';
const isAlpha = (c: string) => /^[A-Za-z]$/.test(c);
const isKeyChar = (c: string) => /^[A-Za-z0-9-]$/.test(c);
const isSectionChar = (c: string) => /^[A-Za-z0-9.-]$/.test(c);

/**
 * Parse a git config file following git-config(1) "Syntax":
 * - `[section]`, `[section "subsection"]` (with `\"`/`\\` escapes) and the
 *   deprecated `[section.subsection]` form;
 * - `#` / `;` comments (also trailing, outside double quotes);
 * - values with partial double-quoting, `\n \t \b \" \\` escapes and
 *   backslash-newline continuation; leading/trailing whitespace dropped,
 *   internal whitespace runs kept;
 * - a variable without `=` is boolean true;
 * - CRLF line endings and a UTF-8 BOM are accepted.
 */
export function parseConfig(content: string): GitConfig {
  const src = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const sections: ConfigSection[] = [];
  let currentSection: ConfigSection | null = null;
  let pos = 0;
  let line = 1;

  const fail = (msg: string): never => {
    throw new ConfigParseError(`bad config line ${line}: ${msg}`);
  };
  const peek = () => (pos < src.length ? src[pos] : '');
  const skipToEol = () => {
    while (pos < src.length && src[pos] !== '\n') pos++;
  };

  const parseSectionHeader = (): ConfigSection => {
    // At '['
    pos++;
    let name = '';
    while (isSectionChar(peek())) name += src[pos++];
    let subsection: string | undefined;

    if (peek() === ']') {
      pos++;
      if (name === '') fail('empty section name');
      const dot = name.indexOf('.');
      if (dot !== -1) {
        // Deprecated [section.subsection]: both parts are lowercased.
        subsection = name.slice(dot + 1).toLowerCase();
        name = name.slice(0, dot);
        if (name === '' || subsection === '') fail('bad section name');
      }
    } else if (isSpace(peek())) {
      while (isSpace(peek())) pos++;
      if (peek() !== '"') fail('expected quoted subsection');
      pos++;
      subsection = '';
      for (;;) {
        const c = peek();
        if (c === '' || c === '\n') fail('unterminated subsection');
        pos++;
        if (c === '"') break;
        if (c === '\\') {
          const n = peek();
          if (n === '' || n === '\n') fail('unterminated subsection');
          pos++;
          subsection += n;
        } else {
          subsection += c;
        }
      }
      if (peek() !== ']') fail('expected ]');
      pos++;
      if (name === '' || name.includes('.')) fail('bad section name');
    } else {
      fail('invalid section header');
    }

    return {
      name: name.toLowerCase(),
      subsection,
      options: new Map(),
    };
  };

  const parseValue = (): string => {
    let value = '';
    let quoted = false;
    let pendingSpace = 0;
    for (;;) {
      const c = peek();
      if (c === '') {
        if (quoted) fail('unterminated quote');
        break;
      }
      if (c === '\n') {
        if (quoted) fail('unterminated quote');
        break;
      }
      pos++;
      if (!quoted && (c === '#' || c === ';')) {
        skipToEol();
        break;
      }
      if (!quoted && isSpace(c)) {
        if (value.length > 0) pendingSpace++;
        continue;
      }
      if (pendingSpace > 0) {
        value += ' '.repeat(pendingSpace);
        pendingSpace = 0;
      }
      if (c === '\\') {
        const n = peek();
        pos++;
        switch (n) {
          case '\n':
            line++;
            continue; // line continuation
          case 'n':
            value += '\n';
            continue;
          case 't':
            value += '\t';
            continue;
          case 'b':
            value += '\b';
            continue;
          case '\\':
          case '"':
            value += n;
            continue;
          default:
            fail('bad escape sequence');
        }
      }
      if (c === '"') {
        quoted = !quoted;
        continue;
      }
      value += c;
    }
    return value;
  };

  while (pos < src.length) {
    const c = src[pos];
    if (c === '\n') {
      pos++;
      line++;
      continue;
    }
    if (isSpace(c)) {
      pos++;
      continue;
    }
    if (c === '#' || c === ';') {
      skipToEol();
      continue;
    }
    if (c === '[') {
      currentSection = parseSectionHeader();
      sections.push(currentSection);
      // The rest of the line may hold a variable or a comment.
      continue;
    }
    if (!isAlpha(c)) {
      fail(`unexpected character '${c}'`);
    }
    if (!currentSection) {
      // git accepts variables before any section header (empty section).
      currentSection = { name: '', options: new Map() };
      sections.push(currentSection);
    }

    let key = '';
    while (isKeyChar(peek())) key += src[pos++];
    while (isSpace(peek())) pos++;

    let value: string;
    if (peek() === '=') {
      pos++;
      value = parseValue();
    } else if (peek() === '' || peek() === '\n') {
      value = 'true';
    } else if (peek() === '#' || peek() === ';') {
      skipToEol();
      value = 'true';
    } else {
      value = fail('invalid variable name');
    }
    currentSection!.options.set(key.toLowerCase(), value);
  }

  return { sections };
}

function quoteConfigValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\x08/g, '\\b');
  const needsQuotes =
    /^\s|\s$/.test(value) || value.includes('#') || value.includes(';');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function formatSubsection(subsection: string): string {
  return subsection.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function serializeConfig(config: GitConfig): string {
  const lines: string[] = [];

  // Variables outside any section must come before the first header.
  const headerless = (s: ConfigSection) =>
    s.name === '' && s.subsection === undefined;
  const ordered = [
    ...config.sections.filter(headerless),
    ...config.sections.filter((s) => !headerless(s)),
  ];

  for (const section of ordered) {
    if (headerless(section)) {
      // No header line.
    } else if (section.subsection !== undefined) {
      lines.push(`[${section.name} "${formatSubsection(section.subsection)}"]`);
    } else {
      lines.push(`[${section.name}]`);
    }

    for (const [key, value] of section.options) {
      lines.push(`\t${key} = ${quoteConfigValue(value)}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function sectionMatches(
  section: ConfigSection,
  name: string,
  subsection?: string,
): boolean {
  return (
    section.name.toLowerCase() === name.toLowerCase() &&
    section.subsection === subsection
  );
}

function getOptionCaseInsensitive(
  options: Map<string, string>,
  key: string,
): string | undefined {
  const lower = key.toLowerCase();
  if (options.has(lower)) return options.get(lower);
  let found: string | undefined;
  for (const [k, v] of options) {
    if (k.toLowerCase() === lower) found = v;
  }
  return found;
}

export function getConfigSection(
  config: GitConfig,
  name: string,
  subsection?: string,
): ConfigSection | undefined {
  return config.sections.find((s) => sectionMatches(s, name, subsection));
}

/**
 * Last value of `name[.subsection].key`, searching every matching section
 * (a section may appear several times in a file; the last value wins, as
 * with `git config --get`).
 */
export function getConfigValue(
  config: GitConfig,
  name: string,
  key: string,
  subsection?: string,
): string | undefined {
  let result: string | undefined;
  for (const section of config.sections) {
    if (!sectionMatches(section, name, subsection)) continue;
    const value = getOptionCaseInsensitive(section.options, key);
    if (value !== undefined) result = value;
  }
  return result;
}

export function setConfigSection(
  config: GitConfig,
  section: ConfigSection,
): void {
  const existingIndex = config.sections.findIndex((s) =>
    sectionMatches(s, section.name, section.subsection),
  );

  if (existingIndex >= 0) {
    config.sections[existingIndex] = section;
  } else {
    config.sections.push(section);
  }
}

export function createDefaultConfig(): GitConfig {
  return {
    sections: [
      {
        name: 'core',
        options: new Map([
          ['repositoryformatversion', '0'],
          ['filemode', 'false'],
          ['bare', 'false'],
          ['logallrefupdates', 'true'],
        ]),
      },
    ],
  };
}

export async function readConfig(
  fs: FSAdapter,
  gitdir: string,
): Promise<GitConfig> {
  const configPath = joinPaths(gitdir, 'config');

  if (!(await fs.exists(configPath))) {
    return createDefaultConfig();
  }

  const content = await fs.readFileString(configPath);
  return parseConfig(content);
}

export async function writeConfig(
  fs: FSAdapter,
  gitdir: string,
  config: GitConfig,
): Promise<void> {
  const configPath = joinPaths(gitdir, 'config');
  const content = serializeConfig(config);
  await fs.writeFile(configPath, content);
}

export function getDefaultBranch(config: GitConfig): string {
  const initDefaultBranch = getConfigValue(config, 'init', 'defaultBranch');
  return initDefaultBranch ?? 'master';
}

export function setDefaultBranch(config: GitConfig, branch: string): void {
  let section = getConfigSection(config, 'init');

  if (!section) {
    section = {
      name: 'init',
      options: new Map(),
    };
    config.sections.push(section);
  }

  section.options.set('defaultBranch', branch);
}
