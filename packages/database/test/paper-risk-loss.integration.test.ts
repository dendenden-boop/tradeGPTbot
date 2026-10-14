import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import * as portfolio from '@ctp/paper-engine/portfolio';
import {
  createPostgresPaperConfiguration,
  paperConfigurationSchema,
  type PaperOwner,
} from '@ctp/paper-engine/configuration';
import { createPostgresPaperFunding, paperFundingSchema } from '@ctp/paper-engine/funding';
import { reconstructUtcLoss, type UtcLossEvidence } from '@ctp/risk-engine';
import { frameFixture } from '../../paper-engine/test/frame-fixture.js';
import { setTimeout as wait } from 'node:timers/promises';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import { bindingSchema, draftSchema, createPostgresOrderStore } from '@ctp/order-engine';
import { state } from '../../order-engine/test/fixtures.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_PAPER_LOSS_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_PAPER_LOSS_VARIABLE_REQUIRED');
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
async function prepared(
  options: { owner?: PaperOwner; quote?: string; amount?: string; nonquote?: boolean } = {},
) {
  const raw = frameFixture().configuration.configuration;
  const c = paperConfigurationSchema.parse({
    ...raw,
    owner: options.owner ?? raw.owner,
    valuationAsset: options.quote ?? raw.valuationAsset,
  });
  if (!options.owner)
    await admin.query(
      'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
      [c.owner.tenantId, c.owner.tenantId + '@example.invalid'],
    );
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'paper-loss-epoch\',now())',
    [
      c.owner.accountId,
      c.owner.tenantId,
      c.source.exchange,
      'paper:' + c.owner.accountId,
      c.source.region,
    ],
  );
  const config = await createPostgresPaperConfiguration({
    connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),
    environment: 'test',
  });
  try {
    await config.register(c, io());
  } finally {
    await config.close();
  }
  const funding = await createPostgresPaperFunding({
    connectionString: required('DATABASE_PAPER_FUNDING_URL'),
    environment: 'test',
  });
  let receipt;
  try {
    receipt = await funding.initialize(
      paperFundingSchema.parse({
        id: randomUUID(),
        owner: c.owner,
        configurationId: c.id,
        balances: [
          { asset: options.nonquote ? 'BTC' : c.valuationAsset, amount: options.amount ?? '1000' },
        ],
      }),
      io(),
    );
  } finally {
    await funding.close();
  }
  const book = await portfolio.createPostgresPaperPortfolioBootstrap({
    connectionString: required('DATABASE_PAPER_BOOK_URL'),
    environment: 'test',
  });
  try {
    await book.initialize(c.owner, io());
  } finally {
    await book.close();
  }
  return { c, receipt };
}
async function effects(owner: PaperOwner) {
  return (
    await admin.query<{
      ledger: number;
      entries: number;
      intents: number;
      decisions: number;
      reservations: number;
      evidence: number;
      outbox: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM public.ledger_transaction WHERE "tenantId"=$1) ledger,
        (SELECT count(*)::int FROM public.ledger_entry WHERE "tenantId"=$1) entries,
        (SELECT count(*)::int FROM public.order_intent WHERE "tenantId"=$1) intents,
        (SELECT count(*)::int FROM public.risk_decision WHERE "tenantId"=$1) decisions,
        (SELECT count(*)::int FROM public.risk_reservation WHERE "tenantId"=$1) reservations,
        (SELECT count(*)::int FROM ctp_portfolio.evidence WHERE "tenantId"=$1) evidence,
        (SELECT count(*)::int FROM ctp_portfolio.outbox WHERE "tenantId"=$1) outbox`,
      [owner.tenantId],
    )
  ).rows;
}
type Reader = {
  read(
    owner: PaperOwner,
    context: ReturnType<typeof io>,
  ): Promise<{
    kind: string;
    asOf: number;
    actualEquity: string;
    validUntil: number;
    inventory: portfolio.PaperRiskPortfolioSource;
    evidence: UtcLossEvidence;
  }>;
  close(): Promise<void>;
};
it('production PAPER cash loss derives UTC opening and flows from retained quote books without a second financial effect', async () => {
  const f = await prepared(),
    before = await effects(f.c.owner),
    factory = (portfolio as Record<string, unknown>)['createPostgresPaperRiskLossSource'];
  expect(typeof factory).toBe('function');
  const source = await (
    factory as (options: { connectionString: string; environment: 'test' }) => Promise<Reader>
  )({
    connectionString: required('DATABASE_PAPER_RISK_LOSS_URL'),
    environment: 'test',
  });
  handles.push(source);
  const result = await source.read(f.c.owner, io()),
    dayStart = Math.floor(result.asOf / 86400000) * 86400000,
    prior = f.receipt.createdAt < dayStart,
    scope = {
      tenantId: f.c.owner.tenantId,
      mode: 'PAPER' as const,
      valuationAsset: f.c.valuationAsset,
    };
  expect(result).toMatchObject({
    kind: 'PAPER_RISK_LOSS_SOURCE',
    evidence: {
      scope,
      complete: true,
      utcDayStart: dayStart,
      opening: { equity: prior ? '1000' : '0' },
    },
  });
  expect(reconstructUtcLoss(result.evidence, scope, result.asOf, 5000)).toMatchObject({
    adjustedOpeningEquity: prior ? '1000' : '0',
    adjustedCurrentEquity: prior ? '1000' : '0',
    adjustedPeakEquity: prior ? '1000' : '0',
    externalFlows: prior ? '0' : '1000',
    dailyNetRealizedPnl: '0',
  });
  expect(result).not.toHaveProperty('grant');
  expect(result).not.toHaveProperty('reservationId');
  expect(await effects(f.c.owner)).toEqual(before);
});

async function openLoss(connectionString = required('DATABASE_PAPER_RISK_LOSS_URL')) {
  const factory = (portfolio as Record<string, unknown>)['createPostgresPaperRiskLossSource'];
  expect(typeof factory).toBe('function');
  const h = await (
    factory as (options: { connectionString: string; environment: 'test' }) => Promise<Reader>
  )({ connectionString, environment: 'test' });
  handles.push(h);
  return h;
}
it('cash loss concurrent reads and restart reconstruct each original seed once without monetary effects', async () => {
  const f = await prepared({ amount: '9007199254740993.000000000000000001' });
  await prepared({
    owner: { ...f.c.owner, accountId: randomUUID() },
    amount: '0.000000000000000001',
  });
  const before = await effects(f.c.owner),
    h = await openLoss();
  const captures = await Promise.all(Array.from({ length: 4 }, () => h.read(f.c.owner, io())));
  for (const r of captures) {
    expect(r.actualEquity).toBe('9007199254740993.000000000000000002');
    expect(r.inventory.accounts).toHaveLength(2);
    expect(r.evidence.events.filter((e) => e.kind === 'FLOW')).toHaveLength(2);
  }
  await h.close();
  const r = await (await openLoss()).read(f.c.owner, io());
  expect(r.inventory.hash).toBe(captures[0]!.inventory.hash);
  expect(r.evidence.opening).toEqual(captures[0]!.evidence.opening);
  expect(r.evidence.events.filter((e) => e.kind === 'FLOW')).toEqual(
    captures[0]!.evidence.events.filter((e) => e.kind === 'FLOW'),
  );
  expect(await effects(f.c.owner)).toEqual(before);
});
it.each(['nonquote', 'mixed-quote', 'disabled', 'unconfigured', 'extra-posting'] as const)(
  'cash loss %s evidence rejects the entire inventory without a partial opening',
  async (kind) => {
    const f = await prepared({ nonquote: kind === 'nonquote' });
    if (kind === 'mixed-quote')
      await prepared({ owner: { ...f.c.owner, accountId: randomUUID() }, quote: 'USD' });
    if (kind === 'disabled')
      await admin.query("UPDATE public.exchange_account SET status='DISABLED' WHERE id=$1", [
        f.c.owner.accountId,
      ]);
    if (kind === 'unconfigured') {
      const id = randomUUID();
      await admin.query(
        'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'cash-loss-sibling\',now())',
        [id, f.c.owner.tenantId, f.c.source.exchange, 'paper:' + id, f.c.source.region],
      );
    }
    if (kind === 'extra-posting') {
      const id = randomUUID(),
        p = await admin.connect();
      try {
        await p.query('BEGIN');
        await p.query(
          'INSERT INTO public.ledger_transaction(id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode") VALUES($1,$2,$3,\'PAPER\',\'ADJUSTMENT\',$4,now(),\'cash-loss-fixture\')',
          [id, f.c.owner.tenantId, f.c.owner.accountId, id],
        );
        await p.query(
          "INSERT INTO public.ledger_entry(id,\"tenantId\",\"transactionId\",\"accountId\",mode,\"entryIndex\",asset,bucket,amount) VALUES($1,$2,$3,$4,'PAPER',0,'USDT','AVAILABLE',1),($5,$2,$3,$4,'PAPER',1,'USDT','EXTERNAL',-1)",
          [randomUUID(), f.c.owner.tenantId, id, f.c.owner.accountId, randomUUID()],
        );
        await p.query('COMMIT');
      } finally {
        await p.query('ROLLBACK');
        p.release();
      }
    }
    const before = await effects(f.c.owner);
    await expect((await openLoss()).read(f.c.owner, io())).rejects.toThrow(
      /PAPER_RISK_LOSS_(CASH_ONLY|INCOMPLETE|CORRUPT|OWNERSHIP|MISSING)/,
    );
    expect(await effects(f.c.owner)).toEqual(before);
  },
);
it('funded cash history cannot be removed or retargeted across mode or ownership after restart', async () => {
  const f = await prepared(),
    h = await openLoss(),
    before = await effects(f.c.owner);
  await h.read(f.c.owner, io());
  await h.close();
  const otherTenant = randomUUID();
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"emailVerifiedAt","updatedAt") VALUES($1,$2,\'ACTIVE\',now(),now())',
    [otherTenant, otherTenant + '@example.invalid'],
  );
  for (const sql of [
    'DELETE FROM public.exchange_account WHERE id=$1',
    "UPDATE public.exchange_account SET mode='DEMO' WHERE id=$1",
  ])
    await expect(admin.query(sql, [f.c.owner.accountId])).rejects.toThrow();
  await expect(
    admin.query('UPDATE public.exchange_account SET "tenantId"=$2 WHERE id=$1', [
      f.c.owner.accountId,
      otherTenant,
    ]),
  ).rejects.toThrow(/foreign key/);
  expect((await (await openLoss()).read(f.c.owner, io())).actualEquity).toBe('1000');
  expect(await effects(f.c.owner)).toEqual(before);
});
it('the immutable cash funding seal cannot be rewritten before restart recapture', async () => {
  const f = await prepared(),
    h = await openLoss(),
    before = await effects(f.c.owner);
  await h.read(f.c.owner, io());
  await h.close();
  await expect(
    admin.query(
      "UPDATE ctp_paper.funding_seal SET receipt_hash=decode(repeat('00',32),'hex') WHERE id=$1",
      [f.receipt.funding.id],
    ),
  ).rejects.toThrow();
  expect((await (await openLoss()).read(f.c.owner, io())).actualEquity).toBe('1000');
  expect(await effects(f.c.owner)).toEqual(before);
});
it('an UNKNOWN common PAPER order invalidates cash loss evidence without releasing or reseeding balances', async () => {
  const f = await prepared(),
    frame = frameFixture(),
    i = frame.p.record.instrument,
    r = frame.p.record.rules;
  i.scope = r.scope = { ...f.c.source };
  await admin.query(
    'INSERT INTO public.instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1,$2,\'SPOT\',$3,$4,$5,$6,true,now())',
    [
      frame.p.key.dbInstrumentId,
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
      frame.p.key.dbRuleId,
      frame.p.key.dbInstrumentId,
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
  const orders = await createPostgresOrderStore({
    connectionString: required('DATABASE_EXECUTION_URL'),
    environment: 'test',
  });
  handles.push(orders);
  const binding = bindingSchema.parse({
    ...f.c.owner,
    connectionId: null,
    externalAccountId: 'paper:' + f.c.owner.accountId,
    profile: {
      ...f.c.source,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: f.c.model.version,
    },
  });
  const draft = draftSchema.parse({
    ...state().draft,
    key: randomUUID(),
    dbInstrumentId: frame.p.key.dbInstrumentId,
    dbRuleId: frame.p.key.dbRuleId,
    order: {
      ...state().draft.order,
      instrumentId: i.id,
      ruleVersion: r.version,
      size: { kind: 'BASE_QUANTITY', asset: i.baseAsset, value: '0.5' },
    },
  });
  const order = await orders.create(binding, draft, io()),
    h = await openLoss();
  expect((await h.read(f.c.owner, io())).inventory.accounts[0]!.drafts).toHaveLength(1);
  await admin.query('UPDATE public."order" SET status=\'UNKNOWN\' WHERE id=$1', [order.id]);
  const before = await effects(f.c.owner);
  await h.close();
  await expect((await openLoss()).read(f.c.owner, io())).rejects.toThrow(
    'PAPER_RISK_LOSS_INCOMPLETE',
  );
  expect(await effects(f.c.owner)).toEqual(before);
});
it.each(['abort', 'deadline'] as const)(
  'hung cash source %s settles physically and makes its slot reusable',
  async (kind) => {
    const f = await prepared(),
      h = await openLoss(),
      p = await admin.connect(),
      controller = new AbortController();
    try {
      await p.query('BEGIN');
      await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [
        f.receipt.funding.id,
      ]);
      const rejected = expect(
        h.read(f.c.owner, io(controller.signal, kind === 'deadline' ? 150 : 2500)),
      ).rejects.toThrow('PAPER_RISK_LOSS_ABORTED');
      await wait(50);
      const start = Date.now();
      if (kind === 'abort') controller.abort();
      await rejected;
      expect(Date.now() - start).toBeLessThan(1500);
    } finally {
      controller.abort();
      await p.query('ROLLBACK');
      p.release();
    }
    expect((await h.read(f.c.owner, io())).actualEquity).toBe('1000');
  },
);
it('four cash source sockets bound hung captures and close drains them before restart', async () => {
  const f = await prepared(),
    h = await openLoss(),
    p = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query('SELECT id FROM ctp_portfolio.book WHERE id=$1 FOR UPDATE', [
      f.receipt.funding.id,
    ]);
    const settled = Promise.allSettled(Array.from({ length: 4 }, () => h.read(f.c.owner, io())));
    await wait(60);
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_LOSS_BUSY');
    await h.close();
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_LOSS_CLOSED');
  } finally {
    await p.query('ROLLBACK');
    p.release();
  }
  expect((await (await openLoss()).read(f.c.owner, io())).actualEquity).toBe('1000');
});
it('lost acknowledged cash source COMMIT yields no evidence and restart recaptures without another monetary effect', async () => {
  const f = await prepared(),
    before = await effects(f.c.owner),
    proxy = await registryCommitProxy(required('DATABASE_PAPER_RISK_LOSS_URL'), 'PAPER_RISK_LOSS');
  try {
    const h = await openLoss(proxy.connectionString);
    proxy.arm();
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_LOSS_UNCERTAIN');
    expect(proxy.dropped()).toBe(1);
    await h.close();
    expect((await (await openLoss()).read(f.c.owner, io())).actualEquity).toBe('1000');
    expect(await effects(f.c.owner)).toEqual(before);
  } finally {
    await proxy.close();
  }
});
it('cash capture closes the tenant account catalog until transaction settlement', async () => {
  const f = await prepared(),
    runtime = new Pool({
      connectionString: required('DATABASE_PAPER_RISK_LOSS_URL'),
      max: 1,
      query_timeout: 3000,
    });
  const p = await runtime.connect(),
    insert = await admin.connect();
  try {
    await p.query('BEGIN');
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [f.c.owner.tenantId]);
    await p.query('SELECT ctp_paper.capture_risk_loss($1::jsonb)', [JSON.stringify(f.c.owner)]);
    await insert.query('BEGIN');
    await insert.query("SET LOCAL lock_timeout='100ms'");
    const id = randomUUID();
    await expect(
      insert.query(
        'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'SIMULATED\',\'ACTIVE\',\'loss-catalog\',now())',
        [id, f.c.owner.tenantId, f.c.source.exchange, 'paper:' + id, f.c.source.region],
      ),
    ).rejects.toThrow(/lock timeout/);
    await p.query('COMMIT');
  } finally {
    await insert.query('ROLLBACK');
    insert.release();
    await p.query('ROLLBACK');
    p.release();
    await runtime.end();
  }
  expect((await (await openLoss()).read(f.c.owner, io())).inventory.accounts).toHaveLength(1);
});
it('cash inventory capacity rejects the whole catalog instead of accepting a bounded subset', async () => {
  const f = await prepared();
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","updatedAt") SELECT gen_random_uuid(),$1,$2::public."Exchange",\'PAPER\',\'paper:over-capacity-\'||n,$3,\'SIMULATED\',\'ACTIVE\',\'loss-capacity\',now() FROM generate_series(1,100)n',
    [f.c.owner.tenantId, f.c.source.exchange, f.c.source.region],
  );
  await expect((await openLoss()).read(f.c.owner, io())).rejects.toThrow(
    'PAPER_RISK_LOSS_CAPACITY',
  );
});
it('caller opening or subset and a different owner cannot enter the fixed cash capture', async () => {
  const f = await prepared(),
    h = await openLoss();
  await expect(
    h.read(
      { ...f.c.owner, opening: '1000', accountIds: [f.c.owner.accountId] } as PaperOwner,
      io(),
    ),
  ).rejects.toThrow('PAPER_RISK_LOSS_INPUT');
  await expect(h.read({ ...f.c.owner, tenantId: randomUUID() }, io())).rejects.toThrow(
    'PAPER_RISK_LOSS_OWNERSHIP',
  );
  await expect(openLoss(required('DATABASE_PAPER_RISK_PORTFOLIO_URL'))).rejects.toThrow(
    'PAPER_RISK_LOSS_ROLE_UNSAFE',
  );
});
it.each(['LOGIN', 'TABLE', 'FUNCTION'] as const)(
  'cash capture refuses additional %s authority after factory startup',
  async (kind) => {
    const f = await prepared(),
      h = await openLoss();
    const grant =
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_risk_loss LOGIN'
        : kind === 'TABLE'
          ? 'GRANT SELECT ON ctp_portfolio.book TO ctp_paper_risk_loss'
          : 'GRANT EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb) TO ctp_paper_risk_loss';
    const revoke =
      kind === 'LOGIN'
        ? 'ALTER ROLE ctp_paper_risk_loss NOLOGIN'
        : kind === 'TABLE'
          ? 'REVOKE SELECT ON ctp_portfolio.book FROM ctp_paper_risk_loss'
          : 'REVOKE EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb) FROM ctp_paper_risk_loss';
    try {
      await admin.query(grant);
      await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_LOSS_ROLE_UNSAFE');
    } finally {
      await admin.query(revoke);
    }
  },
);
it.each(['trade', 'funding'] as const)(
  'unposted native %s evidence cannot certify zero cash loss',
  async (kind) => {
    const f = await prepared(),
      instrument = randomUUID();
    await admin.query(
      'INSERT INTO public.instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1,$2,\'SPOT\',$3,$4,\'BTC\',\'USDT\',true,now())',
      [instrument, f.c.source.exchange, f.c.source.environment, 'cash-loss-evidence-' + instrument],
    );
    if (kind === 'trade')
      await admin.query(
        'INSERT INTO public.trade(id,"tenantId","accountId",mode,"instrumentId","positionSide","pnlAsset","grossPnl","netPnl","openedAt") VALUES($1,$2,$3,\'PAPER\',$4,\'LONG\',\'USDT\',-10,-10,now())',
        [randomUUID(), f.c.owner.tenantId, f.c.owner.accountId, instrument],
      );
    else
      await admin.query(
        'INSERT INTO public.funding_payment(id,"tenantId","accountId",mode,"instrumentId","paymentIdentity",asset,amount,rate,timestamp,"receivedAt") VALUES($1,$2,$3,\'PAPER\',$4,$5,\'USDT\',-10,-0.01,now(),now())',
        [randomUUID(), f.c.owner.tenantId, f.c.owner.accountId, instrument, randomUUID()],
      );
    const before = await effects(f.c.owner),
      h = await openLoss();
    await expect(h.read(f.c.owner, io())).rejects.toThrow('PAPER_RISK_LOSS_INCOMPLETE');
    expect(await effects(f.c.owner)).toEqual(before);
  },
);
