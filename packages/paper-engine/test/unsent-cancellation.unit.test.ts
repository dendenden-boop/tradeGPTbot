import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonical, hash } from '@ctp/order-engine';
import { preparePaperUnsentCancellation } from '../../order-engine/src/paper.js';
import { state } from '../../order-engine/test/fixtures.js';
import * as server from '../src/risk.js';
import * as root from '../src/index.js';

const fake = vi.hoisted(() => ({
  payload: null as unknown,
  queries: [] as string[],
  values: [] as unknown[],
  committed: false,
  uncertain: false,
}));
vi.mock('../src/admission-database.js', () => ({
  openPaperAdmissionDatabase: async () => ({
    async transaction(_tenant: string, _io: unknown, work: (sql: unknown) => Promise<unknown>) {
      const result = await work({
        async query(text: string, values: unknown[]) {
          fake.queries.push(text);
          fake.values.push(values);
          return { rows: [{ result: fake.payload }] };
        },
      });
      if (fake.uncertain) throw Error('PAPER_ADMISSION_UNCERTAIN');
      fake.committed = true;
      return result;
    },
    async close() {},
  }),
}));
type Port = {
  cancel(raw: unknown, io: unknown): Promise<unknown>;
  reconcile(raw: unknown, io: unknown): Promise<unknown>;
  close(): Promise<void>;
};
async function open() {
  const factory = (server as unknown as Record<string, unknown>)[
    'createPostgresPaperUnsentCancellation'
  ];
  expect(factory, 'The durable local PAPER cancellation boundary is required').toBeTypeOf(
    'function',
  );
  return (factory as (options: unknown) => Promise<Port>)({
    connectionString: 'postgresql://fixture:private@127.0.0.1/paper',
    environment: 'test',
  });
}
function fixture() {
  const s = state();
  s.binding = {
    ...s.binding,
    mode: 'PAPER',
    connectionId: null,
    profile: {
      ...s.binding.profile,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: 'spot-l2-taker-v1',
    },
  };
  s.command.clientOrderId = '9223372036854775807';
  const withdrawal = {
      outcome: 'NOT_SENT',
      collateral: 'RETAINED',
      eventId: randomUUID(),
      reservationId: randomUUID(),
      orderId: s.id,
      intentId: s.intentId,
      decisionId: randomUUID(),
      commandHash: hash({ operation: 'createOrder', command: s.command, binding: s.binding }),
      stateRevision: '1',
      observedAt: 200,
      bookId: randomUUID(),
      bookRevision: '2',
      bookHash: 'a'.repeat(64),
    },
    release = {
      ...withdrawal,
      collateral: 'RELEASED',
      eventId: randomUUID(),
      withdrawalEventId: withdrawal.eventId,
      releaseVersion: '1',
      releasedAt: 300,
      bookRevision: '3',
      bookHash: 'b'.repeat(64),
      debits: [{ asset: 'USDT', amount: '1000', holdId: randomUUID() }],
    } as Record<string, unknown>;
  delete release.stateRevision;
  delete release.observedAt;
  const request = {
      kind: 'PAPER_CANCEL_UNSENT',
      binding: s.binding,
      orderId: s.id,
      key: 'local-cancel-once',
      authorization: { permissionEpoch: '9223372036854775807', userSessionEpoch: '2147483647' },
    },
    source = { state: s, withdrawal, release },
    plan = preparePaperUnsentCancellation(
      { kind: 'PAPER_PREPARE_UNSENT_CANCEL', key: request.key, ...source },
      1000,
    ),
    receipt = {
      outcome: 'NOT_SENT',
      collateral: 'RELEASED',
      orderId: s.id,
      placeIntentId: s.intentId,
      intentId: randomUUID(),
      eventId: randomUUID(),
      clientOrderId: s.command.clientOrderId,
      requestHash: plan.requestHash,
      command: plan.command,
      commandHash: plan.commandHash,
      status: 'CANCELED',
      version: '1',
      canceledAt: 400,
      reservationId: withdrawal.reservationId,
      withdrawalEventId: withdrawal.eventId,
      releaseEventId: release.eventId,
    },
    packet = { kind: 'CANCELED', request: plan.request, source, receipt };
  return { request, packet, receipt };
}
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2000 });
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  fake.queries = [];
  fake.values = [];
  fake.committed = false;
  fake.uncertain = false;
});
afterEach(() => vi.restoreAllMocks());

