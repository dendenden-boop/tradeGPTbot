import { setTimeout as wait } from 'node:timers/promises';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import * as portfolio from '@ctp/paper-engine/portfolio';
import { calculatePaperInventoryValuation } from '@ctp/paper-engine';
import { parseDecimal } from '@ctp/exchange-core';
import { createPostgresMarketSnapshots } from '@ctp/market-data';
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
// Default fixture producers only. Every payload, read and financial operation
// remains fresh; inventory/valuation/Order readers and explicit URL probes do not share handles.
let configurationWriter: ReturnType<typeof createPostgresPaperConfiguration> | undefined;
let fundingWriter: ReturnType<typeof createPostgresPaperFunding> | undefined;
let bookWriter: ReturnType<typeof createPostgresPaperPortfolioBootstrap> | undefined;
function ownWriter<T extends { close(): Promise<void> }>(opening: Promise<T>): Promise<T> {
  return opening.then((handle) => {
    handles.push(handle);
    return handle;
  });
}
function configurationPort() {
  return (configurationWriter ??= ownWriter(
    createPostgresPaperConfiguration({
      connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
      environment: 'test',
    }),
  ));
}
function fundingPort() {
  return (fundingWriter ??= ownWriter(
    createPostgresPaperFunding({
      connectionString: required('DATABASE_PAPER_FUNDING_URL'),
      environment: 'test',
    }),
  ));
}
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
async function fixture({
  configure = true,
  region,
}: { configure?: boolean; region?: string } = {}) {
  const f = frameFixture();
  if (region) {
    f.configuration.configuration.source = { ...f.configuration.configuration.source, region };
    for (const holder of [
      f.p.key,
      f.p.record.instrument,
      f.p.record.rules,
      f.s.key,
      f.s.record.instrument,
      f.s.record.rules,
      f.s.book,
      f.s.ticker,
    ])
      holder.scope = { ...holder.scope, region };
  }
  const c = paperConfigurationSchema.parse(f.configuration.configuration);
  const externalAccountId = 'paper:' + c.owner.accountId;
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
  );
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-draft-epoch\',now())',
    [c.owner.accountId, c.owner.tenantId, c.source.exchange, externalAccountId, c.source.region],
  );
  const config = await configurationPort();
  if (configure) await config.register(c, io());
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

async function prepared({
  draft = true,
  fund = true,
  region,
}: { draft?: boolean; fund?: boolean; region?: string } = {}) {
  const f = await fixture(region ? { region } : {});
  const fundingId = randomUUID();
  if (fund) {
    const funding = await fundingPort();
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
  }
  const orders = await openOrders();
  const order = draft ? await orders.create(f.binding, f.draft, io()) : null;
  return { ...f, fundingId, orders, order };
}
async function openBook(connectionString = required('DATABASE_PAPER_BOOK_URL')) {
  if (arguments.length === 0)
    return (bookWriter ??= ownWriter(
      createPostgresPaperPortfolioBootstrap({ connectionString, environment: 'test' }),
    ));
  const h = await createPostgresPaperPortfolioBootstrap({ connectionString, environment: 'test' });
  handles.push(h);
  return h;
}

