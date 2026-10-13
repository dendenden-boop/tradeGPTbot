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