it('verifies common cancellation content and returns a frozen receipt only after known commit', async () => {
  expect(root).not.toHaveProperty('createPostgresPaperUnsentCancellation');
  const f = fixture(),
    port = await open();
  fake.payload = f.packet;
  const result = await port.cancel(f.request, io());
  expect(result).toEqual(f.receipt);
  expect(Object.isFrozen(result)).toBe(true);
  expect(fake.committed).toBe(true);
  expect(fake.queries).toEqual(['SELECT ctp_paper.evaluate_and_reserve($1::jsonb) AS result']);
  expect(fake.values).toEqual([[canonical(f.request)]]);
  expect(result).not.toHaveProperty('grant');
  expect(result).not.toHaveProperty('permit');
  await port.close();
});

it.each([
  'outcome',
  'collateral',
  'orderId',
  'placeIntentId',
  'intentId',
  'eventId',
  'clientOrderId',
  'requestHash',
  'commandHash',
  'status',
  'version',
  'canceledAt',
  'reservationId',
  'withdrawalEventId',
  'releaseEventId',
  'extra authority',
  'command locator',
  'source UNKNOWN',
  'source owner',
  'source release',
  'request key',
])('rejects conflicting %s before COMMIT', async (field) => {
  const f = fixture(),
    port = await open(),
    r = f.receipt as Record<string, unknown>;
  if (field === 'command locator')
    r.command = { ...f.receipt.command, locator: { kind: 'EXCHANGE_ID', id: 'fake' } };
  else if (field === 'source UNKNOWN') f.packet.source.state.status = 'UNKNOWN';
  else if (field === 'source owner') f.packet.source.state.binding.tenantId = randomUUID();
  else if (field === 'source release') f.packet.source.release.collateral = 'RETAINED';
  else if (field === 'request key') f.packet.request.key = 'different';
  else if (field === 'extra authority') r.permit = {};
  else if (field === 'intentId') r.intentId = f.receipt.placeIntentId;
  else if (field === 'eventId') r.eventId = f.receipt.intentId;
  else if (field === 'canceledAt') r.canceledAt = 299;
  else r[field] = 'conflicting';
  fake.payload = f.packet;
  await expect(port.cancel(f.request, io())).rejects.toThrow('PAPER_ADMISSION_EVIDENCE');
  expect(fake.committed).toBe(false);
  await port.close();
});

it.each([
  { key: '' },
  { orderId: 'bad' },
  { kind: 'LIVE_CANCEL' },
  { tenantId: randomUUID() },
  { authorization: { permissionEpoch: '01', userSessionEpoch: '0' } },
  { authorization: { permissionEpoch: '9223372036854775808', userSessionEpoch: '0' } },
  { authorization: { permissionEpoch: '0', userSessionEpoch: '2147483648' } },
  { authorization: { permissionEpoch: 0, userSessionEpoch: '0' } },
  { authorization: { permissionEpoch: '0', userSessionEpoch: '0', trust: true } },
  { authorization: undefined },
])('rejects invalid or caller-added request fields %j without SQL', async (change) => {
  const f = fixture(),
    port = await open();
  await expect(port.cancel({ ...f.request, ...change }, io())).rejects.toThrow(
    'PAPER_ADMISSION_INPUT',
  );
  expect(fake.queries).toEqual([]);
  await port.close();
});

it('does not return a receipt or retry after ambiguous COMMIT', async () => {
  const f = fixture(),
    port = await open();
  fake.payload = f.packet;
  fake.uncertain = true;
  await expect(port.cancel(f.request, io())).rejects.toThrow('PAPER_ADMISSION_UNCERTAIN');
  expect(fake.queries).toHaveLength(1);
  expect(fake.committed).toBe(false);
  await port.close();
});
it('readonly reconciliation verifies the original receipt and never calls the mutation RPC', async () => {
  const f = fixture(),
    port = await open();
  fake.payload = { ...f.packet, kind: 'COMMITTED' };
  expect(await port.reconcile(f.request, io())).toEqual({
    kind: 'COMMITTED',
    request: f.packet.request,
    receipt: f.receipt,
  });
  expect(fake.queries).toEqual(['SELECT ctp_paper.reconcile_admission($1::jsonb) AS result']);
  await port.close();
});
it('readonly MISSING carries exact semantic identity and allocates no command', async () => {
  const f = fixture(),
    port = await open();
  fake.payload = { kind: 'MISSING', request: f.packet.request };
  expect(await port.reconcile(f.request, io())).toEqual(fake.payload);
  expect(fake.queries).toEqual(['SELECT ctp_paper.reconcile_admission($1::jsonb) AS result']);
  await port.close();
});
