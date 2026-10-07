import { describe, expect, it } from 'vitest';
import { inPlaceAmendmentSchema } from '@ctp/exchange-core';
import {
  validateBinanceAmendment,
  reconcileBinanceAmendmentHistory,
  checkBinanceAmendmentAck,
} from '../src/amendment.js';
import { normalizeBinanceAdmission } from '../src/public-data.js';
import { getBinanceProfile } from '../src/profiles.js';
import { NOW, spotSymbol } from './fixtures/public-data.js';
import {
  newOrder,
  privateRecord,
  INTERNAL_ORDER_ID,
  INTENT_ID,
  order,
} from './fixtures/private-data.js';

const command = () =>
  inPlaceAmendmentSchema.parse({
    semantics: 'IN_PLACE',
    identity: { exchangeOrderId: 'PRESERVED', clientOrderId: 'REPLACED' },
    locator: { instrumentId: 'BTCUSDT', locator: { kind: 'EXCHANGE_ID', id: order().orderId } },
    target: {
      internalOrderId: INTERNAL_ORDER_ID,
      placeIntentId: INTENT_ID,
      revision: '9007199254740993',
      observedAt: NOW,
      nativeUpdatedAt: NOW - 10,
      current: newOrder(),
      filledQuantity: '0.025',
    },
    replacement: {
      ...newOrder(),
      clientOrderId: 'fixture-amend-1',
      size: { kind: 'BASE_QUANTITY', value: '0.075', asset: 'BTC' },
    },
  });
const row = () => ({
  symbol: 'BTCUSDT',
  orderId: order().orderId,
  executionId: '9007199254740993',
  origClientOrderId: 'fixture-order-1',
  newClientOrderId: 'fixture-amend-1',
  origQty: '0.1',
  newQty: '0.075',
  time: String(NOW),
});
const endpoint = getBinanceProfile('binance-spot-testnet-v1');
const admission = () => normalizeBinanceAdmission({ ...spotSymbol(), amendAllowed: true });

