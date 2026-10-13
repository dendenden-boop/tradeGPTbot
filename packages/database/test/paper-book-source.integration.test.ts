import { setTimeout as wait } from 'node:timers/promises';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import * as portfolio from '@ctp/paper-engine/portfolio';
import { createPostgresPaperPortfolioBootstrap } from '@ctp/paper-engine/portfolio';
import type { PaperOwner } from '@ctp/paper-engine/configuration';
import { createPostgresPaperFunding, paperFundingSchema } from '@ctp/paper-engine/funding';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createPostgresOrderStore, bindingSchema, draftSchema } from '@ctp/order-engine';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
} from '@ctp/paper-engine/configuration';
import { frameFixture } from '../../paper-engine/test/frame-fixture.js';
import { state } from '../../order-engine/test/fixtures.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_DRAFT_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_PAPER_DRAFT_VARIABLE_REQUIRED');
  return value;
};
const admin = new Pool({
  connectionString: required('DATABASE_MIGRATION_URL'),
  max: 3,
  query_timeout: 5000,
});
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await admin.end();
});
async function openOrders() {
  const h = await createPostgresOrderStore({
    connectionString: required('DATABASE_EXECUTION_URL'),
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function fixture({ configure = true } = {}) {
  const f = frameFixture(),
    c = paperConfigurationSchema.parse(f.configuration.configuration);
  const externalAccountId = 'paper:' + c.owner.accountId;
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
  );
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-draft-epoch\',now())',
    [c.owner.accountId, c.owner.tenantId, c.source.exchange, externalAccountId, c.source.region],
  );
  const config = await createPostgresPaperConfiguration({
    connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
    environment: 'test',
  });
  try {
    if (configure) await config.register(c, io());
  } finally {
    await config.close();
  }
  const i = f.p.record.instrument,
    r = f.p.record.rules;
  await admin.query(
    'INSERT INTO public.instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1,$2,\'SPOT\',$3,$4,$5,$6,true,now())',
    [
      f.p.key.dbInstrumentId,
      i.scope.exchange,
      i.scope.environment,
      i.exchangeSymbol,
      i.baseAsset,
      i.quoteAsset,
    ],
  );
  await admin.query(
    'INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules) VALUES($1,$2,1,true,$3,now(),$4,$5,$6,$7,$8,$9,$10::jsonb)',
    [
      f.p.key.dbRuleId,
      f.p.key.dbInstrumentId,
      new Date(r.effectiveAt),
      Buffer.alloc(32, 1),
      r.tickSize,
      r.stepSize,
      r.minQuantity,
      r.maxQuantity,
      r.minNotional,
      JSON.stringify(r),
    ],
  );
  const binding = bindingSchema.parse({
    ...c.owner,
    connectionId: null,
    externalAccountId,
    profile: {
      ...c.source,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: c.model.version,
    },
  });
  const draft = draftSchema.parse({
    ...state().draft,
    key: randomUUID(),
    dbInstrumentId: f.p.key.dbInstrumentId,
    dbRuleId: f.p.key.dbRuleId,
    order: {
      ...state().draft.order,
      instrumentId: i.id,
      ruleVersion: r.version,
      size: { kind: 'BASE_QUANTITY', asset: i.baseAsset, value: '0.5' },
    },
  });
  return { f, c, binding, draft };
}

async function prepared({ draft = true, fund = true } = {}) {
  const f = await fixture();
  const fundingId = randomUUID();
  if (fund) {
    const funding = await createPostgresPaperFunding({
      connectionString: required('DATABASE_PAPER_FUNDING_URL'),
      environment: 'test',
    });
    try {
      await funding.initialize(
        paperFundingSchema.parse({
          id: fundingId,
          owner: f.c.owner,
          configurationId: f.c.id,
          balances: [
            { asset: 'BTC', amount: '0.000000000000000001' },
            { asset: 'USDT', amount: '9007199254740993' },
          ],
        }),
        io(),
      );
    } finally {
      await funding.close();
    }
  }
  const orders = await openOrders();
  const order = draft ? await orders.create(f.binding, f.draft, io()) : null;
  return { ...f, fundingId, orders, order };
}
async function openBook(connectionString = required('DATABASE_PAPER_BOOK_URL')) {
  const h = await createPostgresPaperPortfolioBootstrap({ connectionString, environment: 'test' });
  handles.push(h);
  return h;
}

it('current PAPER book capture after common drafts preserves original snapshot and adds no financial authority', async () => {
  const f = await prepared(),
    h = await openBook(),
    origin = await h.initialize(f.c.owner, io());
  if (!f.order) throw new Error('DRAFT_REQUIRED');
  expect(origin.bookId).toBe(f.fundingId);
  expect(origin.state.binding.connectionId).toBeNull();
  const factory = (portfolio as Record<string, unknown>)['createPostgresPaperBookSource'];
  expect(factory).toBeTypeOf('function');
  if (typeof factory !== 'function') throw new Error('CURRENT_PAPER_BOOK_SOURCE_REQUIRED');
  const reader = await (
    factory as (o: { connectionString: string; environment: 'test' }) => Promise<{
      read(owner: PaperOwner, context: ReturnType<typeof io>): Promise<unknown>;
      close(): Promise<void>;
    }>
  )({ connectionString: required('DATABASE_PAPER_BOOK_SOURCE_URL'), environment: 'test' });
  handles.push(reader);
  const captured = await reader.read(f.c.owner, io());
  expect(captured).toMatchObject({
    kind: 'PAPER_BOOK_SOURCE',
    bookId: origin.bookId,
    revision: origin.revision,
    state: origin.state,
    drafts: [
      {
        orderId: f.order.id,
        intentId: f.order.intentId,
        clientOrderId: f.order.command.clientOrderId,
      },
    ],
  });
  expect(captured).not.toHaveProperty('grant');
  expect(captured).not.toHaveProperty('reservationId');
  for (const table of [
    'ledger_transaction',
    'risk_reservation',
    'risk_decision',
    'submission_attempt',
    'fill',
  ] as const) {
    const rows = await admin.query<{ n: number }>(
      'SELECT count(*)::int n FROM public.' + table + ' WHERE "accountId"=$1',
      [f.c.owner.accountId],
    );
    expect(rows.rows[0]?.n).toBe(table === 'ledger_transaction' ? 1 : 0);
  }
  expect(await h.read(f.c.owner, io())).toEqual(origin);
});

type F = Awaited<ReturnType<typeof prepared>>;
async function count(table: string, f: F) {
  if (
    !/^(public\.(ledger_transaction|ledger_entry|order_intent|risk_reservation|risk_decision|submission_attempt|fill)|ctp_portfolio\.(book|evidence|outbox|hold_watermark)|ctp_paper\.(book_origin|book_origin_seal))$/.test(
      table,
    )
  )
    throw new Error('OWNED_TABLE_REQUIRED');
  const column = table.startsWith('ctp_paper.') ? 'account_id' : '"accountId"';
  const r = await admin.query<{ n: number }>(
    `SELECT count(*)::int n FROM ${table} WHERE ${column}=$1`,
    [f.c.owner.accountId],
  );
  return r.rows[0]?.n;
}
async function unchangedMoney(f: F) {
  expect(await count('public.ledger_transaction', f)).toBe(1);
  expect(await count('public.ledger_entry', f)).toBe(4);
  for (const t of [
    'public.risk_reservation',
    'public.risk_decision',
    'public.submission_attempt',
    'public.fill',
  ])
    expect(await count(t, f)).toBe(0);
}
async function corrupt(query: string, values: unknown[]) {
  const p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query('SET LOCAL session_replication_role = replica');
    await p.query(query, values);
    await p.query('COMMIT');
  } catch (error) {
    await p.query('ROLLBACK');
    throw error;
  } finally {
    p.release();
  }
}

