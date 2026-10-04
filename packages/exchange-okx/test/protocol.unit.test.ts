import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getOkxProfile, okxProfileIds } from '../src/profiles.js';
import { signRest, signWs } from '../src/auth.js';
import {
  normalizeInstrument,
  normalizeTicker,
  normalizeCandles,
  createBookAssembler,
} from '../src/public-data.js';
import {
  normalizeWallet,
  normalizeOrder,
  normalizePosition,
  normalizeFill,
} from '../src/private-data.js';
import { parseWireJson } from '../src/wire.js';
import { account, identity, scope, now, nativeInstrument, nativeOrder } from './fixtures.js';
describe('OKX native contracts before implementation', () => {
  it('four server profiles isolate Demo header and all WS domains on TLS443', () => {
    expect(okxProfileIds).toHaveLength(4);
    for (const id of okxProfileIds) {
      const p = getOkxProfile(id);
      expect(p.rest).toBe('https://openapi.okx.com');
      expect(new URL(p.publicWs).port).toBe('');
      expect(p.publicWs).toContain(id.includes('demo') ? 'wspap.okx.com' : 'ws.okx.com');
      expect(p.demo).toBe(id.includes('demo'));
    }
    expect(() => getOkxProfile('okx-spot-testnet-v1' as never)).toThrow();
  });
  it.each(['GET', 'POST'] as const)(
    'signs exact %s path/query/body and native WS verify prehash',
    (method) => {
      const t = new Date(now).toISOString(),
        path = '/api/v5/trade/order?instId=BTC-USDT',
        body = method === 'POST' ? ' {"sz":"0.01"}' : '';
      expect(signRest('secret', t, method, path, body)).toBe(
        createHmac('sha256', 'secret')
          .update(t + method + path + body)
          .digest('base64'),
      );
      expect(signWs('secret', String(Math.floor(now / 1000)))).toBe(
        createHmac('sha256', 'secret')
          .update(String(Math.floor(now / 1000)) + 'GET/users/self/verify')
          .digest('base64'),
      );
    },
  );
  it('large IDs and precise decimals are never rounded', () => {
    expect(parseWireJson('{"id":90071992547409931234,"qty":0.000000000000000001}')).toEqual({
      id: '90071992547409931234',
      qty: '0.000000000000000001',
    });
  });
  it.each([false, true])('native size and contract units swap=%s', (swap) => {
    const x = normalizeInstrument(
      nativeInstrument(swap),
      { ...scope, market: swap ? 'LINEAR_PERPETUAL' : 'SPOT' },
      now,
      'a',
    );
    expect(x.record.rules.quantityUnit).toBe(swap ? 'CONTRACTS' : 'BASE');
    expect(x.record.instrument.contract?.size).toBe(swap ? '0.01' : undefined);
    expect(x.record.rules.marketMaxQuantity).toBe(swap ? '100' : '1000');
    expect(x.admission.unsupportedConstraints).toEqual([]);
  });
  it.each(['futureConstraint', 'unknownLimit'])(
    'unknown instrument constraint %s blocks new risk',
    (key) => {
      expect(
        normalizeInstrument({ ...nativeInstrument(), [key]: false }, scope, now, 'a').admission
          .unsupportedConstraints,
      ).toContain(key);
    },
  );
  it('upcoming tick change bounds expiry before dispatch', () => {
    const x = normalizeInstrument(
      {
        ...nativeInstrument(),
        upcChg: [{ param: 'tickSz', newValue: '1', effTime: String(now + 5000) }],
      },
      scope,
      now,
      'a',
    );
    expect(x.record.rules.expiresAt).toBe(now + 5000);
  });
  it.each([{ ctType: 'inverse' }, { ctMult: '2' }, { settleCcy: 'USDC' }])(
    'unsupported contract cannot be normalized %j',
    (fields) => {
      expect(() =>
        normalizeInstrument(
          { ...nativeInstrument(true), ...fields },
          { ...scope, market: 'LINEAR_PERPETUAL' },
          now,
          'a',
        ),
      ).toThrow();
    },
  );
  it('ticker empty prices remain unavailable', () => {
    const r = normalizeInstrument(nativeInstrument(), scope, now, 'a').record;
    expect(
      normalizeTicker(
        {
          instId: 'BTC-USDT',
          instType: 'SPOT',
          ts: String(now),
          last: '50000',
          bidPx: '0.000',
          askPx: '',
        },
        r,
        now,
      ).bid.state,
    ).toBe('UNAVAILABLE');
  });
  it('reverse native nine-column candles retain BASE/quote/confirm semantics', () => {
    const r = normalizeInstrument(
      nativeInstrument(true),
      { ...scope, market: 'LINEAR_PERPETUAL' },
      now,
      'a',
    ).record;
    const t = Math.floor(now / 60000) * 60000 - 120000;
    const x = normalizeCandles(
      [[String(t), '10', '12', '9', '11', '2', '0.02', '0.22', '1']],
      r,
      '1m',
      now,
    );
    expect(x[0]).toMatchObject({
      baseVolume: '0.02',
      quoteVolume: { state: 'AVAILABLE', value: '0.22' },
      closeTime: t + 60000,
      complete: true,
    });
  });
  it('book checks actual prevSeq linkage with deprecated zero checksum; contract levels become BASE', () => {
    const r = normalizeInstrument(
        nativeInstrument(true),
        { ...scope, market: 'LINEAR_PERPETUAL' },
        now,
        'a',
      ).record,
      b = createBookAssembler(r, 10);
    expect(
      b.update(
        {
          action: 'snapshot',
          data: [
            {
              ts: String(now),
              seqId: 10,
              prevSeqId: -1,
              checksum: 0,
              bids: [['49999', '2', '0', '1']],
              asks: [['50001', '1', '0', '1']],
            },
          ],
        },
        now,
      )?.bids[0]?.quantity,
    ).toBe('0.02');
    expect(() =>
      b.update(
        {
          action: 'update',
          data: [{ ts: String(now), seqId: 12, prevSeqId: 9, checksum: 0, bids: [], asks: [] }],
        },
        now,
      ),
    ).toThrow();
  });
  it('wallet preserves cash rather than USD-equity and never fabricates free', () => {
    const x = normalizeWallet(
      [
        {
          uTime: String(now),
          details: [{ ccy: 'USDT', cashBal: '10', availBal: '8', frozenBal: '2', liab: '0' }],
        },
      ],
      account,
      scope,
      now,
    );
    expect(x.balances[0]).toMatchObject({
      total: '10',
      free: null,
      locked: '2',
      availableToTrade: { state: 'AVAILABLE', value: '8' },
    });
  });
  it('ordinary order rejects algo identity and quote-budget ambiguity', () => {
    const r = normalizeInstrument(nativeInstrument(), scope, now, 'a').record;
    expect(normalizeOrder(nativeOrder(), r, account, identity, 'cash').status).toBe('FILLED');
    expect(() =>
      normalizeOrder({ ...nativeOrder(), algoId: 'algo-1' }, r, account, identity, 'cash'),
    ).toThrow();
    expect(() =>
      normalizeOrder({ ...nativeOrder(), tgtCcy: 'quote_ccy' }, r, account, identity, 'cash'),
    ).toThrow();
  });
  it('signed net position keeps CONTRACTS and native margin mode', () => {
    const r = normalizeInstrument(
      nativeInstrument(true),
      { ...scope, market: 'LINEAR_PERPETUAL' },
      now,
      'a',
    ).record;
    expect(
      normalizePosition(
        {
          instType: 'SWAP',
          instId: 'BTC-USDT-SWAP',
          posSide: 'net',
          pos: '-2',
          mgnMode: 'cross',
          avgPx: '50000',
          lever: '10',
          liqPx: '',
          uTime: String(now),
        },
        r,
        account,
        'cross',
      ),
    ).toMatchObject({ quantity: '-2', quantityUnit: 'CONTRACTS', side: 'NET' });
  });
  it('execution bill ID is durable and native negative fees become positive charges', () => {
    const r = normalizeInstrument(nativeInstrument(), scope, now, 'a').record;
    expect(
      normalizeFill(
        {
          instType: 'SPOT',
          instId: 'BTC-USDT',
          ordId: 'native1',
          billId: 'bill1',
          tradeId: 'trade1',
          fillPx: '50000',
          fillSz: '0.01',
          fee: '-0.1',
          feeCcy: 'USDT',
          fillTime: String(now),
          ts: String(now),
          side: 'buy',
          posSide: '',
          tradeQuoteCcy: 'USDT',
        },
        r,
        account,
        identity.internalOrderId,
        now,
      ),
    ).toMatchObject({ fillId: 'bill1', fees: [{ asset: 'USDT', amount: '0.1', kind: 'TRADING' }] });
  });
});
