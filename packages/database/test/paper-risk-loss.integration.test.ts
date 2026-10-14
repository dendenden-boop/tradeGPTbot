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
async function prepared() {
  const c = paperConfigurationSchema.parse(frameFixture().configuration.configuration);
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
        balances: [{ asset: c.valuationAsset, amount: '1000' }],
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
