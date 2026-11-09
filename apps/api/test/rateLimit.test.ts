import { describe, expect, it } from 'vitest';
import { ipKeyFor } from '../src/lib/rateLimit.ts';
import { sha256Hex } from '../src/lib/crypto.ts';

describe('ipKeyFor', () => {
  it('groups IPv4 by /24 and stores only the hashed network', async () => {
    const a = await ipKeyFor('196.188.1.2');
    expect(a).toBe(await ipKeyFor('196.188.1.250'));
    expect(a).not.toBe(await ipKeyFor('196.188.2.2'));
    expect(a).toBe(`ip:${await sha256Hex('196.188.1.0/24')}`);
    expect(a).not.toBe(`ip:${await sha256Hex('196.188.1.2')}`);
  });

  it('groups IPv6 by /64, whatever the spelling', async () => {
    const a = await ipKeyFor('2001:db8:1:2::1');
    expect(a).toBe(await ipKeyFor('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'));
    expect(a).not.toBe(await ipKeyFor('2001:db8:1:3::1'));
  });

  it('never throws on odd input', async () => {
    for (const odd of [undefined, '', 'unknown', '1:2:3:4:5:6:7:8:9::1', '999.1.1.1.1']) {
      await expect(ipKeyFor(odd)).resolves.toMatch(/^ip:[0-9a-f]{64}$/);
    }
  });
});
