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

async function inventoryFixture() {
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
