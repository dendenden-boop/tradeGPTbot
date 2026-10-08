import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPostgresPortfolioStore, type PortfolioStore } from '@ctp/portfolio';
import {
  createPostgresOrderStore,
  bindingSchema as orderBindingSchema,
  type OrderStore,
} from '@ctp/order-engine';
import {
  createPostgresInstrumentRegistry,
  createPostgresMarketSnapshots,
  marketSnapshotPublicationSchema,
  type DurableMarketSnapshots,
} from '@ctp/market-data';
import {
  createPostgresRiskSnapshotStore,
  createRiskSnapshotCoordinator,
  createPostgresRiskObservations,
  createPostgresPolicies,
  createPostgresLossJournal,
  riskLimitsSchema,
  riskNativeObservationSchema,
  type PostgresPolicies,
} from '@ctp/risk-engine';
import { parseDecimal } from '@ctp/exchange-core';
import { captureFixture } from '../../risk-engine/test/snapshot-fixtures.js';
import { binding, snapshot } from '../../portfolio/test/fixtures.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_CERTIFIED_SOURCE_RUNNER_REQUIRED');
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('ISOLATED_CERTIFIED_SOURCE_VARIABLE_REQUIRED');
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
const options = (key: string) => ({
  connectionString: required(key),
  environment: 'test' as const,
});
let portfolio: PortfolioStore,
  orders: OrderStore,
  market: DurableMarketSnapshots,
  platform: PostgresPolicies,
  user: PostgresPolicies,
  loss: Awaited<ReturnType<typeof createPostgresLossJournal>>,
  observer: Awaited<ReturnType<typeof createPostgresRiskObservations>>;
