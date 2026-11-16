import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
import { currentOrderRiskFixture } from './current-order-risk-fixtures.js';
import { decodePaperCurrentRiskContents } from '../src/postgres-current-risk.js';
const fake = vi.hoisted<{
  queries: string[];
  requests: unknown[];
  safe: boolean;
  payload: unknown;
  commitFailure: boolean;
}>(() => ({
  queries: [],
  requests: [],
  safe: true,
  payload: null,
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
        return { rows: [{ result: fake.payload }] };
      }
      if (text === 'COMMIT' && fake.commitFailure) throw Error('private lost COMMIT');
      return { rows: [] };
    }
  },
}));
interface Source {
  kind: string;
  target: unknown;
  certificate: { id: string; expiresAt: number };
  evaluation: { result: { kind: string; notional?: string; reasons?: string[] } };
}
interface Port {
  capture(r: unknown, context: ReturnType<typeof io>): Promise<Source>;
  readCurrent(r: unknown, context: ReturnType<typeof io>): Promise<Source>;
  advanceLoss(r: unknown, context: ReturnType<typeof io>): Promise<unknown>;
  close(): Promise<void>;
}
const ports: Port[] = [];
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
it('rejects an uncertain COMMIT without returning its calculated result', async () => {
  const f = currentOrderRiskFixture();
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  fake.payload = f.reply();
  const port = await open();
  fake.commitFailure = true;
  await expect(port.capture(f.request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.queries.filter((q) => q.includes(' AS result'))).toHaveLength(1);
});
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
    expect((await port.capture(f.request, io())).evaluation.result.kind).toBe(kind);
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
