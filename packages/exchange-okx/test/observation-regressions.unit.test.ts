import { describe, expect, it } from 'vitest';
import { normalizeInstrument, normalizeTicker, createBookAssembler } from '../src/public-data.js';
import { normalizeWallet, normalizeOrder } from '../src/private-data.js';
import { account, identity, scope, now, nativeInstrument, nativeOrder } from './fixtures.js';
const record = () => normalizeInstrument(nativeInstrument(), scope, now, 'a').record;
describe('OKX observation proof, units and malformed native states', () => {
  it('missing ticker timestamp cannot fabricate a fresh exchange observation', () => {
    expect(() =>
      normalizeTicker({ instId: 'BTC-USDT', instType: 'SPOT', last: '50000' }, record(), now),
    ).toThrow();
  });
  it('foreign native ticker instType cannot enter selected scope', () => {
    expect(() =>
      normalizeTicker(
        { instId: 'BTC-USDT', instType: 'SWAP', ts: String(now), last: '50000' },
        record(),
        now,
      ),
    ).toThrow();
  });
  it.each([false, true])('native 24h volume units are explicit swap=%s', (swap) => {
    const r = normalizeInstrument(
      nativeInstrument(swap),
      { ...scope, market: swap ? 'LINEAR_PERPETUAL' : 'SPOT' },
      now,
      'a',
    ).record;
    expect(
      normalizeTicker(
        {
          instId: r.instrument.id,
          instType: swap ? 'SWAP' : 'SPOT',
          ts: String(now),
          vol24h: '2',
          volCcy24h: '3',
        },
        r,
        now,
      ),
    ).toMatchObject({
      baseVolume: { value: swap ? '3' : '2' },
      quoteVolume: swap ? { state: 'UNAVAILABLE' } : { value: '3' },
    });
  });
  it.each([
    { state: 'live', accFillSz: '0.001' },
    { state: 'partially_filled', accFillSz: '0' },
    { state: 'partially_filled', accFillSz: '0.01' },
    { state: 'filled', accFillSz: '0.001' },
    { state: 'filled', uTime: String(now - 200) },
  ])('rejects inconsistent native ordinary state %j', (fields) => {
    expect(() =>
      normalizeOrder({ ...nativeOrder(), ...fields }, record(), account, identity, 'cash'),
    ).toThrow();
  });
  it('unrepresented wallet liabilities fail closed', () => {
    expect(() =>
      normalizeWallet(
        [{ uTime: String(now), details: [{ ccy: 'USDT', cashBal: '10', liab: '1' }] }],
        account,
        scope,
        now,
      ),
    ).toThrow();
  });
  it('same sequence conflicting book cannot overwrite accepted observation', () => {
    const b = createBookAssembler(record(), 5),
      frame = {
        ts: String(now),
        seqId: '10',
        prevSeqId: '-1',
        bids: [['49999', '1', '0', '1']],
        asks: [['50001', '1', '0', '1']],
      };
    b.update({ action: 'snapshot', data: [frame] }, now);
    expect(() =>
      b.update(
        {
          action: 'update',
          data: [{ ...frame, prevSeqId: '10', bids: [['49999', '2', '0', '1']] }],
        },
        now,
      ),
    ).toThrow();
  });
});
