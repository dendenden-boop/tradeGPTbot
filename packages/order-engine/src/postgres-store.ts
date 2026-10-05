import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import {
  authorizationSchema,
  operations,
  computeCommandHash,
  newOrderSchema,
  mutationOutcomeSchema,
  orderSchema,
  decimalMultiply,
  parseDecimal,
} from '@ctp/exchange-core';
import { bindingSchema as portfolioBindingSchema, fillEventSchema } from '@ctp/portfolio';
import {
  bindingSchema,
  draftSchema,
  grantSchema,
  stateSchema,
  hash,
  canonical,
  type OrderBinding,
  type OrderDraft,
  type OrderState,
  type IoContext,
  type DispatchClaim,
  type OrderStore,
  type OrderEngineEvent,
} from './domain.js';
import { reduceOrder, terminal } from './state.js';
const bytes = (value: string) => Buffer.from(value, 'hex');
const market = (b: OrderBinding) => (b.profile.market === 'SPOT' ? 'SPOT' : 'PERPETUAL');
export async function createPostgresOrderStore(options: {
  connectionString: string;
  environment: 'test' | 'development' | 'staging' | 'production';
}): Promise<OrderStore> {
  let url: URL;
  try {
    z.strictObject({
      connectionString: z.string().max(4096),
      environment: z.enum(['test', 'development', 'staging', 'production']),
    }).parse(options);
    url = new URL(options.connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.username ||
      !url.pathname.slice(1) ||
      url.hash ||
      [...url.searchParams.keys()].some((k) => k !== 'sslmode') ||
      (options.environment === 'production' && url.searchParams.get('sslmode') !== 'verify-full') ||
      (options.environment === 'test' &&
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
      throw new Error();
  } catch {
    throw new Error('ORDER_DATABASE_URL_INVALID');
  }
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 4,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 10000,
    statement_timeout: 2000,
    query_timeout: 2500,
    options: '-c idle_in_transaction_session_timeout=3000',
  });
  pool.on('error', () => {});
  let closed = false;
  const sockets = new Set<PoolClient>();
  pool.on('connect', (c) => {
    sockets.add(c);
    c.once('end', () => sockets.delete(c));
  });
  const io = () => ({ signal: new AbortController().signal, deadline: Date.now() + 3000 });
  async function tx<T>(
    b: OrderBinding | null,
    c: IoContext,
    work: (p: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new Error('ORDER_CLOSED');
    if (c.signal.aborted || !Number.isSafeInteger(c.deadline) || c.deadline <= Date.now())
      throw new Error('ORDER_ABORTED');
    let p: PoolClient | undefined,
      destroyed = false;
    const abort = () => {
      if (destroyed) return;
      destroyed = true;
      p?.release(true);
    };
    c.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(c.deadline - Date.now(), 3000));
    try {
      p = await pool.connect();
      if (destroyed || c.signal.aborted) {
        p.release(true);
        p = undefined;
        throw new Error('ORDER_ABORTED');
      }
      await p.query('BEGIN');
      if (b) await p.query("SELECT set_config('app.tenant_id',$1,true)", [b.tenantId]);
      const value = await work(p);
      if (destroyed || c.signal.aborted) throw new Error('ORDER_ABORTED');
      await p.query('COMMIT');
      if (destroyed || c.signal.aborted) throw new Error('ORDER_ABORTED');
      return value;
    } catch (error) {
      if (p && !destroyed) await p.query('ROLLBACK').catch(() => {});
      const message =
        error instanceof Error && /^ORDER_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'ORDER_STORE_FAILED';
      throw new Error(destroyed || c.signal.aborted ? 'ORDER_ABORTED' : message, {
        // eslint-disable-next-line preserve-caught-error -- Raw PostgreSQL errors may contain binding data or connection secrets.
        cause: new Error('ORDER_TRANSACTION_FAILED'),
      });
    } finally {
      clearTimeout(timer);
      c.signal.removeEventListener('abort', abort);
      if (p && !destroyed) p.release();
    }
  }
  try {
    await tx(null, io(), async (p) => {
      const r = await p.query<{ safe: boolean }>(
        `SELECT NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication) AND current_user=session_user AND NOT has_function_privilege(current_user,'ctp_risk.update_global(jsonb)','EXECUTE') AND NOT has_function_privilege(current_user,'ctp_risk.update_tenant(jsonb)','EXECUTE') AND pg_has_role(current_user,'ctp_execution','MEMBER') AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE (x.rolsuper OR x.rolbypassrls OR x.rolcreatedb OR x.rolcreaterole OR x.rolreplication OR left(x.rolname,3)='pg_' OR x.rolname IN('ctp_api','ctp_auth','ctp_auth_owner','ctp_ingest','ctp_signer','ctp_portfolio','ctp_risk_control','ctp_risk_operator')) AND pg_has_role(current_user,x.oid,'MEMBER')) AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT has_schema_privilege(current_user,'ctp_execution','CREATE') AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP') AND NOT EXISTS(SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND pg_has_role(current_user,x.relowner,'MEMBER')) AND NOT has_table_privilege(current_user,'public.ledger_transaction','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS safe FROM pg_roles r WHERE r.rolname=current_user`,
      );
      if (r.rows[0]?.safe !== true) throw new Error('ORDER_ROLE_UNSAFE');
      const privileges = await p.query<{ safe: boolean }>(`SELECT NOT EXISTS(
        SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN('public','ctp_auth','ctp_market','ctp_portfolio','ctp_execution','ctp_risk') AND t.relkind IN('r','p','v','m','f') AND (
          (t.oid NOT IN('public.exchange_account'::regclass,'public.exchange_connection'::regclass,'public.instrument'::regclass,'public.instrument_rule_version'::regclass,'public.capability_snapshot'::regclass,'public.account_state_version'::regclass,'public.risk_decision'::regclass,'public.risk_reservation'::regclass,'public.ledger_transaction'::regclass,'public.order_intent'::regclass,'public.order'::regclass,'public.order_event'::regclass,'public.submission_attempt'::regclass,'public.fill'::regclass,'public.fee'::regclass,'public.outbox_event'::regclass,'ctp_portfolio.book'::regclass,'ctp_portfolio.evidence'::regclass,'ctp_execution.command'::regclass,'ctp_execution.progress'::regclass,'ctp_execution.evidence'::regclass,'ctp_execution.fill_adoption'::regclass) AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
          OR has_table_privilege(current_user,t.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES')
          OR (t.oid IN('public.exchange_connection'::regclass,'public.instrument'::regclass,'public.instrument_rule_version'::regclass,'public.capability_snapshot'::regclass,'public.account_state_version'::regclass,'public.risk_decision'::regclass,'public.risk_reservation'::regclass,'public.ledger_transaction'::regclass,'ctp_portfolio.book'::regclass,'ctp_portfolio.evidence'::regclass) AND (has_table_privilege(current_user,t.oid,'INSERT,UPDATE') OR has_any_column_privilege(current_user,t.oid,'INSERT,UPDATE')))
          OR (t.oid IN('public.order_intent'::regclass,'public.order_event'::regclass,'public.fill'::regclass,'public.fee'::regclass,'public.outbox_event'::regclass,'ctp_execution.command'::regclass,'ctp_execution.evidence'::regclass,'ctp_execution.fill_adoption'::regclass) AND has_any_column_privilege(current_user,t.oid,'UPDATE'))
        )) AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('ctp_auth','ctp_market','ctp_portfolio') AND has_schema_privilege(current_user,n.oid,'CREATE')) AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.exchange_account'::regclass AND a.attnum>0 AND NOT a.attisdropped AND (has_column_privilege(current_user,a.attrelid,a.attnum,'INSERT') OR (a.attname<>'clientIdHighWatermark' AND has_column_privilege(current_user,a.attrelid,a.attnum,'UPDATE')))) AS safe`);
      if (privileges.rows[0]?.safe !== true) throw new Error('ORDER_ROLE_UNSAFE');
      await p.query('SELECT "intentId" FROM ctp_execution.command LIMIT 0');
    });
  } catch {
    closed = true;
    await pool.end();
    throw new Error('ORDER_DATABASE_ROLE_UNSAFE');
  }
  async function owner(p: PoolClient, b: OrderBinding, lock = false) {
    const r = await p.query<{ epoch: string; counter: string; status: string; permission: string }>(
      `SELECT a."clientIdEpoch" AS epoch,a."clientIdHighWatermark"::text AS counter,a.status::text,a."permissionEpoch"::text AS permission FROM public.exchange_account a LEFT JOIN public.exchange_connection x ON x."tenantId"=a."tenantId" AND x."accountId"=a.id AND x.mode=a.mode AND x.id=$4 WHERE a."tenantId"=$1 AND a.id=$2 AND a.mode=$3 AND a.exchange=$5 AND a.region=$6 AND a."externalAccountId"=$7 AND a."accountMode"=$8 AND (($3='PAPER' AND $4::uuid IS NULL) OR x.id IS NOT NULL) ${lock ? 'FOR UPDATE OF a' : ''}`,
      [
        b.tenantId,
        b.accountId,
        b.mode,
        b.connectionId,
        b.profile.exchange,
        b.profile.region,
        b.externalAccountId,
        b.profile.accountMode,
      ],
    );
    if (!r.rows[0]) throw new Error('ORDER_BINDING_DENIED');
    return r.rows[0];
  }
  async function metadata(p: PoolClient, b: OrderBinding, d: OrderDraft) {
    const r = await p.query<{ base: string; quote: string }>(
      `SELECT i."baseAsset" AS base,i."quoteAsset" AS quote FROM public.instrument i JOIN public.instrument_rule_version r ON r."instrumentId"=i.id WHERE i.id=$1 AND r.id=$2 AND i.exchange=$3 AND i.mode=$4 AND i.market=$5 AND i."exchangeSymbol"=$6 AND i.active AND NOT i."isInverse" AND i."expiryAt" IS NULL AND r."isCurrent" AND r."effectiveAt"<=now() AND r.rules->>'version'=$7`,
      [
        d.dbInstrumentId,
        d.dbRuleId,
        b.profile.exchange,
        b.mode,
        market(b),
        d.order.instrumentId,
        d.order.ruleVersion,
      ],
    );
    const m = r.rows[0];
    if (!m || d.order.size.kind !== 'BASE_QUANTITY' || d.order.size.asset !== m.base)
      throw new Error('ORDER_METADATA');
    return m;
  }
  type Row = {
    payload: string;
    binding: string;
    draft: string;
    intentId: string;
    status: OrderState['status'];
    reconciliation: OrderState['reconciliation'];
    version: number;
    exchangeId: string | null;
    quantity: string;
    average: string;
    nativeAt: string | null;
    nativeStatus: OrderState['status'] | null;
    nativeHash: Buffer | null;
    created: string;
    executed: string;
    notional: string;
    attemptId: string | null;
    operation: 'PLACE' | 'CANCEL' | null;
  };
  async function read(
    p: PoolClient,
    b: OrderBinding,
    id: string,
    lock = false,
  ): Promise<OrderState> {
    z.uuid().parse(id);
    const r = await p.query<Row>(
      `SELECT c.command AS payload,c.binding,c.draft,o."intentId",o.status,o."reconciliationState" AS reconciliation,o.version,o."exchangeOrderId" AS "exchangeId",o."filledQuantity"::text AS quantity,o."averageFillPrice"::text AS average,g."nativeAt"::text,g."nativeHash",g."nativeStatus",(extract(epoch from o."createdAt")*1000)::bigint::text AS created,COALESCE((SELECT sum(quantity) FROM public.fill f WHERE f."tenantId"=o."tenantId" AND f."orderId"=o.id),0)::text AS executed,COALESCE((SELECT sum("quoteAmount") FROM public.fill f WHERE f."tenantId"=o."tenantId" AND f."orderId"=o.id),0)::text AS notional,a.id AS "attemptId",a.operation FROM public."order" o JOIN ctp_execution.command c ON c."tenantId"=o."tenantId" AND c."intentId"=o."intentId" JOIN ctp_execution.progress g ON g."tenantId"=o."tenantId" AND g."orderId"=o.id LEFT JOIN LATERAL(SELECT id,operation FROM public.submission_attempt WHERE "tenantId"=o."tenantId" AND "orderId"=o.id AND status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED') ORDER BY "operationVersion" DESC LIMIT 1)a ON true WHERE o."tenantId"=$1 AND o.id=$2 ${lock ? 'FOR UPDATE OF o' : ''}`,
      [b.tenantId, id],
    );
    const x = r.rows[0];
    if (!x || canonical(bindingSchema.parse(JSON.parse(x.binding) as unknown)) !== canonical(b))
      throw new Error('ORDER_BINDING_DENIED');
    return stateSchema.parse({
      id,
      intentId: x.intentId,
      binding: b,
      draft: draftSchema.parse(JSON.parse(x.draft) as unknown),
      command: newOrderSchema.parse(JSON.parse(x.payload) as unknown),
      status: x.status,
      reconciliation: x.reconciliation,
      version: x.version,
      exchangeOrderId: x.exchangeId,
      filledQuantity: parseDecimal(x.quantity),
      executedQuantity: parseDecimal(x.executed),
      executionNotional: parseDecimal(x.notional),
      averageFillPrice: x.average === '0' ? null : parseDecimal(x.average),
      lastNativeStatus: x.nativeStatus,
      lastExchangeAt: x.nativeAt === null ? null : Number(x.nativeAt),
      lastObservationHash: x.nativeHash?.toString('hex') ?? null,
      activeAttemptId: x.attemptId,
      activeOperation: x.operation,
      createdAt: Number(x.created),
    });
  }
  async function publish(
    p: PoolClient,
    s: OrderState,
    source: string,
    identity: string,
    fp: string,
    previous: OrderState['status'] | null,
  ) {
    await p.query(
      'INSERT INTO public.order_event("tenantId","orderId",version,"previousStatus",status,source,"sourceIdentity","evidenceHash","occurredAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())',
      [s.binding.tenantId, s.id, s.version, previous, s.status, source, identity, bytes(fp)],
    );
    await p.query(
      `INSERT INTO public.outbox_event("tenantId","eventType","schemaVersion","aggregateType","aggregateId","aggregateVersion",payload,"occurredAt") VALUES($1,'OrderUpdated',1,'Order',$2,$3,$4::jsonb,now())`,
      [
        s.binding.tenantId,
        s.id,
        s.version,
        canonical({
          orderId: s.id,
          intentId: s.intentId,
          status: s.status,
          reconciliation: s.reconciliation,
        }),
      ],
    );
  }
  async function apply(
    p: PoolClient,
    s: OrderState,
    event: OrderEngineEvent,
    identity: string,
  ): Promise<OrderState> {
    const fp = hash(event),
      seen = await p.query<{ fingerprint: Buffer }>(
        'SELECT fingerprint FROM ctp_execution.evidence WHERE "tenantId"=$1 AND "orderId"=$2 AND identity=$3',
        [s.binding.tenantId, s.id, identity],
      );
    if (seen.rows[0]) {
      if (!seen.rows[0].fingerprint.equals(bytes(fp))) throw new Error('ORDER_EVIDENCE_CONFLICT');
      return s;
    }
    const next = reduceOrder(s, event);
    await p.query(
      'INSERT INTO ctp_execution.evidence("tenantId","orderId",identity,fingerprint) VALUES($1,$2,$3,$4)',
      [s.binding.tenantId, s.id, identity, bytes(fp)],
    );
    if (next.version === s.version) return s;
    await p.query(
      'UPDATE public."order" SET status=$1,"reconciliationState"=$2,"filledQuantity"=$3::numeric,"averageFillPrice"=$4::numeric,"exchangeOrderId"=$5,version=$6,"lastExchangeAt"=to_timestamp($7::double precision/1000),"terminalAt"=CASE WHEN $8 THEN COALESCE("terminalAt",now()) ELSE "terminalAt" END,"updatedAt"=now() WHERE "tenantId"=$9 AND id=$10',
      [
        next.status,
        next.reconciliation,
        next.filledQuantity,
        next.averageFillPrice ?? '0',
        next.exchangeOrderId,
        next.version,
        next.lastExchangeAt,
        terminal(next.status),
        s.binding.tenantId,
        s.id,
      ],
    );
    await p.query(
      'UPDATE ctp_execution.progress SET "nativeAt"=$1,"nativeHash"=$2,"nativeStatus"=$3 WHERE "tenantId"=$4 AND "orderId"=$5',
      [
        next.lastExchangeAt,
        next.lastObservationHash === null ? null : bytes(next.lastObservationHash),
        next.lastNativeStatus,
        s.binding.tenantId,
        s.id,
      ],
    );
    await publish(p, next, event.type, identity, fp, s.status);
    return next;
  }
  async function insertIntent(
    p: PoolClient,
    b: OrderBinding,
    d: OrderDraft,
    intentId: string,
    cmd: unknown,
    operation: 'PLACE' | 'CANCEL',
    target: string | null,
    fp: string,
  ) {
    const m = await metadata(p, b, d);
    const o = d.order;
    await p.query(
      `INSERT INTO public.order_intent(id,"tenantId","accountId",mode,"connectionId","instrumentId","ruleVersionId","targetOrderId",origin,destination,operation,"idempotencyKey","commandHash",side,"positionSide","orderType","timeInForce","quantityAsset","priceAsset",quantity,"limitPrice","triggerPrice","reduceOnly") VALUES($1,$2,$3,$4,$5,$6,$7,$8,'USER',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::numeric,$20::numeric,$21::numeric,$22)`,
      [
        intentId,
        b.tenantId,
        b.accountId,
        b.mode,
        b.connectionId,
        d.dbInstrumentId,
        d.dbRuleId,
        target,
        b.mode === 'PAPER' ? 'PAPER_ENGINE' : 'EXCHANGE',
        operation,
        d.key,
        bytes(fp),
        o.side,
        d.positionSide,
        o.type,
        o.timeInForce,
        m.base,
        m.quote,
        o.size.value,
        o.limitPrice,
        o.trigger?.price ?? null,
        o.reduceOnly,
      ],
    );
    void cmd;
  }
  async function risk(
    p: PoolClient,
    b: OrderBinding,
    s: OrderState,
    intentId: string,
    fp: string,
    g: ReturnType<typeof grantSchema.parse>,
    decisionDraft: OrderDraft = s.draft,
  ) {
    if (!['TESTNET', 'DEMO'].includes(b.mode)) throw new Error('ORDER_MODE_DISABLED');
    const r = await p.query(
      `SELECT r.id FROM public.risk_reservation r JOIN public.risk_decision d ON d."tenantId"=r."tenantId" AND d.id=r."decisionId" JOIN public.exchange_account a ON a."tenantId"=d."tenantId" AND a.id=d."accountId" AND a.mode=d.mode JOIN public.exchange_connection x ON x."tenantId"=a."tenantId" AND x."accountId"=a.id AND x.mode=a.mode JOIN public.account_state_version v ON v."tenantId"=d."tenantId" AND v.id=d."stateVersionId" JOIN public.capability_snapshot c ON c.id=d."capabilitySnapshotId" WHERE r."tenantId"=$1 AND r.id=$2 AND d.id=$3 AND d."intentId"=$4 AND d."accountId"=$5 AND d.mode=$6 AND d."commandHash"=$7 AND d."ruleVersionId"=$8 AND d."permissionEpoch"=$9::bigint AND a."permissionEpoch"=d."permissionEpoch" AND a.status='ACTIVE' AND x.id=$10 AND x.status='ACTIVE' AND x."disabledAt" IS NULL AND NOT x."withdrawalPermissionDetected" AND x.permissions->>'trade'='true' AND x."permissionsVerifiedAt">=now()-interval '30 seconds' AND x."permissionsVerifiedAt"<=now() AND d.verdict IN('APPROVE','REDUCE_ONLY') AND (d.verdict<>'REDUCE_ONLY' OR $11) AND d."expiresAt">=to_timestamp($12::double precision/1000) AND r."expiresAt">=to_timestamp($12::double precision/1000) AND r.status='ACTIVE' AND v."reconciledAt">=now()-interval '5 seconds' AND v."reconciliationEpoch"=a."reconciliationEpoch" AND v."sourceAt">=now()-interval '5 seconds' AND v."sourceAt"<=now() AND v."receivedAt"<=now() AND v."receivedAt">=v."sourceAt" AND v."reconciledAt"<=now() AND NOT EXISTS(SELECT 1 FROM public.account_state_version newer WHERE newer."tenantId"=v."tenantId" AND newer."accountId"=v."accountId" AND newer.mode=v.mode AND newer.version>v.version) AND c.exchange=$13 AND c.mode=$6 AND c.market=$14 AND c.region=$15 AND c."accountMode"=$16 AND c."profileVersion"=$17 AND c."verifiedAt"<=now() AND c."expiresAt">=to_timestamp($12::double precision/1000)`,
      [
        b.tenantId,
        g.reservationId,
        g.decisionId,
        intentId,
        b.accountId,
        b.mode,
        bytes(fp),
        decisionDraft.dbRuleId,
        g.permissionEpoch,
        b.connectionId,
        s.command.reduceOnly,
        g.expiresAt,
        b.profile.exchange,
        market(b),
        b.profile.region,
        b.profile.accountMode,
        b.profile.profileVersion,
      ],
    );
    if (r.rowCount !== 1 || g.expiresAt <= Date.now() || g.expiresAt - Date.now() > 30000)
      throw new Error('ORDER_RISK_DENIED');
    await metadata(p, b, decisionDraft);
  }
  async function findCreate(p: PoolClient, b: OrderBinding, d: OrderDraft) {
    const seen = await p.query<{ id: string; requestHash: Buffer }>(
      'SELECT c."orderId" AS id,c."requestHash" FROM ctp_execution.command c JOIN public.order_intent i ON i."tenantId"=c."tenantId" AND i.id=c."intentId" WHERE i."tenantId"=$1 AND i.operation=\'PLACE\' AND i."idempotencyKey"=$2',
      [b.tenantId, d.key],
    );
    const previous = seen.rows[0];
    if (!previous) return null;
    if (!previous.requestHash.equals(bytes(hash({ binding: b, draft: d }))))
      throw new Error('ORDER_IDEMPOTENCY_CONFLICT');
    return read(p, b, previous.id);
  }
  return Object.freeze({
    findCreate(rawB: OrderBinding, rawD: OrderDraft, c: IoContext) {
      const b = bindingSchema.parse(rawB),
        d = draftSchema.parse(rawD);
      return tx(b, c, async (p) => {
        await owner(p, b);
        return findCreate(p, b, d);
      });
    },
    create(rawB: OrderBinding, rawD: OrderDraft, c: IoContext) {
      const b = bindingSchema.parse(rawB),
        d = draftSchema.parse(rawD),
        requestHash = hash({ binding: b, draft: d });
      return tx(b, c, async (p) => {
        const a = await owner(p, b, true);
        const existing = await findCreate(p, b, d);
        if (existing !== null) return existing;
        if (BigInt(a.counter) >= 9223372036854775807n) throw new Error('ORDER_ID_EXHAUSTED');
        const clientId = (BigInt(a.counter) + 1n).toString();
        await p.query(
          'UPDATE public.exchange_account SET "clientIdHighWatermark"=$1::bigint WHERE "tenantId"=$2 AND id=$3',
          [clientId, b.tenantId, b.accountId],
        );
        const id = randomUUID(),
          intentId = randomUUID(),
          command = newOrderSchema.parse({ ...d.order, clientOrderId: clientId }),
          fp =
            b.mode === 'PAPER'
              ? hash({ operation: 'createOrder', command, binding: b })
              : computeCommandHash('createOrder', command, {
                  profile: b.profile,
                  account: {
                    tenantId: b.tenantId,
                    connectionId: b.connectionId,
                    externalAccountId: b.externalAccountId,
                  },
                });
        await insertIntent(p, b, d, intentId, command, 'PLACE', null, fp);
        const m = await metadata(p, b, d);
        await p.query(
          `INSERT INTO public."order"(id,"tenantId","intentId","accountId",mode,"connectionId","instrumentId","ruleVersionId","clientIdNamespace","clientId",market,side,"positionSide","orderType","timeInForce","quantityAsset","priceAsset",quantity,"limitPrice","reduceOnly","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::numeric,$19::numeric,$20,now())`,
          [
            id,
            b.tenantId,
            intentId,
            b.accountId,
            b.mode,
            b.connectionId,
            d.dbInstrumentId,
            d.dbRuleId,
            a.epoch,
            clientId,
            market(b),
            command.side,
            d.positionSide,
            command.type,
            command.timeInForce,
            m.base,
            m.quote,
            command.size.value,
            command.limitPrice,
            command.reduceOnly,
          ],
        );
        await p.query(
          'INSERT INTO ctp_execution.command("tenantId","intentId","orderId",binding,draft,command,operation,"requestHash","commandHash") VALUES($1,$2,$3,$4,$5,$6,\'PLACE\',$7,$8)',
          [
            b.tenantId,
            intentId,
            id,
            canonical(b),
            canonical(d),
            canonical(command),
            bytes(requestHash),
            bytes(fp),
          ],
        );
        await p.query('INSERT INTO ctp_execution.progress("tenantId","orderId") VALUES($1,$2)', [
          b.tenantId,
          id,
        ]);
        const s = await read(p, b, id);
        await publish(p, s, 'CREATE', intentId, fp, null);
        return s;
      });
    },
    read(rawB: OrderBinding, id: string, c: IoContext) {
      const b = bindingSchema.parse(rawB);
      return tx(b, c, async (p) => {
        await owner(p, b);
        return read(p, b, id);
      });
    },
    cancelIntent(rawB: OrderBinding, id: string, key: string, c: IoContext) {
      const b = bindingSchema.parse(rawB);
      idSchemaParse(key);
      return tx(b, c, async (p) => {
        await owner(p, b, true);
        const s = await read(p, b, id, true);
        const command = {
            instrumentId: s.command.instrumentId,
            locator: { kind: 'CLIENT_ID' as const, id: s.command.clientOrderId },
          },
          requestHash = hash({ binding: b, orderId: id, command }),
          fp = computeCommandHash('cancelOrder', command, {
            profile: b.profile,
            account: {
              tenantId: b.tenantId,
              connectionId: b.connectionId,
              externalAccountId: b.externalAccountId,
            },
          });
        const seen = await p.query<{
          intentId: string;
          requestHash: Buffer;
          draft: string;
          dispatched: boolean;
        }>(
          'SELECT c."intentId",c."requestHash",c.draft,EXISTS(SELECT 1 FROM public.submission_attempt t WHERE t."tenantId"=c."tenantId" AND t."intentId"=c."intentId") AS dispatched FROM ctp_execution.command c JOIN public.order_intent i ON i."tenantId"=c."tenantId" AND i.id=c."intentId" WHERE i."tenantId"=$1 AND i.operation=\'CANCEL\' AND i."idempotencyKey"=$2',
          [b.tenantId, key],
        );
        if (seen.rows[0]) {
          if (!seen.rows[0].requestHash.equals(bytes(requestHash)))
            throw new Error('ORDER_IDEMPOTENCY_CONFLICT');
          return {
            state: s,
            intentId: seen.rows[0].intentId,
            commandHash: fp,
            ruleVersion: draftSchema.parse(JSON.parse(seen.rows[0].draft) as unknown).order
              .ruleVersion,
            dispatched: seen.rows[0].dispatched,
          };
        }
        const intentId = randomUUID();
        const current = await p.query<{ id: string; version: string }>(
          `SELECT id,rules->>'version' AS version FROM public.instrument_rule_version WHERE "instrumentId"=$1 AND "isCurrent" AND "effectiveAt"<=now()`,
          [s.draft.dbInstrumentId],
        );
        if (current.rowCount !== 1 || !current.rows[0]?.version) throw new Error('ORDER_METADATA');
        const d = draftSchema.parse({
          ...s.draft,
          key,
          dbRuleId: current.rows[0].id,
          order: { ...s.draft.order, ruleVersion: current.rows[0].version },
        });
        await insertIntent(p, b, d, intentId, command, 'CANCEL', id, fp);
        await p.query(
          'INSERT INTO ctp_execution.command("tenantId","intentId","orderId",binding,draft,command,operation,"requestHash","commandHash") VALUES($1,$2,$3,$4,$5,$6,\'CANCEL\',$7,$8)',
          [
            b.tenantId,
            intentId,
            id,
            canonical(b),
            canonical(d),
            canonical(command),
            bytes(requestHash),
            bytes(fp),
          ],
        );
        await p.query(
          `INSERT INTO public.outbox_event("tenantId","eventType","schemaVersion","aggregateType","aggregateId","aggregateVersion",payload,"occurredAt") VALUES($1,'OrderIntentCreated',1,'OrderIntent',$2,0,$3::jsonb,now())`,
          [b.tenantId, intentId, canonical({ intentId, orderId: id, operation: 'CANCEL' })],
        );
        return {
          state: s,
          intentId,
          commandHash: fp,
          ruleVersion: d.order.ruleVersion,
          dispatched: false,
        };
      });
    },
    begin(
      rawB: OrderBinding,
      id: string,
      intentId: string,
      rawG: ReturnType<typeof grantSchema.parse>,
      c: IoContext,
    ) {
      const b = bindingSchema.parse(rawB),
        g = grantSchema.parse(rawG);
      return tx(b, c, async (p) => {
        await owner(p, b, true);
        let s = await read(p, b, id, true);
        const existing = await p.query(
          'SELECT id FROM public.submission_attempt WHERE "tenantId"=$1 AND "intentId"=$2',
          [b.tenantId, intentId],
        );
        if (existing.rowCount) return null;
        const cr = await p.query<{
          operation: 'PLACE' | 'CANCEL';
          command: string;
          commandHash: Buffer;
          draft: string;
        }>(
          'SELECT operation,command,"commandHash",draft FROM ctp_execution.command WHERE "tenantId"=$1 AND "intentId"=$2 AND "orderId"=$3',
          [b.tenantId, intentId, id],
        );
        const cmd = cr.rows[0];
        if (!cmd) throw new Error('ORDER_BINDING_DENIED');
        if (cmd.operation === 'PLACE') {
          const blocked = await p.query(
            "SELECT id FROM public.\"order\" WHERE \"tenantId\"=$1 AND \"accountId\"=$2 AND mode=$3 AND id<>$4 AND (status IN('SUBMITTING','UNKNOWN','RECONCILIATION_REQUIRED','CANCEL_PENDING') OR (status<>'CREATED' AND \"reconciliationState\"<>'CONSISTENT')) LIMIT 1",
            [b.tenantId, b.accountId, b.mode, id],
          );
          if (blocked.rowCount) throw new Error('ORDER_RECONCILIATION_REQUIRED');
        }
        await risk(
          p,
          b,
          s,
          intentId,
          cmd.commandHash.toString('hex'),
          g,
          draftSchema.parse(JSON.parse(cmd.draft) as unknown),
        );
        if (cmd.operation === 'PLACE')
          s = await apply(p, s, { type: 'APPROVE' }, `approve:${intentId}`);
        const attemptId = randomUUID();
        await p.query(
          `INSERT INTO public.submission_attempt(id,"tenantId","orderId","intentId","accountId",mode,"instrumentId","operationVersion",operation,"permissionEpoch","reservationId","workerId","commandHash","permitConsumedAt","deadlineAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,$11,'order-engine',$12,now(),to_timestamp($13::double precision/1000))`,
          [
            attemptId,
            b.tenantId,
            id,
            intentId,
            b.accountId,
            b.mode,
            s.draft.dbInstrumentId,
            s.version + 1,
            cmd.operation,
            g.permissionEpoch,
            g.reservationId,
            cmd.commandHash,
            g.expiresAt,
          ],
        );
        s = await apply(
          p,
          s,
          { type: 'DISPATCH', operation: cmd.operation, attemptId },
          `dispatch:${attemptId}`,
        );
        return {
          state: s,
          intentId,
          attemptId,
          operation: cmd.operation,
          commandHash: cmd.commandHash.toString('hex'),
          command: JSON.parse(cmd.command) as unknown,
          expiresAt: g.expiresAt,
        };
      });
    },
    result(rawB: OrderBinding, claim: DispatchClaim, raw: unknown, c: IoContext) {
      const b = bindingSchema.parse(rawB),
        outcome = mutationOutcomeSchema.parse(raw);
      return tx(b, c, async (p) => {
        await owner(p, b, true);
        const s = await read(p, b, claim.state.id, true);
        const proof = await p.query(
          `SELECT t.id FROM public.submission_attempt t JOIN ctp_execution.command k ON k."tenantId"=t."tenantId" AND k."intentId"=t."intentId" WHERE t."tenantId"=$1 AND t.id=$2 AND t."orderId"=$3 AND t."intentId"=$4 AND t.operation=$5 AND t."commandHash"=$6 AND k.command=$7 AND (extract(epoch from t."deadlineAt")*1000)::bigint=$8::bigint`,
          [
            b.tenantId,
            claim.attemptId,
            s.id,
            claim.intentId,
            claim.operation,
            bytes(claim.commandHash),
            canonical(claim.command),
            claim.expiresAt,
          ],
        );
        if (
          proof.rowCount !== 1 ||
          (outcome.kind === 'ACCEPTED' && outcome.ack.commandId !== claim.intentId)
        )
          throw new Error('ORDER_BINDING_DENIED');
        const n = await apply(
          p,
          s,
          { type: 'RESULT', operation: claim.operation, attemptId: claim.attemptId, outcome },
          `result:${claim.attemptId}`,
        );
        await p.query(
          'UPDATE public.submission_attempt SET status=$1,"responseReceivedAt"=now(),"responseCode"=$2,"evidenceHash"=$3 WHERE "tenantId"=$4 AND id=$5 AND "orderId"=$6 AND status<>\'RECONCILED\'',
          [
            outcome.kind === 'ACCEPTED'
              ? 'ACKNOWLEDGED'
              : outcome.kind === 'UNKNOWN'
                ? 'UNKNOWN'
                : 'REJECTED',
            outcome.kind,
            bytes(hash(outcome)),
            b.tenantId,
            claim.attemptId,
            s.id,
          ],
        );
        return n;
      });
    },
    observe(rawB: OrderBinding, id: string, raw: unknown, c: IoContext) {
      const b = bindingSchema.parse(rawB),
        order = orderSchema.parse(raw);
      return tx(b, c, async (p) => {
        await owner(p, b, true);
        const s = await read(p, b, id, true);
        if (s.status === 'CREATED') throw new Error('ORDER_TRANSITION');
        const n = await apply(p, s, { type: 'NATIVE', order }, `native:${order.updatedAt}`);
        if (
          n.lastExchangeAt !== s.lastExchangeAt &&
          order.status !== 'UNKNOWN' &&
          (s.activeOperation === 'PLACE' || terminal(n.status))
        )
          await p.query(
            "UPDATE public.submission_attempt SET status='RECONCILED',\"resolvedAt\"=now() WHERE \"tenantId\"=$1 AND \"orderId\"=$2 AND status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED')",
            [b.tenantId, id],
          );
        return n;
      });
    },
    gap(rawB: OrderBinding, id: string, c: IoContext) {
      const b = bindingSchema.parse(rawB);
      return tx(b, c, async (p) => {
        await owner(p, b, true);
        const s = await read(p, b, id, true);
        return apply(p, s, { type: 'GAP' }, `gap:${s.version}`);
      });
    },
    complete(rawB: OrderBinding, id: string, raw: unknown, c: IoContext) {
      const b = bindingSchema.parse(rawB),
        order = orderSchema.parse(raw);
      return tx(b, c, async (p) => {
        await owner(p, b, true);
        let s = await read(p, b, id, true);
        if (order.updatedAt > Date.now() || s.status === 'CREATED')
          throw new Error('ORDER_HISTORY_REQUIRED');
        s = await apply(p, s, { type: 'NATIVE', order }, `native:${order.updatedAt}`);
        if (s.lastObservationHash !== hash(order)) throw new Error('ORDER_HISTORY_REQUIRED');
        const n = await apply(p, s, { type: 'COMPLETE' }, `complete:${s.version}`);
        await p.query(
          `UPDATE public.submission_attempt SET status='RECONCILED',"resolvedAt"=now() WHERE "tenantId"=$1 AND "orderId"=$2 AND status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED') AND (operation='PLACE' OR $3)`,
          [b.tenantId, id, terminal(n.status)],
        );
        return n;
      });
    },
    adopt(rawB: OrderBinding, id: string, bookId: string, eventId: string, c: IoContext) {
      const b = bindingSchema.parse(rawB);
      z.uuid().parse(bookId);
      idSchemaParse(eventId);
      return tx(b, c, async (p) => {
        await owner(p, b, true);
        const s = await read(p, b, id, true);
        const er = await p.query<{
          payload: string;
          fingerprint: Buffer;
          ledger: string | null;
          bindingState: string;
        }>(
          `SELECT e.payload,e.fingerprint,e.ledger,k.state AS "bindingState" FROM ctp_portfolio.evidence e JOIN ctp_portfolio.book k ON k."tenantId"=e."tenantId" AND k.id=e.book WHERE e."tenantId"=$1 AND e.book=$2 AND e.id=$3 AND e."accountId"=$4 AND e.mode=$5`,
          [b.tenantId, bookId, eventId, b.accountId, b.mode],
        );
        const e = er.rows[0];
        if (
          !e ||
          e.ledger === null ||
          !e.fingerprint.equals(bytes(hash(JSON.parse(e.payload) as unknown)))
        )
          throw new Error('ORDER_FILL_PROOF');
        const pb = portfolioBindingSchema.parse(
            (JSON.parse(e.bindingState) as { binding: unknown }).binding,
          ),
          f = fillEventSchema.parse(JSON.parse(e.payload) as unknown);
        if (
          pb.tenantId !== b.tenantId ||
          pb.accountId !== b.accountId ||
          pb.mode !== b.mode ||
          pb.connectionId !== b.connectionId ||
          pb.externalAccountId !== b.externalAccountId ||
          hash(pb.scope) !==
            hash({
              exchange: b.profile.exchange,
              region: b.profile.region,
              environment: b.profile.environment,
              market: b.profile.market,
            }) ||
          f.instrumentId !== s.command.instrumentId ||
          f.native.exchangeOrderId !== s.exchangeOrderId ||
          f.side !== s.command.side ||
          f.positionSide !== s.draft.positionSide ||
          f.bucket !== s.draft.bucket
        )
          throw new Error('ORDER_FILL_PROOF');
        const assets = await p.query<{ base: string; quote: string }>(
          'SELECT "baseAsset" AS base,"quoteAsset" AS quote FROM public.instrument WHERE id=$1',
          [s.draft.dbInstrumentId],
        );
        if (
          assets.rows[0]?.base !== f.base ||
          assets.rows[0]?.quote !== f.quote ||
          f.timestamp < s.createdAt ||
          f.timestamp > Date.now()
        )
          throw new Error('ORDER_FILL_PROOF');
        const found = await p.query<{ id: string; fingerprint: Buffer }>(
          'SELECT a."fillId" AS id,e.fingerprint FROM ctp_execution.fill_adoption a JOIN ctp_portfolio.evidence e ON e."tenantId"=a."tenantId" AND e.book=a.book AND e.id=a."eventId" WHERE a."tenantId"=$1 AND a.book=$2 AND a."eventId"=$3',
          [b.tenantId, bookId, eventId],
        );
        if (found.rows[0]) return s;
        const rr = await p.query<{ id: string }>(
          `SELECT id FROM public.instrument_rule_version WHERE "instrumentId"=$1 AND rules->>'version'=$2 LIMIT 2`,
          [s.draft.dbInstrumentId, f.ruleVersion],
        );
        if (rr.rowCount !== 1) throw new Error('ORDER_METADATA');
        const fillId = randomUUID();
        const identity = hash([f.native.identityScope, f.instrumentId, f.native.fillId]);
        const n = await apply(
          p,
          s,
          { type: 'EXECUTION', quantity: parseDecimal(f.quantity), price: parseDecimal(f.price) },
          `fill:${identity}`,
        );
        await p.query(
          `INSERT INTO public.fill(id,"tenantId","orderId","accountId",mode,"instrumentId","ruleVersionId",market,"executionIdentity","exchangeTradeId",side,"baseAsset","quoteAsset",quantity,price,"quoteAmount",timestamp,"receivedAt","evidenceHash") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::numeric,$15::numeric,$16::numeric,to_timestamp($17::double precision/1000),now(),$18)`,
          [
            fillId,
            b.tenantId,
            id,
            b.accountId,
            b.mode,
            s.draft.dbInstrumentId,
            rr.rows[0]!.id,
            market(b),
            identity,
            f.native.fillId,
            f.side,
            f.base,
            f.quote,
            f.quantity,
            f.price,
            decimalMultiply(parseDecimal(f.quantity), parseDecimal(f.price)),
            f.timestamp,
            e.fingerprint,
          ],
        );
        await p.query(
          'INSERT INTO ctp_execution.fill_adoption("tenantId","fillId",book,"eventId",ledger) VALUES($1,$2,$3,$4,$5)',
          [b.tenantId, fillId, bookId, eventId, e.ledger],
        );
        for (const [i, fee] of f.fees.entries())
          await p.query(
            `INSERT INTO public.fee("tenantId","fillId","accountId",mode,"ledgerTransactionId","feeIdentity",asset,kind,amount,timestamp) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,to_timestamp($10::double precision/1000))`,
            [
              b.tenantId,
              fillId,
              b.accountId,
              b.mode,
              e.ledger,
              hash([identity, i]),
              fee.asset,
              fee.amount.startsWith('-') ? 'REBATE' : 'CHARGE',
              fee.amount,
              f.timestamp,
            ],
          );
        return n;
      });
    },
    async authorize(operation: unknown, input: unknown, raw: unknown): Promise<boolean> {
      try {
        if (operation !== 'createOrder' && operation !== 'cancelOrder') return false;
        const req = operations[operation].input.parse(input),
          a = authorizationSchema.parse(req.authorization),
          context = z
            .strictObject({
              profile: z.unknown(),
              account: z.unknown(),
              signal: z.instanceof(AbortSignal),
              deadline: z.number(),
              correlationId: z.string(),
            })
            .parse(raw);
        if (
          a.expiresAt <= Date.now() ||
          a.issuedAt > Date.now() ||
          hash(context.profile) !== hash(a.profile) ||
          hash(context.account) !== hash(a.account) ||
          computeCommandHash(operation, req.command, { profile: a.profile, account: a.account }) !==
            a.commandHash
        )
          return false;
        return await tx(null, context, async (p) => {
          await p.query("SELECT set_config('app.tenant_id',$1,true)", [a.account.tenantId]);
          const gate = await p.query<{ allowed: boolean }>(
            'SELECT ctp_risk.dispatch_gate($1::uuid,$2::uuid) AS allowed',
            [a.account.tenantId, a.account.connectionId],
          );
          if (gate.rows[0]?.allowed !== true) return false;
          const r = await p.query<{
            binding: string;
            orderId: string;
            intentId: string;
            operation: 'PLACE' | 'CANCEL';
            draft: string;
          }>(
            `SELECT c.binding,c."orderId",c."intentId",c.operation,c.draft FROM ctp_execution.command c JOIN public.submission_attempt t ON t."tenantId"=c."tenantId" AND t."intentId"=c."intentId" WHERE t."tenantId"=$1 AND t.id=$2 AND c."intentId"=$3 AND t.status='DISPATCHING' AND t."commandHash"=$4 AND t."transportStartedAt" IS NULL AND t."deadlineAt">now() AND t."deadlineAt">=to_timestamp($5::double precision/1000)`,
            [
              a.account.tenantId,
              a.dispatchAttemptId,
              a.commandId,
              bytes(a.commandHash),
              a.expiresAt,
            ],
          );
          const row = r.rows[0];
          if (!row || row.operation !== (operation === 'createOrder' ? 'PLACE' : 'CANCEL'))
            return false;
          const b = bindingSchema.parse(JSON.parse(row.binding) as unknown);
          await owner(p, b, true);
          const s = await read(p, b, row.orderId);
          const gr = await p.query<{
            decisionId: string;
            reservationId: string;
            permissionEpoch: string;
            expiresAt: string;
          }>(
            `SELECT r."decisionId",r.id AS "reservationId",t."permissionEpoch"::text,(extract(epoch from t."deadlineAt")*1000)::bigint::text AS "expiresAt" FROM public.submission_attempt t JOIN public.risk_reservation r ON r."tenantId"=t."tenantId" AND r.id=t."reservationId" WHERE t."tenantId"=$1 AND t.id=$2`,
            [b.tenantId, a.dispatchAttemptId],
          );
          const g = gr.rows[0];
          if (!g) return false;
          await risk(
            p,
            b,
            s,
            row.intentId,
            a.commandHash,
            {
              ...g,
              expiresAt: Number(g.expiresAt),
            },
            draftSchema.parse(JSON.parse(row.draft) as unknown),
          );
          const consumed = await p.query(
            'UPDATE public.submission_attempt SET "transportStartedAt"=clock_timestamp() WHERE "tenantId"=$1 AND id=$2 AND "transportStartedAt" IS NULL AND status=\'DISPATCHING\' AND "deadlineAt">clock_timestamp() AND to_timestamp($3::double precision/1000)>clock_timestamp()',
            [b.tenantId, a.dispatchAttemptId, a.expiresAt],
          );
          return consumed.rowCount === 1;
        });
      } catch {
        return false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const timer = setTimeout(() => {
        for (const s of sockets) void s.end().catch(() => {});
      }, 500);
      try {
        await pool.end();
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
function idSchemaParse(value: string) {
  z.string()
    .min(1)
    .max(128)
    .regex(/^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u)
    .parse(value);
}
