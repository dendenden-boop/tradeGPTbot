import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { canonical } from '@ctp/portfolio';
import { parseDecimal } from '@ctp/exchange-core';
import { evaluatePaperOrder, preparePaperFrame } from '@ctp/paper-engine';
import { fixture } from '../../paper-engine/test/fixtures.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw Error('ISOLATED_EXECUTION_MATH_RUNNER_REQUIRED');
const admin = new Pool({
  connectionString: process.env['DATABASE_MIGRATION_URL'],
  max: 2,
  query_timeout: 5000,
});
afterAll(async () => {
  await admin.end();
});
function input() {
  const { execution, ...market } = fixture();
  return { ...execution, frame: structuredClone(preparePaperFrame(market)) };
}
async function derive(raw: unknown) {
  const result = await admin.query<{ result: unknown }>(
    'SELECT ctp_paper.derive_pristine_buy($1::jsonb) AS result',
    [canonical(raw)],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.result;
}
it.each(['0', '-9223372036854775808', '9223372036854775807', '9007199254740993'])(
  'paper-execution-math: derives exact seeded BUY fees/slippage/fill identity for seed %s',
  async (seed) => {
    const x = input();
    x.frame.model.seed = seed;
    x.frame.model.maxSlippageRate = '0.01';
    expect(await derive(x)).toEqual(evaluatePaperOrder(x));
  },
);
it('paper-execution-math: derives actual partial execution and consumed frame', async () => {
  const x = input();
  x.frame.trade.quantity = parseDecimal('0.5');
  const expected = evaluatePaperOrder(x);
  expect(expected.status).toBe('PARTIALLY_FILLED');
  expect(await derive(x)).toEqual(expected);
});
it.each(['IOC', 'FOK'] as const)(
  'paper-execution-math: derives definitive %s expiration with exact original frame semantics',
  async (timeInForce) => {
    const x = input();
    x.order.timeInForce = timeInForce;
    x.frame.trade.quantity = parseDecimal('0.5');
    const expected = evaluatePaperOrder(x);
    expect(expected.status).toBe('EXPIRED');
    expect(await derive(x)).toEqual(expected);
  },
);
it('paper-execution-math: derives MARKET remainder without a synthetic limit or retry', async () => {
  const x = input();
  x.order.type = 'MARKET';
  x.order.limitPrice = null;
  x.order.timeInForce = null;
  x.frame.trade.quantity = parseDecimal('0.5');
  expect(await derive(x)).toEqual(evaluatePaperOrder(x));
});
it('paper-execution-math: derives WAITING before latency without allocating liquidity', async () => {
  const x = input();
  x.submittedAt = x.now - 99;
  const expected = evaluatePaperOrder(x);
  expect(expected.reason).toBe('LATENCY');
  expect(await derive(x)).toEqual(expected);
});
it('paper-execution-math: counts fee atoms exactly without floating point', async () => {
  const x = input();
  x.frame.model.takerFeeRate = '0.000000000000000001';
  const expected = evaluatePaperOrder(x);
  expect(expected.fills[0]!.quoteFee).toBe('0.000000000000000006');
  expect(await derive(x)).toEqual(expected);
});
it.each(['SELL', 'STOP_MARKET', 'reflected-history', 'executed-history', 'triggered-history'])(
  'paper-execution-math: rejects unsupported pristine scope %s',
  async (field) => {
    const x = input();
    if (field === 'SELL') x.order.side = 'SELL';
    else if (field === 'STOP_MARKET') {
      x.order.type = 'STOP_MARKET';
      x.order.limitPrice = null;
      x.order.timeInForce = null;
      x.order.trigger = { price: parseDecimal('10'), source: 'LAST' };
    } else if (field === 'executed-history') x.executedQuantity = '0.1';
    else if (field === 'triggered-history') x.triggeredAt = x.submittedAt;
    else {
      x.frame.volumeUsed = parseDecimal('0.1');
      x.frame.asksUsed[0] = parseDecimal('0.1');
    }
    await expect(derive(x)).rejects.toThrow('PAPER_EXECUTION_MATH_');
  },
);
it.each([
  'crossed',
  'stale',
  'old-rules',
  'wrong-scope',
  'unknown-rule-field',
  'unknown-model-field',
  'extra-input',
])(
  'paper-execution-math: rejects %s instead of trusting caller-shaped execution input',
  async (field) => {
    const x = input();
    if (field === 'crossed') x.frame.book.bids[0]!.price = x.frame.book.asks[0]!.price;
    else if (field === 'stale')
      x.frame.book.receivedAt = x.now - x.frame.model.maxEvidenceAgeMs - 1;
    else if (field === 'old-rules') x.frame.record.rules.expiresAt = x.now;
    else if (field === 'wrong-scope')
      x.frame.trade.scope = { ...x.frame.trade.scope, environment: 'DEMO' };
    else if (field === 'unknown-rule-field')
      Object.assign(x.frame.record.rules, { futureConstraint: '1' });
    else if (field === 'unknown-model-field')
      Object.assign(x.frame.model, { futureConstraint: '1' });
    else Object.assign(x, { approved: true });
    await expect(derive(x)).rejects.toThrow('PAPER_EXECUTION_MATH_');
  },
);
it('paper-execution-math: private immutable helper grants no runtime role or monetary permission', async () => {
  const result = await admin.query<{
    immutable: boolean;
    definer: boolean;
    runtime: boolean;
    public: boolean;
  }>(`SELECT p.provolatile='i' immutable,p.prosecdef definer,
    has_function_privilege('ctp_paper_risk_admission',p.oid,'EXECUTE') runtime,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public
    FROM pg_proc p WHERE p.oid='ctp_paper.derive_pristine_buy(jsonb)'::regprocedure`);
  expect(result.rows).toEqual([{ immutable: true, definer: false, runtime: false, public: false }]);
});
