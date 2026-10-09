import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PortfolioStore } from '@ctp/portfolio';
import { bindingSchema as orderBindingSchema, type OrderStore } from '@ctp/order-engine';
import {
  createPostgresInstrumentRegistry,
  marketSnapshotPublicationSchema,
  type DurableMarketSnapshots,
} from '@ctp/market-data';
import {
  riskLimitsSchema,
  riskNativeObservationSchema,
  type PostgresPolicies,
  type createPostgresLossJournal,
  type createPostgresRiskObservations,
} from '@ctp/risk-engine';
import { parseDecimal, type InstrumentRecord, type CapabilityRecord } from '@ctp/exchange-core';
import { expect } from 'vitest';
import { captureFixture } from '../../../risk-engine/test/snapshot-fixtures.js';
import { binding, snapshot } from '../../../portfolio/test/fixtures.js';
interface FixturePorts {
  admin: Pool;
  portfolio: PortfolioStore;
  orders: OrderStore;
  market: DurableMarketSnapshots;
  platform: PostgresPolicies;
  user: PostgresPolicies;
  loss: Awaited<ReturnType<typeof createPostgresLossJournal>>;
  observer: Awaited<ReturnType<typeof createPostgresRiskObservations>>;
  registryOptions: { connectionString: string; environment: 'test' };
  nativeAmend?: boolean;
  nativeCancel?: boolean;
  /** Explicit test-owned production assembly evidence; never a runtime source. */
  nativeProfile?: {
    identities: { tenantId: string; accountId: string; connectionId: string };
    record: InstrumentRecord;
    capabilities: readonly CapabilityRecord[];
  };
}
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
export async function seedRiskCertification(ports: FixturePorts, missing?: 'OBSERVATION' | 'LOSS') {
  const { admin, portfolio, orders, market, platform, user, loss, observer } = ports;
  const identities = ports.nativeProfile?.identities ?? {
      tenantId: randomUUID(),
      accountId: randomUUID(),
      connectionId: randomUUID(),
    },
    f = captureFixture(identities),
    i = f.risk.record.instrument,
    r = f.risk.record.rules;
  if (ports.nativeAmend) {
    // Test-owned capability evidence; production profile dispatch stays disabled.
    f.risk.capabilities.push({ ...f.risk.capabilities[0]!, feature: 'AMEND_ORDER' });
  }
  if (ports.nativeCancel)
    f.risk.capabilities.push({ ...f.risk.capabilities[0]!, feature: 'CANCEL_ORDER' });
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
  if (ports.nativeProfile) {
    const native = ports.nativeProfile;
    Object.assign(i, native.record.instrument);
    Object.assign(r, native.record.rules);
    f.key.instrumentId = i.id;
    f.risk.order.instrumentId = i.id;
    f.risk.order.ruleVersion = r.version;
    f.risk.order.size = { kind: 'BASE_QUANTITY', value: parseDecimal('1'), asset: 'BTC' };
    f.risk.capabilities.splice(0, f.risk.capabilities.length, ...native.capabilities);
    f.risk.adapterVersion = native.capabilities[0]!.adapterVersion;
    f.key.binding.profile = native.capabilities[0]!.profile;
    f.risk.binding.profile = native.capabilities[0]!.profile;
    f.publication.key.instrumentId = i.id;
    f.publication.ticker.instrumentId = i.id;
    f.publication.book.instrumentId = i.id;
    f.observation.key.instrumentId = i.id;
    f.observation.key.binding.profile = native.capabilities[0]!.profile;
    f.rehashMarket();
    f.rehashObservation();
  }
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
    ...ports.registryOptions,
    scope: i.scope,
    instrumentIds: [i.id],
  });
  try {
    if (ports.nativeProfile) {
      // Native public transport has already durably published this exact immutable version.
      expect(registry.get(i.scope, i.id, Date.now())).toEqual({ ok: true, value: f.risk.record });
    } else expect((await registry.putBatch([f.risk.record], Date.now(), io())).ok).toBe(true);
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
