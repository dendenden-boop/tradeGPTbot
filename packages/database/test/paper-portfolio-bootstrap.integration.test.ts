import * as paperPortfolio from '@ctp/paper-engine/portfolio';
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
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await admin.end();
});
async function open() {
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

it('funded PAPER with a common draft bootstraps one durable shared Portfolio checkpoint without a second ledger effect', async () => {
  const f = await fixture(),
    store = await open();
  const funding = await createPostgresPaperFunding({
    connectionString: required('DATABASE_PAPER_FUNDING_URL'),
    environment: 'test',
  });
  const fundingId = randomUUID();
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
  const order = await store.create(f.binding, f.draft, io());
  // Exercise real funding and common draft first. The missing production port is
  // the RED prerequisite; no permissive substitute or fake writer is installed.
  const factory: unknown = Reflect.get(paperPortfolio, 'createPostgresPaperPortfolioBootstrap');
  expect(factory).toBeTypeOf('function');
  if (typeof factory !== 'function') throw new Error('PAPER_BOOK_IMPLEMENTATION_REQUIRED');
  const bootstrap = await (
    factory as (o: { connectionString: string; environment: 'test' }) => Promise<{
      initialize(
        o: typeof f.c.owner,
        c: ReturnType<typeof io>,
      ): Promise<{ bookId: string; state: { balances: unknown } }>;
      close(): Promise<void>;
    }>
  )({ connectionString: required('DATABASE_PAPER_BOOK_URL'), environment: 'test' });
  handles.push(bootstrap);
  const receipt = await bootstrap.initialize(f.c.owner, io());
  expect(receipt.bookId).toBe(fundingId);
  expect(receipt.state.balances).toEqual([
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
  expect(
    (
      await admin.query(
        'SELECT count(*)::int n FROM public.ledger_transaction WHERE "accountId"=$1',
        [f.c.owner.accountId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await admin.query('SELECT count(*)::int n FROM public.ledger_entry WHERE "accountId"=$1', [
        f.c.owner.accountId,
      ])
    ).rows[0].n,
  ).toBe(4);
  for (const table of ['ctp_portfolio.book', 'ctp_portfolio.evidence', 'ctp_portfolio.outbox'])
    expect(
      (
        await admin.query('SELECT count(*)::int n FROM ' + table + ' WHERE "accountId"=$1', [
          f.c.owner.accountId,
        ])
      ).rows[0].n,
    ).toBe(1);
  expect((await store.read(f.binding, order.id, io())).command).toEqual(order.command);
});