async function openSource(connectionString = required('DATABASE_PAPER_BOOK_SOURCE_URL')) {
  const h = await portfolio.createPostgresPaperBookSource({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function ready(options: Parameters<typeof prepared>[0] = {}) {
  const f = await prepared(options),
    original = await openBook(),
    origin = await original.initialize(f.c.owner, io()),
    h = await openSource();
  return { ...f, original, origin, h };
}
it('capture restart and concurrent reads preserve one original book with zero second ledger effects', async () => {
  const f = await ready(),
    sources = await Promise.all(Array.from({ length: 4 }, () => f.h.read(f.c.owner, io())));
  for (const s of sources) {
    expect(s.state).toEqual(f.origin.state);
    expect(s.asOf).toBeGreaterThanOrEqual(f.origin.createdAt);
    expect(s.hash).toBe(sources[0]?.hash);
  }
  await f.h.close();
  const restart = await openSource(),
    s = await restart.read(f.c.owner, io());
  expect(s.hash).toBe(sources[0]?.hash);
  expect(s.state.snapshotAt).toBe(f.origin.createdAt);
  for (const t of ['ctp_portfolio.book', 'ctp_portfolio.evidence', 'ctp_portfolio.outbox'])
    expect(await count(t, f)).toBe(1);
  await unchangedMoney(f);
});
it('pristine common book explicitly captures empty draft inventory without creating intents', async () => {
  const f = await ready({ draft: false }),
    s = await f.h.read(f.c.owner, io());
  expect(s.drafts).toEqual([]);
  expect(s.accountState.clientIdHighWatermark).toBe('0');
  expect(await count('public.order_intent', f)).toBe(0);
  await unchangedMoney(f);
});
it('new common draft changes current content identity but never overwrites original snapshot', async () => {
  const f = await ready(),
    before = await f.h.read(f.c.owner, io()),
    next = await f.orders.create(f.binding, { ...f.draft, key: randomUUID() }, io()),
    after = await f.h.read(f.c.owner, io());
  expect(after.drafts).toHaveLength(2);
  expect(after.drafts[1]?.orderId).toBe(next.id);
  expect(after.hash).not.toBe(before.hash);
  expect(after.state).toEqual(before.state);
  expect(after.state.snapshotAt).toBe(f.origin.createdAt);
  expect(await f.original.read(f.c.owner, io())).toEqual(f.origin);
  await unchangedMoney(f);
});
it('current permission reconciliation epochs and client counter remain lossless after restart', async () => {
  const f = await ready();
  await f.h.close();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"=9007199254740993,"reconciliationEpoch"=9223372036854775807,"clientIdHighWatermark"=9007199254740993,version=version+1 WHERE id=$1',
    [f.c.owner.accountId],
  );
  const h = await openSource(),
    s = await h.read(f.c.owner, io());
  expect(s.accountState).toMatchObject({
    permissionEpoch: '9007199254740993',
    reconciliationEpoch: '9223372036854775807',
    clientIdHighWatermark: '9007199254740993',
    version: 1,
  });
  expect(s.state).toEqual(f.origin.state);
  await unchangedMoney(f);
});
it('missing bootstrap cannot be reconstructed from existing conserved funding', async () => {
  const f = await prepared(),
    h = await openSource();
  await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_MISSING');
  expect(await count('ctp_portfolio.book', f)).toBe(0);
  await unchangedMoney(f);
});
it('another tenant account cannot be read through a mismatched owner', async () => {
  const f = await ready(),
    other = await ready();
  await expect(
    f.h.read({ ...f.c.owner, accountId: other.c.owner.accountId }, io()),
  ).rejects.toThrow(/PAPER_BOOK_SOURCE_(MISSING|OWNERSHIP)/);
  await unchangedMoney(f);
  await unchangedMoney(other);
});
it.each(['suspended', 'unverified', 'disabled', 'epoch', 'external', 'region'] as const)(
  'current %s owner replacement rejects source after startup',
  async (kind) => {
    const f = await ready();
    if (kind === 'suspended')
      await admin.query('UPDATE public."user" SET status=\'SUSPENDED\' WHERE id=$1', [
        f.c.owner.tenantId,
      ]);
    if (kind === 'unverified')
      await admin.query('UPDATE public."user" SET "emailVerifiedAt"=NULL WHERE id=$1', [
        f.c.owner.tenantId,
      ]);
    if (kind === 'disabled')
      await admin.query("UPDATE public.exchange_account SET status='DISABLED' WHERE id=$1", [
        f.c.owner.accountId,
      ]);
    if (kind === 'epoch')
      await admin.query(
        'UPDATE public.exchange_account SET "clientIdEpoch"=\'replaced\' WHERE id=$1',
        [f.c.owner.accountId],
      );
    if (kind === 'external')
      await admin.query(
        'UPDATE public.exchange_account SET "externalAccountId"=\'replaced\' WHERE id=$1',
        [f.c.owner.accountId],
      );
    if (kind === 'region')
      await admin.query("UPDATE public.exchange_account SET region='replaced' WHERE id=$1", [
        f.c.owner.accountId,
      ]);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_OWNERSHIP');
    await unchangedMoney(f);
  },
);
it.each(['book', 'origin', 'seal', 'evidence', 'outbox', 'configuration', 'funding'] as const)(
  'missing retained %s rejects source without repairing provenance',
  async (kind) => {
    const f = await ready(),
      tables = {
        book: 'ctp_portfolio.book',
        origin: 'ctp_paper.book_origin',
        seal: 'ctp_paper.book_origin_seal',
        evidence: 'ctp_portfolio.evidence',
        outbox: 'ctp_portfolio.outbox',
        configuration: 'ctp_paper.configuration_seal',
        funding: 'ctp_paper.funding_seal',
      };
    const column = ['book', 'outbox', 'configuration', 'funding'].includes(kind) ? 'id' : 'book';
    await corrupt('DELETE FROM ' + tables[kind] + ' WHERE ' + column + '=$1', [
      kind === 'configuration' ? f.c.id : f.fundingId,
    ]);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow(
      kind === 'origin' ? 'PAPER_BOOK_SOURCE_MISSING' : 'PAPER_BOOK_SOURCE_CORRUPT',
    );
    await unchangedMoney(f);
  },
);
it('coherent rewritten book after restart is not adopted or rebuilt from seed', async () => {
  const f = await ready();
  await f.h.close();
  const s = structuredClone(f.origin.state),
    b = s.balances.find((x) => x.asset === 'USDT');
  if (!b) throw Error('BALANCE_REQUIRED');
  b.total = b.free = b.available = '9007199254740994';
  const text = JSON.stringify(s);
  await admin.query(
    "UPDATE ctp_portfolio.book SET state=$1,state_hash=sha256(convert_to($1,'UTF8')) WHERE id=$2",
    [text, f.fundingId],
  );
  const h = await openSource();
  await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_CORRUPT');
  await unchangedMoney(f);
});
it('UNKNOWN after capture prevents subsequent source without releasing or reseeding funds', async () => {
  const f = await ready();
  await f.h.read(f.c.owner, io());
  if (!f.order) throw Error('DRAFT_REQUIRED');
  await admin.query('UPDATE public."order" SET status=\'UNKNOWN\' WHERE id=$1', [f.order.id]);
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_INCOMPLETE');
  await unchangedMoney(f);
});
it('arbitrary second common book cannot enter the certified-source prerequisite', async () => {
  const f = await ready(),
    text = JSON.stringify({
      ...f.origin.state,
      binding: { ...f.origin.state.binding, walletId: 'unproven' },
    });
  await admin.query(
    "INSERT INTO ctp_portfolio.book(\"tenantId\",\"accountId\",mode,wallet,state,state_hash) VALUES($1,$2,'PAPER','unproven',$3,sha256(convert_to($3,'UTF8')))",
    [f.c.owner.tenantId, f.c.owner.accountId, text],
  );
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_CORRUPT');
  await unchangedMoney(f);
});
it('other conserved economic posting prevents exporting unchanged seed as current', async () => {
  const f = await ready(),
    id = randomUUID(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query(
      'INSERT INTO public.ledger_transaction(id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode") VALUES($1::uuid,$2::uuid,$3::uuid,\'PAPER\',\'ADJUSTMENT\',($1::uuid)::text,now(),\'owned-source-fixture\')',
      [id, f.c.owner.tenantId, f.c.owner.accountId],
    );
    await p.query(
      "INSERT INTO public.ledger_entry(\"tenantId\",\"transactionId\",\"accountId\",mode,\"entryIndex\",asset,bucket,amount) VALUES($1,$2,$3,'PAPER',0,'USDT','AVAILABLE',1),($1,$2,$3,'PAPER',1,'USDT','EXTERNAL',-1)",
      [f.c.owner.tenantId, id, f.c.owner.accountId],
    );
    await p.query('COMMIT');
  } catch (error) {
    await p.query('ROLLBACK');
    throw error;
  } finally {
    p.release();
  }
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_INCOMPLETE');
  expect(await count('public.ledger_transaction', f)).toBe(2);
});
it('physically lost read COMMIT gives no source and restart retains original book without retry', async () => {
  const f = await ready(),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_BOOK_SOURCE_URL'),
      'PAPER_BOOK_SOURCE',
    );
  try {
    const h = await openSource(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    const restarted = await openSource(),
      s = await restarted.read(f.c.owner, io());
    expect(s.state).toEqual(f.origin.state);
    expect(await f.original.read(f.c.owner, io())).toEqual(f.origin);
    await unchangedMoney(f);
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'hung account %s settles source physically and slot remains reusable',
  async (kind) => {
    const f = await ready(),
      lock = await admin.connect(),
      controller = new AbortController(),
      started = Date.now();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
        f.c.owner.accountId,
      ]);
      const read = f.h.read(f.c.owner, io(controller.signal, kind === 'deadline' ? 100 : 2500));
      const rejected = expect(read).rejects.toThrow('PAPER_BOOK_SOURCE_ABORTED');
      if (kind === 'abort') {
        await wait(30);
        controller.abort();
      }
      await rejected;
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      controller.abort();
      await lock.query('ROLLBACK');
      lock.release();
    }
    expect((await f.h.read(f.c.owner, io())).state).toEqual(f.origin.state);
    await unchangedMoney(f);
  },
);
it.each(['abort', 'deadline'] as const)(
  'hung common book %s settles without returning source',
  async (kind) => {
    const f = await ready(),
      lock = await admin.connect(),
      controller = new AbortController();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
      const read = f.h.read(f.c.owner, io(controller.signal, kind === 'deadline' ? 100 : 2500));
      const rejected = expect(read).rejects.toThrow('PAPER_BOOK_SOURCE_ABORTED');
      if (kind === 'abort') {
        await wait(30);
        controller.abort();
      }
      await rejected;
    } finally {
      controller.abort();
      await lock.query('ROLLBACK');
      lock.release();
    }
    expect((await f.h.read(f.c.owner, io())).state).toEqual(f.origin.state);
    await unchangedMoney(f);
  },
);
it('four physical source slots reject BUSY and become reusable only after abort settlement', async () => {
  const f = await ready(),
    lock = await admin.connect(),
    controllers = Array.from({ length: 4 }, () => new AbortController());
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.c.owner.accountId,
    ]);
    const settled = Promise.allSettled(controllers.map((c) => f.h.read(f.c.owner, io(c.signal))));
    await wait(50);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_BUSY');
    controllers.forEach((c) => c.abort());
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
  } finally {
    controllers.forEach((c) => c.abort());
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect((await f.h.read(f.c.owner, io())).state).toEqual(f.origin.state);
  await unchangedMoney(f);
});
it('source close drains a hung physical operation and rejects subsequent reads', async () => {
  const f = await ready(),
    lock = await admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.fundingId]);
    const rejected = expect(f.h.read(f.c.owner, io())).rejects.toThrow();
    await wait(30);
    const start = Date.now();
    await f.h.close();
    await rejected;
    expect(Date.now() - start).toBeLessThan(1500);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_CLOSED');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  await unchangedMoney(f);
});
it.each(['LOGIN', 'TABLE', 'FUNCTION'] as const)(
  'SQL refuses new %s source authority after startup',
  async (kind) => {
    const f = await ready(),
      change =
        kind === 'LOGIN'
          ? 'ALTER ROLE ctp_paper_book_source LOGIN'
          : kind === 'TABLE'
            ? 'GRANT SELECT ON ctp_portfolio.book TO ctp_paper_book_source'
            : 'GRANT EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb) TO ctp_paper_book_source',
      restore =
        kind === 'LOGIN'
          ? 'ALTER ROLE ctp_paper_book_source NOLOGIN'
          : kind === 'TABLE'
            ? 'REVOKE SELECT ON ctp_portfolio.book FROM ctp_paper_book_source'
            : 'REVOKE EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb) FROM ctp_paper_book_source';
    try {
      await admin.query(change);
      await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_ROLE_UNSAFE');
    } finally {
      await admin.query(restore);
    }
    await unchangedMoney(f);
  },
);
it('bootstrap authority cannot become a current capture role and capture has no initialize method', async () => {
  const f = await ready();
  expect(f.h).not.toHaveProperty('initialize');
  await expect(
    portfolio.createPostgresPaperBookSource({
      connectionString: required('DATABASE_PAPER_BOOK_URL'),
      environment: 'test',
    }),
  ).rejects.toThrow('PAPER_BOOK_SOURCE_ROLE_UNSAFE');
  await unchangedMoney(f);
});
it('published client counter guard and current source both reject watermark regression', async () => {
  const f = await ready();
  const query = 'UPDATE public.exchange_account SET "clientIdHighWatermark"=0 WHERE id=$1';
  await expect(admin.query(query, [f.c.owner.accountId])).rejects.toThrow(
    'Client counter cannot regress',
  );
  expect((await f.h.read(f.c.owner, io())).state).toEqual(f.origin.state);
  // Test-only physical corruption exercises the source guard independently of
  // the published writer guard, which stays enabled on every runtime path.
  await corrupt(query, [f.c.owner.accountId]);
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_CORRUPT');
  await unchangedMoney(f);
});
it('over-capacity draft inventory rejects wholly without creating financial effects', async () => {
  const f = await ready();
  if (!f.order) throw Error('DRAFT_REQUIRED');
  await admin.query(
    "INSERT INTO public.order_intent SELECT (jsonb_populate_record(NULL::public.order_intent,to_jsonb(i)||jsonb_build_object('id',gen_random_uuid(),'idempotencyKey',gen_random_uuid()::text))).* FROM public.order_intent i CROSS JOIN generate_series(1,1000) n WHERE i.id=$1",
    [f.order.intentId],
  );
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_SOURCE_CAPACITY');
  await unchangedMoney(f);
});
