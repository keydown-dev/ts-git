import type { RefUpdate } from '../commands/fetch.js';
import type { PushRefResult } from '../errors.js';

/** "refs/heads/main" -> "main", "refs/remotes/origin/x" -> "origin/x". */
export function shortRefName(ref: string): string {
  return ref.replace(/^refs\/(heads|tags|remotes)\//, '');
}

const abbrev = (oid: string | null) => (oid ? oid.slice(0, 7) : '');

function pad(rows: Array<[string, string, string, string, string]>): string {
  const w1 = Math.max(0, ...rows.map((r) => r[1].length));
  const w2 = Math.max(0, ...rows.map((r) => r[2].length));
  return rows
    .map(
      ([flag, summary, from, to, note]) =>
        ` ${flag} ${summary.padEnd(w1)} ${from.padEnd(w2)} -> ${to}${note ? `  (${note})` : ''}`,
    )
    .join('\n');
}

/** Ref update table in the style of `git fetch`. Up-to-date refs are omitted. */
export function formatFetchUpdates(url: string, updates: RefUpdate[]): string {
  const rows: Array<[string, string, string, string, string]> = [];
  for (const u of updates) {
    const to = shortRefName(u.localRef);
    const from = u.remoteRef ? shortRefName(u.remoteRef) : '(none)';
    const isTag = u.localRef.startsWith('refs/tags/');
    switch (u.status) {
      case 'new':
        rows.push(['*', isTag ? '[new tag]' : '[new branch]', from, to, '']);
        break;
      case 'fast-forward':
        rows.push([
          ' ',
          `${abbrev(u.oldOid)}..${abbrev(u.newOid)}`,
          from,
          to,
          '',
        ]);
        break;
      case 'forced':
        rows.push([
          '+',
          `${abbrev(u.oldOid)}...${abbrev(u.newOid)}`,
          from,
          to,
          'forced update',
        ]);
        break;
      case 'rejected':
        rows.push(['!', '[rejected]', from, to, u.reason ?? '']);
        break;
      case 'pruned':
        rows.push(['-', '[deleted]', '(none)', to, '']);
        break;
    }
  }
  return rows.length ? `From ${url}\n${pad(rows)}` : '';
}

/** Ref update table in the style of `git push`. */
export function formatPushResults(url: string, refs: PushRefResult[]): string {
  const rows: Array<[string, string, string, string, string]> = [];
  for (const r of refs) {
    const to = shortRefName(r.ref);
    const from = r.src ? shortRefName(r.src) : '';
    const isTag = r.ref.startsWith('refs/tags/');
    switch (r.status) {
      case 'new':
        rows.push(['*', isTag ? '[new tag]' : '[new branch]', from, to, '']);
        break;
      case 'fast-forward':
        rows.push([
          ' ',
          `${abbrev(r.oldOid)}..${abbrev(r.newOid)}`,
          from,
          to,
          '',
        ]);
        break;
      case 'forced':
        rows.push([
          '+',
          `${abbrev(r.oldOid)}...${abbrev(r.newOid)}`,
          from,
          to,
          'forced update',
        ]);
        break;
      case 'deleted':
        rows.push(['-', '[deleted]', '', to, '']);
        break;
      case 'rejected':
        rows.push(['!', '[rejected]', from, to, r.reason ?? '']);
        break;
      case 'remote-rejected':
        rows.push(['!', '[remote rejected]', from, to, r.reason ?? '']);
        break;
    }
  }
  if (rows.length === 0) return 'Everything up-to-date';
  return `To ${url}\n${pad(rows)}`;
}
