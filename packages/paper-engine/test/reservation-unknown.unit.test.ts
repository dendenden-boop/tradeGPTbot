import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { canonical, reducePortfolio } from '@ctp/portfolio';
import { admissionWire, wireHash, wireNow } from './admission-wire-fixtures.js';
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
import { createPostgresPaperReservationLifecycle } from '../src/postgres-reservation-lifecycle.js';
import * as server from '../src/risk.js';
import * as pure from '../src/index.js';
const options = {
  connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
  environment: 'test',
};
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
function fixture() {
  const f = admissionWire(wireNow - 10),
    p = f.packet.portfolio;
  const before = reducePortfolio(p.before, p.events[0]!, {
    now: () => wireNow,
    holdWatermark: null,
  });
  const request = {
    kind: 'PAPER_RESERVATION_UNKNOWN' as const,
    admission: f.expected,
    reservationId: f.packet.receipt.reservationId,
    eventId: '00000000-0000-4000-8000-000000000999',
    expectedRevision: '1' as const,
  };
  const event = {
    id: request.eventId,
    type: 'COMMITMENT' as const,
    timestamp: wireNow,
    hold: { ...before.state.holds[0]!, status: 'UNKNOWN' as const },
  };
  const after = reducePortfolio(before.state, event, {
    now: () => wireNow,
    holdWatermark: before.holdWatermark!,
  });
  const portfolio = {
    bookId: p.bookId,
    previousRevision: '2',
    revision: '3',
    before: before.state,
    event,
    previousWatermark: before.holdWatermark!,
    afterText: canonical(after.state),
    afterHash: wireHash(after.state),
  };
  const receipt = {
    eventId: request.eventId,
    reservationId: request.reservationId,
    orderId: f.expected.orderId,
    intentId: f.expected.intentId,
    decisionId: f.packet.receipt.decisionId,
    revision: '2' as const,
    observedAt: wireNow,
    bookId: p.bookId,
    bookRevision: portfolio.revision,
    bookHash: portfolio.afterHash,
  };
  return { request, packet: { kind: 'UNKNOWN' as const, request, receipt, portfolio } };
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.duplicate = false;
});
afterEach(() => vi.restoreAllMocks());
it('exposes quarantine only on the server risk subpath and accepts no caller authority or transport override', async () => {
  expect(server.createPostgresPaperReservationLifecycle).toBeTypeOf('function');
  expect(pure).not.toHaveProperty('createPostgresPaperReservationLifecycle');
  for (const extra of [
    { role: 'ctp_api' },
    { rpc: 'user_rpc' },
    { query: 'SELECT true' },
    { client: {} },
    { snapshot: {} },
    { grant: {} },
    { tenantId: 'forged' },
    { resolved: true },
  ]) {
    fake.queries = [];
    await expect(createPostgresPaperReservationLifecycle({ ...options, ...extra })).rejects.toThrow(
      'PAPER_ADMISSION_DATABASE_URL',
    );
    expect(fake.queries).toEqual([]);
  }
});
it('conservative UNKNOWN independently preserves the entire hold and all cash before COMMIT', async () => {
  const f = fixture();
  fake.payload = f.packet;
  const port = await createPostgresPaperReservationLifecycle(options);
  try {
    fake.queries = [];
    expect(await port.markUnknown(f.request, io())).toEqual(f.packet.receipt);
    expect(fake.queries).toContain('SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result');
    expect(fake.queries.at(-1)).toBe('COMMIT');
    expect(Object.isFrozen(await port.markUnknown(f.request, io()))).toBe(true);
  } finally {
    await port.close();
  }
});
it.each([
  'amount',
  'asset',
  'scope',
  'cash',
  'hold omitted',
  'watermark',
  'event',
  'revision',
  'hash',
  'receipt',
  'duplicate row',
])('rejects %s evidence before COMMIT', async (kind) => {
  const f = fixture(),
    p = f.packet.portfolio;
  if (kind === 'amount') p.event.hold.amount = '0';
  if (kind === 'asset') p.event.hold.asset = 'BTC';
  if (kind === 'scope') p.before.binding.accountId = '00000000-0000-4000-8000-000000000888';
  if (kind === 'cash') p.before.balances[0]!.total = '0';
  if (kind === 'hold omitted') p.before.holds = [];
  if (kind === 'watermark') p.previousWatermark.fingerprint = '0'.repeat(64);
  if (kind === 'event') p.event.id += 'forged';
  if (kind === 'revision') p.revision = p.previousRevision;
  if (kind === 'hash') p.afterHash = '0'.repeat(64);
  if (kind === 'receipt') f.packet.receipt.reservationId = f.packet.receipt.eventId;
  fake.duplicate = kind === 'duplicate row';
  fake.payload = f.packet;
  const port = await createPostgresPaperReservationLifecycle(options);
  try {
    fake.queries = [];
    await expect(port.markUnknown(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(fake.queries).toContain('ROLLBACK');
    expect(fake.queries).not.toContain('COMMIT');
  } finally {
    await port.close();
  }
});
it('MISSING reconciliation is a historical read and does not call the mutation RPC', async () => {
  const f = fixture();
  fake.payload = { kind: 'MISSING', request: f.request };
  const port = await createPostgresPaperReservationLifecycle(options);
  try {
    fake.queries = [];
    expect(await port.reconcileUnknown(f.request, io())).toEqual(fake.payload);
    expect(fake.queries).not.toContain(
      'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result',
    );
  } finally {
    await port.close();
  }
});
it('rejects caller release/resolution/snapshot authority and unsupported revision before SQL', async () => {
  const f = fixture();
  const port = await createPostgresPaperReservationLifecycle(options);
  try {
    for (const extra of [
      { resolved: true },
      { snapshot: {} },
      { expectedRevision: '2' },
      { reservationId: 'bad' },
    ]) {
      fake.queries = [];
      await expect(port.markUnknown({ ...f.request, ...extra }, io())).rejects.toThrow(
        'PAPER_ADMISSION_INPUT',
      );
      expect(fake.queries).toEqual([]);
    }
  } finally {
    await port.close();
  }
});