it('complete same-tenant PAPER Risk inventory captures two common books without a second financial effect', async () => {
  const f = await prepared(),
    bootstrap = await openBook();
  const first = await bootstrap.initialize(f.c.owner, io());
  const sibling = paperConfigurationSchema.parse({
    ...f.c,
    id: randomUUID(),
    owner: { ...f.c.owner, accountId: randomUUID() },
  });
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-draft-epoch\',now())',
    [
      sibling.owner.accountId,
      sibling.owner.tenantId,
      sibling.source.exchange,
      'paper:' + sibling.owner.accountId,
      sibling.source.region,
    ],
  );
  const configuration = await createPostgresPaperConfiguration({
    connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
    environment: 'test',
  });
  try {
    await configuration.register(sibling, io());
  } finally {
    await configuration.close();
  }
  const funding = await createPostgresPaperFunding({
    connectionString: required('DATABASE_PAPER_FUNDING_URL'),
    environment: 'test',
  });
  try {
    await funding.initialize(
      paperFundingSchema.parse({
        id: randomUUID(),
        owner: sibling.owner,
        configurationId: sibling.id,
        balances: [{ asset: 'USDT', amount: '3' }],
      }),
      io(),
    );
  } finally {
    await funding.close();
  }
  const second = await bootstrap.initialize(sibling.owner, io());
  const before = await admin.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM public.ledger_transaction WHERE "tenantId"=$1',
    [f.c.owner.tenantId],
  );
  const candidate = (portfolio as unknown as Record<string, unknown>)[
    'createPostgresPaperRiskPortfolioSource'
  ];
  expect(typeof candidate, 'PAPER_RISK_PORTFOLIO_FACTORY_MISSING').toBe('function');
  const create = candidate as (o: { connectionString: string; environment: 'test' }) => Promise<{
    read(
      owner: PaperOwner,
      context: ReturnType<typeof io>,
    ): Promise<{
      kind: string;
      accounts: readonly { bookId: string; state: { snapshotAt: number | null } }[];
    }>;
    close(): Promise<void>;
  }>;
  const source = await create({
    connectionString: required('DATABASE_PAPER_RISK_PORTFOLIO_URL'),
    environment: 'test',
  });
  handles.push(source);
  const capture = await source.read(f.c.owner, io());
  expect(capture.kind).toBe('PAPER_RISK_PORTFOLIO_SOURCE');
  expect(capture.accounts.map((a) => a.bookId).sort()).toEqual(
    [first.bookId, second.bookId].sort(),
  );
  expect(capture.accounts.find((a) => a.bookId === first.bookId)?.state.snapshotAt).toBe(
    first.state.snapshotAt,
  );
  expect(capture.accounts.find((a) => a.bookId === second.bookId)?.state.snapshotAt).toBe(
    second.state.snapshotAt,
  );
  expect(capture).not.toHaveProperty('grant');
  expect(capture).not.toHaveProperty('reservationId');
  const after = await admin.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM public.ledger_transaction WHERE "tenantId"=$1',
    [f.c.owner.tenantId],
  );
  expect(after.rows).toEqual(before.rows);
  expect(after.rows[0]?.n).toBe('2');
});