const handles: { close(): Promise<void> }[] = [];
beforeAll(async () => {
  portfolio = await createPostgresPortfolioStore(options('DATABASE_PORTFOLIO_URL'));
  orders = await createPostgresOrderStore(options('DATABASE_EXECUTION_URL'));
  market = await createPostgresMarketSnapshots(options('DATABASE_MARKET_SNAPSHOT_URL'));
  platform = await createPostgresPolicies({
    ...options('DATABASE_RISK_POLICY_OPERATOR_URL'),
    authority: 'PLATFORM',
  });
  user = await createPostgresPolicies({
    ...options('DATABASE_RISK_POLICY_CONTROLLER_URL'),
    authority: 'USER',
  });
  loss = await createPostgresLossJournal(options('DATABASE_RISK_EVIDENCE_URL'));
  observer = await createPostgresRiskObservations(options('DATABASE_RISK_OBSERVATION_URL'));
  handles.push(portfolio, orders, market, platform, user, loss, observer);
});
afterAll(async () => {
  for (const h of handles.splice(0)) await h.close();
  await admin.end();
});
async function open() {
  const s = await createPostgresRiskSnapshotStore(options('DATABASE_RISK_CERTIFICATION_URL'));
  handles.push(s);
  return {
    store: s,
    coordinator: createRiskSnapshotCoordinator({ store: s, now: () => Date.now() }),
  };
}
async function fixture(missing?: 'OBSERVATION' | 'LOSS') {
  const identities = {
      tenantId: randomUUID(),
      accountId: randomUUID(),
      connectionId: randomUUID(),
    },
    f = captureFixture(identities),
    i = f.risk.record.instrument,
    r = f.risk.record.rules;
  f.key.instrumentId = f.key.dbInstrumentId;
  i.id = f.key.instrumentId;
  i.exchangeSymbol = i.id;
  i.metadataVersion = randomUUID();
  r.instrumentId = i.id;
  r.version = randomUUID();
  f.risk.order.instrumentId = i.id;
  f.risk.order.ruleVersion = r.version;
  f.publication.key.instrumentId = i.id;
  f.publication.ticker.instrumentId = i.id;
  f.publication.book.instrumentId = i.id;
  f.observation.key.instrumentId = i.id;
  f.rehashMarket();
  f.rehashObservation();
  const b = f.key.binding;
  await admin.query(
    'INSERT INTO public."user"(id,"emailNormalized",status,"updatedAt") VALUES($1,$2,\'ACTIVE\',now())',
    [b.tenantId, b.tenantId + '@example.invalid'],
  );
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","permissionEpoch","updatedAt") VALUES($1,$2,\'BINANCE\',\'TESTNET\',$3,\'global\',\'SPOT\',\'ACTIVE\',\'certificate\',1,now())',
    [b.accountId, b.tenantId, b.externalAccountId],
  );
  await admin.query(
    'INSERT INTO public.exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"permissionsVersion","permissionsVerifiedAt","updatedAt") VALUES($1,$2,$3,\'TESTNET\',\'certificate\',\'ACTIVE\',\'{"read":true,"trade":true,"withdrawal":false}\',1,now(),now())',
    [b.connectionId, b.tenantId, b.accountId],
  );
  await admin.query(
    "INSERT INTO public.instrument(id,exchange,market,mode,\"exchangeSymbol\",\"baseAsset\",\"quoteAsset\",active,\"updatedAt\") VALUES($1,'BINANCE','SPOT','TESTNET',$2,'BTC','USDT',true,now())",
    [f.key.dbInstrumentId, i.exchangeSymbol],
  );
  await admin.query(
    'INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"isCurrent","effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity","maxQuantity","minNotional",rules) VALUES($1,$2,1,true,$3,now(),$4,$5,$6,$7,$8,$9,$10::jsonb)',
    [
      f.key.dbRuleId,
      f.key.dbInstrumentId,
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
  await admin.query(
    "INSERT INTO public.capability_snapshot(id,exchange,market,mode,region,\"accountMode\",version,\"profileVersion\",\"verifiedAt\",\"expiresAt\",capabilities,\"evidenceHash\") SELECT $1::uuid,'BINANCE','SPOT','TESTNET','global','SPOT',COALESCE(max(version),0)+1,$2,now(),now()+interval '1 hour',$3::jsonb,$4 FROM public.capability_snapshot WHERE exchange='BINANCE' AND market='SPOT' AND mode='TESTNET' AND region='global' AND \"accountMode\"='SPOT'",
    [
      f.key.dbCapabilityId,
      b.profile.profileVersion,
      JSON.stringify({ adapterVersion: f.risk.adapterVersion, features: f.risk.capabilities }),
      Buffer.alloc(32, 1),
    ],
  );
  const registry = await createPostgresInstrumentRegistry({
    ...options('DATABASE_INSTRUMENT_REGISTRY_URL'),
    scope: i.scope,
    instrumentIds: [i.id],
  });
  try {
    expect((await registry.putBatch([f.risk.record], Date.now(), io())).ok).toBe(true);
  } finally {
    await registry.close();
  }
  await portfolio.apply(
    { ...binding(), ...identities },
    snapshot({ id: randomUUID(), timestamp: f.now }),
    0,
    io(),
  );
  const { clientOrderId: omitted, ...order } = f.risk.order;
  void omitted;
  const created = await orders.create(
    orderBindingSchema.parse(b),
    {
      key: randomUUID(),
      dbInstrumentId: f.key.dbInstrumentId,
      dbRuleId: f.key.dbRuleId,
      positionSide: 'NET',
      bucket: 'CROSS',
      order,
    },
    io(),
  );
  f.key.intentId = created.intentId;
  f.raw.intent.id = created.intentId;
  f.raw.intent.command = created.command;
  const p =
    (
      await admin.query<{ version: string }>(
        "SELECT version::text FROM ctp_risk.policy_head WHERE scope='PLATFORM' AND mode='TESTNET'",
      )
    ).rows[0]?.version ?? '0';
  await platform.update(
    {
      scope: { kind: 'PLATFORM' },
      mode: 'TESTNET',
      eventId: randomUUID(),
      expectedVersion: p,
      reason: 'ISOLATED_CERTIFICATION_FIXTURE',
      limits: riskLimitsSchema.parse(f.risk.platform),
    },
    io(),
  );
  await user.update(
    {
      scope: { kind: 'USER', tenantId: b.tenantId },
      mode: 'TESTNET',
      eventId: randomUUID(),
      expectedVersion: '0',
      reason: 'ISOLATED_CERTIFICATION_FIXTURE',
      limits: riskLimitsSchema.parse(f.risk.user),
    },
    io(),
  );
  const day = Math.floor(f.now / 86400000) * 86400000;
  if (missing !== 'LOSS')
    await loss.append(
      {
        scope: { tenantId: b.tenantId, mode: 'TESTNET', valuationAsset: 'USDT' },
        dayStart: day,
        id: randomUUID(),
        expectedSequence: '0',
        opening: {
          at: day,
          equity: parseDecimal('1000'),
          sourceId: randomUUID(),
          sourceHash: 'a'.repeat(64),
        },
        coveredThrough: f.now,
        events: [{ id: randomUUID(), at: f.now, kind: 'EQUITY', amount: parseDecimal('1000') }],
        coverage: { from: day, through: f.now, sourceId: randomUUID(), sourceHash: 'b'.repeat(64) },
      },
      io(),
    );
  await market.publish(marketSnapshotPublicationSchema.parse(f.publication), io());
  const observationEvent = {
    id: randomUUID(),
    expectedRevision: '0',
    observation: riskNativeObservationSchema.parse(f.observation),
  };
  const observed =
    missing === 'OBSERVATION' ? undefined : await observer.publish(observationEvent, io());
  return { ...f, created, observed, observationEvent };
}
it('certifies all nine current durable families, reads after restart and creates no Risk grant/reservation or monetary ledger effect', async () => {
  const f = await fixture(),
    { store, coordinator } = await open();
  const before = (
    await admin.query<{ n: number }>(
      'SELECT count(*)::int n FROM public.ledger_transaction WHERE "tenantId"=$1',
      [f.key.binding.tenantId],
    )
  ).rows[0]!.n;
  const c = await coordinator.certify(f.key, io());
  expect(c.projection.sources).toHaveLength(9);
  expect(c.projection.key).toEqual(f.key);
  expect(c.projection.snapshot.availableAmount).toBe('1000');
  expect(c).not.toHaveProperty('decisionId');
  await store.close();
  const restarted = await open();
  expect(await restarted.coordinator.readCurrent(f.key, io())).toEqual(c);
  expect(
    (
      await admin.query('SELECT id FROM public.risk_reservation WHERE "tenantId"=$1', [
        f.key.binding.tenantId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM public.ledger_transaction WHERE "tenantId"=$1',
        [f.key.binding.tenantId],
      )
    ).rows[0]!.n,
  ).toBe(before);
});
it('re-reads current permission revision and rejects replacement before returning a historical certificate', async () => {
  const f = await fixture(),
    { coordinator } = await open();
  await coordinator.certify(f.key, io());
  await admin.query(
    'UPDATE public.exchange_connection SET "permissionsVersion"="permissionsVersion"+1 WHERE id=$1',
    [f.key.binding.connectionId],
  );
  await expect(coordinator.readCurrent(f.key, io())).rejects.toThrow(/^RISK_/);
});
it('cannot invent zero exposure for an unresolved legacy pending order', async () => {
  const f = await fixture(),
    { coordinator } = await open();
  await admin.query(
    'UPDATE public."order" SET status=\'UNKNOWN\',version=version+1 WHERE "tenantId"=$1 AND id=$2',
    [f.key.binding.tenantId, f.created.id],
  );
  await expect(coordinator.certify(f.key, io())).rejects.toThrow('RISK_SNAPSHOT_UNISSUED_EXPOSURE');
});
it('allocates permanent ordered certificate identities across concurrent writers and restart', async () => {
  const f = await fixture(),
    first = await open(),
    second = await open();
  const results = await Promise.all([
    first.coordinator.certify(f.key, io()),
    second.coordinator.certify(f.key, io()),
  ]);
  expect(new Set(results.map((c) => c.id)).size).toBe(2);
  expect(results.map((c) => c.revision).sort()).toEqual(['1', '2']);
  await first.store.close();
  await second.store.close();
  const restarted = await open(),
    third = await restarted.coordinator.certify(f.key, io());
  expect(third.revision).toBe('3');
  expect(results.map((c) => c.id)).not.toContain(third.id);
  expect(await restarted.coordinator.readCurrent(f.key, io())).toEqual(third);
  expect(
    (
      await admin.query('SELECT id FROM ctp_certification.certificate WHERE "tenantId"=$1', [
        f.key.binding.tenantId,
      ])
    ).rowCount,
  ).toBe(3);
});
it.each(['POLICY', 'REGISTRY', 'MARKET_GAP', 'DISABLED_CONNECTION'] as const)(
  'rejects historical certification after current %s source replacement',
  async (kind) => {
    const f = await fixture(),
      { coordinator } = await open();
    await coordinator.certify(f.key, io());
    if (kind === 'POLICY')
      await user.update(
        {
          scope: { kind: 'USER', tenantId: f.key.binding.tenantId },
          mode: 'TESTNET',
          eventId: randomUUID(),
          expectedVersion: '1',
          reason: 'CURRENT_POLICY_REPLACEMENT',
          limits: riskLimitsSchema.parse({ ...f.risk.user, maxOrderNotional: '1' }),
        },
        io(),
      );
    else if (kind === 'REGISTRY') {
      const registry = await createPostgresInstrumentRegistry({
        ...options('DATABASE_INSTRUMENT_REGISTRY_URL'),
        scope: f.risk.record.instrument.scope,
        instrumentIds: [f.key.instrumentId],
      });
      try {
        const replaced = structuredClone(f.risk.record);
        replaced.instrument.metadataVersion = randomUUID();
        replaced.rules.version = randomUUID();
        expect((await registry.putBatch([replaced], Date.now(), io())).ok).toBe(true);
      } finally {
        await registry.close();
      }
    } else if (kind === 'MARKET_GAP')
      await market.publish(
        {
          id: randomUUID(),
          kind: 'GAP',
          key: f.publication.key,
          expectedRevision: '1',
          timestamp: Date.now(),
          reason: 'INDEPENDENT_NATIVE_GAP',
        },
        io(),
      );
    else if (kind === 'DISABLED_CONNECTION')
      await admin.query(
        "UPDATE public.exchange_connection SET status='DISABLED',version=version+1 WHERE id=$1",
        [f.key.binding.connectionId],
      );
    await expect(coordinator.readCurrent(f.key, io())).rejects.toThrow(/^RISK_/);
  },
);
it.each(['OBSERVATION', 'LOSS'] as const)(
  'rejects missing native %s evidence without allocating a certificate',
  async (kind) => {
    const f = await fixture(kind),
      { coordinator } = await open();
    await expect(coordinator.certify(f.key, io())).rejects.toThrow(`RISK_SNAPSHOT_${kind}`);
    expect(
      (
        await admin.query('SELECT id FROM ctp_certification.identity WHERE "tenantId"=$1', [
          f.key.binding.tenantId,
        ])
      ).rowCount,
    ).toBe(0);
  },
);
it('replays the exact native observation after restart and permission refresh, rejects semantic conflict and stale CAS', async () => {
  const f = await fixture();
  await admin.query(
    'UPDATE public.exchange_account SET "permissionEpoch"="permissionEpoch"+1 WHERE id=$1',
    [f.key.binding.accountId],
  );
  const restarted = await createPostgresRiskObservations(options('DATABASE_RISK_OBSERVATION_URL'));
  try {
    expect(await restarted.publish(f.observationEvent, io())).toEqual({
      ...f.observed,
      replayed: true,
    });
    await expect(
      restarted.publish(
        {
          ...f.observationEvent,
          observation: { ...f.observationEvent.observation, leverage: parseDecimal('2') },
        },
        io(),
      ),
    ).rejects.toThrow('RISK_OBSERVATION_CONFLICT');
    await expect(
      restarted.publish({ ...f.observationEvent, id: randomUUID() }, io()),
    ).rejects.toThrow(/^RISK_/);
  } finally {
    await restarted.close();
  }
});
it('returns no certificate on real lost COMMIT response, then recovers the actual immutable committed certificate without a grant', async () => {
  const f = await fixture(),
    proxy = await registryCommitProxy(required('DATABASE_RISK_CERTIFICATION_URL'), 'CERTIFICATE');
  let store: Awaited<ReturnType<typeof createPostgresRiskSnapshotStore>> | undefined;
  try {
    store = await createPostgresRiskSnapshotStore({
      connectionString: proxy.connectionString,
      environment: 'test',
    });
    const coordinator = createRiskSnapshotCoordinator({ store, now: () => Date.now() });
    proxy.arm();
    await expect(coordinator.certify(f.key, io())).rejects.toThrow('RISK_SNAPSHOT_STORE_FAILED');
    expect(proxy.dropped()).toBe(1);
    const recovered = await open(),
      c = await recovered.coordinator.readCurrent(f.key, io());
    expect(c.revision).toBe('1');
    expect(
      (
        await admin.query('SELECT id FROM ctp_certification.certificate WHERE "tenantId"=$1', [
          f.key.binding.tenantId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await admin.query('SELECT id FROM public.risk_reservation WHERE "tenantId"=$1', [
          f.key.binding.tenantId,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    await store?.close();
    await proxy.close();
  }
});
it.each(['ABORT', 'DEADLINE'] as const)(
  'physically removes a native tenant-lock waiter on %s and allows subsequent capture while retaining source authority',
  async (kind) => {
    const f = await fixture(),
      { coordinator } = await open(),
      blocker = await admin.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1::text,0))",
        [f.key.binding.tenantId],
      );
      const controller = new AbortController(),
        started = Date.now();
      pending = coordinator.certify(f.key, io(controller.signal, kind === 'DEADLINE' ? 150 : 2500));
      const refused = expect(pending).rejects.toThrow('RISK_SNAPSHOT_ABORTED');
      if (kind === 'ABORT') {
        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
          if (
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
                [new URL(required('DATABASE_RISK_CERTIFICATION_URL')).username],
              )
            ).rowCount
          )
            break;
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.abort();
      }
      await refused;
      expect(Date.now() - started).toBeLessThan(1000);
      // pg's socket promise settles before PostgreSQL necessarily notices EOF
      // while waiting on an advisory lock. Prove backend teardown under the
      // independent 2s statement guard, keeping the blocker held throughout.
      const teardownStarted = Date.now();
      let remainingWaiters = 1;
      while (remainingWaiters && Date.now() - teardownStarted < 2500) {
        remainingWaiters =
          (
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
              [new URL(required('DATABASE_RISK_CERTIFICATION_URL')).username],
            )
          ).rowCount ?? 1;
        if (remainingWaiters) await new Promise((r) => setTimeout(r, 5));
      }
      expect(remainingWaiters).toBe(0);
      expect(Date.now() - teardownStarted).toBeLessThan(2500);
      expect(
        (
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
            [new URL(required('DATABASE_RISK_CERTIFICATION_URL')).username],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query('SELECT id FROM ctp_certification.identity WHERE "tenantId"=$1', [
            f.key.binding.tenantId,
          ])
        ).rowCount,
      ).toBe(0);
      await blocker.query('COMMIT');
      expect(await coordinator.certify(f.key, io())).toHaveProperty('id');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await pending?.catch(() => {});
      blocker.release();
    }
  },
);
