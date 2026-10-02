import { describe, expect, it } from 'vitest';
import { canonicalDecimal, parseWireJson, wireId, wireInteger } from '../src/wire.js';

describe('Binance lossless wire boundary', () => {
  it('preserves numeric exchange IDs beyond safe integer and decimal lexemes', () => {
    expect(
      parseWireJson('{"id":9007199254740993123,"money":0.100000000000000001,"time":1790767094510}'),
    ).toEqual({ id: '9007199254740993123', money: '0.100000000000000001', time: '1790767094510' });
  });
  it.each([
    ['0.01000000', '0.01'],
    ['-1.230000', '-1.23'],
    ['-0.0000', '0'],
    ['100', '100'],
    ['0.000000000000000001', '0.000000000000000001'],
  ])('normalizes exact decimal %s', (input, expected) => {
    expect(canonicalDecimal(input)).toBe(expected);
  });
  it.each([
    0.1,
    NaN,
    Infinity,
    -0,
    '1e3',
    '+1',
    '01',
    '0.0000000000000000001',
    '9'.repeat(31),
    {},
    null,
  ])('rejects invalid money %j', (value) => {
    expect(() => canonicalDecimal(value)).toThrow('INVALID_BINANCE_RESPONSE');
  });
  it('keeps integer IDs strings and bounded time/counts numbers', () => {
    expect(wireId('9007199254740993123')).toBe('9007199254740993123');
    expect(wireInteger('1790767094510')).toBe(1790767094510);
  });
  it.each([9007199254740992, -1, 1.1, '9007199254740992', '1e3', null, -0])(
    'rejects invalid count %j',
    (value) => {
      expect(() => wireInteger(value)).toThrow('INVALID_BINANCE_RESPONSE');
    },
  );
  it.each([
    '{',
    '{"__proto__":{}}',
    '{"nested":{"constructor":1}}',
    '[1,]',
    '{"secret":"sentinel"',
  ])('contains malformed JSON %s', (text) => {
    expect(() => parseWireJson(text)).toThrow('INVALID_BINANCE_RESPONSE');
  });
});