describe('Binance native AMEND causality and exact decimals', () => {
  it('preserves large native IDs and rejects Number-rounded execution identities', () => {
    const evidence = reconcileBinanceAmendmentHistory([row()], command(), 'BTCUSDT', NOW);
    expect(evidence).toMatchObject({
      kind: 'APPLIED_EVIDENCE',
      evidence: { executionId: '9007199254740993', exchangeOrderId: '9223372036854775807' },
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(() =>
      reconcileBinanceAmendmentHistory(
        [{ ...row(), executionId: Number('9007199254740993') }],
        command(),
        'BTCUSDT',
        NOW,
      ),
    ).toThrow();
  });
  it('retains historical causal evidence if a subsequent native amendment exists', () => {
    const second = {
      ...row(),
      executionId: '9007199254740994',
      origClientOrderId: 'fixture-amend-1',
      newClientOrderId: 'fixture-amend-2',
      origQty: '0.075',
      newQty: '0.05',
    };
    expect(
      reconcileBinanceAmendmentHistory([row(), second], command(), 'BTCUSDT', NOW),
    ).toMatchObject({
      kind: 'APPLIED_EVIDENCE',
      evidence: { newClientOrderId: 'fixture-amend-1' },
    });
  });
  it.each([
    ['duplicate execution', () => [row(), row()]],
    ['out-of-order execution', () => [row(), { ...row(), executionId: '9007199254740992' }]],
    ['wrong native order', () => [{ ...row(), orderId: '9' }]],
    ['wrong symbol', () => [{ ...row(), symbol: 'ETHUSDT' }]],
    ['matched IDs with wrong cumulative quantity', () => [{ ...row(), newQty: '0.074' }]],
    ['matched IDs with wrong original quantity', () => [{ ...row(), origQty: '0.09' }]],
    ['future exchange time', () => [{ ...row(), time: String(NOW + 1) }]],
    ['event before original native revision', () => [{ ...row(), time: String(NOW - 11) }]],
    [
      'broken quantity chain',
      () => [
        row(),
        {
          ...row(),
          executionId: '9007199254740994',
          origClientOrderId: 'fixture-amend-1',
          newClientOrderId: 'fixture-amend-2',
          origQty: '0.07',
          newQty: '0.05',
        },
      ],
    ],
    [
      'broken identity chain',
      () => [
        row(),
        {
          ...row(),
          executionId: '9007199254740994',
          origClientOrderId: 'unrelated',
          newClientOrderId: 'fixture-amend-2',
          origQty: '0.075',
          newQty: '0.05',
        },
      ],
    ],
    ['saturated history cannot prove complete scan', () => Array.from({ length: 1000 }, row)],
    ['overflowing history', () => Array.from({ length: 1001 }, row)],
  ])('rejects %s', (_name, rows) => {
    expect(() =>
      reconcileBinanceAmendmentHistory((rows as () => unknown)(), command(), 'BTCUSDT', NOW),
    ).toThrow();
  });
  it('same current order quantity without causal request identity is indeterminate', () => {
    expect(
      reconcileBinanceAmendmentHistory(
        [{ ...row(), origClientOrderId: 'other-original', newClientOrderId: 'other-amend' }],
        command(),
        'BTCUSDT',
        NOW,
      ),
    ).toEqual({ kind: 'INDETERMINATE', reason: 'NO_CAUSAL_EVIDENCE' });
  });
  it('canonicalizes wire quantities without changing identity or cumulative interpretation', () => {
    expect(
      reconcileBinanceAmendmentHistory(
        [{ ...row(), origQty: '0.10000000', newQty: '0.07500000' }],
        command(),
        'BTCUSDT',
        NOW,
      ),
    ).toMatchObject({
      kind: 'APPLIED_EVIDENCE',
      evidence: { originalQuantity: '0.1', newQuantity: '0.075' },
    });
  });
  it.each(['0.1', '0.11'])('denies unchanged/increasing Binance total %s', (quantity) => {
    const c = command();
    expect(() =>
      validateBinanceAmendment(
        {
          ...c,
          replacement: { ...c.replacement, size: { ...c.replacement.size, value: quantity } },
        },
        privateRecord(),
        admission(),
        endpoint,
        NOW,
      ),
    ).toThrow('UNSUPPORTED');
  });
  it('does not treat a new price as quantity-only native amendment', () => {
    const c = command();
    expect(() =>
      validateBinanceAmendment(
        { ...c, replacement: { ...c.replacement, limitPrice: '101' } },
        privateRecord(),
        admission(),
        endpoint,
        NOW,
      ),
    ).toThrow('UNSUPPORTED');
  });
  it('denies unknown filter constraints and absent native capability', () => {
    expect(() =>
      validateBinanceAmendment(
        command(),
        privateRecord(),
        { ...admission(), unsupportedFilters: ['NEW_CONSTRAINT'] },
        endpoint,
        NOW,
      ),
    ).toThrow('UNSUPPORTED');
    expect(normalizeBinanceAdmission(spotSymbol()).amendAllowed).toBe(false);
    expect(() => normalizeBinanceAdmission({ ...spotSymbol(), amendAllowed: 'true' })).toThrow();
  });
  it('does not interpret a generic getOrder observation as amendment ACK', () => {
    expect(() =>
      checkBinanceAmendmentAck({ ...order(), origQty: '0.075' }, command(), 'BTCUSDT', NOW),
    ).toThrow();
  });
  it('recovery still correlates original target after current rules refresh and request expiry', () => {
    const old = command();
    const expired = {
      ...old,
      target: { ...old.target, observedAt: NOW - 100_000, nativeUpdatedAt: NOW - 100_100 },
    };
    const c = inPlaceAmendmentSchema.parse(expired);
    expect(reconcileBinanceAmendmentHistory([row()], c, 'BTCUSDT', NOW)).toMatchObject({
      kind: 'APPLIED_EVIDENCE',
    });
    expect(() => validateBinanceAmendment(c, privateRecord(), admission(), endpoint, NOW)).toThrow(
      'STALE_METADATA',
    );
  });
});
