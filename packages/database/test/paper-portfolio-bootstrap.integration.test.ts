import {
  createPostgresPaperPortfolioBootstrap,
  createPostgresPaperInitialPortfolio,
} from '@ctp/paper-engine/portfolio';
import { createState, createPostgresPortfolioStore } from '@ctp/portfolio';
import { setTimeout as wait } from 'node:timers/promises';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
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
it('funded PAPER with a common draft bootstraps one durable shared Portfolio checkpoint without a second ledger effect', async () => {
  const f = await prepared(),
    h = await openBook(),
    r = await h.initialize(f.c.owner, io());
  expect(r.bookId).toBe(f.fundingId);
  expect(r.revision).toBe('1');
  expect(r.state.binding).toMatchObject({
    mode: 'PAPER',
    connectionId: null,
    walletId: 'paper-initial:' + f.fundingId,
  });
  expect(r.state.balances).toEqual([
    {
      asset: 'BTC',
      total: '0.000000000000000001',
      free: '0.000000000000000001',
      available: '0.000000000000000001',
      locked: '0',
    },
    {
      asset: 'USDT',
      total: '9007199254740993',
      free: '9007199254740993',
      available: '9007199254740993',
      locked: '0',
    },
  ]);
  for (const t of [
    'ctp_portfolio.book',
    'ctp_portfolio.evidence',
    'ctp_portfolio.outbox',
    'ctp_paper.book_origin',
    'ctp_paper.book_origin_seal',
  ])
    expect(await count(t, f)).toBe(1);
  await unchangedMoney(f);
  if (!f.order) throw new Error('DRAFT_REQUIRED');
  expect((await f.orders.read(f.binding, f.order.id, io())).command).toEqual(f.order.command);
  const evidence = await admin.query<{ id: string; ledger: string }>(
    'SELECT id,ledger FROM ctp_portfolio.evidence WHERE book=$1',
    [f.fundingId],
  );
  expect(evidence.rows).toEqual([{ id: 'paper-bootstrap:' + f.fundingId, ledger: f.fundingId }]);
});
it('pristine funded account bootstraps through the common snapshot without orders or monetary authority', async () => {
  const f = await prepared({ draft: false }),
    h = await openBook(),
    r = await h.initialize(f.c.owner, io());
  expect(r.state.status).toBe('RECONCILED');
  expect(await count('public.order_intent', f)).toBe(0);
  await unchangedMoney(f);
});
it('concurrent exact initialization and restart preserve one original book receipt and ledger seed', async () => {
  const f = await prepared(),
    a = await openBook(),
    b = await openBook();
  const [x, y] = await Promise.all([a.initialize(f.c.owner, io()), b.initialize(f.c.owner, io())]);
  expect(x).toEqual(y);
  await a.close();
  await b.close();
  const h = await openBook();
  expect(await h.read(f.c.owner, io())).toEqual(x);
  expect(await h.initialize(f.c.owner, io())).toEqual(x);
  for (const t of ['ctp_portfolio.book', 'ctp_portfolio.evidence', 'ctp_portfolio.outbox'])
    expect(await count(t, f)).toBe(1);
  await unchangedMoney(f);
});
it('more common CREATED drafts do not overwrite the original snapshot or renew replay freshness', async () => {
  const f = await prepared(),
    h = await openBook(),
    r = await h.initialize(f.c.owner, io());
  await wait(25);
  await f.orders.create(f.binding, { ...f.draft, key: randomUUID() }, io());
  expect(await h.initialize(f.c.owner, io())).toEqual(r);
  expect(await h.read(f.c.owner, io())).toEqual(r);
  expect(r.state.snapshotAt).toBe(r.createdAt);
  expect(await count('public.order_intent', f)).toBe(2);
  await unchangedMoney(f);
});
it('missing bootstrap read cannot create a common book or projection event', async () => {
  const f = await prepared(),
    h = await openBook();
  await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_MISSING');
  expect(await count('ctp_portfolio.book', f)).toBe(0);
  await unchangedMoney(f);
});
it('unfunded configuration cannot invent opening balances', async () => {
  const f = await prepared({ fund: false, draft: false }),
    h = await openBook();
  await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_MISSING');
  expect(await count('public.ledger_transaction', f)).toBe(0);
  expect(await count('ctp_portfolio.book', f)).toBe(0);
});
it('different tenant cannot bootstrap an existing PAPER account', async () => {
  const f = await prepared(),
    h = await openBook();
  await expect(h.initialize({ ...f.c.owner, tenantId: randomUUID() }, io())).rejects.toThrow(
    'PAPER_BOOK_MISSING',
  );
  expect(await count('ctp_portfolio.book', f)).toBe(0);
  await unchangedMoney(f);
});
it.each(['suspended', 'unverified', 'disabled', 'epoch', 'external', 'region'] as const)(
  'current %s ownership change denies initialization and replay',
  async (kind) => {
    const f = await prepared(),
      h = await openBook();
    await h.initialize(f.c.owner, io());
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
    await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_OWNERSHIP');
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_OWNERSHIP');
    await unchangedMoney(f);
  },
);
it.each(['configuration', 'funding'] as const)(
  'missing retained %s seal fails closed instead of deriving a new checksum',
  async (kind) => {
    const f = await prepared(),
      h = await openBook();
    const table = kind === 'configuration' ? 'configuration_seal' : 'funding_seal';
    const id = kind === 'configuration' ? f.c.id : f.fundingId;
    await corrupt(`DELETE FROM ctp_paper.${table} WHERE id=$1`, [id]);
    await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_CORRUPT');
    expect(await count('ctp_portfolio.book', f)).toBe(0);
  },
);
it('coherent rewritten common state after restart cannot be adopted or restored from the seed', async () => {
  const f = await prepared(),
    h = await openBook(),
    r = await h.initialize(f.c.owner, io());
  await h.close();
  const s = structuredClone(r.state);
  const balance = s.balances.find((b) => b.asset === 'USDT');
  if (!balance) throw new Error('BALANCE_REQUIRED');
  balance.total = balance.free = balance.available = '9007199254740994';
  const text = JSON.stringify(s);
  await admin.query(
    "UPDATE ctp_portfolio.book SET state=$1,state_hash=sha256(convert_to($1,'UTF8')) WHERE id=$2",
    [text, f.fundingId],
  );
  const restarted = await openBook();
  await expect(restarted.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_CORRUPT');
  await expect(restarted.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_CORRUPT');
  await unchangedMoney(f);
});
it.each(['book', 'origin', 'seal', 'evidence', 'outbox'] as const)(
  'missing original %s never authorizes a replacement checkpoint',
  async (kind) => {
    const f = await prepared(),
      h = await openBook();
    await h.initialize(f.c.owner, io());
    const tables = {
      book: 'ctp_portfolio.book',
      origin: 'ctp_paper.book_origin',
      seal: 'ctp_paper.book_origin_seal',
      evidence: 'ctp_portfolio.evidence',
      outbox: 'ctp_portfolio.outbox',
    };
    const column = kind === 'book' || kind === 'outbox' ? 'id' : 'book';
    await corrupt(`DELETE FROM ${tables[kind]} WHERE ${column}=$1`, [f.fundingId]);
    await expect(h.initialize(f.c.owner, io())).rejects.toThrow(
      kind === 'origin' ? 'PAPER_BOOK_INCOMPLETE' : 'PAPER_BOOK_CORRUPT',
    );
    await unchangedMoney(f);
  },
);
it('unproven existing book cannot be overwritten or adopted', async () => {
  const f = await prepared(),
    h = await openBook();
  const state = createState({
    tenantId: f.c.owner.tenantId,
    accountId: f.c.owner.accountId,
    mode: 'PAPER',
    connectionId: null,
    externalAccountId: f.binding.externalAccountId,
    walletId: 'unproven',
    scope: f.c.source,
  });
  const text = JSON.stringify(state);
  await admin.query(
    "INSERT INTO ctp_portfolio.book(\"tenantId\",\"accountId\",mode,wallet,state,state_hash) VALUES($1,$2,'PAPER','unproven',$3,sha256(convert_to($3,'UTF8')))",
    [f.c.owner.tenantId, f.c.owner.accountId, text],
  );
  await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_INCOMPLETE');
  expect(await count('ctp_portfolio.book', f)).toBe(1);
  await unchangedMoney(f);
});
it('later UNKNOWN order cannot export or regenerate seed balances', async () => {
  const f = await prepared(),
    h = await openBook();
  await h.initialize(f.c.owner, io());
  if (!f.order) throw new Error('DRAFT_REQUIRED');
  await admin.query('UPDATE public."order" SET status=\'UNKNOWN\' WHERE id=$1', [f.order.id]);
  await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_INCOMPLETE');
  await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_INCOMPLETE');
  await unchangedMoney(f);
});
it('other conserved monetary posting prevents bootstrap from ignoring economic history', async () => {
  const f = await prepared(),
    h = await openBook(),
    id = randomUUID(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query(
      'INSERT INTO public.ledger_transaction(id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode") VALUES($1::uuid,$2::uuid,$3::uuid,\'PAPER\',\'ADJUSTMENT\',($1::uuid)::text,now(),\'owned-fixture\')',
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
  await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_INCOMPLETE');
  expect(await count('ctp_portfolio.book', f)).toBe(0);
  expect(await count('public.ledger_transaction', f)).toBe(2);
});
it('physically lost acknowledged bootstrap COMMIT recovers one original checkpoint after restart without retry', async () => {
  const f = await prepared(),
    proxy = await registryCommitProxy(required('DATABASE_PAPER_BOOK_URL'), 'PAPER_BOOK');
  try {
    const h = await openBook(proxy.connectionString);
    proxy.arm();
    await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    const restarted = await openBook(),
      r = await restarted.read(f.c.owner, io());
    expect(await restarted.initialize(f.c.owner, io())).toEqual(r);
    for (const t of ['ctp_portfolio.book', 'ctp_portfolio.evidence', 'ctp_portfolio.outbox'])
      expect(await count(t, f)).toBe(1);
    await unchangedMoney(f);
  } finally {
    await proxy.close();
  }
});
it.each(['abort', 'deadline'] as const)(
  'hung account lock %s settles physically with no projection and reusable slot',
  async (kind) => {
    const f = await prepared(),
      h = await openBook(),
      lock = await admin.connect(),
      controller = new AbortController();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
        f.c.owner.accountId,
      ]);
      const start = Date.now(),
        pending = h.initialize(f.c.owner, io(controller.signal, kind === 'deadline' ? 120 : 2500));
      await wait(50);
      if (kind === 'abort') controller.abort();
      await expect(pending).rejects.toThrow('PAPER_BOOK_ABORTED');
      expect(Date.now() - start).toBeLessThan(1500);
      expect(await count('ctp_portfolio.book', f)).toBe(0);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    const r = await h.initialize(f.c.owner, io());
    expect(r.bookId).toBe(f.fundingId);
    await unchangedMoney(f);
  },
);
it('four physical bootstrap slots reject BUSY and become reusable only after abort settlement', async () => {
  const f = await prepared(),
    h = await openBook(),
    lock = await admin.connect(),
    controllers = Array.from({ length: 4 }, () => new AbortController());
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM public.exchange_account WHERE id=$1 FOR UPDATE', [
      f.c.owner.accountId,
    ]);
    const pending = controllers.map((c) => h.initialize(f.c.owner, io(c.signal)));
    const settled = Promise.allSettled(pending);
    await wait(50);
    await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_BUSY');
    controllers.forEach((c) => c.abort());
    const results = await settled;
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(await count('ctp_portfolio.book', f)).toBe(0);
  } finally {
    controllers.forEach((c) => c.abort());
    await lock.query('ROLLBACK');
    lock.release();
  }
  const r = await h.initialize(f.c.owner, io());
  expect(await h.read(f.c.owner, io())).toEqual(r);
  await unchangedMoney(f);
});
it.each(['LOGIN', 'TABLE', 'FUNCTION'] as const)(
  'SQL refuses newly added %s authority after startup',
  async (kind) => {
    const f = await prepared(),
      h = await openBook();
    const change =
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_book_initializer LOGIN'
        : kind === 'TABLE'
          ? 'GRANT SELECT ON ctp_portfolio.book TO ctp_paper_book_initializer'
          : 'GRANT EXECUTE ON FUNCTION ctp_paper.initialize_funding(text) TO ctp_paper_book_initializer';
    const restore =
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_book_initializer NOLOGIN'
        : kind === 'TABLE'
          ? 'REVOKE SELECT ON ctp_portfolio.book FROM ctp_paper_book_initializer'
          : 'REVOKE EXECUTE ON FUNCTION ctp_paper.initialize_funding(text) FROM ctp_paper_book_initializer';
    try {
      await admin.query(change);
      await expect(h.initialize(f.c.owner, io())).rejects.toThrow('PAPER_BOOK_ROLE_UNSAFE');
      expect(await count('ctp_portfolio.book', f)).toBe(0);
    } finally {
      await admin.query(restore);
    }
    await unchangedMoney(f);
  },
);
it('ordinary initial reader remains fail closed and native Portfolio writer cannot gain PAPER authority', async () => {
  const f = await prepared(),
    h = await openBook(),
    r = await h.initialize(f.c.owner, io());
  const initial = await createPostgresPaperInitialPortfolio({
    connectionString: required('DATABASE_PAPER_PORTFOLIO_URL'),
    environment: 'test',
  });
  handles.push(initial);
  await expect(initial.read(f.c.owner, io())).rejects.toThrow('PAPER_PORTFOLIO_INCOMPLETE');
  const native = await createPostgresPortfolioStore({
    connectionString: required('DATABASE_PORTFOLIO_URL'),
    environment: 'test',
  });
  handles.push(native);
  expect(() => native.read(r.state.binding, io())).toThrow('PORTFOLIO_BINDING_DENIED');
  await unchangedMoney(f);
});