async function inventoryFixture(region?: string) {
  const f = await prepared(region ? { region } : {}),
    bootstrap = await openBook();
  const first = await bootstrap.initialize(f.c.owner, io());
  const sibling = paperConfigurationSchema.parse({
    ...f.c,
    id: randomUUID(),
    owner: { ...f.c.owner, accountId: randomUUID() },
  });
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-draft-epoch\',now())',
    [
      sibling.owner.accountId,
      sibling.owner.tenantId,
      sibling.source.exchange,
      'paper:' + sibling.owner.accountId,
      sibling.source.region,
    ],
  );
  const configuration = await configurationPort();
  await configuration.register(sibling, io());
  const funding = await fundingPort();
  await funding.initialize(
    paperFundingSchema.parse({
      id: randomUUID(),
      owner: sibling.owner,
      configurationId: sibling.id,
      balances: [{ asset: 'USDT', amount: '3' }],
    }),
    io(),
  );
  const second = await bootstrap.initialize(sibling.owner, io());
  return { ...f, first, second, sibling };
}
async function openInventory(connectionString = required('DATABASE_PAPER_RISK_PORTFOLIO_URL')) {
  const h = await portfolio.createPostgresPaperRiskPortfolioSource({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
}
async function readyInventory() {
  const f = await inventoryFixture(),
    h = await openInventory();
  return { ...f, h };
}

it('concurrent complete inventory and restart preserve stable identity and two original ledger seeds', async () => {
  const f = await readyInventory();
  const a = await f.h.read(f.c.owner, io()),
    values = await Promise.all(Array.from({ length: 4 }, () => f.h.read(f.c.owner, io())));
  for (const b of values) expect(b.hash).toBe(a.hash);
  await f.h.close();
  const h = await openInventory();
  expect((await h.read(f.c.owner, io())).hash).toBe(a.hash);
});
it.each(['disabled', 'external', 'epoch', 'region'] as const)(
  'unsafe sibling %s rejects the whole inventory after startup',
  async (kind) => {
    const f = await readyInventory();
    if (kind === 'disabled')
      await admin.query("UPDATE public.exchange_account SET status='DISABLED' WHERE id=$1", [
        f.sibling.owner.accountId,
      ]);
    if (kind === 'external')
      await admin.query(
        'UPDATE public.exchange_account SET "externalAccountId"=\'replacement\' WHERE id=$1',
        [f.sibling.owner.accountId],
      );
    if (kind === 'epoch')
      await admin.query(
        'UPDATE public.exchange_account SET "clientIdEpoch"=\'replacement\' WHERE id=$1',
        [f.sibling.owner.accountId],
      );
    if (kind === 'region')
      await admin.query("UPDATE public.exchange_account SET region='replacement' WHERE id=$1", [
        f.sibling.owner.accountId,
      ]);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_OWNERSHIP');
  },
);
it('foreign requested account is never substituted by owned books', async () => {
  const f = await readyInventory(),
    other = await readyInventory();
  await expect(
    f.h.read({ ...f.c.owner, accountId: other.c.owner.accountId }, io()),
  ).rejects.toThrow('PAPER_RISK_PORTFOLIO_OWNERSHIP');
});
it('new unconfigured sibling prevents returning the previously complete subset', async () => {
  const f = await readyInventory();
  const id = randomUUID();
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'new-account\',now())',
    [id, f.c.owner.tenantId, f.c.source.exchange, 'paper:' + id, f.c.source.region],
  );
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_MISSING');
});
it('coherent sibling balance rewrite is not adopted after restart', async () => {
  const f = await readyInventory();
  await f.h.close();
  const s = structuredClone(f.second.state),
    b = s.balances[0];
  if (!b) throw Error('BALANCE_REQUIRED');
  b.total = b.available = b.free = '4';
  const text = JSON.stringify(s);
  await admin.query(
    "UPDATE ctp_portfolio.book SET state=$1,state_hash=sha256(convert_to($1,'UTF8')) WHERE id=$2",
    [text, f.second.bookId],
  );
  const h = await openInventory();
  await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_CORRUPT');
});
it('UNKNOWN common order blocks the complete inventory without releasing or reseeding money', async () => {
  const f = await readyInventory();
  if (!f.order) throw Error('DRAFT_REQUIRED');
  await admin.query('UPDATE public."order" SET status=\'UNKNOWN\' WHERE id=$1', [f.order.id]);
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_INCOMPLETE');
});
it('current sibling permission epochs remain exact above Number precision', async () => {
  const f = await readyInventory();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"=9007199254740993,"reconciliationEpoch"=9223372036854775807 WHERE id=$1',
    [f.sibling.owner.accountId],
  );
  const r = await f.h.read(f.c.owner, io());
  expect(
    r.accounts.find((a) => a.state.binding.accountId === f.sibling.owner.accountId)?.accountState,
  ).toMatchObject({
    permissionEpoch: '9007199254740993',
    reconciliationEpoch: '9223372036854775807',
  });
});
it.each(['abort', 'deadline'] as const)(
  'hung sibling account %s settles physically without clipping the inventory',
  async (kind) => {
    const f = await readyInventory(),
      lock = await admin.connect(),
      controller = new AbortController(),
      start = Date.now();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
        f.sibling.owner.accountId,
      ]);
      const read = f.h.read(f.c.owner, io(controller.signal, kind === 'deadline' ? 100 : 2500)),
        rejected = expect(read).rejects.toThrow('PAPER_RISK_PORTFOLIO_ABORTED');
      if (kind === 'abort') {
        await wait(30);
        controller.abort();
      }
      await rejected;
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      controller.abort();
      await lock.query('ROLLBACK');
      lock.release();
    }
    expect((await f.h.read(f.c.owner, io())).accounts).toHaveLength(2);
  },
);
it('four physical inventory slots reject BUSY and become reusable only after settlement', async () => {
  const f = await readyInventory(),
    lock = await admin.connect(),
    controllers = Array.from({ length: 4 }, () => new AbortController());
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.sibling.owner.accountId,
    ]);
    const settled = Promise.allSettled(controllers.map((c) => f.h.read(f.c.owner, io(c.signal))));
    await wait(50);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_BUSY');
    controllers.forEach((c) => c.abort());
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
  } finally {
    controllers.forEach((c) => c.abort());
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect((await f.h.read(f.c.owner, io())).accounts).toHaveLength(2);
});
it('inventory close drains hung physical read and disables reuse', async () => {
  const f = await readyInventory(),
    lock = await admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.second.bookId]);
    const rejected = expect(f.h.read(f.c.owner, io())).rejects.toThrow();
    await wait(30);
    const start = Date.now();
    await f.h.close();
    await rejected;
    expect(Date.now() - start).toBeLessThan(1500);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_CLOSED');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
});
it('physically lost inventory read COMMIT returns no source and restart preserves the original books', async () => {
  const f = await readyInventory(),
    proxy = await registryCommitProxy(
      required('DATABASE_PAPER_RISK_PORTFOLIO_URL'),
      'PAPER_RISK_PORTFOLIO',
    );
  try {
    const h = await openInventory(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    const h2 = await openInventory(),
      r = await h2.read(f.c.owner, io());
    expect(r.accounts.map((a) => a.bookId).sort()).toEqual(
      [f.first.bookId, f.second.bookId].sort(),
    );
  } finally {
    await proxy.close();
  }
});
it('single-account source authority cannot become full tenant inventory authority', async () => {
  await expect(openInventory(required('DATABASE_PAPER_BOOK_SOURCE_URL'))).rejects.toThrow(
    'PAPER_RISK_PORTFOLIO_ROLE_UNSAFE',
  );
});

it('over-capacity owned catalog rejects wholly instead of returning a bounded subset', async () => {
  const f = await readyInventory();
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") SELECT id,$1,$2,\'PAPER\',\'paper:\'||id::text,$3,\'SIMULATED\',\'ACTIVE\',\'capacity\',now() FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,100)) q',
    [f.c.owner.tenantId, f.c.source.exchange, f.c.source.region],
  );
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_CAPACITY');
});
it.each(['LOGIN', 'TABLE', 'FUNCTION'] as const)(
  'SQL refuses new %s inventory authority after startup',
  async (kind) => {
    const f = await readyInventory();
    const grant =
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_risk_portfolio LOGIN'
        : kind === 'TABLE'
          ? 'GRANT SELECT ON ctp_portfolio.book TO ctp_paper_risk_portfolio'
          : 'GRANT EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb) TO ctp_paper_risk_portfolio';
    const revoke =
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_risk_portfolio NOLOGIN'
        : kind === 'TABLE'
          ? 'REVOKE SELECT ON ctp_portfolio.book FROM ctp_paper_risk_portfolio'
          : 'REVOKE EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb) FROM ctp_paper_risk_portfolio';
    try {
      await admin.query(grant);
      await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_PORTFOLIO_ROLE_UNSAFE');
    } finally {
      await admin.query(revoke);
    }
  },
);
it('catalog FK insertion cannot bypass a capture already holding the tenant inventory', async () => {
  const f = await readyInventory(),
    lock = await admin.connect();
  let observed: Promise<unknown> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [f.second.bookId]);
    const capture = f.h.read(f.c.owner, io());
    observed = capture.then(
      (r) => r,
      () => null,
    );
    let waiting = false;
    for (let n = 0; n < 30; n++) {
      const r = await admin.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT ctp_paper.capture_risk_portfolio(%' AND wait_event_type='Lock') AS waiting",
      );
      if (r.rows[0]?.waiting) {
        waiting = true;
        break;
      }
      await wait(10);
    }
    expect(waiting).toBe(true);
    const insert = await admin.connect();
    try {
      await insert.query('BEGIN');
      await insert.query("SET LOCAL lock_timeout='100ms'");
      const id = randomUUID();
      await expect(
        insert.query(
          'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'concurrent-catalog\',now())',
          [id, f.c.owner.tenantId, f.c.source.exchange, 'paper:' + id, f.c.source.region],
        ),
      ).rejects.toThrow(/lock timeout/);
    } finally {
      await insert.query('ROLLBACK');
      insert.release();
    }
    await lock.query('ROLLBACK');
    const r = await capture;
    expect(r.accounts).toHaveLength(2);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    await observed;
  }
});

