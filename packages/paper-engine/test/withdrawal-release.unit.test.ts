import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical, reducePortfolio, type PortfolioState } from '@ctp/portfolio';
import { admissionWire, wireHash, wireNow } from './admission-wire-fixtures.js';
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
type Release = {
  release(raw: unknown, options: ReturnType<typeof io>): Promise<unknown>;
  reconcile(raw: unknown, options: ReturnType<typeof io>): Promise<unknown>;
  close(): Promise<void>;
};
async function open(o: unknown = options) {
  const factory = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperWithdrawalRelease'
  ];
  expect(factory, 'Trusted durable NOT_SENT release factory is required').toBeTypeOf('function');
  return (factory as (o: unknown) => Promise<Release>)(o);
}
function fixture() {
  const f = admissionWire(wireNow - 20),
    request = {
      kind: 'PAPER_RELEASE_WITHDRAWN',
      admission: f.expected,
      reservationId: f.packet.receipt.reservationId,
      withdrawalEventId: '00000000-0000-4000-8000-000000000998',
      eventId: '00000000-0000-4000-8000-000000000999',
      expectedRevision: '1',
    },
    before = JSON.parse(f.packet.portfolio.afterText) as PortfolioState,
    event = {
      type: 'RELEASE' as const,
      id: request.eventId,
      timestamp: wireNow,
      holdId: f.packet.debits[0]!.holdId,
      resolved: false,
    },
    previousWatermark = {
      timestamp: wireNow - 20,
      fingerprint: wireHash({ type: 'COMMITMENT', hold: before.holds[0] }),
      released: false as const,
      unknown: false as const,
    },
    after = reducePortfolio(before, event, {
      now: () => wireNow,
      holdWatermark: previousWatermark,
    }).state,
    receipt = {
      outcome: 'NOT_SENT',
      collateral: 'RELEASED',
      eventId: request.eventId,
      withdrawalEventId: request.withdrawalEventId,
      reservationId: request.reservationId,
      orderId: f.expected.orderId,
      intentId: f.expected.intentId,
      decisionId: f.packet.receipt.decisionId,
      commandHash: f.expected.commandHash,
      releaseVersion: '1',
      releasedAt: wireNow,
      bookId: f.packet.portfolio.bookId,
      bookRevision: '3',
      bookHash: wireHash(after),
      debits: f.packet.debits,
    },
    packet = {
      kind: 'RELEASED',
      request,
      receipt,
      portfolio: {
        bookId: receipt.bookId,
        previousRevision: '2',
        revision: '3',
        before,
        event,
        previousWatermark,
        afterText: canonical(after),
        afterHash: wireHash(after),
      },
    };
  return { request, packet };
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(wireNow);
  fake.queries = [];
  fake.duplicate = false;
});
afterEach(() => vi.restoreAllMocks());

it('exports only the server release; verifies the actual Portfolio reducer and commits a frozen receipt without a grant or posting', async () => {
  expect(pure).not.toHaveProperty('createPostgresPaperWithdrawalRelease');
  const f = fixture(),
    port = await open();
  fake.payload = f.packet;
  fake.queries = [];
  try {
    const result = await port.release(f.request, io());
    expect(result).toEqual(f.packet.receipt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.queries).toContain('SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result');
    expect(fake.queries.at(-1)).toBe('COMMIT');
  } finally {
    await port.close();
  }
});

