import { describe, expect, it } from 'vitest';
import { createCursorCodec } from '../src/cursor.js';

describe('scoped opaque cursors', () => {
  const now = 1_800_000_000_000;
  it('preserves a raw opaque ID without converting large numeric-looking IDs', () => {
    const codec = createCursorCodec();
    const raw = '900719925474099312345678901';
    const cursor = codec.encode(raw, 'scope/filters/account', now);
    expect(codec.decode(cursor, 'scope/filters/account', now)).toBe(raw);
  });
  it('rejects a different tenant, environment, operation or filter binding', () => {
    const codec = createCursorCodec();
    const token = codec.encode('page-2', 'tenant1/TESTNET/getOrders/BTC', now);
    for (const binding of [
      'tenant2/TESTNET/getOrders/BTC',
      'tenant1/LIVE/getOrders/BTC',
      'tenant1/TESTNET/getTrades/BTC',
      'tenant1/TESTNET/getOrders/ETH',
    ])
      expect(codec.decode(token, binding, now)).toBeNull();
  });
  it('has an exclusive expiry and rejects a backwards clock outside its lifetime', () => {
    const codec = createCursorCodec();
    const token = codec.encode('page-2', 'binding', now);
    expect(codec.decode(token, 'binding', now + 299_999)).toBe('page-2');
    expect(codec.decode(token, 'binding', now + 300_000)).toBeNull();
    expect(codec.decode(token, 'binding', now - 1)).toBeNull();
  });
  it('rejects altered payloads/signatures, malformed encodings and another adapter instance', () => {
    const codec = createCursorCodec();
    const token = codec.encode('page-2', 'binding', now);
    expect(createCursorCodec().decode(token, 'binding', now)).toBeNull();
    for (const bad of [
      token.replace(/^./, token.startsWith('a') ? 'b' : 'a'),
      `${token.slice(0, -1)}!`,
      `${token}.extra`,
      '',
      '.',
      'a.b',
      'a'.repeat(2049),
      `${token}\n`,
    ])
      expect(codec.decode(bad, 'binding', now)).toBeNull();
  });
  it('fails closed for invalid clocks instead of bypassing expiry comparisons', () => {
    const codec = createCursorCodec();
    const token = codec.encode('page-2', 'binding', now);
    for (const invalid of [NaN, Infinity, -1, 1.5])
      expect(codec.decode(token, 'binding', invalid)).toBeNull();
  });
});
