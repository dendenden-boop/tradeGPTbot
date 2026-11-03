import { beforeEach, expect, it } from 'vitest';
import { canonical } from '@ctp/portfolio';
import { parseDecimal } from '@ctp/exchange-core';
import * as paper from '../src/index.js';
import { wireNow } from './admission-wire-fixtures.js';
import { executionStartFixture } from './execution-start-fixtures.js';
import { startedExecutionFixture } from './started-execution-fixtures.js';

interface Result {
  kind: 'PAPER_STARTED_EXECUTION_PORTFOLIO_CALCULATION';
  version: 'paper-pristine-started-portfolio-v1';
  attemptId: string;
  startEventId: string;
  startedAt: number;
  calculation: paper.PaperExecutionPortfolioCalculation;
}
function entry() {
  const fn = (paper as unknown as Record<string, unknown>)[
    'calculatePaperStartedExecutionPortfolio'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_STARTED_EXECUTION_MISSING');
  return fn as (raw: unknown) => Result;
}
beforeEach(() => {
  entry();
});
const calculate = (raw: unknown) => entry()(raw);

it('uses START rather than the earlier PREPARE time for latency and evidence eligibility', () => {
  const x = startedExecutionFixture(wireNow + 99);
  expect(x.attempt.request.preparedAt).toBe(wireNow - 1);
  expect(x.attempt.startedAt).toBe(wireNow);
  const r = calculate(x);
  expect(r.calculation.fills).toEqual([]);
  expect(r.calculation.ledger.execution.executions[0]!.eligibleAfter).toBe(wireNow + 100);
  const premature = paper.calculatePaperExecutionPortfolio({
    portfolio: x.portfolio,
    competition: {
      now: x.now,
      frame: x.frame,
      orders: [
        {
          ...paper.projectPristinePaperExecutionAttempt({ state: x.attempt, now: x.now }),
          submittedAt: wireNow - 1,
        },
      ],
    },
  });
  expect(premature.fills.length).toBeGreaterThan(0);
});
it.each(['bookReceived', 'bookNative', 'tradeReceived', 'tradeNative'])(
  'waits when %s evidence precedes START plus latency',
  (field) => {
    const x = startedExecutionFixture();
    if (field === 'bookReceived') x.frame.book.receivedAt--;
    if (field === 'bookNative') x.frame.book.exchangeTime = wireNow + 99;
    if (field === 'tradeReceived') x.frame.trade.receivedAt--;
    if (field === 'tradeNative') x.frame.trade.exchangeTime--;
    expect(calculate(x).calculation.fills).toEqual([]);
  },
);
it('derives the immutable original command and exact partial-fill accounting at eligibility', () => {
  const x = startedExecutionFixture(),
    r = calculate(x);
  expect(r).toMatchObject({
    kind: 'PAPER_STARTED_EXECUTION_PORTFOLIO_CALCULATION',
    version: 'paper-pristine-started-portfolio-v1',
    attemptId: x.attempt.request.attemptId,
    startEventId: x.attempt.lastEvent.id,
    startedAt: wireNow,
  });
  expect(r.calculation).toEqual(
    paper.calculatePaperExecutionPortfolio({
      portfolio: x.portfolio,
      competition: {
        now: x.now,
        frame: x.frame,
        orders: [paper.projectPristinePaperExecutionAttempt({ state: x.attempt, now: x.now })],
      },
    }),
  );
  expect(r.calculation.fills[0]!.event).toMatchObject({
    internalOrderId: x.attempt.request.admission.orderId,
    quantity: '0.5',
    price: '10.05',
    fees: [{ amount: '0.005025' }],
  });
  expect(r.calculation.state.holds).toEqual(x.portfolio.holds);
});
it('returns deterministic frozen calculation content while leaving START, frame and holds unchanged', () => {
  const x = startedExecutionFixture(),
    before = canonical(x),
    r = calculate(x);
  expect(calculate(structuredClone(x))).toEqual(r);
  expect(canonical(x)).toBe(before);
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.calculation.state)).toBe(true);
  expect('permit' in r || 'grant' in r || 'committed' in r).toBe(false);
});
it.each(['tenantId', 'accountId', 'externalAccountId', 'scope'])(
  'rejects a different Portfolio %s instead of calculating against another account',
  (field) => {
    const x = startedExecutionFixture();
    if (field === 'scope')
      x.portfolio.binding.scope = { ...x.portfolio.binding.scope, environment: 'DEMO' };
    else if (field === 'externalAccountId')
      x.portfolio.binding.externalAccountId = 'another-paper-account';
    else if (field === 'tenantId')
      x.portfolio.binding.tenantId = '99999999-9999-4999-8999-999999999999';
    else x.portfolio.binding.accountId = '99999999-9999-4999-8999-999999999999';
    expect(() => calculate(x)).toThrow();
  },
);
it.each(['PREPARED', 'NOT_SENT', 'UNKNOWN'])(
  'does not project %s into a first execution',
  (phase) => {
    const x = startedExecutionFixture(),
      f = executionStartFixture();
    if (phase === 'PREPARED') x.attempt = structuredClone(f.preparation);
    else if (phase === 'UNKNOWN') x.attempt = structuredClone(f.unknown);
    else
      x.attempt = structuredClone(
        paper.reducePaperExecutionAttempt({
          state: f.preparation,
          event: {
            id: '88888888-8888-4888-8888-888888888888',
            kind: 'NOT_SENT',
            expectedRevision: '1',
            at: wireNow,
            reason: 'CONTROL',
          },
        }).state,
      );
    expect(() => calculate(x)).toThrow();
  },
);
it('rejects a future START instead of backdating it', () => {
  const x = startedExecutionFixture();
  x.now = wireNow - 1;
  expect(() => calculate(x)).toThrow();
});
it.each(['requestHash', 'startedAt', 'eventTime'])(
  'rejects contradictory START %s content',
  (field) => {
    const x = startedExecutionFixture();
    if (field === 'requestHash') x.attempt.requestHash = '0'.repeat(64);
    else if (field === 'startedAt') x.attempt.startedAt = wireNow - 1;
    else x.attempt.lastEvent.at = wireNow - 1;
    expect(() => calculate(x)).toThrow();
  },
);
it.each(['submittedAt', 'executedQuantity', 'triggeredAt', 'orders', 'order', 'permit'])(
  'rejects caller %s overrides',
  (field) => expect(() => calculate({ ...startedExecutionFixture(), [field]: '0' })).toThrow(),
);
it('rejects the post-fill Portfolio rather than resetting an executed attempt to zero fills', () => {
  const x = startedExecutionFixture(),
    r = calculate(x);
  expect(() => calculate({ ...x, portfolio: r.calculation.state })).toThrow();
});
it('rejects retained UNKNOWN collateral', () => {
  const x = startedExecutionFixture();
  x.portfolio.holds[0]!.status = 'UNKNOWN';
  expect(() => calculate(x)).toThrow();
});
it('rejects economic history even when positions and pending projections are empty', () => {
  const x = startedExecutionFixture();
  x.portfolio.lastEconomicAt = wireNow;
  expect(() => calculate(x)).toThrow();
});
it('preserves the remaining shared frame budget instead of replacing it with a fresh frame', () => {
  const x = startedExecutionFixture();
  x.frame.volumeUsed = parseDecimal('0.4');
  x.frame.asksUsed[0] = parseDecimal('0.4');
  expect(calculate(x).calculation.fills[0]!.event.quantity).toBe('0.1');
});
it('does not rewrite a known historical START when its original admission expires', () => {
  const x = startedExecutionFixture(wireNow + 1000);
  expect(x.now).toBeGreaterThan(x.attempt.request.admission.expiresAt);
  const r = calculate(x);
  expect(r.startedAt).toBe(wireNow);
  expect(r.calculation.fills).toHaveLength(1);
  expect('grant' in r || 'permit' in r).toBe(false);
});
it('rejects oversized collections before schema traversal', () => {
  const x = startedExecutionFixture();
  const levels = new Array(1001).fill(x.frame.book.asks[0]);
  expect(() =>
    calculate({ ...x, frame: { ...x.frame, book: { ...x.frame.book, asks: levels } } }),
  ).toThrow();
});
it('does not execute accessor properties in untrusted calculation content', () => {
  const x = startedExecutionFixture();
  let visited = false;
  Object.defineProperty(x, 'attempt', {
    enumerable: true,
    get() {
      visited = true;
      throw Error('ACCESSOR');
    },
  });
  expect(() => calculate(x)).toThrow();
  expect(visited).toBe(false);
});
