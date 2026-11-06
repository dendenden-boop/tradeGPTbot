import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { canonical } from '@ctp/portfolio';
import { parseDecimal } from '@ctp/exchange-core';
import { calculatePaperStartedTransition } from '@ctp/paper-engine';
import {
  admissionWire,
  wireHash,
  wireNow,
} from '../../paper-engine/test/admission-wire-fixtures.js';
import { startedExecutionFixture } from '../../paper-engine/test/started-execution-fixtures.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw Error('ISOLATED_EXECUTION_EFFECTS_RUNNER_REQUIRED');
const migrationUrl = process.env['DATABASE_MIGRATION_URL'];
if (!migrationUrl) throw Error('EXECUTION_EFFECTS_MIGRATION_URL_REQUIRED');
const admin = new Pool({ connectionString: migrationUrl, max: 2, query_timeout: 5000 });
afterAll(async () => {
  await admin.end();
});
function input() {
  const x = startedExecutionFixture(),
    a = x.attempt.request.admission;
  const { model, record, book, trade } = admissionWire(a.admittedAt).packet.budget;
  const hold = x.portfolio.holds[0]!;
  return {
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
          timestamp: wireNow,
          fingerprint: wireHash({ type: 'COMMITMENT', hold }),
          released: false,
          unknown: false,
        },
      ],
    },
  };
}
function expected(x: ReturnType<typeof input>) {
  const r = calculatePaperStartedTransition(x),
    e = r.execution.calculation.ledger.execution.executions[0]!;
  return {
    execution: {
      status: e.status,
      reason: e.reason,
      eligibleAfter: e.eligibleAfter,
      triggeredAt: e.triggeredAt,
      quantity: e.quantity,
      fills: e.fills,
      frame: r.execution.calculation.ledger.execution.frame,
    },
    order: r.order,
    reservation: r.reservation,
    fills: r.execution.calculation.fills,
    holdChanges: r.holdChanges,
    state: r.state,
  };
}
async function derive(raw: unknown) {
  const result = await admin.query<{ result: unknown }>(
    'SELECT ctp_paper.derive_pristine_effects($1::jsonb) AS result',
    [canonical(raw)],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.result;
}
function rebind(x: ReturnType<typeof input>) {
  const a = x.attempt.request.admission;
  a.commandHash = wireHash({ operation: 'createOrder', command: a.command, binding: a.binding });
  x.attempt.requestHash = wireHash(x.attempt.request);
}
it.each(['GTC', 'IOC', 'FOK'] as const)(
  'paper-execution-effects: independently derives %s partial/terminal accounting and hold progress',
  async (timeInForce) => {
    const x = input();
    x.attempt.request.admission.command.timeInForce = timeInForce;
    rebind(x);
    x.frame.trade.quantity = parseDecimal('0.5');
    expect(await derive(x)).toEqual(expected(x));
  },
);
it('paper-execution-effects: full fill posts economics once and releases only unspent collateral', async () => {
  const x = input(),
    e = expected(x);
  expect(e.order.status).toBe('FILLED');
  expect(e.state.holds).toEqual([]);
  expect(await derive(x)).toEqual(e);
});
it('paper-execution-effects: WAITING preserves book, reservation revision and complete hold', async () => {
  const x = input();
  x.now = wireNow + 99;
  x.frame.book.receivedAt = x.frame.book.exchangeTime = x.now;
  x.frame.trade.receivedAt = x.frame.trade.exchangeTime = x.now;
  const e = expected(x);
  expect(e.holdChanges).toEqual([]);
  expect(e.state).toEqual(x.portfolio);
  expect(await derive(x)).toEqual(e);
});
it('paper-execution-effects: preserves unrelated collateral and assets', async () => {
  const x = input();
  x.portfolio.holds.push({
    ...x.portfolio.holds[0]!,
    id: 'another-hold',
    amount: parseDecimal('1'),
  });
  expect(await derive(x)).toEqual(expected(x));
});
it.each([
  'requestHash',
  'commandHash',
  'reservation',
  'hold',
  'watermark',
  'original',
  'expired',
  'UNKNOWN',
  'progressed',
])('paper-execution-effects: rejects forged or conflicting %s content', async (field) => {
  const x = input();
  if (field === 'requestHash') x.attempt.requestHash = '0'.repeat(64);
  else if (field === 'commandHash') {
    x.attempt.request.admission.commandHash = '0'.repeat(64);
    x.attempt.requestHash = wireHash(x.attempt.request);
  } else if (field === 'reservation') x.reservation.id = '99999999-9999-4999-8999-999999999999';
  else if (field === 'hold') x.portfolio.holds[0]!.amount = parseDecimal('1');
  else if (field === 'watermark') x.reservation.watermarks[0]!.fingerprint = '0'.repeat(64);
  else if (field === 'original') x.original.model.seed = '123';
  else if (field === 'expired') x.now = x.attempt.request.admission.expiresAt;
  else if (field === 'UNKNOWN') x.portfolio.holds[0]!.status = 'UNKNOWN';
  else x.portfolio = structuredClone(expected(x).state);
  expect(() => expected(x)).toThrow();
  await expect(derive(x)).rejects.toThrow('PAPER_EXECUTION_');
});
