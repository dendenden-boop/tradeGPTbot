import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { computeCommandHash, parseDecimal } from '@ctp/exchange-core';
import {
  canonical,
  bindingSchema as portfolioBindingSchema,
  reducePortfolio,
  createPostgresPortfolioStore,
  type PortfolioStore,
} from '@ctp/portfolio';
import { createPostgresOrderStore, type OrderStore } from '@ctp/order-engine';
import { createPostgresMarketSnapshots, type DurableMarketSnapshots } from '@ctp/market-data';
import {
  createPostgresOrderRiskPort,
  createPostgresRiskObservations,
  createPostgresPolicies,
  createPostgresLossJournal,
  createPostgresControls,
  createPostgresRiskSnapshotStore,
  createRiskSnapshotCoordinator,
  riskLimitsSchema,
  type PostgresPolicies,
} from '@ctp/risk-engine';
import { seedRiskCertification } from './fixtures/risk-certification.js';
import { order as nativeOrderFixture } from '../../exchange-core/test/fixtures/adapter.js';
import { registryCommitProxy } from './fixtures/registry-commit-proxy.js';
import { binding as portfolioBinding, snapshot, fill } from '../../portfolio/test/fixtures.js';
import {
  prepareRiskSnapshot,
  riskEvidenceHash,
  type RiskSnapshotKey,
} from '../../risk-engine/src/coordinator.js';
import { decodeRiskSnapshotCapture } from '../../risk-engine/src/snapshot-capture.js';
import { decodeRiskPortfolioSource } from '../../risk-engine/src/portfolio-source.js';
import { evaluateRiskPolicy, type RiskEvaluationInput } from '../../risk-engine/src/policy.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw new Error('ISOLATED_ADMISSION_RUNNER_REQUIRED');
const options = (key: string) => {
  const connectionString = process.env[key];
  if (!connectionString) throw new Error('ISOLATED_ADMISSION_VARIABLE_REQUIRED');
  return { connectionString, environment: 'test' as const };
};
const admin = new Pool({ ...options('DATABASE_MIGRATION_URL'), max: 3, query_timeout: 5000 });
const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2500 });
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
  const operator = await createPostgresControls({
    ...options('DATABASE_RISK_OPERATOR_URL'),
    authority: 'GLOBAL',
  });
  handles.push(operator);
  const current = await operator.read(null, io());
  await operator.update(
    {
      scope: { kind: 'GLOBAL' },
      kind: 'KILL_SWITCH',
      key: 'kill',
      state: 'RUNNING',
      expectedEpoch: current.find((c) => c.kind === 'KILL_SWITCH')!.epoch,
      eventId: randomUUID(),
      reason: 'ISOLATED_ADMISSION_ACCEPTANCE',
      evidenceHash: 'a'.repeat(64),
    },
    io(),
  );
});
afterAll(async () => {
  for (const h of handles.splice(0)) await h.close();
  await admin.end();
});
async function fixture() {
  const f = await seedRiskCertification({
    admin,
    portfolio,
    orders,
    market,
    platform,
    user,
    loss,
    observer,
    registryOptions: options('DATABASE_INSTRUMENT_REGISTRY_URL'),
  });
  const commandHash = computeCommandHash('createOrder', f.created.command, {
    profile: f.key.binding.profile,
    account: {
      tenantId: f.key.binding.tenantId,
      connectionId: f.key.binding.connectionId,
      externalAccountId: f.key.binding.externalAccountId,
    },
  });
  return {
    ...f,
    input: {
      binding: f.key.binding,
      state: { id: f.created.id },
      intentId: f.created.intentId,
      operation: 'PLACE' as const,
      commandHash,
    },
  };
}
async function open() {
  const port = await createPostgresOrderRiskPort(options('DATABASE_RISK_ADMISSION_URL'));
  handles.push(port);
  return port;
}
async function bridgeFixture(dispatch = true) {
  const f = await fixture(),
    port = await open();
  const grant = await port.approve(f.input, io());
  const claim = await orders.begin(f.key.binding, f.created.id, f.created.intentId, grant, io());
  if (!claim) throw new Error('MISSING_BRIDGE_CLAIM');
  if (dispatch) {
    const account = {
      tenantId: f.key.binding.tenantId,
      connectionId: f.key.binding.connectionId,
      externalAccountId: f.key.binding.externalAccountId,
    };
    expect(
      await orders.authorize(
        'createOrder',
        {
          command: claim.command,
          authorization: {
            commandId: claim.intentId,
            commandHash: claim.commandHash,
            dispatchAttemptId: claim.attemptId,
            profile: f.key.binding.profile,
            account,
            issuedAt: Date.now(),
            expiresAt: grant.expiresAt,
          },
        },
        { ...io(), profile: f.key.binding.profile, account, correlationId: randomUUID() },
      ),
    ).toBe(true);
  }
  const book = (
    await admin.query<{ id: string }>('SELECT id FROM ctp_portfolio.book WHERE "accountId"=$1', [
      f.key.binding.accountId,
    ])
  ).rows[0]!.id;
  return { ...f, grant, claim, book };
}
async function bridgeState(f: Awaited<ReturnType<typeof bridgeFixture>>) {
  const reservation = (
    await admin.query<{ status: string; amount: string }>(
      'SELECT status,trim_scale(amount)::text amount FROM public.risk_reservation WHERE id=$1',
      [f.grant.reservationId],
    )
  ).rows[0]!;
  const book = (
    await admin.query<{ state: string; revision: number }>(
      'SELECT state,revision FROM ctp_portfolio.book WHERE id=$1',
      [f.book],
    )
  ).rows[0]!;
  book.revision = Number(book.revision);
  if (!Number.isSafeInteger(book.revision)) throw new Error('INVALID_NATIVE_BOOK_REVISION');
  const watermark = (
    await admin.query<{ released: boolean; unknown: boolean }>(
      'SELECT released,unknown FROM ctp_portfolio.hold_watermark WHERE book=$1 AND "holdId"=$2',
      [f.book, f.grant.reservationId],
    )
  ).rows[0]!;
  return {
    reservation,
    book,
    watermark,
    state: JSON.parse(book.state) as { holds: { id: string; status: string; amount: string }[] },
  };
}
it.each(['internalOrderId', 'intentId'] as const)(
  'native SQL authority rejects conflicting %s without changing UNKNOWN collateral',
  async (field) => {
    const f = await bridgeFixture();
    await orders.result(
      f.key.binding,
      f.claim,
      { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } },
      io(),
    );
    const before = await bridgeState(f);
    const native = {
      ...nativeOrderFixture,
      internalOrderId: f.created.id,
      intentId: f.created.intentId,
      account: {
        tenantId: f.key.binding.tenantId,
        connectionId: f.key.binding.connectionId,
        externalAccountId: f.key.binding.externalAccountId,
      },
      scope: f.risk.record.instrument.scope,
      instrumentId: f.created.command.instrumentId,
      clientOrderId: f.created.command.clientOrderId,
      exchangeOrderId: 'identity-' + f.created.id,
      createdAt: f.created.createdAt,
      updatedAt: Date.now(),
      status: 'CANCELED',
      quantity: f.created.command.size.value,
      price: { state: 'AVAILABLE', value: f.created.command.limitPrice },
      filledQuantity: '0',
      averageFillPrice: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' },
      fees: [],
      [field]: randomUUID(),
    };
    const payload = canonical({ type: 'NATIVE', order: native });
    const fingerprint = createHash('sha256').update(payload).digest();
    const pool = new Pool({ ...options('DATABASE_EXECUTION_URL'), max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.key.binding.tenantId]);
      await client.query('SELECT pg_advisory_xact_lock_shared(1129599058,12)');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1,0))", [
        f.key.binding.tenantId,
      ]);
      await client.query(
        'INSERT INTO ctp_execution.evidence("tenantId","orderId",identity,fingerprint) VALUES($1,$2,$3,$4)',
        [f.key.binding.tenantId, f.created.id, `native:${native.updatedAt}`, fingerprint],
      );
      await expect(
        client.query(
          'INSERT INTO ctp_execution.authoritative_event("tenantId","orderId",identity,fingerprint,payload) VALUES($1,$2,$3,$4,$5)',
          [
            f.key.binding.tenantId,
            f.created.id,
            `native:${native.updatedAt}`,
            fingerprint,
            payload,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514', message: 'ORDER_NATIVE_IDENTITY_SCOPE' });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      await pool.end();
    }
    expect(await bridgeState(f)).toEqual(before);
    const restarted = await createPostgresOrderStore(options('DATABASE_EXECUTION_URL'));
    handles.push(restarted);
    expect((await restarted.read(f.key.binding, f.created.id, io())).status).toBe('UNKNOWN');
    expect(
      (
        await admin.query(
          'SELECT identity FROM ctp_execution.authoritative_event WHERE "tenantId"=$1 AND "orderId"=$2 AND identity=$3',
          [f.key.binding.tenantId, f.created.id, `native:${native.updatedAt}`],
        )
      ).rowCount,
    ).toBe(0);
  },
);
it.each(['POLICY', 'HEALTH'] as const)(
  'final issued dispatch refuses current %s replacement before consuming the transport permit',
  async (kind) => {
    const f = await bridgeFixture(false);
    if (kind === 'POLICY') {
      await user.update(
        {
          scope: { kind: 'USER', tenantId: f.key.binding.tenantId },
          mode: 'TESTNET',
          eventId: randomUUID(),
          expectedVersion: '1',
          reason: 'ISOLATED_FINAL_DISPATCH_REPLACEMENT',
          limits: riskLimitsSchema.parse({ ...f.risk.user, maxOrderNotional: '1' }),
        },
        io(),
      );
    } else {
      await observer.publish(
        {
          ...f.observationEvent,
          id: randomUUID(),
          expectedRevision: '1',
          observation: {
            ...f.observationEvent.observation,
            health: {
              ...f.observationEvent.observation.health,
              privateStream: {
                sourceId: randomUUID(),
                asOf: Date.now(),
                status: 'FAILED',
              },
            },
          },
        },
        io(),
      );
    }
    const account = {
      tenantId: f.key.binding.tenantId,
      connectionId: f.key.binding.connectionId,
      externalAccountId: f.key.binding.externalAccountId,
    };
    expect(
      await orders.authorize(
        'createOrder',
        {
          command: f.claim.command,
          authorization: {
            commandId: f.claim.intentId,
            commandHash: f.claim.commandHash,
            dispatchAttemptId: f.claim.attemptId,
            profile: f.key.binding.profile,
            account,
            issuedAt: Date.now(),
            expiresAt: f.grant.expiresAt,
          },
        },
        { ...io(), profile: f.key.binding.profile, account, correlationId: randomUUID() },
      ),
    ).toBe(false);
    expect(
      (
        await admin.query(
          'SELECT "permitConsumedAt","transportStartedAt" FROM public.submission_attempt WHERE id=$1',
          [f.claim.attemptId],
        )
      ).rows,
    ).toEqual([{ permitConsumedAt: null, transportStartedAt: null }]);
    await orders.result(
      f.key.binding,
      f.claim,
      { kind: 'DEFINITIVELY_REJECTED', error: { code: 'AUTHORIZATION_REQUIRED' } },
      io(),
    );
    expect((await bridgeState(f)).reservation.status).toBe('RELEASED');
    expect(
      (
        await admin.query('SELECT "responseCode" FROM public.submission_attempt WHERE id=$1', [
          f.claim.attemptId,
        ])
      ).rows,
    ).toEqual([{ responseCode: 'NOT_SENT' }]);
  },
);
it('an execution SQL writer cannot bypass current policy validation by consuming an issued permit directly', async () => {
  const f = await bridgeFixture(false);
  await user.update(
    {
      scope: { kind: 'USER', tenantId: f.key.binding.tenantId },
      mode: 'TESTNET',
      eventId: randomUUID(),
      expectedVersion: '1',
      reason: 'ISOLATED_DIRECT_DISPATCH_FORGERY',
      limits: riskLimitsSchema.parse({ ...f.risk.user, maxOrderNotional: '1' }),
    },
    io(),
  );
  const execution = new Pool({ ...options('DATABASE_EXECUTION_URL'), max: 1 });
  const client = await execution.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.key.binding.tenantId]);
    expect(
      (
        await client.query(
          "SELECT (SELECT has_function_privilege(current_user,f.oid,'EXECUTE') FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='ctp_admission' AND f.proname='validate_dispatch') validator, (SELECT has_function_privilege(current_user,f.oid,'EXECUTE') FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='ctp_certification' AND f.proname='capture_sources') capture",
        )
      ).rows,
    ).toEqual([{ validator: false, capture: false }]);
    await expect(
      client.query(
        'UPDATE public.submission_attempt SET "transportStartedAt"=stamp.at,"permitConsumedAt"=stamp.at FROM (SELECT date_trunc(\'milliseconds\',clock_timestamp()) at) stamp WHERE id=$1',
        [f.claim.attemptId],
      ),
    ).rejects.toThrow('RISK_DISPATCH_REPLACED');
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await execution.end();
  }
  expect(
    (
      await admin.query(
        'SELECT "permitConsumedAt","transportStartedAt" FROM public.submission_attempt WHERE id=$1',
        [f.claim.attemptId],
      )
    ).rows,
  ).toEqual([{ permitConsumedAt: null, transportStartedAt: null }]);
});
it('reservation bridge retains UNKNOWN collateral across restart and releases once after authoritative native cancel', async () => {
  const f = await bridgeFixture();
  await orders.result(
    f.key.binding,
    f.claim,
    { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } },
    io(),
  );
  const unknown = await bridgeState(f);
  expect(unknown.reservation.status).toBe('UNRESOLVED');
  expect(unknown.state.holds).toEqual([
    expect.objectContaining({ id: f.grant.reservationId, status: 'UNKNOWN', amount: '5.005' }),
  ]);
  expect(unknown.watermark).toEqual({ released: false, unknown: true });
  const restarted = await createPostgresOrderStore(options('DATABASE_EXECUTION_URL'));
  handles.push(restarted);
  expect((await restarted.read(f.key.binding, f.created.id, io())).status).toBe('UNKNOWN');
  const native = {
    ...nativeOrderFixture,
    internalOrderId: f.created.id,
    intentId: f.created.intentId,
    account: {
      tenantId: f.key.binding.tenantId,
      connectionId: f.key.binding.connectionId,
      externalAccountId: f.key.binding.externalAccountId,
    },
    scope: f.risk.record.instrument.scope,
    instrumentId: f.created.command.instrumentId,
    clientOrderId: f.created.command.clientOrderId,
    exchangeOrderId: 'bridge-' + f.created.id,
    createdAt: f.created.createdAt,
    updatedAt: Date.now(),
    status: 'CANCELED',
    quantity: f.created.command.size.value,
    price: { state: 'AVAILABLE', value: f.created.command.limitPrice },
    filledQuantity: '0',
    averageFillPrice: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' },
    fees: [],
  };
  await restarted.complete(f.key.binding, f.created.id, native, io());
  const released = await bridgeState(f);
  expect(released.reservation.status).toBe('RELEASED');
  expect(released.state.holds).toEqual([]);
  expect(released.watermark.released).toBe(true);
  await restarted.complete(f.key.binding, f.created.id, native, io());
  expect(await bridgeState(f)).toEqual(released);
});
it('reservation bridge definitive NOT_SENT releases the durable reservation and hold atomically', async () => {
  const f = await bridgeFixture(false);
  const outcome = { kind: 'DEFINITIVELY_REJECTED', error: { code: 'AUTHORIZATION_REQUIRED' } };
  await orders.result(f.key.binding, f.claim, outcome, io());
  const released = await bridgeState(f);
  expect(released.reservation.status).toBe('RELEASED');
  expect(released.state.holds).toEqual([]);
  expect(released.watermark.released).toBe(true);
  await orders.result(f.key.binding, f.claim, outcome, io());
  expect(await bridgeState(f)).toEqual(released);
});
it('reservation bridge acknowledgement retains collateral until authoritative resolution', async () => {
  const f = await bridgeFixture();
  await orders.result(
    f.key.binding,
    f.claim,
    {
      kind: 'ACCEPTED',
      ack: {
        commandId: f.created.intentId,
        status: 'ACKNOWLEDGED',
        exchangeId: 'bridge-' + f.created.id,
        receivedAt: Date.now(),
      },
    },
    io(),
  );
  const held = await bridgeState(f);
  expect(held.reservation.status).toBe('ACTIVE');
  expect(held.state.holds).toEqual([
    expect.objectContaining({ id: f.grant.reservationId, status: 'RESERVED', amount: '5.005' }),
  ]);
  expect(held.watermark).toEqual({ released: false, unknown: false });
});
it('reservation bridge certifies bounded UNKNOWN exactly once and blocks dispatch until reconciliation', async () => {
  const f = await bridgeFixture();
  const outcome = { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } };
  await orders.result(f.key.binding, f.claim, outcome, io());
  const held = await bridgeState(f);
  await orders.result(f.key.binding, f.claim, outcome, io());
  expect(await bridgeState(f)).toEqual(held);
  const input = await secondInput(f);
  const store = await createPostgresRiskSnapshotStore(options('DATABASE_RISK_CERTIFICATION_URL'));
  handles.push(store);
  const certificate = await createRiskSnapshotCoordinator({ store, now: () => Date.now() }).certify(
    { ...f.key, intentId: input.intentId },
    io(),
  );
  expect(certificate.projection.snapshot).toMatchObject({
    instrumentExposure: '5',
    userExposure: '5',
    openOrders: 1,
    availableAmount: '994.995',
    unknownExposure: false,
  });
  const restarted = await open();
  const grant = await restarted.approve(input, io());
  await expect(
    orders.begin(f.key.binding, input.state.id, input.intentId, grant, io()),
  ).rejects.toThrow('ORDER_RECONCILIATION_REQUIRED');
  const current = await bridgeState(f);
  expect(current.reservation).toEqual(held.reservation);
  expect(current.state.holds.find((h) => h.id === f.grant.reservationId)).toEqual(
    held.state.holds[0],
  );
});
it('reservation bridge rejects standalone Portfolio release of active issued collateral', async () => {
  const f = await bridgeFixture(false),
    held = await bridgeState(f);
  const b = portfolioBindingSchema.parse({
    ...portfolioBinding(),
    tenantId: f.key.binding.tenantId,
    accountId: f.key.binding.accountId,
    connectionId: f.key.binding.connectionId,
  });
  await expect(
    portfolio.apply(
      b,
      {
        id: randomUUID(),
        type: 'RELEASE',
        holdId: f.grant.reservationId,
        resolved: true,
        timestamp: Date.now(),
      },
      held.book.revision,
      io(),
    ),
  ).rejects.toThrow();
  expect(await bridgeState(f)).toEqual(held);
});
it('an issued hold cannot become native-reflected through a standalone Portfolio commitment without durable attribution', async () => {
  const f = await bridgeFixture(false),
    held = await bridgeState(f);
  const b = portfolioBindingSchema.parse({
    ...portfolioBinding(),
    tenantId: f.key.binding.tenantId,
    accountId: f.key.binding.accountId,
    connectionId: f.key.binding.connectionId,
  });
  await expect(
    portfolio.apply(
      b,
      {
        id: randomUUID(),
        type: 'COMMITMENT',
        timestamp: Date.now(),
        hold: {
          id: f.grant.reservationId,
          asset: 'USDT',
          amount: '5.005',
          status: 'RESERVED',
          reflected: true,
        },
      },
      held.book.revision,
      io(),
    ),
  ).rejects.toThrow();
  expect(await bridgeState(f)).toEqual(held);
});
it.each(['MATCH', 'DIFFERENT_PRICE'] as const)(
  'restart replays legacy hash-only native evidence with %s and preserves issued collateral authority',
  async (kind) => {
    const f = await bridgeFixture();
    await orders.result(
      f.key.binding,
      f.claim,
      { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } },
      io(),
    );
    const native = {
      ...nativeOrderFixture,
      internalOrderId: f.created.id,
      intentId: f.created.intentId,
      account: {
        tenantId: f.key.binding.tenantId,
        connectionId: f.key.binding.connectionId,
        externalAccountId: f.key.binding.externalAccountId,
      },
      scope: f.risk.record.instrument.scope,
      instrumentId: f.created.command.instrumentId,
      clientOrderId: f.created.command.clientOrderId,
      exchangeOrderId: 'legacy-' + f.created.id,
      createdAt: f.created.createdAt,
      updatedAt: Date.now(),
      status: 'CANCELED',
      quantity: f.created.command.size.value,
      price: { state: 'AVAILABLE', value: kind === 'MATCH' ? f.created.command.limitPrice : '11' },
      filledQuantity: '0',
      averageFillPrice: { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' },
      fees: [],
    };
    const payload = canonical({ type: 'NATIVE', order: native });
    const fingerprint = createHash('sha256').update(payload).digest();
    // Seed the exact evidence-only representation published before migration 20.
    // No authoritative_event existed in that version; no immutable row is changed.
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.key.binding.tenantId]);
      await client.query(
        'INSERT INTO ctp_execution.evidence("tenantId","orderId",identity,fingerprint) VALUES($1,$2,$3,$4)',
        [f.key.binding.tenantId, f.created.id, `native:${native.updatedAt}`, fingerprint],
      );
      await client.query(
        'UPDATE public."order" SET status=\'CANCELED\',"reconciliationState"=\'CONSISTENT\',"exchangeOrderId"=$3,version=version+1,"lastExchangeAt"=to_timestamp($4::double precision/1000),"terminalAt"=now(),"updatedAt"=now() WHERE "tenantId"=$1 AND id=$2',
        [f.key.binding.tenantId, f.created.id, native.exchangeOrderId, native.updatedAt],
      );
      await client.query(
        'UPDATE ctp_execution.progress SET "nativeAt"=$3,"nativeHash"=$4,"nativeStatus"=\'CANCELED\' WHERE "tenantId"=$1 AND "orderId"=$2',
        [
          f.key.binding.tenantId,
          f.created.id,
          native.updatedAt,
          createHash('sha256').update(canonical(native)).digest(),
        ],
      );
      await client.query(
        'UPDATE public.submission_attempt SET status=\'RECONCILED\',"resolvedAt"=now() WHERE "tenantId"=$1 AND id=$2',
        [f.key.binding.tenantId, f.claim.attemptId],
      );
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    expect((await bridgeState(f)).reservation.status).toBe('UNRESOLVED');
    const restarted = await createPostgresOrderStore(options('DATABASE_EXECUTION_URL'));
    handles.push(restarted);
    await expect(
      restarted.complete(f.key.binding, f.created.id, { ...native, side: 'SELL' }, io()),
    ).rejects.toThrow('ORDER_EVIDENCE_CONFLICT');
    expect((await bridgeState(f)).reservation.status).toBe('UNRESOLVED');
    if (kind === 'DIFFERENT_PRICE') {
      await expect(restarted.complete(f.key.binding, f.created.id, native, io())).rejects.toThrow(
        'ORDER_SCOPE',
      );
      expect((await bridgeState(f)).reservation.status).toBe('UNRESOLVED');
      expect(
        (
          await admin.query(
            'SELECT identity FROM ctp_execution.authoritative_event WHERE "tenantId"=$1 AND "orderId"=$2 AND identity=$3',
            [f.key.binding.tenantId, f.created.id, `native:${native.updatedAt}`],
          )
        ).rowCount,
      ).toBe(0);
      return;
    }
    await restarted.complete(f.key.binding, f.created.id, native, io());
    const released = await bridgeState(f);
    expect(released.reservation.status).toBe('RELEASED');
    expect(released.state.holds).toEqual([]);
    expect(
      (
        await admin.query(
          'SELECT payload FROM ctp_execution.authoritative_event WHERE "tenantId"=$1 AND "orderId"=$2 AND identity=$3',
          [f.key.binding.tenantId, f.created.id, `native:${native.updatedAt}`],
        )
      ).rows,
    ).toEqual([{ payload }]);
    await restarted.complete(f.key.binding, f.created.id, native, io());
    expect(await bridgeState(f)).toEqual(released);
  },
);
it('reservation bridge released tombstone rejects new commitment and ignores old commitment replay', async () => {
  const f = await bridgeFixture(false);
  await orders.result(
    f.key.binding,
    f.claim,
    { kind: 'DEFINITIVELY_REJECTED', error: { code: 'AUTHORIZATION_REQUIRED' } },
    io(),
  );
  const released = await bridgeState(f);
  const b = portfolioBindingSchema.parse({
    ...portfolioBinding(),
    tenantId: f.key.binding.tenantId,
    accountId: f.key.binding.accountId,
    connectionId: f.key.binding.connectionId,
  });
  const old = (
    await admin.query<{ payload: string }>(
      'SELECT payload FROM ctp_portfolio.evidence WHERE book=$1 AND id=$2',
      [f.book, 'risk-reserve-' + f.grant.reservationId],
    )
  ).rows[0]!;
  const event = JSON.parse(old.payload) as Parameters<PortfolioStore['apply']>[1];
  expect(
    (await portfolio.apply(b, { ...event, id: randomUUID() }, released.book.revision, io()))
      .duplicate,
  ).toBe(true);
  expect(await bridgeState(f)).toEqual(released);
  await expect(
    portfolio.apply(
      b,
      { ...event, id: randomUUID(), timestamp: Date.now() },
      released.book.revision,
      io(),
    ),
  ).rejects.toThrow();
  expect(await bridgeState(f)).toEqual(released);
});
it('reservation bridge durable histories and full execution evidence cannot be rewritten', async () => {
  const f = await bridgeFixture();
  await orders.result(
    f.key.binding,
    f.claim,
    { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } },
    io(),
  );
  const c = await admin.connect();
  try {
    for (const sql of [
      'UPDATE ctp_admission.lifecycle_revision SET status=\'ACTIVE\' WHERE "tenantId"=$1',
      'DELETE FROM ctp_admission.lifecycle_revision WHERE "tenantId"=$1',
      'DELETE FROM ctp_admission.lifecycle_head WHERE "tenantId"=$1',
      'UPDATE ctp_execution.authoritative_event SET payload=\'{}\' WHERE "tenantId"=$1',
    ]) {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.key.binding.tenantId]);
      await expect(c.query(sql, [f.key.binding.tenantId])).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    }
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
it('reservation bridge adjusts residual collateral only after adopted fill and reconciled native snapshot proof', async () => {
  const f = await bridgeFixture();
  await orders.result(
    f.key.binding,
    f.claim,
    { kind: 'UNKNOWN', error: { code: 'UNAVAILABLE' } },
    io(),
  );
  const b = portfolioBindingSchema.parse({
    ...portfolioBinding(),
    tenantId: f.key.binding.tenantId,
    accountId: f.key.binding.accountId,
    connectionId: f.key.binding.connectionId,
  });
  const execution = fill({
    id: randomUUID(),
    timestamp: Date.now(),
    internalOrderId: f.created.id,
    instrumentId: f.created.command.instrumentId,
    metadataVersion: f.risk.record.instrument.metadataVersion,
    ruleVersion: f.created.command.ruleVersion,
    quantity: '0.2',
    price: '10',
    native: {
      fillId: randomUUID(),
      identityScope: 'bridge-trades',
      exchangeOrderId: 'bridge-' + f.created.id,
    },
  });
  const initial = await portfolio.read(b, io());
  const applied = await portfolio.apply(b, execution, initial.revision, io());
  const native = {
    ...nativeOrderFixture,
    internalOrderId: f.created.id,
    intentId: f.created.intentId,
    account: {
      tenantId: f.key.binding.tenantId,
      connectionId: f.key.binding.connectionId,
      externalAccountId: f.key.binding.externalAccountId,
    },
    scope: f.risk.record.instrument.scope,
    instrumentId: f.created.command.instrumentId,
    clientOrderId: f.created.command.clientOrderId,
    exchangeOrderId: execution.native.exchangeOrderId,
    createdAt: f.created.createdAt,
    updatedAt: Date.now(),
    status: 'PARTIALLY_FILLED',
    quantity: f.created.command.size.value,
    price: { state: 'AVAILABLE', value: f.created.command.limitPrice },
    filledQuantity: '0.2',
    averageFillPrice: { state: 'AVAILABLE', value: '10' },
    fees: [],
  };
  await orders.observe(f.key.binding, f.created.id, native, io());
  await orders.adopt(f.key.binding, f.created.id, f.book, execution.id, io());
  expect((await bridgeState(f)).state.holds[0]?.amount).toBe('5.005');
  await orders.complete(f.key.binding, f.created.id, native, io());
  expect((await bridgeState(f)).state.holds[0]?.amount).toBe('5.005');
  const checkpoint = await portfolio.read(b, io());
  const confirmed = snapshot({
    id: randomUUID(),
    timestamp: Date.now(),
    covered: [execution.id],
    balances: applied.checkpoint.state.balances,
    positions: [
      {
        instrumentId: f.created.command.instrumentId,
        positionSide: 'NET',
        bucket: 'CROSS',
        base: 'BTC',
        quote: 'USDT',
        quantity: '0.2',
        entryPrice: '10',
      },
    ],
  });
  await portfolio.apply(b, confirmed, checkpoint.revision, io());
  const adjusted = await bridgeState(f);
  expect(adjusted.reservation).toEqual({ status: 'ACTIVE', amount: '3.003' });
  expect(adjusted.state.holds).toEqual([
    expect.objectContaining({ id: f.grant.reservationId, amount: '3.003', status: 'RESERVED' }),
  ]);
  expect(adjusted.watermark).toEqual({ released: false, unknown: false });
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function secondInput(f: Fixture) {
  const { clientOrderId: omitted, ...order } = f.created.command;
  void omitted;
  const created = await orders.create(
    f.key.binding,
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
  return {
    ...f.input,
    state: { id: created.id },
    intentId: created.intentId,
    commandHash: computeCommandHash('createOrder', created.command, {
      profile: f.key.binding.profile,
      account: {
        tenantId: f.key.binding.tenantId,
        connectionId: f.key.binding.connectionId,
        externalAccountId: f.key.binding.externalAccountId,
      },
    }),
  };
}
/** Direct function caller proves SQL guards independently of the trusted TS evaluator. */
async function directPayload(
  input: Fixture['input'],
  tamper: (p: Record<string, unknown>) => void,
  evaluationSnapshot: (
    snapshot: RiskEvaluationInput['snapshot'],
  ) => RiskEvaluationInput['snapshot'] = (snapshot) => snapshot,
) {
  const pool = new Pool({ ...options('DATABASE_RISK_ADMISSION_URL'), max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [input.binding.tenantId]);
    const lookup = {
      binding: input.binding,
      orderId: input.state.id,
      intentId: input.intentId,
      operation: input.operation,
      commandHash: input.commandHash,
    };
    const prepared = (
      await c.query<{
        result: {
          key: RiskSnapshotKey;
          capture: { portfolio: unknown; intent: { command: Fixture['created']['command'] } };
          allocation: {
            certificateId: string;
            revision: string;
            decisionId: string;
            reservationId: string;
          };
        };
      }>('SELECT ctp_admission.prepare($1::jsonb) result', [canonical(lookup)])
    ).rows[0]!.result;
    const now = Date.now(),
      sources = decodeRiskSnapshotCapture(prepared.capture, prepared.key, now);
    const projection = prepareRiskSnapshot(
      sources,
      prepared.key,
      {
        id: prepared.allocation.certificateId,
        revision: prepared.allocation.revision,
      },
      now,
    );
    const evaluation = evaluateRiskPolicy({
      now,
      binding: projection.snapshot.binding,
      order: prepared.capture.intent.command,
      record: projection.metadata.record,
      capabilities: projection.metadata.capabilities,
      adapterVersion: projection.metadata.adapterVersion,
      platform: projection.platform.limits,
      user: projection.user.limits,
      snapshot: evaluationSnapshot(projection.snapshot),
    });
    if (evaluation.kind !== 'EVALUATED') throw new Error('INVALID_DIRECT_ADMISSION_FIXTURE');
    const book = decodeRiskPortfolioSource(
      prepared.capture.portfolio,
      {
        tenantId: input.binding.tenantId,
        mode: input.binding.mode,
        targetAccountId: input.binding.accountId,
        maxEvidenceAgeMs: 5000,
      },
      now,
    ).books.find((b) => b.accountId === input.binding.accountId)!;
    const event = {
      id: 'risk-reserve-' + prepared.allocation.reservationId,
      timestamp: now,
      type: 'COMMITMENT' as const,
      hold: {
        id: prepared.allocation.reservationId,
        asset: evaluation.proposal.asset,
        amount: evaluation.proposal.amount,
        status: 'RESERVED' as const,
        reflected: false,
      },
    };
    const reduced = reducePortfolio(book.state, event, { now: () => now, holdWatermark: null });
    const stateText = canonical(reduced.state),
      certificate = {
        id: prepared.allocation.certificateId,
        revision: prepared.allocation.revision,
        hash: riskEvidenceHash(projection),
        projection: structuredClone(projection),
        createdAt: now,
        expiresAt: projection.snapshot.sourceAt + 5000,
      };
    const payload = {
      certificate,
      evaluation,
      allocation: prepared.allocation,
      portfolio: {
        bookId: book.id,
        expectedRevision: book.revision,
        event,
        watermark: reduced.holdWatermark,
        stateText,
        hash: createHash('sha256').update(stateText).digest('hex'),
      },
    };
    tamper(payload);
    // A self-consistent hash cannot establish authority for fabricated values.
    certificate.hash = riskEvidenceHash(certificate.projection);
    return await c.query('SELECT ctp_admission.persist($1::jsonb,$2::text) result', [
      canonical(lookup),
      canonical(payload),
    ]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pool.end();
  }
}
it('atomically commits one immutable decision/reservation and an actual Portfolio commitment without a monetary posting', async () => {
  const f = await fixture(),
    port = await open(),
    tenantId = f.key.binding.tenantId;
  const before = (
    await admin.query<{ n: number }>(
      'SELECT count(*)::int n FROM public.ledger_transaction WHERE "tenantId"=$1',
      [tenantId],
    )
  ).rows[0]!.n;
  const grant = await port.approve(f.input, io());
  const reservations = await admin.query<{ status: string; asset: string; amount: string }>(
    'SELECT status,asset,trim_scale(amount)::text amount FROM public.risk_reservation WHERE "tenantId"=$1 AND id=$2',
    [tenantId, grant.reservationId],
  );
  expect(reservations.rowCount).toBe(1);
  expect(reservations.rows[0]).toMatchObject({ status: 'ACTIVE', asset: 'USDT' });
  const book = (
    await admin.query<{ state: string }>(
      'SELECT state FROM ctp_portfolio.book WHERE "tenantId"=$1 AND "accountId"=$2',
      [tenantId, f.key.binding.accountId],
    )
  ).rows[0]!;
  const state = JSON.parse(book.state) as { holds: unknown[] };
  expect(state.holds).toEqual([
    {
      id: grant.reservationId,
      asset: 'USDT',
      amount: parseDecimal(reservations.rows[0]!.amount),
      status: 'RESERVED',
      reflected: false,
    },
  ]);
  expect(
    (
      await admin.query('SELECT ledger FROM ctp_portfolio.evidence WHERE "tenantId"=$1 AND id=$2', [
        tenantId,
        'risk-reserve-' + grant.reservationId,
      ])
    ).rows,
  ).toEqual([{ ledger: null }]);
  const evidence = (
    await admin.query<{ payload: string }>(
      'SELECT payload FROM ctp_portfolio.evidence WHERE "tenantId"=$1 AND id=$2',
      [tenantId, 'risk-reserve-' + grant.reservationId],
    )
  ).rows[0]!;
  const event = JSON.parse(evidence.payload) as { type: 'COMMITMENT'; hold: unknown };
  expect(evidence.payload).toBe(canonical(event));
  const watermark = (
    await admin.query<{ fingerprint: Buffer }>(
      'SELECT fingerprint FROM ctp_portfolio.hold_watermark WHERE "tenantId"=$1 AND "holdId"=$2',
      [tenantId, grant.reservationId],
    )
  ).rows[0]!;
  expect(watermark.fingerprint.toString('hex')).toBe(
    createHash('sha256')
      .update(canonical({ type: event.type, hold: event.hold }))
      .digest('hex'),
  );
  expect(
    (
      await admin.query(
        'SELECT type FROM ctp_portfolio.outbox WHERE "tenantId"=$1 AND "eventId"=$2',
        [tenantId, 'risk-reserve-' + grant.reservationId],
      )
    ).rows,
  ).toEqual([{ type: 'COMMITMENT' }]);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM public.ledger_transaction WHERE "tenantId"=$1',
        [tenantId],
      )
    ).rows[0]!.n,
  ).toBe(before);
});
it('exact admission replay survives process restart and preserves the original permanent decision, reservation and hold', async () => {
  const f = await fixture(),
    first = await open();
  const result = await first.approve(f.input, io());
  await first.close();
  const second = await open();
  expect(await second.approve(f.input, io())).toEqual(result);
  for (const table of ['risk_decision', 'risk_reservation'])
    expect(
      (
        await admin.query<{ n: number }>(
          `SELECT count(*)::int n FROM public.${table} WHERE "tenantId"=$1`,
          [f.key.binding.tenantId],
        )
      ).rows[0]!.n,
    ).toBe(1);
  await expect(second.approve({ ...f.input, commandHash: 'f'.repeat(64) }, io())).rejects.toThrow(
    'RISK_ADMISSION_CONFLICT',
  );
});
it('certifies an issued pending order/reservation/hold exactly once and admits a second order against current remaining collateral', async () => {
  const f = await fixture(),
    port = await open();
  const first = await port.approve(f.input, io());
  const { clientOrderId: omitted, ...order } = f.created.command;
  void omitted;
  const second = await orders.create(
    f.key.binding,
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
  const store = await createPostgresRiskSnapshotStore(options('DATABASE_RISK_CERTIFICATION_URL'));
  handles.push(store);
  const c = await createRiskSnapshotCoordinator({ store, now: () => Date.now() }).certify(
    {
      ...f.key,
      intentId: second.intentId,
    },
    io(),
  );
  expect(c.projection.snapshot.instrumentExposure).toBe('5');
  expect(c.projection.snapshot.userExposure).toBe('5');
  expect(c.projection.snapshot.openOrders).toBe(1);
  expect(c.projection.snapshot.availableAmount).toBe('994.995');
  const next = await port.approve(
    {
      ...f.input,
      state: { id: second.id },
      intentId: second.intentId,
      commandHash: computeCommandHash('createOrder', second.command, {
        profile: f.key.binding.profile,
        account: {
          tenantId: f.key.binding.tenantId,
          connectionId: f.key.binding.connectionId,
          externalAccountId: f.key.binding.externalAccountId,
        },
      }),
    },
    io(),
  );
  expect(next.reservationId).not.toBe(first.reservationId);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM public.risk_reservation WHERE "tenantId"=$1',
        [f.key.binding.tenantId],
      )
    ).rows[0]!.n,
  ).toBe(2);
});
it('rejects a direct SQL caller that hashes a fabricated zero-exposure projection over a real active reservation', async () => {
  const f = await fixture(),
    port = await open();
  await port.approve(f.input, io());
  const next = await secondInput(f);
  await expect(
    directPayload(next, (raw) => {
      const certificate = raw['certificate'] as {
        projection: { snapshot: Record<string, unknown> };
      };
      Object.assign(certificate.projection.snapshot, {
        instrumentExposure: '0',
        assetExposure: '0',
        accountExposure: '0',
        userExposure: '0',
      });
    }),
  ).rejects.toThrow('RISK_ADMISSION_EXPOSURE');
});
it('rejects a direct SQL caller that fabricates a healthy loss baseline over the current durable loss checkpoint', async () => {
  const f = await fixture(),
    scope = { tenantId: f.key.binding.tenantId, mode: 'TESTNET' as const, valuationAsset: 'USDT' };
  const day = Math.floor(Date.now() / 86400000) * 86400000,
    previous = await loss.read(scope, day, io());
  if (!previous) throw new Error('LOSS_FIXTURE_REQUIRED');
  const now = Date.now();
  await loss.append(
    {
      scope,
      dayStart: day,
      id: randomUUID(),
      expectedSequence: previous.sequence,
      opening: null,
      coveredThrough: now,
      events: [{ id: randomUUID(), at: now, kind: 'EQUITY', amount: parseDecimal('700') }],
      coverage: {
        from: previous.coveredThrough,
        through: now,
        sourceId: randomUUID(),
        sourceHash: 'c'.repeat(64),
      },
    },
    io(),
  );
  await expect(
    directPayload(
      f.input,
      (raw) => {
        const certificate = raw['certificate'] as {
          projection: { snapshot: Record<string, unknown> };
        };
        certificate.projection.snapshot['adjustedCurrentEquity'] = '1000';
      },
      (s) => ({ ...s, adjustedCurrentEquity: parseDecimal('1000') }),
    ),
  ).rejects.toThrow('RISK_ADMISSION_LOSS');
});
it.each(['amount', 'watermark', 'status'] as const)(
  'rejects malformed or forged Portfolio %s before any durable financial effect',
  async (kind) => {
    const f = await fixture();
    await expect(
      directPayload(f.input, (raw) => {
        const p = raw['portfolio'] as {
          event: { hold: Record<string, unknown> };
          watermark: Record<string, unknown>;
        };
        if (kind === 'amount') delete p.event.hold['amount'];
        else if (kind === 'status') p.event.hold['status'] = null;
        else p.watermark['fingerprint'] = 'f'.repeat(64);
      }),
    ).rejects.toThrow('RISK_ADMISSION_PORTFOLIO');
    expect(
      (
        await admin.query('SELECT id FROM public.risk_reservation WHERE "tenantId"=$1', [
          f.key.binding.tenantId,
        ])
      ).rowCount,
    ).toBe(0);
  },
);
it('serializes concurrent intents under one tenant budget and cannot overcommit the account open-order limit', async () => {
  const f = await fixture(),
    second = await secondInput(f),
    port = await open();
  await user.update(
    {
      scope: { kind: 'USER', tenantId: f.key.binding.tenantId },
      mode: 'TESTNET',
      eventId: randomUUID(),
      expectedVersion: '1',
      reason: 'ISOLATED_CONCURRENT_ADMISSION',
      limits: riskLimitsSchema.parse({ ...f.risk.user, maxOpenOrders: 1 }),
    },
    io(),
  );
  const results = await Promise.allSettled([
    port.approve(f.input, io()),
    port.approve(second, io()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const denied = results.find((r) => r.status === 'rejected');
  expect(denied).toMatchObject({ status: 'rejected', reason: new Error('RISK_MAX_OPEN_ORDERS') });
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM public.risk_reservation WHERE "tenantId"=$1',
        [f.key.binding.tenantId],
      )
    ).rows[0]!.n,
  ).toBe(1);
});
it('concurrent exact duplicate admission returns one permanent result and creates one hold', async () => {
  const f = await fixture(),
    port = await open();
  const results = await Promise.all([port.approve(f.input, io()), port.approve(f.input, io())]);
  expect(results[0]).toEqual(results[1]);
  expect(
    (
      await admin.query<{ n: number }>(
        'SELECT count(*)::int n FROM public.risk_reservation WHERE "tenantId"=$1',
        [f.key.binding.tenantId],
      )
    ).rows[0]!.n,
  ).toBe(1);
});
it('enforces the same-mode user exposure limit across concurrent orders on distinct accounts', async () => {
  const f = await fixture(),
    accountId = randomUUID(),
    connectionId = randomUUID(),
    externalAccountId = 'native-account-' + accountId;
  await admin.query(
    'INSERT INTO public.exchange_account(id,"tenantId",exchange,mode,"externalAccountId",region,"accountMode",status,"clientIdEpoch","permissionEpoch","updatedAt") VALUES($1,$2,\'BINANCE\',\'TESTNET\',$3,\'global\',\'SPOT\',\'ACTIVE\',\'cross-account\',1,now())',
    [accountId, f.key.binding.tenantId, externalAccountId],
  );
  await admin.query(
    'INSERT INTO public.exchange_connection(id,"tenantId","accountId",mode,label,status,permissions,"permissionsVersion","permissionsVerifiedAt","updatedAt") VALUES($1,$2,$3,\'TESTNET\',\'cross-account\',\'ACTIVE\',\'{"read":true,"trade":true,"withdrawal":false}\',1,now(),now())',
    [connectionId, f.key.binding.tenantId, accountId],
  );
  const binding = { ...f.key.binding, accountId, connectionId, externalAccountId },
    now = Date.now();
  await portfolio.apply(
    {
      ...portfolioBinding(),
      tenantId: binding.tenantId,
      accountId,
      connectionId,
      externalAccountId,
    },
    snapshot({ id: randomUUID(), timestamp: now }),
    0,
    io(),
  );
  const { clientOrderId: omitted, ...order } = f.created.command;
  void omitted;
  const created = await orders.create(
    binding,
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
  await observer.publish(
    {
      ...f.observationEvent,
      id: randomUUID(),
      observation: {
        ...f.observationEvent.observation,
        key: { ...f.observationEvent.observation.key, binding },
      },
    },
    io(),
  );
  const scope = { tenantId: binding.tenantId, mode: 'TESTNET' as const, valuationAsset: 'USDT' },
    day = Math.floor(now / 86400000) * 86400000,
    previous = await loss.read(scope, day, io());
  await loss.append(
    {
      scope,
      dayStart: day,
      id: randomUUID(),
      expectedSequence: previous.sequence,
      opening: null,
      coveredThrough: now,
      events: [
        { id: randomUUID(), at: now, kind: 'FLOW', amount: parseDecimal('1000') },
        { id: randomUUID(), at: now, kind: 'EQUITY', amount: parseDecimal('2000') },
      ],
      coverage: {
        from: previous.coveredThrough,
        through: now,
        sourceId: randomUUID(),
        sourceHash: 'd'.repeat(64),
      },
    },
    io(),
  );
  await user.update(
    {
      scope: { kind: 'USER', tenantId: binding.tenantId },
      mode: 'TESTNET',
      eventId: randomUUID(),
      expectedVersion: '1',
      reason: 'ISOLATED_CROSS_ACCOUNT_BUDGET',
      limits: riskLimitsSchema.parse({ ...f.risk.user, maxUserExposure: '7.5' }),
    },
    io(),
  );
  const input = {
      ...f.input,
      binding,
      state: { id: created.id },
      intentId: created.intentId,
      commandHash: computeCommandHash('createOrder', created.command, {
        profile: binding.profile,
        account: { tenantId: binding.tenantId, connectionId, externalAccountId },
      }),
    },
    port = await open();
  const results = await Promise.allSettled([
    port.approve(f.input, io()),
    port.approve(input, io()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    status: 'rejected',
    reason: new Error('RISK_MAX_USER_EXPOSURE'),
  });
  expect(
    (
      await admin.query('SELECT id FROM public.risk_reservation WHERE "tenantId"=$1', [
        binding.tenantId,
      ])
    ).rowCount,
  ).toBe(1);
});
it('returns no grant on a real lost COMMIT response and recovers the same committed reservation and Portfolio hold after restart', async () => {
  const f = await fixture(),
    proxy = await registryCommitProxy(
      options('DATABASE_RISK_ADMISSION_URL').connectionString,
      'ADMISSION',
    );
  const monetaryBefore = (
    await admin.query(
      'SELECT to_jsonb(t) evidence FROM public.ledger_transaction t WHERE "tenantId"=$1 ORDER BY id',
      [f.key.binding.tenantId],
    )
  ).rows;
  let port: Awaited<ReturnType<typeof createPostgresOrderRiskPort>> | undefined;
  try {
    port = await createPostgresOrderRiskPort({
      connectionString: proxy.connectionString,
      environment: 'test',
    });
    proxy.arm();
    await expect(port.approve(f.input, io())).rejects.toThrow('RISK_SNAPSHOT_STORE_FAILED');
    expect(proxy.dropped()).toBe(1);
    await port.close();
    const restarted = await open(),
      result = await restarted.approve(f.input, io());
    expect(
      (
        await admin.query('SELECT id FROM public.risk_reservation WHERE "tenantId"=$1', [
          f.key.binding.tenantId,
        ])
      ).rows,
    ).toEqual([{ id: result.reservationId }]);
    expect(
      (
        await admin.query(
          'SELECT id FROM ctp_portfolio.evidence WHERE "tenantId"=$1 AND id LIKE \'risk-reserve-%\'',
          [f.key.binding.tenantId],
        )
      ).rows,
    ).toEqual([{ id: 'risk-reserve-' + result.reservationId }]);
    expect(
      (
        await admin.query(
          'SELECT to_jsonb(t) evidence FROM public.ledger_transaction t WHERE "tenantId"=$1 ORDER BY id',
          [f.key.binding.tenantId],
        )
      ).rows,
    ).toEqual(monetaryBefore);
  } finally {
    await port?.close();
    await proxy.close();
  }
});
it.each(['ABORT', 'DEADLINE'] as const)(
  'physically tears down admission waiting on the native tenant lock on %s, with no late reserve and a usable pool',
  async (kind) => {
    const f = await fixture(),
      port = await open(),
      blocker = await admin.connect();
    const login = new URL(options('DATABASE_RISK_ADMISSION_URL').connectionString).username;
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('ctp:risk:'||$1::text,0))",
        [f.key.binding.tenantId],
      );
      const controller = new AbortController(),
        started = Date.now();
      pending = port.approve(f.input, {
        signal: controller.signal,
        deadline: Date.now() + (kind === 'DEADLINE' ? 150 : 2500),
      });
      const refused = expect(pending).rejects.toThrow('RISK_SNAPSHOT_ABORTED');
      if (kind === 'ABORT') {
        const deadline = Date.now() + 500;
        while (Date.now() < deadline) {
          if (
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
                [login],
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
      const teardown = Date.now();
      let waiters = 1;
      while (waiters && Date.now() - teardown < 2500) {
        waiters =
          (
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
              [login],
            )
          ).rowCount ?? 1;
        if (waiters) await new Promise((r) => setTimeout(r, 5));
      }
      expect(waiters).toBe(0);
      expect(Date.now() - teardown).toBeLessThan(2500);
      expect(
        (
          await admin.query('SELECT id FROM public.risk_reservation WHERE "tenantId"=$1', [
            f.key.binding.tenantId,
          ])
        ).rowCount,
      ).toBe(0);
      await blocker.query('COMMIT');
      expect(await port.approve(f.input, io())).toHaveProperty('reservationId');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await pending?.catch(() => {});
      blocker.release();
    }
  },
);
