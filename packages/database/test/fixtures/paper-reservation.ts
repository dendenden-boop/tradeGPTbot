// Isolated storage fixture only. Never a production admission/certificate.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
if (!/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw Error('ISOLATED_PAPER_RESERVATION_FIXTURE_REQUIRED');
export async function createPaperReservationFixture(p: Pick<PoolClient, 'query'>, side = 'SELL') {
  const x = Object.fromEntries(
    [
      'tenant',
      'account',
      'instrument',
      'rule',
      'state',
      'capability',
      'profile',
      'intent',
      'decision',
      'reservation',
    ].map((k) => [k, randomUUID()]),
  ) as Record<
    | 'tenant'
    | 'account'
    | 'instrument'
    | 'rule'
    | 'state'
    | 'capability'
    | 'profile'
    | 'intent'
    | 'decision'
    | 'reservation',
    string
  >;
  const hash = Buffer.alloc(32, 7);
  await p.query("SELECT set_config('app.tenant_id',$1,true)", [x.tenant]);
  await p.query('INSERT INTO public."user"(id,"updatedAt") VALUES($1,now())', [x.tenant]);
  await p.query(
    `INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode","clientIdEpoch","updatedAt") VALUES($1::uuid,$2,'BINANCE','PAPER',$1::text,'global','SIMULATED','vector-storage',now())`,
    [x.account, x.tenant],
  );
  await p.query(
    `INSERT INTO public.instrument(id,exchange,market,mode,"exchangeSymbol","baseAsset","quoteAsset",active,"updatedAt") VALUES($1::uuid,'BINANCE','SPOT','LIVE',$1::text,'BTC','USDT',true,now())`,
    [x.instrument],
  );
  await p.query(
    `INSERT INTO public.instrument_rule_version(id,"instrumentId",version,"effectiveAt","fetchedAt","sourceHash","priceTick","quantityStep","minQuantity",rules) VALUES($1,$2,1,now(),now(),$3,'0.01','0.001','0.001','{}')`,
    [x.rule, x.instrument, hash],
  );
  await p.query(
    `INSERT INTO public.account_state_version(id,"tenantId","accountId",mode,version,"sourceCursor","sourceAt","receivedAt","reconciliationEpoch","stateHash") VALUES($1,$2,$3,'PAPER',0,'vector-storage',now(),now(),0,$4)`,
    [x.state, x.tenant, x.account, hash],
  );
  await p.query(
    `INSERT INTO public.capability_snapshot(id,exchange,market,mode,region,"accountMode",version,"profileVersion","verifiedAt","expiresAt",capabilities,"evidenceHash") VALUES($1::uuid,'BINANCE','SPOT','PAPER',left($1::text,32),'SIMULATED',1,'v1',now(),now()+interval '1 hour','{}',$2)`,
    [x.capability, hash],
  );
  await p.query(
    `INSERT INTO public.risk_profile(id,"tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt") VALUES($1,$2,'vector-storage',1,$3,'USDT',1000,100,0.5,10,'{}',now())`,
    [x.profile, x.tenant, hash],
  );
  await p.query(
    `INSERT INTO public.order_intent(id,"tenantId","accountId",mode,"instrumentId","ruleVersionId",origin,destination,operation,"idempotencyKey","commandHash",side,"orderType","quantityAsset","priceAsset",quantity,"limitPrice") VALUES($1::uuid,$2,$3,'PAPER',$4,$5,'USER','PAPER_ENGINE','PLACE',$1::text,$6,$7,'LIMIT','BTC','USDT',1,100)`,
    [x.intent, x.tenant, x.account, x.instrument, x.rule, hash, side],
  );
  await p.query(
    `INSERT INTO public.risk_decision(id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","permissionEpoch","expiresAt") VALUES($1,$2,$3,$4,'PAPER',$5,$6,$7,$8,'APPROVE',1,$9,0,now()+interval '1 hour')`,
    [x.decision, x.tenant, x.intent, x.account, x.profile, x.state, x.rule, x.capability, hash],
  );
  return x;
}
