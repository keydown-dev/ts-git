import { describe, it, expect, afterEach } from 'vitest';
import {
  parseConfig,
  serializeConfig,
  getConfigValue,
  getConfigSection,
} from '../../core/config.js';
import { ConfigParseError } from '../../errors.js';
import { createGitSandbox, type GitSandbox } from './git-env.js';

/** `git config -z --list --file` → map of "section\0sub\0key" → last value. */
/**
 * Older git turned whitespace inside unquoted values into spaces; current git
 * (and ts-git) keep it as written. Compare modulo that when the local git is
 * the older kind.
 */
function legacyWhitespace(sb: GitSandbox): boolean {
  sb.write('probe.config', '[p]\n\tk = a\tb\n');
  return !sb.git(['config', '--file', 'probe.config', 'p.k']).includes('\t');
}

function comparable(
  sb: GitSandbox,
  map: Map<string, string>,
): Record<string, string> {
  const legacy = legacyWhitespace(sb);
  return Object.fromEntries(
    [...map].map(([k, v]) => [k, legacy ? v.replace(/[\t\v\f]/g, ' ') : v]),
  );
}

function gitConfigMap(sb: GitSandbox, file: string): Map<string, string> {
  const out = sb.git(['config', '-z', '--list', '--file', file]);
  const map = new Map<string, string>();
  for (const entry of out.split('\0').filter(Boolean)) {
    const nl = entry.indexOf('\n');
    const fullKey = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? 'true' : entry.slice(nl + 1);
    const first = fullKey.indexOf('.');
    const last = fullKey.lastIndexOf('.');
    const section = first === -1 ? '' : fullKey.slice(0, first);
    const sub = first === last ? '' : fullKey.slice(first + 1, last);
    const key = fullKey.slice(last + 1);
    map.set(`${section}\0${sub}\0${key}`, value);
  }
  return map;
}

function ourConfigMap(text: string): Map<string, string> {
  const config = parseConfig(text);
  const map = new Map<string, string>();
  for (const s of config.sections) {
    for (const key of s.options.keys()) {
      const id = `${s.name}\0${s.subsection ?? ''}\0${key}`;
      map.set(id, getConfigValue(config, s.name, key, s.subsection)!);
    }
  }
  return map;
}

const SAMPLE = [
  '﻿# leading comment',
  '; another comment',
  '[Core]',
  '\tRepositoryFormatVersion = 0',
  '\tfilemode=true   ; trailing comment',
  '\tbare',
  '\tignoreCase = false # hash comment',
  '[remote "Origin"]',
  '\turl = https://example.com/repo.git',
  '\tfetch = +refs/heads/*:refs/remotes/Origin/*',
  '[remote "origin"]',
  '\turl = other',
  '[Branch.Main]',
  '\tremote = origin',
  '[alias]',
  '\tlg = "log --oneline # not a comment"',
  '\tquoted = a"b c"d',
  '\tspaces =   inner    spaces  kept   ',
  '\ttabs = a\t\tb',
  '\tesc = "tab\\there\\nnewline \\"quote\\" back\\\\slash"',
  '\tcont = first \\',
  '  second',
  '\tsemi = "a;b"',
  '\tempty =',
  '\temptyq = ""',
  '[core]',
  '\tbare = false',
  '[section "sub \\"quoted\\" \\\\ name"]',
  '\tkey = v',
  '[with-dash "x.y.z"] key = same-line',
  '[crlf]\r',
  '\tkey = value\r',
  '',
].join('\n');

describe('config parsing vs git config --list', () => {
  let sb: GitSandbox;
  afterEach(() => sb?.cleanup());

  it('matches git for a config exercising git-config(1) syntax', () => {
    sb = createGitSandbox();
    sb.write('test.config', SAMPLE);
    const expected = gitConfigMap(sb, 'test.config');
    const actual = ourConfigMap(SAMPLE);
    expect(comparable(sb, actual)).toEqual(comparable(sb, expected));
  });

  it('lookups are case-insensitive for section and key but not subsection', () => {
    const config = parseConfig(SAMPLE);
    expect(getConfigValue(config, 'CORE', 'REPOSITORYFORMATVERSION')).toBe('0');
    // Later [core] section overrides the earlier implicit boolean.
    expect(getConfigValue(config, 'core', 'bare')).toBe('false');
    expect(getConfigValue(config, 'remote', 'url', 'Origin')).toBe(
      'https://example.com/repo.git',
    );
    expect(getConfigValue(config, 'remote', 'url', 'origin')).toBe('other');
    // Old-style [Branch.Main] lowercases the subsection.
    expect(getConfigSection(config, 'branch', 'main')).toBeDefined();
    expect(getConfigValue(config, 'alias', 'esc')).toBe(
      'tab\there\nnewline "quote" back\\slash',
    );
  });

  it('serializeConfig output is read back identically by git and by us', () => {
    sb = createGitSandbox();
    const config = parseConfig(SAMPLE);
    const text = serializeConfig(config);
    sb.write('round.config', text);
    expect(Object.fromEntries(gitConfigMap(sb, 'round.config'))).toEqual(
      Object.fromEntries(gitConfigMap(sb, 'round.config')),
    );
    expect(comparable(sb, ourConfigMap(text))).toEqual(
      comparable(sb, gitConfigMap(sb, 'round.config')),
    );
    sb.write('orig.config', SAMPLE);
    expect(comparable(sb, gitConfigMap(sb, 'round.config'))).toEqual(
      comparable(sb, gitConfigMap(sb, 'orig.config')),
    );
  });

  it('reads a config written by git config', () => {
    sb = createGitSandbox();
    sb.git(['config', 'remote.origin.url', 'git@host:x/y.git']);
    sb.git([
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
    sb.git(['config', 'user.name', '  Spaced  Name ']);
    sb.git(['config', 'alias.x', 'echo "hi" # there; \\ ok']);
    sb.git(['config', 'branch.Feature/X.remote', 'origin']);
    const text = sb.read('.git/config').toString('utf8');
    expect(Object.fromEntries(ourConfigMap(text))).toEqual(
      Object.fromEntries(gitConfigMap(sb, '.git/config')),
    );
  });

  it('rejects malformed input like git does', () => {
    sb = createGitSandbox();
    const bad = [
      '[core\n',
      '[core]\n\tkey = "unterminated\n',
      '[core]\n\tkey = bad \\q escape\n',
      '[core]\n\t1key = v\n',
    ];
    for (const text of bad) {
      sb.write('bad.config', text);
      expect(
        sb.gitTry(['config', '--list', '--file', 'bad.config']).status,
      ).not.toBe(0);
      expect(() => parseConfig(text)).toThrow(ConfigParseError);
    }
  });

  it('accepts variables before the first section header, like git', () => {
    sb = createGitSandbox();
    const text = 'top = 1\n[core]\n\tx = y\n';
    sb.write('top.config', text);
    expect(Object.fromEntries(ourConfigMap(text))).toEqual(
      Object.fromEntries(gitConfigMap(sb, 'top.config')),
    );
    const round = serializeConfig(parseConfig(text));
    sb.write('top2.config', round);
    expect(Object.fromEntries(gitConfigMap(sb, 'top2.config'))).toEqual(
      Object.fromEntries(gitConfigMap(sb, 'top.config')),
    );
  });
});
