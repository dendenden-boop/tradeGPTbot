import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalDecimal, parseWireJson, wireObject } from '../src/wire.js';
import { signQuery, canonicalQuery, signPrivateWs } from '../src/auth.js';
import { getHtxProfile } from '../src/profiles.js';
import {
  normalizeInstrument,
  normalizeBook,
  normalizeTicker,
  normalizeCandle,
} from '../src/public-data.js';

import { now, spot, swap } from './fixtures.js';
describe('HTX native protocol contracts before implementation', () => {
  it('preserves numeric financial tokens and big IDs without IEEE rounding', () => {
    const x = wireObject(
      parseWireJson('{"id":90071992547409931234,"qty":1.82e-4,"price":50000.000000000000000001}'),
    );
    expect(x.id).toBe('90071992547409931234');
    expect(canonicalDecimal(x.qty)).toBe('0.000182');
    expect(canonicalDecimal(x.price)).toBe('50000.000000000000000001');
  });
  it.each(['1e999', '1e-19', 'NaN', '01', '1.0000000000000000001', -0, 0.1])(
    'rejects unsafe numeric source %s',
    (x) => {
      expect(() => canonicalDecimal(x)).toThrow();
    },
  );
  it.each(['__proto__', 'constructor', 'prototype'])('rejects poisoned key %s', (key) => {
    expect(() => parseWireJson(`{"${key}":1}`)).toThrow();
  });
  it('uses RFC3986 byte ordering and canonical method/host/path/query HMAC', () => {
    const params = {
      Timestamp: '2017-05-11T16:22:06',
      AccessKeyId: 'key',
      SignatureVersion: '2',
      SignatureMethod: 'HmacSHA256',
      'order-id': '90071992547409931234',
      value: "a !'()*+",
    };
    const query =
      'AccessKeyId=key&SignatureMethod=HmacSHA256&SignatureVersion=2&Timestamp=2017-05-11T16%3A22%3A06&order-id=90071992547409931234&value=a%20%21%27%28%29%2A%2B';
    expect(canonicalQuery(params)).toBe(query);
    expect(signQuery('secret', 'GET', 'API.HUOBI.PRO', '/v1/order/orders', params)).toBe(
      createHmac('sha256', 'secret')
        .update(`GET\napi.huobi.pro\n/v1/order/orders\n${query}`)
        .digest('base64'),
    );
  });
  it('private WS Spot v2.1 and contracts v2 are different signed envelopes', () => {
    const s = signPrivateWs(getHtxProfile('htx-spot-live-v1'), 'fixtureKey', 'fixtureSecret', now);
    const d = signPrivateWs(
      getHtxProfile('htx-linear-live-v1'),
      'fixtureKey',
      'fixtureSecret',
      now,
    );
    expect(s).toMatchObject({
      action: 'req',
      ch: 'auth',
      params: { signatureVersion: '2.1', authType: 'api' },
    });
    expect(d).toMatchObject({ op: 'auth', type: 'api', SignatureVersion: '2' });
  });
  it('does not invent Demo/Testnet or accept URL profiles', () => {
    for (const id of ['htx-spot-testnet-v1', 'htx-linear-demo-v1', 'https://user.example'])
      expect(() => getHtxProfile(id as never)).toThrow();
    expect(getHtxProfile('htx-spot-live-v1').scope.environment).toBe('LIVE');
  });
  it('Spot metadata retains directional native admission constraints and exact steps', () => {
    const n = normalizeInstrument(
      spot,
      getHtxProfile('htx-spot-live-v1').scope,
      now,
      'observation1',
    );
    expect(n.record.rules).toMatchObject({
      tickSize: '0.01',
      stepSize: '0.000001',
      quantityUnit: 'BASE',
      maxQuantity: '500',
    });
    expect(n.admission).toMatchObject({
      unsupportedFields: [],
      nativeConstraints: { blmlt: '1.1' },
    });
  });
  it('unknown constraint fields fail closed while metadata is readable', () => {
    const n = normalizeInstrument(
      { ...spot, futureConstraint: '1' },
      getHtxProfile('htx-spot-live-v1').scope,
      now,
      'observation1',
    );
    expect(n.admission.unsupportedFields).toContain('futureConstraint');
    expect(n.admission.newRiskSupported).toBe(false);
  });
  it('linear contracts have BASE face value and CONTRACTS order units, conservative unproved order limits', () => {
    const n = normalizeInstrument(
      swap,
      getHtxProfile('htx-linear-live-v1').scope,
      now,
      'observation2',
    );
    expect(n.record.instrument.contract).toMatchObject({ size: '0.001', unit: 'BASE' });
    expect(n.record.rules.quantityUnit).toBe('CONTRACTS');
    expect(n.admission.newRiskSupported).toBe(false);
    expect(n.admission.unsupportedFields).toContain('MISSING_NATIVE_ORDER_LIMITS');
  });
  it.each([
    { business_type: 'futures' },
    { contract_type: 'quarter' },
    { delivery_time: '1791129700000' },
    { pair: 'ETH-USDT' },
  ])('rejects wrong derivative identity %j', (fields) => {
    expect(() =>
      normalizeInstrument(
        { ...swap, ...fields },
        getHtxProfile('htx-linear-live-v1').scope,
        now,
        'observation2',
      ),
    ).toThrow();
  });
  it('normalizes full depth snapshots, contract volume to BASE, without fake deltas', () => {
    const r = normalizeInstrument(
      swap,
      getHtxProfile('htx-linear-live-v1').scope,
      now,
      'observation2',
    ).record;
    const b = normalizeBook(
      { ts: now, version: '90071992547409931234', bids: [['50000', '2']], asks: [['50001', '3']] },
      r,
      20,
      now,
    );
    expect(b).toMatchObject({
      kind: 'SNAPSHOT',
      bids: [{ quantity: '0.002' }],
      sourceSequence: '90071992547409931234',
      previousSequence: null,
    });
  });
  it('ticker uses exchange timestamp and unavailable observations explicitly', () => {
    const r = normalizeInstrument(
      spot,
      getHtxProfile('htx-spot-live-v1').scope,
      now,
      'observation1',
    ).record;
    expect(
      normalizeTicker(
        { close: '50000', bid: ['49999', '1'], ask: ['50001', '1'], amount: '2', vol: '100000' },
        r,
        now - 10000,
        now,
      ).freshness,
    ).toBe('STALE');
  });
  it('candles never claim finality before native close and retain exact derivatives amount/vol units', () => {
    const r = normalizeInstrument(
      swap,
      getHtxProfile('htx-linear-live-v1').scope,
      now,
      'observation2',
    ).record;
    expect(
      normalizeCandle(
        {
          id: now / 1000,
          open: '50000',
          high: '50001',
          low: '49999',
          close: '50000',
          amount: '0.002',
          vol: '2',
          count: 1,
        },
        r,
        '1m',
        now,
      ),
    ).toMatchObject({
      complete: false,
      baseVolume: '0.002',
      quoteVolume: { state: 'UNAVAILABLE' },
    });
  });
});