it.each([
  'request',
  'outcome',
  'collateral',
  'eventId',
  'withdrawalEventId',
  'reservationId',
  'orderId',
  'intentId',
  'commandHash',
  'releaseVersion',
  'future time',
  'debit amount',
  'debit asset',
  'holdId',
  'duplicate debit',
  'owner',
  'account',
  'native binding',
  'wallet',
  'profile',
  'missing hold',
  'UNKNOWN hold',
  'reflected hold',
  'watermark before snapshot',
  'released watermark',
  'UNKNOWN watermark',
  'watermark fingerprint',
  'event type',
  'event identity',
  'event hold',
  'trusted resolution',
  'equal time',
  'bookId',
  'revision',
  'invalid revision',
  'hash',
  'cash change',
  'extra authority',
  'duplicate rows',
])('fails closed on %s before COMMIT', async (field) => {
  const f = fixture(),
    port = await open(),
    p = f.packet.portfolio,
    r = f.packet.receipt;
  const other = '00000000-0000-4000-8000-000000000777';
  if (field === 'request') f.packet.request = { ...f.request, eventId: other };
  else if (['eventId', 'withdrawalEventId', 'reservationId', 'orderId', 'intentId'].includes(field))
    (r as Record<string, unknown>)[field] = other;
  else if (field === 'outcome') r.outcome = 'FILLED';
  else if (field === 'collateral') r.collateral = 'RETAINED';
  else if (field === 'commandHash') r.commandHash = 'f'.repeat(64);
  else if (field === 'releaseVersion') r.releaseVersion = '2';
  else if (field === 'future time') r.releasedAt = wireNow + 1;
  else if (field === 'debit amount') r.debits[0]!.amount = '1';
  else if (field === 'debit asset') r.debits[0]!.asset = 'BTC';
  else if (field === 'holdId') r.debits[0]!.holdId = other;
  else if (field === 'duplicate debit') r.debits.push(r.debits[0]!);
  else if (field === 'owner') p.before.binding.tenantId = other;
  else if (field === 'account') p.before.binding.accountId = other;
  else if (field === 'native binding') p.before.binding.connectionId = other;
  else if (field === 'wallet') p.before.binding.walletId = 'other';
  else if (field === 'profile')
      p.before.binding.scope = { ...p.before.binding.scope, environment: 'LIVE' };
  else if (field === 'missing hold') p.before.holds = [];
  else if (field === 'UNKNOWN hold') p.before.holds[0]!.status = 'UNKNOWN';
  else if (field === 'reflected hold') p.before.holds[0]!.reflected = true;
  else if (field === 'watermark before snapshot') p.previousWatermark.timestamp--;
  else if (field === 'released watermark')
    (p.previousWatermark as { released: boolean }).released = true;
  else if (field === 'UNKNOWN watermark')
    (p.previousWatermark as { unknown: boolean }).unknown = true;
  else if (field === 'watermark fingerprint') p.previousWatermark.fingerprint = 'f'.repeat(64);
  else if (field === 'event type')
    (p as Record<string, unknown>)['event'] = {
      type: 'GAP',
      id: f.request.eventId,
      timestamp: wireNow,
    };
  else if (field === 'event identity') p.event.id = other;
  else if (field === 'event hold') p.event.holdId = other;
  else if (field === 'trusted resolution') p.event.resolved = true;
  else if (field === 'equal time') p.event.timestamp = p.previousWatermark.timestamp;
  else if (field === 'bookId') p.bookId = other;
  else if (field === 'revision') p.revision = '4';
  else if (field === 'invalid revision') p.revision = 'not-an-integer';
  else if (field === 'hash') p.afterHash = 'f'.repeat(64);
  else if (field === 'cash change') {
    const after = JSON.parse(p.afterText) as PortfolioState;
    after.balances[0]!.available = '9999';
    p.afterText = canonical(after);
    p.afterHash = wireHash(after);
    r.bookHash = p.afterHash;
  } else if (field === 'extra authority') (f.packet as Record<string, unknown>)['grant'] = {};
  fake.duplicate = field === 'duplicate rows';
  fake.payload = f.packet;
  fake.queries = [];
  try {
    await expect(port.release(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
    expect(fake.queries).not.toContain('COMMIT');
  } finally {
    await port.close();
  }
});

it.each(['resolved', 'fills', 'status', 'snapshot', 'tenantId', 'debits', 'releaseAmount'])(
  'does not accept caller %s as release authority',
  async (field) => {
    const port = await open();
    fake.queries = [];
    try {
      await expect(port.release({ ...fixture().request, [field]: true }, io())).rejects.toThrow(
        'PAPER_ADMISSION_INPUT',
      );
      expect(fake.queries).toHaveLength(0);
    } finally {
      await port.close();
    }
  },
);
it.each(['MISSING', 'COMMITTED'])(
  'reconciles %s only through the fixed read RPC and validates exact identities',
  async (kind) => {
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
  },
);