function valuationInput(capture: portfolio.PaperRiskPortfolioSource, now = Date.now()) {
  return {
    inventory: capture,
    now,
    maxEvidenceAgeMs: 5000,
    quote: 'USDT',
    prices: capture.accounts.flatMap((a) =>
      a.state.balances
        .filter((b) => b.asset !== 'USDT')
        .map((b) => ({
          accountId: a.state.binding.accountId,
          asset: b.asset,
          quote: 'USDT',
          price: '2',
          kind: 'LAST' as const,
          sourceId: 'native-test-price',
          asOf: now,
          scope: a.state.binding.scope,
        })),
    ),
  };
}
async function valuationEffects(tenantId: string) {
  return (
    await admin.query<{ effects: unknown }>(
      `SELECT jsonb_build_object(
    'ledger',(SELECT count(*) FROM public.ledger_transaction WHERE "tenantId"=$1),
    'entries',(SELECT count(*) FROM public.ledger_entry WHERE "tenantId"=$1),
    'books',(SELECT count(*) FROM ctp_portfolio.book WHERE "tenantId"=$1),
    'decisions',(SELECT count(*) FROM public.risk_decision WHERE "tenantId"=$1),
    'reservations',(SELECT count(*) FROM public.risk_reservation WHERE "tenantId"=$1)
    ) AS effects`,
      [tenantId],
    )
  ).rows;
}
it('complete native PAPER inventory values historical seeds exactly without refreshing snapshots or financial effects', async () => {
  const f = await readyInventory(),
    before = await valuationEffects(f.c.owner.tenantId);
  const capture = await f.h.read(f.c.owner, io()),
    input = valuationInput(capture);
  const r = calculatePaperInventoryValuation(input);
  expect(r.equity).toBe('9007199254740996.000000000000000002');
  expect(r.accounts.map((a) => a.snapshotAt)).toEqual(
    capture.accounts.map((a) => a.state.snapshotAt),
  );
  expect(capture.accounts.map((a) => a.state.snapshotAt).sort()).toEqual(
    [f.first.createdAt, f.second.createdAt].sort(),
  );
  expect(r).not.toHaveProperty('grant');
  expect(r).not.toHaveProperty('reservationId');
  expect(await valuationEffects(f.c.owner.tenantId)).toEqual(before);
});

