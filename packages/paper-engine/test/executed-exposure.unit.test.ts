import { beforeEach, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { canonical } from '@ctp/portfolio';
import { parseDecimal } from '@ctp/exchange-core';
import * as paper from '../src/index.js';
import { normalizedFixtures } from '../../exchange-core/test/fixtures/domain.js';
import { admissionWire, wireHash } from './admission-wire-fixtures.js';
import { startedExecutionFixture } from './started-execution-fixtures.js';

interface Result {
  kind: 'PAPER_EXECUTED_EXPOSURE_CALCULATION';
  version: 'paper-single-executed-exposure-v1';
  coverage: 'SINGLE_EXECUTED_ORDER';
  tenantInventoryComplete: false;
  computedAt: number;
  asOf: number;
  validUntil: number;
  executedAt: number;
  owner: { tenantId: string; accountId: string; mode: 'PAPER' };
  instrumentId: string;
  valuationAsset: string;
  position: { quantity: string; price: string; notional: string };
  pending: {
    orderId: string;
    intentId: string;
    reservationId: string;
    quantity: string;
    notional: string;
  } | null;
  collateral: { holdId: string; asset: string; amount: string } | null;
  combinedNotional: string;
  openOrders: number;
  positionCount: number;
}
function entry() {
  const fn = (paper as unknown as Record<string, unknown>)['calculatePaperExecutedExposure'];
  if (typeof fn !== 'function') throw Error('PAPER_EXECUTED_EXPOSURE_MISSING');
  return fn as (raw: unknown) => Result;
}
beforeEach(() => {
  entry();
});
const calculate = (raw: unknown) => entry()(raw);
function fixture(partial = true) {
  const x = startedExecutionFixture(),
    a = x.attempt.request.admission;
  const { model, record, book, trade } = admissionWire(a.admittedAt).packet.budget;
  const hold = x.portfolio.holds[0]!;
  if (partial) x.frame.trade.quantity = parseDecimal('0.5');
  const executionInput = {
    ...x,
    original: { now: a.admittedAt, model, record, book, trade },
    reservation: {
      id: a.reservationId,
      decisionId: a.decisionId,
      orderId: a.orderId,
      intentId: a.intentId,
      revision: '1',
      status: 'ACTIVE',
      debits: [{ asset: hold.asset, amount: hold.amount, holdId: hold.id }],
      watermarks: [
        {
          holdId: hold.id,
          timestamp: a.admittedAt,
          fingerprint: wireHash({ type: 'COMMITMENT', hold }),
          released: false,
          unknown: false,
        },
      ],
    },
  };
  const now = x.now + 20000,
    native = normalizedFixtures();
  const currentMarket = {
    id: '99999999-9999-4999-8999-999999999999',
    kind: 'SNAPSHOT' as const,
    expectedRevision: '9007199254740993',
    timestamp: now,
    key: {
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      dbInstrumentId: a.dbInstrumentId,
      dbRuleId: '88888888-8888-4888-8888-888888888888',
    },
    record: structuredClone(record),
    ticker: {
      ...native.ticker,
      last: { state: 'AVAILABLE' as const, value: '12.05' },
      receivedAt: now,
      exchangeTime: now,
    },
    book: { ...x.frame.book, receivedAt: now, exchangeTime: now },
  };
  return { now, asOf: now, executionInput, currentMarket };
}
function rebind(f: ReturnType<typeof fixture>) {
  const a = f.executionInput.attempt.request.admission;
  a.commandHash = wireHash({ operation: 'createOrder', command: a.command, binding: a.binding });
  f.executionInput.attempt.requestHash = wireHash(f.executionInput.attempt.request);
}
it('counts a partial position plus the remaining order once, with collateral separate from exposure', () => {
  const f = fixture(),
    r = calculate(f);
  expect(r).toMatchObject({
    kind: 'PAPER_EXECUTED_EXPOSURE_CALCULATION',
    version: 'paper-single-executed-exposure-v1',
    coverage: 'SINGLE_EXECUTED_ORDER',
    tenantInventoryComplete: false,
    position: { quantity: '0.25', price: '12.05', notional: '3.0125' },
    pending: { quantity: '0.25', notional: '2.625' },
    collateral: { asset: 'USDT', amount: '2.627625' },
    combinedNotional: '5.6375',
    openOrders: 1,
    positionCount: 1,
  });
  const a = f.executionInput.attempt.request.admission;
  expect(r.pending).toMatchObject({
    orderId: a.orderId,
    intentId: a.intentId,
    reservationId: a.reservationId,
  });
  expect(r.owner).toEqual({
    tenantId: a.binding.tenantId,
    accountId: a.binding.accountId,
    mode: 'PAPER',
  });
  expect(r.validUntil).toBe(f.now + 5001);
});
it('terminal fill has current position exposure and no remaining order or hold', () => {
  const r = calculate(fixture(false));
  expect(r).toMatchObject({
    position: { quantity: '0.5', notional: '6.025' },
    combinedNotional: '6.025',
    pending: null,
    collateral: null,
    openOrders: 0,
    positionCount: 1,
  });
});
it('IOC retains actual partial position but excludes the definitively expired remainder', () => {
  const f = fixture();
  f.executionInput.attempt.request.admission.command.timeInForce = 'IOC';
  rebind(f);
  expect(calculate(f)).toMatchObject({
    position: { quantity: '0.25' },
    pending: null,
    collateral: null,
    openOrders: 0,
    combinedNotional: '3.0125',
  });
});
it('unfilled FOK releases liability and contributes zero exposure', () => {
  const f = fixture();
  f.executionInput.attempt.request.admission.command.timeInForce = 'FOK';
  rebind(f);
  expect(calculate(f)).toMatchObject({
    position: { quantity: '0', notional: '0' },
    combinedNotional: '0',
    pending: null,
    collateral: null,
    openOrders: 0,
    positionCount: 0,
  });
});
it('uses lossless decimal arithmetic at the current mark and keeps fees out of notional', () => {
  const f = fixture();
  f.currentMarket.ticker.last.value = '12.0500000000000004';
  const r = calculate(f);
  expect(r.position.notional).toBe(new Decimal('0.25').mul('12.0500000000000004').toFixed());
  expect(r.combinedNotional).toBe(new Decimal(r.position.notional).add('2.625').toFixed());
  expect(r.collateral!.amount).toBe('2.627625');
});
it('replays historical execution at its original time while current v2 metadata prices the position', () => {
  const f = fixture();
  const a = f.executionInput.attempt.request.admission;
  f.now = a.expiresAt + 100000;
  f.asOf = f.now;
  f.currentMarket.timestamp = f.now;
  f.currentMarket.ticker.receivedAt = f.now;
  f.currentMarket.ticker.exchangeTime = f.now;
  f.currentMarket.book.receivedAt = f.now;
  f.currentMarket.book.exchangeTime = f.now;
  f.currentMarket.record.rules = {
    ...f.currentMarket.record.rules,
    version: 'current-v2',
    effectiveAt: f.now - 1000,
    expiresAt: f.now + 60000,
  };
  const r = calculate(f);
  expect(r.executedAt).toBe(f.executionInput.now);
  expect(r.position.notional).toBe('3.0125');
  expect(f.executionInput.original.record.rules.version).not.toBe('current-v2');
});
it('fresh recapture does not renew older market expiry or original economic timestamps', () => {
  const f = fixture(),
    first = calculate(f);
  f.now += 10;
  f.asOf += 10;
  const next = calculate(f);
  expect(next.validUntil).toBe(first.validUntil);
  expect(next.executedAt).toBe(first.executedAt);
  expect(next.position).toEqual(first.position);
});
it('uses the original execution maximum for remaining liability even after a lower current mark', () => {
  const f = fixture();
  f.currentMarket.ticker.last.value = '1';
  expect(calculate(f)).toMatchObject({
    position: { notional: '0.25' },
    pending: { notional: '2.625' },
    collateral: { amount: '2.627625' },
    combinedNotional: '2.875',
  });
});
it('does not mutate inputs and returns deeply immutable calculation content', () => {
  const f = fixture(),
    before = canonical(f),
    r = calculate(f);
  expect(canonical(f)).toBe(before);
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.position)).toBe(true);
  expect(Object.isFrozen(r.pending)).toBe(true);
  expect(Object.isFrozen(r.collateral)).toBe(true);
});
it('repeated identical content and JSON roundtrip are deterministic calculation only', () => {
  const f = fixture();
  expect(calculate(f)).toEqual(calculate(JSON.parse(JSON.stringify(f))));
  expect(calculate(f)).toEqual(calculate(f));
});
it('does not issue inventory completeness, policy approval, reservation, permit or monetary events', () => {
  const r = calculate(fixture());
  expect(r.tenantInventoryComplete).toBe(false);
  for (const name of [
    'grant',
    'permit',
    'certificate',
    'approved',
    'postings',
    'events',
    'state',
    'dailyNetRealizedPnl',
    'adjustedOpeningEquity',
    'userExposure',
  ])
    expect(r).not.toHaveProperty(name);
});
it.each(['publication', 'ticker-received', 'ticker-exchange', 'book-received', 'book-exchange'])(
  'rejects stale original price clock %s even with fresh asOf',
  (clock) => {
    const f = fixture(),
      t = f.now - 5001;
    if (clock === 'publication') f.currentMarket.timestamp = t;
    if (clock === 'ticker-received') f.currentMarket.ticker.receivedAt = t;
    if (clock === 'ticker-exchange') f.currentMarket.ticker.exchangeTime = t;
    if (clock === 'book-received') f.currentMarket.book.receivedAt = t;
    if (clock === 'book-exchange') f.currentMarket.book.exchangeTime = t;
    expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
  },
);
it.each(['publication', 'ticker', 'book', 'capture', 'execution'])(
  'rejects future %s clocks',
  (clock) => {
    const f = fixture();
    if (clock === 'publication') f.currentMarket.timestamp = f.now + 1;
    if (clock === 'ticker') f.currentMarket.ticker.exchangeTime = f.now + 1;
    if (clock === 'book') f.currentMarket.book.receivedAt = f.now + 1;
    if (clock === 'capture') f.asOf = f.now + 1;
    if (clock === 'execution') f.executionInput.now = f.now + 1;
    expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
  },
);
it('rejects stale capture independently of fresh prices', () => {
  const f = fixture();
  f.asOf -= 5001;
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});
it('bounds validity by current rule expiry and rejects its exact boundary', () => {
  const f = fixture();
  f.currentMarket.record.rules.expiresAt = f.now + 9;
  expect(calculate(f).validUntil).toBe(f.now + 9);
  f.now += 9;
  f.asOf = f.now;
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});
it.each([
  'instrument',
  'database-instrument',
  'base',
  'quote',
  'scope',
  'metadata',
  'future-rules',
  'missing-price',
  'gap',
])('fails closed on current %s evidence', (kind) => {
  const f = fixture();
  if (kind === 'instrument') f.currentMarket.key.instrumentId = 'other';
  if (kind === 'database-instrument')
    f.currentMarket.key.dbInstrumentId = '77777777-7777-4777-8777-777777777777';
  if (kind === 'base') f.currentMarket.record.instrument.baseAsset = 'ETH';
  if (kind === 'quote') f.currentMarket.record.instrument.quoteAsset = 'OTHER';
  if (kind === 'scope')
    f.currentMarket.key.scope = { ...f.currentMarket.key.scope, environment: 'DEMO' };
  if (kind === 'metadata')
    Object.assign(f.currentMarket.record.rules, { unsupportedFilters: ['NEW_NATIVE_CONSTRAINT'] });
  if (kind === 'future-rules') f.currentMarket.record.rules.effectiveAt = f.now + 1;
  if (kind === 'missing-price')
    Object.assign(f.currentMarket.ticker.last, { state: 'UNAVAILABLE', value: null });
  if (kind === 'gap') Object.assign(f.currentMarket, { kind: 'GAP' });
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});
it.each(['unknown', 'nonpristine', 'command-hash', 'hold', 'watermark', 'wrong-mode'])(
  'rejects conflicting or unprovable historical %s content',
  (kind) => {
    const f = fixture();
    if (kind === 'unknown') f.executionInput.attempt.phase = 'UNKNOWN';
    if (kind === 'nonpristine')
      Object.assign(f.executionInput.attempt, { executedQuantity: '0.1' });
    if (kind === 'command-hash')
      f.executionInput.attempt.request.admission.commandHash = '0'.repeat(64);
    if (kind === 'hold') f.executionInput.portfolio.holds[0]!.amount = parseDecimal('0.01');
    if (kind === 'watermark') f.executionInput.reservation.watermarks[0]!.unknown = true;
    if (kind === 'wrong-mode') Object.assign(f.executionInput.portfolio.binding, { mode: 'LIVE' });
    expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
  },
);
it('rejects waiting content because no committed economic transition is represented', () => {
  const f = fixture();
  f.executionInput.frame.trade.quantity = parseDecimal('0.001');
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});
it('rejects unrelated holds rather than omitting unproven liabilities', () => {
  const f = fixture();
  f.executionInput.portfolio.holds.push({
    ...f.executionInput.portfolio.holds[0]!,
    id: 'unrelated',
    amount: parseDecimal('0.1'),
  });
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});
it('rejects caller-added completeness or financial authority fields', () => {
  const f = { ...fixture(), tenantInventoryComplete: true };
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});
it.each(['root', 'history', 'market'])('rejects %s accessors without evaluating them', (where) => {
  const f = fixture();
  let calls = 0;
  const target = where === 'root' ? f : where === 'history' ? f.executionInput : f.currentMarket;
  Object.defineProperty(target, 'hostile', {
    enumerable: true,
    get() {
      calls++;
      throw Error('private');
    },
  });
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
  expect(calls).toBe(0);
});
it('rejects cyclic and oversized collections before historical traversal', () => {
  const f = fixture();
  Object.assign(f, { self: f });
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
  const huge = fixture();
  huge.executionInput.portfolio.pending = new Array<string>(3201);
  expect(() => calculate(huge)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});
it('rejects sparse or custom prototype inputs', () => {
  const f = fixture();
  Reflect.deleteProperty(f.executionInput.reservation.watermarks, '0');
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
  expect(() => calculate(Object.create(fixture()))).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});

it('fails closed on unrepresentable product scale instead of rounding the position exposure', () => {
  const f = fixture();
  f.currentMarket.ticker.last.value = '12.050000000000000001';
  expect(() => calculate(f)).toThrow(/PAPER_EXECUTED_EXPOSURE_/u);
});
