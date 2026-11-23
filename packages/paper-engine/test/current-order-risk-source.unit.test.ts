import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { parseDecimal } from '@ctp/exchange-core';
import { canonical, reducePortfolio } from '@ctp/portfolio';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { currentOrderRiskFixture } from './current-order-risk-fixtures.js';
import { decodePaperCurrentRiskContents } from '../src/postgres-current-risk.js';
import {
  describeCurrentPaperCommitment,
  type PaperCurrentOrderRiskSource,
} from '../src/postgres-current-order-risk.js';
const fake = vi.hoisted<{
  queries: string[];
  requests: unknown[];
  safe: boolean;
  payload: unknown;
  cashProof: unknown;
  budgetProof: unknown;
  policyProof: unknown;
  operationalProof: unknown;
  orderProof: unknown;
  commitFailure: boolean;
}>(() => ({
  queries: [],
  requests: [],
  safe: true,
  payload: null,
  cashProof: null,
  budgetProof: null,
  policyProof: null,
  operationalProof: null,
  orderProof: null,
  commitFailure: false,
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    async query(text: string, values?: unknown[]) {
      await Promise.resolve();
      fake.queries.push(text);
      if (text.includes(' AS safe')) return { rows: [{ safe: fake.safe }] };
      if (text.includes(' AS result')) {
        fake.requests.push(JSON.parse(String(values?.[0])) as unknown);
        return {
          rows: [
            {
              result: fake.payload,
              cashProof: fake.cashProof,
              budgetProof: fake.budgetProof,
              policyProof: fake.policyProof,
              operationalProof: fake.operationalProof,
              orderProof: fake.orderProof,
            },
          ],
        };
      }
      if (text === 'COMMIT' && fake.commitFailure) throw Error('private lost COMMIT');
      return { rows: [] };
    }
  },
}));
interface Port {
  capture(r: unknown, context: ReturnType<typeof io>): Promise<PaperCurrentOrderRiskSource>;
  readCurrent(r: unknown, context: ReturnType<typeof io>): Promise<PaperCurrentOrderRiskSource>;
  advanceLoss(r: unknown, context: ReturnType<typeof io>): Promise<unknown>;
  close(): Promise<void>;
}
const ports: Port[] = [];
const evaluatedBudget = {
  notional: '2.1',
  currentExposure: '6.025',
  projectedExposure: '8.125',
  openOrders: 0,
  potentialPositions: 1,
  ordersInLastMinute: 2,
  withinLimits: true,
};
const evaluatedPolicy = { liquidity: '4975', marketAllowed: true, lossAllowed: true };
const readyOperation = { runtimeReady: true, tradingReady: true };
const options = {
  connectionString: 'postgresql://paper_current:unit-password@127.0.0.1/current_order_risk',
  environment: 'test',
};
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
function factory() {
  const fn = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperCurrentOrderRiskSource'
  ];
  if (typeof fn !== 'function') throw Error('PAPER_CURRENT_ORDER_RISK_SOURCE_MISSING');
  return fn as (o: unknown) => Promise<Port>;
}
async function open() {
  const p = await factory()(options);
  ports.push(p);
  fake.queries = [];
  fake.requests = [];
  return p;
}
beforeEach(() => {
  Object.assign(fake, {
    queries: [],
    requests: [],
    safe: true,
    payload: null,
    cashProof: {
      asset: 'USDT',
      amount: '2.1021',
      available: '999994.969975',
      remaining: '999992.867875',
    },
    budgetProof: evaluatedBudget,
    policyProof: evaluatedPolicy,
    operationalProof: readyOperation,
    orderProof: { rulesAllowed: true, capabilityReady: true },
    commitFailure: false,
  });
});
afterEach(async () => {
  for (const p of ports.splice(0)) await p.close();
  vi.restoreAllMocks();
});
it('requires a separate fixed server source before accepting durable target content', () => {
  expect(
    (server as unknown as Record<string, unknown>)['createPostgresPaperCurrentOrderRiskSource'],
  ).toBeTypeOf('function');
});
it('retains the original complete certificate decoder for the new server fixture', () => {
  const f = currentOrderRiskFixture();
  expect(
    decodePaperCurrentRiskContents(f.reply().certificate, f.sourceRequest, f.now).snapshot
      .ordersInLastMinute,
  ).toBe(2);
});
it('evaluates the stored target once in the actual minute count without changing unpersisted pure semantics', async () => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const port = await open();
  fake.payload = f.reply();
  expect(
    pure.calculatePaperCurrentRiskEvaluation({
      now: f.now,
      sourceRequest: f.sourceRequest,
      certificate: f.reply().certificate,
      target: {
        owner: f.target.owner,
        orderId: f.target.orderId,
        intentId: f.target.intentId,
        dbInstrumentId: f.target.dbInstrumentId,
        dbRuleId: f.target.dbRuleId,
        command: f.target.command,
      },
    }).result.kind,
  ).toBe('REJECTED');
  const value = await port.capture(f.request, io());
  expect(value).toMatchObject({
    kind: 'PAPER_CURRENT_ORDER_RISK_SOURCE',
    target: { orderId: f.target.orderId, intentId: f.target.intentId, commandHash: f.commandHash },
    evaluation: {
      result: {
        kind: 'EVALUATED',
        notional: '2.1',
        budget: { current: { instrument: '6.025' }, projected: { instrument: '8.125' } },
      },
    },
  });
  expect(value).not.toHaveProperty('grant');
  expect(value).not.toHaveProperty('reservationId');
  expect(value).not.toHaveProperty('permit');
  expect(Object.isFrozen(value)).toBe(true);
  expect(fake.queries.filter((q) => q === 'COMMIT')).toHaveLength(1);
  expect(fake.requests[0]).toEqual(f.request);
});
it('reconciles after close/restart without renewing evidence or inventing a monetary effect', async () => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  const first = await open();
  const value = await first.capture(f.request, io());
  await first.close();
  const next = await open();
  expect(await next.readCurrent(f.request, io())).toEqual(value);
  expect(fake.requests[0]).toMatchObject({ kind: 'PAPER_CURRENT_ORDER_RISK_READ' });
  expect(fake.queries.filter((q) => q.includes(' AS result'))).toHaveLength(1);
});
it.each([
  ['missing', null, 'capture'],
  ['stale rules', { rulesAllowed: false, capabilityReady: true }, 'capture'],
  ['capability declined', { rulesAllowed: true, capabilityReady: false }, 'capture'],
  ['malformed flag on restart', { rulesAllowed: true, capabilityReady: 'true' }, 'readCurrent'],
] as const)('rolls back when the independent order proof is %s', async (_name, proof, op) => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  const port = await open();
  fake.orderProof = proof;
  await expect(port[op](f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(fake.queries).toContain('ROLLBACK');
  expect(fake.queries).not.toContain('COMMIT');
});
it('binds a single commitment to the certified book without posting a second monetary event', async () => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  const source = await (await open()).capture(f.request, io());
  const book = source.certificate.inventory.accounts.find(
    (a) => a.accountId === f.target.owner.accountId,
  )!;
  const before = book.state;
  const basis = source.commitmentBasis;
  expect(basis).toEqual({
    kind: 'PAPER_CURRENT_ORDER_COMMITMENT_BASIS',
    target: f.request.target,
    book: {
      id: book.bookId,
      revision: book.revision,
      stateHash: createHash('sha256').update(canonical(before)).digest('hex'),
    },
    certificate: {
      id: source.certificate.id,
      hash: source.certificate.hash,
      validUntil: source.evaluation.validUntil,
    },
    hold: { asset: 'USDT', amount: '2.1021', status: 'RESERVED', reflected: false },
    spendable: { before: '999994.969975', after: '999992.867875' },
  });
  expect(before.holds).toEqual([]);
  expect(before.pending).toHaveLength(1);
  const hold = { id: randomUUID(), ...basis!.hold };
  const result = reducePortfolio(
    before,
    { id: randomUUID(), type: 'COMMITMENT', timestamp: f.now, hold },
    { now: () => f.now, holdWatermark: null },
  );
  expect(result.ignored).toBeUndefined();
  expect(result.holdWatermark).toMatchObject({ timestamp: f.now, released: false, unknown: false });
  expect(result.postings).toEqual([]);
  expect(result.state).toEqual({ ...before, holds: [hold] });
  expect(Object.isFrozen(basis!.hold)).toBe(true);
});
it('subtracts a retained quote hold once and rejects stale or conflicting Risk amounts', async () => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  const { certificate, evaluation } = await (await open()).capture(f.request, io());
  if (evaluation.result.kind !== 'EVALUATED') throw Error('EXPECTED_RISK_EVALUATION');
  const book = certificate.inventory.accounts.find(
    (a) => a.accountId === f.target.owner.accountId,
  )!;
  // This content check assumes a prior hold. The server reader still validates the actual database graph.
  const hold = {
    id: randomUUID(),
    asset: 'USDT',
    amount: parseDecimal('2.627625'),
    status: 'RESERVED' as const,
    reflected: false,
  };
  const retained = { ...book, state: { ...book.state, holds: [hold] } };
  expect(() =>
    describeCurrentPaperCommitment(f.request.target, retained, certificate, evaluation),
  ).toThrow('PAPER_CURRENT_ORDER_RISK_EVIDENCE');
  const available = parseDecimal('999992.34235');
  const remaining = parseDecimal('999990.24025');
  const updatedCertificate = {
    ...certificate,
    snapshot: { ...certificate.snapshot, availableAmount: available },
  };
  const updatedEvaluation = {
    ...evaluation,
    result: {
      ...evaluation.result,
      debits: [{ ...evaluation.result.debits[0]!, available, remaining }],
    },
  };
  expect(
    describeCurrentPaperCommitment(
      f.request.target,
      retained,
      updatedCertificate,
      updatedEvaluation,
    ),
  ).toMatchObject({ spendable: { before: available, after: remaining } });
  const unknown = {
    ...retained,
    state: { ...retained.state, holds: [{ ...hold, status: 'UNKNOWN' as const }] },
  };
  expect(() =>
    describeCurrentPaperCommitment(
      f.request.target,
      unknown,
      updatedCertificate,
      updatedEvaluation,
    ),
  ).toThrow('PAPER_CURRENT_ORDER_RISK_EVIDENCE');
});
it('rejects an uncertain COMMIT without returning its calculated result', async () => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  const port = await open();
  fake.commitFailure = true;
  await expect(port.capture(f.request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.queries.filter((q) => q.includes(' AS result'))).toHaveLength(1);
});
it.each([
  null,
  { asset: 'USDC' },
  { amount: '2.1' },
  { available: '1000000' },
  { remaining: '999992.867874999999999999' },
  { amount: 2.1021 },
])('rejects missing or conflicting PostgreSQL cash proof %j before COMMIT', async (change) => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  fake.cashProof = change === null ? null : { ...(fake.cashProof as object), ...change };
  const port = await open();
  await expect(port.capture(f.request, io())).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries).not.toContain('COMMIT');
});
it.each([
  null,
  { notional: '2.1021' },
  { currentExposure: '0' },
  { projectedExposure: '8.124999999999999999' },
  { openOrders: 1 },
  { potentialPositions: 2 },
  { ordersInLastMinute: 3 },
  { withinLimits: false },
])('rejects missing or conflicting PostgreSQL budget proof %j before COMMIT', async (change) => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  fake.budgetProof = change === null ? null : { ...evaluatedBudget, ...change };
  const port = await open();
  await expect(port.capture(f.request, io())).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries).toContain('ROLLBACK');
  expect(fake.queries).not.toContain('COMMIT');
});
it.each([
  null,
  { liquidity: '4974.999999999999999999' },
  { liquidity: 4975 },
  { marketAllowed: false },
  { lossAllowed: false },
  { lossAllowed: null },
])(
  'rejects missing or conflicting PostgreSQL market and loss proof %j before COMMIT',
  async (change) => {
    const f = currentOrderRiskFixture();
    vi.spyOn(Date, 'now').mockReturnValue(f.now);
    fake.payload = f.reply();
    fake.policyProof = change === null ? null : { ...evaluatedPolicy, ...change };
    const port = await open();
    await expect(port.capture(f.request, io())).rejects.toThrow(/^PAPER_/u);
    expect(fake.queries).toContain('ROLLBACK');
    expect(fake.queries).not.toContain('COMMIT');
  },
);
it.each([
  null,
  { runtimeReady: false },
  { tradingReady: false },
  { runtimeReady: 'true' },
  { tradingReady: null },
])(
  'rejects missing or conflicting PostgreSQL operational proof %j before COMMIT',
  async (change) => {
    const f = currentOrderRiskFixture();
    vi.spyOn(Date, 'now').mockReturnValue(f.now);
    fake.payload = f.reply();
    fake.operationalProof = change === null ? null : { ...readyOperation, ...change };
    const port = await open();
    await expect(port.capture(f.request, io())).rejects.toThrow(/^PAPER_/u);
    expect(fake.queries).toContain('ROLLBACK');
    expect(fake.queries).not.toContain('COMMIT');
  },
);
it.each(['MISSING', 'REPLACED', 'INCOMPLETE'])('fails closed on %s source state', async (kind) => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const port = await open();
  fake.payload = { kind };
  await expect(port.capture(f.request, io())).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries).not.toContain('COMMIT');
});
it.each(['orderId', 'intentId', 'commandHash'] as const)(
  'rejects a substituted server target %s before COMMIT',
  async (field) => {
    const f = currentOrderRiskFixture();
    vi.spyOn(Date, 'now').mockReturnValue(f.now);
    const packet = f.reply();
    packet.target[field] = field === 'commandHash' ? '0'.repeat(64) : randomUUID();
    fake.payload = packet;
    const port = await open();
    await expect(port.capture(f.request, io())).rejects.toThrow(/^PAPER_/u);
    expect(fake.queries).not.toContain('COMMIT');
  },
);
it.each(['capture', 'readCurrent', 'advanceLoss'] as const)(
  '%s rejects caller evidence and command overrides before SQL',
  async (method) => {
    const f = currentOrderRiskFixture();
    const port = await open();
    await expect(
      port[method](
        { ...f.request, certificate: { complete: true }, command: f.target.command },
        io(),
      ),
    ).rejects.toThrow(/^PAPER_/u);
    expect(fake.queries).toEqual([]);
  },
);
it.each(['capture', 'readCurrent', 'advanceLoss'] as const)(
  '%s observes pre-abort and deadline',
  async (method) => {
    const f = currentOrderRiskFixture();
    const port = await open(),
      c = new AbortController();
    c.abort();
    await expect(port[method](f.request, { ...io(), signal: c.signal })).rejects.toThrow(
      /^PAPER_/u,
    );
    await expect(port[method](f.request, { ...io(), deadline: Date.now() - 1 })).rejects.toThrow(
      /^PAPER_/u,
    );
    expect(fake.queries).toEqual([]);
  },
);
it.each([
  { backend: () => ({}) },
  { role: 'postgres' },
  { clock: () => 1 },
  { tenantId: 'caller' },
  { client: {} },
  { credentials: 'caller-secret' },
])('rejects injected acquisition options %j before connect', async (extra) => {
  await expect(factory()({ ...options, ...extra })).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries).toEqual([]);
});
it('rejects a runtime with excess SQL authority', async () => {
  fake.safe = false;
  await expect(factory()(options)).rejects.toThrow('PAPER_ADMISSION_ROLE_UNSAFE');
});
it('keeps the coordinator and stored-target arithmetic absent from the pure namespace', () => {
  expect(
    (server as unknown as Record<string, unknown>)['createPostgresPaperCurrentOrderRiskSource'],
  ).toBeTypeOf('function');
  expect(pure).not.toHaveProperty('createPostgresPaperCurrentOrderRiskSource');
  expect(pure).not.toHaveProperty('calculatePaperStoredOrderRiskEvaluation');
  expect(server).not.toHaveProperty('calculatePaperStoredOrderRiskEvaluation');
  expect(pure).not.toHaveProperty('describeCurrentPaperCommitment');
  expect(server).not.toHaveProperty('describeCurrentPaperCommitment');
});
it.each([
  [
    'owner',
    (f: ReturnType<typeof currentOrderRiskFixture>) => {
      f.target.owner.accountId = randomUUID();
    },
  ],
  [
    'instrument',
    (f: ReturnType<typeof currentOrderRiskFixture>) => {
      f.target.dbInstrumentId = randomUUID();
    },
  ],
  [
    'rule',
    (f: ReturnType<typeof currentOrderRiskFixture>) => {
      f.target.dbRuleId = randomUUID();
    },
  ],
  [
    'future creation',
    (f: ReturnType<typeof currentOrderRiskFixture>) => {
      f.target.createdAt = f.now + 1;
    },
  ],
  [
    'command',
    (f: ReturnType<typeof currentOrderRiskFixture>) => {
      f.target.command.clientOrderId = '3';
    },
  ],
] as const)('rejects substituted %s content before COMMIT', async (_label, mutate) => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  mutate(f);
  fake.payload = f.reply();
  const port = await open();
  await expect(port.capture(f.request, io())).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries).not.toContain('COMMIT');
});
it.each([
  [60000, 'EVALUATED'],
  [60001, 'REJECTED'],
] as const)(
  'counts a stored target aged %i ms only if present in the captured minute bucket',
  async (age, kind) => {
    const f = currentOrderRiskFixture();
    vi.spyOn(Date, 'now').mockReturnValue(f.now);
    f.target.createdAt = f.now - age;
    fake.payload = f.reply();
    const port = await open();
    const value = await port.capture(f.request, io());
    expect(value.evaluation.result.kind).toBe(kind);
    if (kind === 'REJECTED') expect(value.commitmentBasis).toBeNull();
  },
);
it('does not execute getters while checking a caller selector', async () => {
  const f = currentOrderRiskFixture(),
    port = await open();
  let reads = 0;
  const raw = { ...f.request };
  Object.defineProperty(raw, 'target', {
    enumerable: true,
    get() {
      reads++;
      return f.request.target;
    },
  });
  await expect(port.capture(raw, io())).rejects.toThrow('PAPER_CURRENT_ORDER_RISK_INPUT');
  expect(reads).toBe(0);
  expect(fake.queries).toEqual([]);
});
it('validates an explicit bounded loss-advance reply without manufacturing a certificate or grant', async () => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  const p = f.reply();
  fake.payload = {
    kind: 'ADVANCED',
    request: f.request,
    capturedAt: f.now,
    target: p.target,
    source: f.source,
  };
  const port = await open();
  expect(await port.advanceLoss(f.request, io())).toMatchObject({
    kind: 'PAPER_CURRENT_LOSS_PROGRESS',
    complete: true,
  });
  expect(fake.requests[0]).toMatchObject({ kind: 'PAPER_CURRENT_ORDER_RISK_ADVANCE' });
  expect(fake.queries.filter((q) => q.includes(' AS result'))).toHaveLength(1);
});
it('does not accept a certificate as a completed loss-advance operation', async () => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  const port = await open();
  await expect(port.advanceLoss(f.request, io())).rejects.toThrow(/^PAPER_/u);
  expect(fake.queries).not.toContain('COMMIT');
});
