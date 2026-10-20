import { describe, it, expect } from 'vitest';
import { parseRefAdvertisement } from '../../remote/protocol.js';
import { encodePktLine, FLUSH_PKT, concatBytes } from '../../remote/pktline.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('parseRefAdvertisement', () => {
  it('accepts shallow lines from a shallow server', () => {
    const body = concatBytes([
      encodePktLine('# service=git-upload-pack\n'),
      FLUSH_PKT,
      encodePktLine(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`),
      encodePktLine(`${A} refs/heads/main\n`),
      encodePktLine(`shallow ${B}\n`),
      FLUSH_PKT,
    ]);
    const adv = parseRefAdvertisement(body);
    expect(adv.refs.map((r) => r.name)).toEqual(['HEAD', 'refs/heads/main']);
    expect(adv.symrefs.get('HEAD')).toBe('refs/heads/main');
  });
});