async function openValuation(connectionString = required('DATABASE_PAPER_RISK_VALUATION_URL')) {
  const h = await portfolio.createPostgresPaperRiskValuationSource({
    connectionString,
    environment: 'test',
  });
  handles.push(h);
  return h;
}
it('ambiguous active direct markets cannot silently select one convenient valuation price', async () => {
  const f = await readyValuation();
  const other = await fixture({ region: f.c.source.region }),
    p = structuredClone(other.f.s);
  const at = Date.now();
  p.key = structuredClone(other.f.p.key);
  p.record = structuredClone(other.f.p.record);
  p.timestamp = at;
  p.book.receivedAt = p.book.exchangeTime = at;
  p.ticker.receivedAt = p.ticker.exchangeTime = at;
  expect((await f.snapshots.publish(p, io())).status).toBe('APPLIED');
  await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_VALUATION_MARKET');
});
it('a new durable public price after restart changes valuation only and keeps the original seed graph', async () => {
  const f = await readyValuation(),
    before = await valuationEffects(f.c.owner.tenantId);
  const a = await f.h.read(f.c.owner, io());
  const p = structuredClone(f.p),
    at = Date.now();
  p.id = randomUUID();
  p.expectedRevision = '1';
  p.timestamp = at;
  p.book.receivedAt = p.book.exchangeTime = at;
  p.ticker.receivedAt = p.ticker.exchangeTime = at;
  p.book.sourceSequence = (BigInt(p.book.sourceSequence!) + 1n).toString();
  p.ticker.last = { state: 'AVAILABLE', value: parseDecimal('3') };
  expect((await f.snapshots.publish(p, io())).status).toBe('APPLIED');
  await f.h.close();
  const b = await (await openValuation()).read(f.c.owner, io());
  expect(b.hash).not.toBe(a.hash);
  expect(b.inventory.hash).toBe(a.inventory.hash);
  expect(b.valuation.equity).toBe('9007199254740996.000000000000000003');
  expect(await valuationEffects(f.c.owner.tenantId)).toEqual(before);
});
it('a captured market catalog remains locked until transaction settlement and a following GAP invalidates the next read', async () => {
  const f = await readyValuation();
  const runtime = new Pool({
    connectionString: required('DATABASE_PAPER_RISK_VALUATION_URL'),
    max: 1,
    query_timeout: 3000,
  });
  let settled = false;
  const p = await runtime.connect();
  let publication: Promise<unknown> | undefined;
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query('SELECT ctp_paper.capture_risk_valuation($1::jsonb)', [
      JSON.stringify(f.c.owner),
    ]);
    publication = f.snapshots
      .publish(
        {
          id: randomUUID(),
          key: f.p.key,
          expectedRevision: '1',
          kind: 'GAP',
          reason: 'CONNECTION_LOST',
          timestamp: Date.now(),
        },
        io(),
      )
      .then((r) => {
        settled = true;
        return r;
      });
    // Attach rejection handling before any assertion; preserve the real result.
    void publication.catch(() => {});
    await wait(60);
    expect(settled).toBe(false);
    await p.query('COMMIT');
    await publication;
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_VALUATION_MARKET');
  } finally {
    await p.query('ROLLBACK');
    p.release();
    await publication;
    await runtime.end();
  }
});
async function readyValuation(publish = true) {
  const f = await inventoryFixture('v-' + randomUUID().replaceAll('-', '').slice(0, 24));
  const snapshots = await createPostgresMarketSnapshots({
    connectionString: required('DATABASE_MARKET_SNAPSHOT_URL'),
    environment: 'test',
  });
  handles.push(snapshots);
  const p = structuredClone(f.f.s);
  const at = Date.now();
  p.key = structuredClone(f.f.p.key);
  p.record = structuredClone(f.f.p.record);
  p.timestamp = at;
  p.book.receivedAt = p.book.exchangeTime = at;
  p.ticker.receivedAt = p.ticker.exchangeTime = at;
  p.ticker.last = { state: 'AVAILABLE', value: parseDecimal('2') };
  if (publish) expect((await snapshots.publish(p, io())).status).toBe('APPLIED');
  const h = await openValuation();
  return { ...f, p, snapshots, h };
}
it('production PAPER valuation captures actual durable market heads and complete books in one read transaction', async () => {
  const f = await readyValuation(),
    before = await valuationEffects(f.c.owner.tenantId);
  const r = await f.h.read(f.c.owner, io());
  expect(r.kind).toBe('PAPER_RISK_VALUATION_SOURCE');
  expect(r.valuation.equity).toBe('9007199254740996.000000000000000002');
  expect(r.markets).toMatchObject([{ id: f.p.id, dbRuleId: f.p.key.dbRuleId, revision: '1' }]);
  expect(r.inventory.accounts.map((a) => a.state.snapshotAt).sort()).toEqual(
    [f.first.createdAt, f.second.createdAt].sort(),
  );
  expect(r).not.toHaveProperty('grant');
  expect(await valuationEffects(f.c.owner.tenantId)).toEqual(before);
});
it('production PAPER valuation restart and concurrent replay preserve source identity without a second financial effect', async () => {
  const f = await readyValuation(),
    before = await valuationEffects(f.c.owner.tenantId);
  const a = await f.h.read(f.c.owner, io());
  const all = await Promise.all(Array.from({ length: 4 }, () => f.h.read(f.c.owner, io())));
  expect(all.every((r) => r.hash === a.hash)).toBe(true);
  await f.h.close();
  expect((await (await openValuation()).read(f.c.owner, io())).hash).toBe(a.hash);
  expect(await valuationEffects(f.c.owner.tenantId)).toEqual(before);
});
it.each(['missing', 'stale', 'gap', 'rule-refresh', 'unknown', 'sibling'] as const)(
  'production valuation %s fails closed without a partial result or reservation',
  async (kind) => {
    const f = await readyValuation(kind !== 'missing');
    if (kind === 'stale') await wait(5100);
    const before = await valuationEffects(f.c.owner.tenantId);
    if (kind === 'gap')
      await f.snapshots.publish(
        {
          id: randomUUID(),
          key: f.p.key,
          expectedRevision: '1',
          kind: 'GAP',
          reason: 'CONNECTION_LOST',
          timestamp: Date.now(),
        },
        io(),
      );
    if (kind === 'rule-refresh')
      await admin.query('UPDATE public.instrument_rule_version SET "isCurrent"=false WHERE id=$1', [
        f.p.key.dbRuleId,
      ]);
    if (kind === 'unknown') {
      if (!f.order) throw Error('DRAFT_REQUIRED');
      await admin.query('UPDATE public."order" SET status=\'UNKNOWN\' WHERE id=$1', [f.order.id]);
    }
    if (kind === 'sibling')
      await admin.query("UPDATE public.exchange_account SET status='DISABLED' WHERE id=$1", [
        f.sibling.owner.accountId,
      ]);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow(
      /PAPER_RISK_VALUATION_(MARKET|STALE|INCOMPLETE|OWNERSHIP)/,
    );
    expect(await valuationEffects(f.c.owner.tenantId)).toEqual(before);
  },
);
it('a caller cannot supply a price or omit a sibling in the production valuation request', async () => {
  const f = await readyValuation();
  await expect(f.h.read({ ...f.c.owner, prices: [] } as PaperOwner, io())).rejects.toThrow(
    'PAPER_RISK_VALUATION_INPUT',
  );
  await expect(f.h.read({ ...f.c.owner, tenantId: randomUUID() }, io())).rejects.toThrow(
    'PAPER_RISK_VALUATION_OWNERSHIP',
  );
});
it('physically lost valuation COMMIT yields no source and restart can recapture the unchanged durable graph', async () => {
  const f = await readyValuation(),
    before = await valuationEffects(f.c.owner.tenantId);
  const proxy = await registryCommitProxy(
    required('DATABASE_PAPER_RISK_VALUATION_URL'),
    'PAPER_RISK_VALUATION',
  );
  try {
    const h = await openValuation(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_VALUATION_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    expect((await (await openValuation()).read(f.c.owner, io())).valuation.equity).toBe(
      '9007199254740996.000000000000000002',
    );
    expect(await valuationEffects(f.c.owner.tenantId)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'hung valuation market catalog %s settles physically and recovers the slot',
  async (kind) => {
    const f = await readyValuation(),
      lock = await admin.connect(),
      controller = new AbortController();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE ctp_market.snapshot_head IN ACCESS EXCLUSIVE MODE');
      const rejected = expect(
        f.h.read(f.c.owner, io(controller.signal, kind === 'deadline' ? 150 : 2500)),
      ).rejects.toThrow('PAPER_RISK_VALUATION_ABORTED');
      await wait(50);
      const start = Date.now();
      if (kind === 'abort') controller.abort();
      await rejected;
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      controller.abort();
      await lock.query('ROLLBACK');
      lock.release();
    }
    expect((await f.h.read(f.c.owner, io())).inventory.accounts).toHaveLength(2);
  },
);
it('four physical valuation slots remain bounded and close drains every hung capture', async () => {
  const f = await readyValuation(),
    lock = await admin.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE ctp_market.snapshot_head IN ACCESS EXCLUSIVE MODE');
    const settled = Promise.allSettled(Array.from({ length: 4 }, () => f.h.read(f.c.owner, io())));
    await wait(60);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_VALUATION_BUSY');
    await f.h.close();
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
    await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_VALUATION_CLOSED');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect((await (await openValuation()).read(f.c.owner, io())).inventory.accounts).toHaveLength(2);
});
it.each(['LOGIN', 'TABLE', 'FUNCTION'] as const)(
  'valuation SQL refuses additional %s authority after startup',
  async (kind) => {
    const f = await readyValuation();
    const grant =
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_risk_valuation LOGIN'
        : kind === 'TABLE'
          ? 'GRANT SELECT ON ctp_portfolio.book TO ctp_paper_risk_valuation'
          : 'GRANT EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb) TO ctp_paper_risk_valuation';
    const revoke =
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_risk_valuation NOLOGIN'
        : kind === 'TABLE'
          ? 'REVOKE SELECT ON ctp_portfolio.book FROM ctp_paper_risk_valuation'
          : 'REVOKE EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb) FROM ctp_paper_risk_valuation';
    try {
      await admin.query(grant);
      await expect(f.h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_VALUATION_ROLE_UNSAFE');
    } finally {
      await admin.query(revoke);
    }
  },
);
it('native PAPER valuation after restart changes only the public-price projection and keeps original source identity', async () => {
  const f = await readyInventory(),
    before = await valuationEffects(f.c.owner.tenantId);
  const original = await f.h.read(f.c.owner, io());
  const a = calculatePaperInventoryValuation(valuationInput(original));
  await f.h.close();
  const h = await openInventory(),
    next = await h.read(f.c.owner, io());
  const input = valuationInput(next);
  for (const p of input.prices) {
    p.price = '3';
    p.sourceId = 'native-test-next-price';
  }
  const b = calculatePaperInventoryValuation(input);
  expect(next.hash).toBe(original.hash);
  expect(a.equity).toBe('9007199254740996.000000000000000002');
  expect(b.equity).toBe('9007199254740996.000000000000000003');
  expect(b.accounts.map((a) => a.snapshotAt)).toEqual(a.accounts.map((a) => a.snapshotAt));
  expect(await valuationEffects(f.c.owner.tenantId)).toEqual(before);
});
it('missing stale or foreign native valuation evidence cannot manufacture a partial total or Risk reservation', async () => {
  const f = await readyInventory(),
    before = await valuationEffects(f.c.owner.tenantId);
  const capture = await f.h.read(f.c.owner, io()),
    input = valuationInput(capture);
  expect(() => calculatePaperInventoryValuation({ ...input, prices: [] })).toThrow(
    'PAPER_VALUATION_PRICE',
  );
  expect(() =>
    calculatePaperInventoryValuation({
      ...input,
      prices: input.prices.map((p) => ({ ...p, asOf: input.now - 5001 })),
    }),
  ).toThrow('PAPER_VALUATION_STALE');
  expect(() =>
    calculatePaperInventoryValuation({
      ...input,
      prices: input.prices.map((p) => ({ ...p, accountId: randomUUID() })),
    }),
  ).toThrow('PAPER_VALUATION_PRICE');
  expect((await f.h.read(f.c.owner, io())).hash).toBe(capture.hash);
  expect(await valuationEffects(f.c.owner.tenantId)).toEqual(before);
});
