import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { admissionWire, wireNow } from './admission-wire-fixtures.js';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
const fake = vi.hoisted<{ payload: unknown; queries: string[]; duplicate: boolean }>(() => ({
  payload: null,
  queries: [],
  duplicate: false,
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    query(text: string) {
      fake.queries.push(text);
      return Promise.resolve({
        rows: text.includes(' AS safe')
          ? [{ safe: true }]
          : text.includes(' AS result')
            ? Array.from({ length: fake.duplicate ? 2 : 1 }, () => ({ result: fake.payload }))
            : [],
      });
    }
    async end() {}
  },
}));
const options = {
  connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
  environment: 'test',
};
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
type Barrier = {
  withdraw(raw: unknown, io: ReturnType<typeof io>): Promise<unknown>;
  reconcile(raw: unknown, io: ReturnType<typeof io>): Promise<unknown>;
  close(): Promise<void>;
};
async function open(o: unknown = options) {
  const factory = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperWithdrawalBarrier'
  ];
  expect(factory, 'Durable withdrawal server factory is required').toBeTypeOf('function');
  return (factory as (o: unknown) => Promise<Barrier>)(o);
}
function fixture() {
  const f = admissionWire(wireNow - 10);
  const request = {
    kind: 'PAPER_WITHDRAW_BEFORE_DISPATCH',
    admission: f.expected,
    reservationId: f.packet.receipt.reservationId,
    eventId: '00000000-0000-4000-8000-000000000999',
    expectedRevision: '1',
  };
  const receipt = {
    outcome: 'NOT_SENT',
    collateral: 'RETAINED',
    eventId: request.eventId,
    reservationId: request.reservationId,
    orderId: f.expected.orderId,
    intentId: f.expected.intentId,
    decisionId: f.packet.receipt.decisionId,
    commandHash: f.expected.commandHash,
    stateRevision: '1',
    observedAt: wireNow,
    bookId: f.packet.portfolio.bookId,
    bookRevision: '2',
    bookHash: f.packet.portfolio.afterHash,
  };
  return { request, packet: { kind: 'WITHDRAWN', request, receipt } };
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.duplicate = false;
});
afterEach(() => vi.restoreAllMocks());

it('exports only a server barrier; returns an immutable NOT_SENT receipt after COMMIT, never a grant or CANCEL', async () => {
  expect(pure).not.toHaveProperty('createPostgresPaperWithdrawalBarrier');
  const f = fixture(),
    port = await open();
  fake.payload = f.packet;
  fake.queries = [];
  try {
    const result = await port.withdraw(f.request, io());
    expect(result).toEqual(f.packet.receipt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.queries).toContain('SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result');
    expect(fake.queries.at(-1)).toBe('COMMIT');
  } finally {
    await port.close();
  }
});

it.each([
  'outcome',
  'collateral',
  'reservationId',
  'intentId',
  'orderId',
  'eventId',
  'commandHash',
  'stateRevision',
  'observedAt',
  'extra authority',
  'request',
  'duplicate rows',
])('rejects %s protocol corruption before COMMIT', async (field) => {
  const f = fixture(),
    port = await open();
  const receipt = f.packet.receipt as Record<string, unknown>;
  if (field === 'outcome') receipt[field] = 'CANCELLED';
  else if (field === 'collateral') receipt[field] = 'RELEASED';
  else if (field === 'observedAt') receipt[field] = wireNow + 1;
  else if (field === 'stateRevision') receipt[field] = '2';
  else if (field === 'commandHash') receipt[field] = 'f'.repeat(64);
  else if (field === 'extra authority') receipt['grant'] = {};
  else if (field === 'request')
    f.packet.request = { ...f.request, eventId: f.request.reservationId };
  else if (field !== 'duplicate rows') receipt[field] = '00000000-0000-4000-8000-000000000888';
  fake.duplicate = field === 'duplicate rows';
  fake.payload = f.packet;
  fake.queries = [];
  try {
    await expect(port.withdraw(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(fake.queries).toContain('ROLLBACK');
    expect(fake.queries).not.toContain('COMMIT');
  } finally {
    await port.close();
  }
});

it.each(['MISSING', 'COMMITTED'])('reconciles %s through the read-only fixed RPC', async (kind) => {
  const f = fixture(),
    port = await open();
  fake.payload =
    kind === 'MISSING'
      ? { kind, request: f.request }
      : { kind, request: f.request, receipt: f.packet.receipt };
  fake.queries = [];
  try {
    expect(await port.reconcile(f.request, io())).toEqual(fake.payload);
    expect(fake.queries).toContain('SELECT ctp_paper.reconcile_admission($1::jsonb) AS result');
    expect(fake.queries).not.toContain(
      'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
    );
  } finally {
    await port.close();
  }
});

it.each([{ resolved: true }, { snapshot: {} }, { expectedRevision: '2' }, { release: true }])(
  'rejects caller authority %j before database access',
  async (extra) => {
    const f = fixture(),
      port = await open();
    fake.queries = [];
    try {
      await expect(port.withdraw({ ...f.request, ...extra }, io())).rejects.toThrow(
        'PAPER_ADMISSION_INPUT',
      );
      expect(fake.queries).toEqual([]);
    } finally {
      await port.close();
    }
  },
);

it('rejects runtime role, RPC, transport, tenant and snapshot overrides', async () => {
  for (const extra of [
    { role: 'ctp_api' },
    { rpc: 'user_rpc' },
    { client: {} },
    { tenantId: 'caller' },
    { snapshot: {} },
  ]) {
    fake.queries = [];
    await expect(open({ ...options, ...extra })).rejects.toThrow('PAPER_ADMISSION_DATABASE_URL');
    expect(fake.queries).toEqual([]);
  }
});
