import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createPaperReservationFixture as fixture } from './fixtures/paper-reservation.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw Error('ISOLATED_PAPER_RESERVATION_RUNNER_REQUIRED');
const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) throw Error('ISOLATED_PAPER_RESERVATION_DATABASE_REQUIRED');
const isolated = new URL(url);
if (
  process.env['NODE_ENV'] !== 'test' ||
  !['postgres:', 'postgresql:'].includes(isolated.protocol) ||
  isolated.hostname !== '127.0.0.1' ||
  !/^\/ctp_p2_(fresh|owner)_[a-f0-9]{12}$/u.test(isolated.pathname) ||
  !isolated.port
)
  throw Error('ISOLATED_PAPER_RESERVATION_DATABASE_REQUIRED');
const admin = new Pool({ connectionString: url, max: 2, query_timeout: 5000 });
afterAll(() => admin.end());

async function transaction<T>(f: (p: PoolClient) => Promise<T>) {
  const p = await admin.connect();
  try {
    await p.query('BEGIN');
    const value = await f(p);
    await p.query('COMMIT');
    return value;
  } catch (error) {
    await p.query('ROLLBACK');
    throw error;
  } finally {
    p.release();
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function parent(p: PoolClient, x: Fixture, count = 2) {
  await p.query(
    `INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"vectorSize","expiresAt","updatedAt") VALUES($1,$2,$3,$4,$5,'PAPER',$6,now()+interval '1 hour',now())`,
    [x.reservation, x.tenant, x.decision, x.intent, x.account, count],
  );
}
async function debit(
  p: PoolClient,
  x: Fixture,
  ordinal: number,
  asset: string,
  amount: string,
  holdId = randomUUID(),
) {
  await p.query(
    `INSERT INTO ctp_paper.reservation_debit(tenant_id,reservation_id,intent_id,account_id,mode,ordinal,asset,amount,hold_id) VALUES($1,$2,$3,$4,'PAPER',$5,$6,$7::numeric,$8)`,
    [x.tenant, x.reservation, x.intent, x.account, ordinal, asset, amount, holdId],
  );
}
async function ready(p: PoolClient, side = 'SELL') {
  const x = await fixture(p, side);
  await parent(p, x, side === 'BUY' ? 1 : 2);
  if (side === 'BUY') await debit(p, x, 1, 'USDT', '100.01');
  else {
    await debit(p, x, 1, 'BTC', '1');
    await debit(p, x, 2, 'USDT', '0.01');
  }
  await p.query('SET CONSTRAINTS ALL IMMEDIATE');
  return x;
}

it('paper-reservation: persists SELL base and quote fee without a dummy scalar and keeps exact parent FKs after connection restart', async () => {
  const x = await transaction((p) => ready(p));
  const restarted = new Pool({ connectionString: url, max: 1, query_timeout: 5000 });
  try {
    const q = await restarted.connect();
    try {
      await q.query('BEGIN');
      await q.query("SELECT set_config('app.tenant_id',$1,true)", [x.tenant]);
      const r = await q.query(
        `SELECT r."tenantId",r."intentId",r."accountId",r.mode,r.asset,r.amount::text,r."budgetId",r."vectorSize",r."paperLegacy",r."consumedAmount"::text FROM public.risk_reservation r WHERE r.id=$1`,
        [x.reservation],
      );
      expect(r.rows).toEqual([
        {
          tenantId: x.tenant,
          intentId: x.intent,
          accountId: x.account,
          mode: 'PAPER',
          asset: null,
          amount: null,
          budgetId: null,
          vectorSize: 2,
          paperLegacy: false,
          consumedAmount: '0',
        },
      ]);
      const a = await q.query<{ asset: string; amount: string; hold_id: string }>(
        `SELECT asset,amount::text,hold_id FROM ctp_paper.reservation_debit WHERE reservation_id=$1 ORDER BY ordinal`,
        [x.reservation],
      );
      expect(a.rows.map((v) => ({ asset: v.asset, amount: v.amount }))).toEqual([
        { asset: 'BTC', amount: '1' },
        { asset: 'USDT', amount: '0.01' },
      ]);
      expect(new Set(a.rows.map((v) => v.hold_id)).size).toBe(2);
      const effects = await q.query<{
        ledger: number;
        entries: number;
        outbox: number;
        attempts: number;
        portfolio: number;
      }>(
        `SELECT
       (SELECT count(*)::int FROM public.ledger_transaction WHERE "tenantId"=$1) ledger,
       (SELECT count(*)::int FROM public.ledger_entry WHERE "tenantId"=$1) entries,
       (SELECT count(*)::int FROM public.outbox_event WHERE "tenantId"=$1) outbox,
       (SELECT count(*)::int FROM public.submission_attempt WHERE "tenantId"=$1) attempts,
       (SELECT count(*)::int FROM ctp_portfolio.evidence WHERE "tenantId"=$1) portfolio`,
        [x.tenant],
      );
      expect(effects.rows).toEqual([
        { ledger: 0, entries: 0, outbox: 0, attempts: 0, portfolio: 0 },
      ]);
      await q.query('COMMIT');
    } finally {
      await q.query('ROLLBACK');
      q.release();
    }
  } finally {
    await restarted.end();
  }
});
it('paper-reservation: BUY stores one quote debit and never exposes an asset-less monetary fallback', async () => {
  await transaction(async (p) => {
    const x = await ready(p, 'BUY');
    const r = await p.query(
      'SELECT asset,amount::text FROM ctp_paper.reservation_debit WHERE reservation_id=$1',
      [x.reservation],
    );
    expect(r.rows).toEqual([{ asset: 'USDT', amount: '100.01' }]);
  });
});
it.each([0, 1, 3])(
  'paper-reservation: incomplete or invalid vector cardinality %s cannot commit',
  async (count) => {
    await expect(
      transaction(async (p) => {
        const x = await fixture(p);
        await parent(p, x, count);
        await debit(p, x, 1, 'BTC', '1');
        if (count === 1) await debit(p, x, 2, 'USDT', '0.01');
      }),
    ).rejects.toMatchObject({ code: '23514' });
  },
);
it.each([
  '0',
  '-1',
  '0.0000000000000000001',
  '1000000000000000000000000000000',
  'NaN',
  'Infinity',
  '-Infinity',
  '100000000000000000000',
])('paper-reservation: invalid cash amount %s fails without rounding', async (amount) => {
  await expect(
    transaction(async (p) => {
      const x = await fixture(p);
      await parent(p, x, 1);
      await debit(p, x, 1, 'BTC', amount);
    }),
  ).rejects.toMatchObject({ code: '23514' });
});
it('paper-reservation: wrong BUY asset and shared hold identifiers fail closed', async () => {
  await expect(
    transaction(async (p) => {
      const x = await fixture(p, 'BUY');
      await parent(p, x, 1);
      await debit(p, x, 1, 'BTC', '1');
    }),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    transaction(async (p) => {
      const x = await fixture(p);
      await parent(p, x);
      const id = randomUUID();
      await debit(p, x, 1, 'BTC', '1', id);
      await debit(p, x, 2, 'USDT', '0.01', id);
    }),
  ).rejects.toMatchObject({ code: '23505' });
});
it('paper-reservation: immutable rows prevent overwrite, deletion and A-to-B-to-A identifier reuse', async () => {
  const x = await transaction((p) => ready(p));
  for (const query of [
    `UPDATE ctp_paper.reservation_debit SET amount=2 WHERE reservation_id=$1`,
    `DELETE FROM ctp_paper.reservation_debit WHERE reservation_id=$1`,
    `UPDATE public.risk_reservation SET status='RELEASED',"releasedAt"=now() WHERE id=$1`,
    `DELETE FROM public.risk_reservation WHERE id=$1`,
  ])
    await expect(
      transaction(async (p) => {
        await p.query("SELECT set_config('app.tenant_id',$1,true)", [x.tenant]);
        await p.query(query, [x.reservation]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  await transaction(async (p) => {
    await p.query("SELECT set_config('app.tenant_id',$1,true)", [x.tenant]);
    const r = await p.query<{ status: string }>(
      'SELECT status FROM public.risk_reservation WHERE id=$1',
      [x.reservation],
    );
    expect(r.rows[0]?.status).toBe('ACTIVE');
  });
  // Additional original-identity proof belongs inside the existing immutability
  // case, so the native case inventory remains 27 (assertions are stronger).
  await expect(
    transaction(async (p) => {
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [x.tenant]);
      const decision = randomUUID(),
        reservation = randomUUID();
      await p.query(
        `INSERT INTO public.risk_decision(id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","permissionEpoch","expiresAt") SELECT $1::uuid,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","permissionEpoch","expiresAt" FROM public.risk_decision WHERE id=$2`,
        [decision, x.decision],
      );
      await parent(p, { ...x, decision, reservation });
    }),
  ).rejects.toMatchObject({ code: '23505' });
});
it('paper-reservation: orphan or cross-account allocations cannot bind an existing parent', async () => {
  await expect(
    transaction(async (p) => {
      const x = await fixture(p);
      await parent(p, x, 1);
      await debit(p, { ...x, reservation: randomUUID() }, 1, 'BTC', '1');
    }),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    transaction(async (p) => {
      const x = await fixture(p);
      await parent(p, x, 1);
      await debit(p, { ...x, account: randomUUID() }, 1, 'BTC', '1');
    }),
  ).rejects.toMatchObject({ code: '23503' });
});
it('paper-reservation: existing runtime roles receive no allocation reader or writer authority', async () => {
  const r = await admin.query(
    `SELECT rolname FROM pg_roles WHERE left(rolname,4)='ctp_' AND (has_table_privilege(oid,'ctp_paper.reservation_debit','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(oid,'ctp_paper.reservation_debit','SELECT,INSERT,UPDATE,REFERENCES')) AND NOT rolsuper AND NOT oid=(SELECT relowner FROM pg_class WHERE oid='ctp_paper.reservation_debit'::regclass)`,
  );
  expect(r.rows).toEqual([]);
});

it.each(['TESTNET', 'DEMO', 'LIVE'])(
  'paper-reservation: native %s cannot omit its scalar debit and budget',
  async (mode) => {
    await expect(
      transaction(async (p) => {
        const x = await fixture(p);
        await p.query(
          `INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"expiresAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now())`,
          [x.reservation, x.tenant, x.decision, x.intent, x.account, mode],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  },
);
it('paper-reservation: PAPER cannot fall back to a missing vector size', async () => {
  await expect(
    transaction(async (p) => {
      const x = await fixture(p);
      await p.query(
        `INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"expiresAt","updatedAt") VALUES($1,$2,$3,$4,$5,'PAPER',now()+interval '1 hour',now())`,
        [x.reservation, x.tenant, x.decision, x.intent, x.account],
      );
    }),
  ).rejects.toMatchObject({ code: '23514' });
});
it('paper-reservation: scalar and vector cash representations cannot be mixed', async () => {
  await expect(
    transaction(async (p) => {
      const x = await fixture(p);
      await p.query(
        `INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"vectorSize",asset,amount,"expiresAt","updatedAt") VALUES($1,$2,$3,$4,$5,'PAPER',1,'BTC',1,now()+interval '1 hour',now())`,
        [x.reservation, x.tenant, x.decision, x.intent, x.account],
      );
    }),
  ).rejects.toMatchObject({ code: '23514' });
});
it('paper-reservation: an ordinal gap cannot claim a complete one-element vector', async () => {
  await expect(
    transaction(async (p) => {
      const x = await fixture(p, 'BUY');
      await parent(p, x, 1);
      await debit(p, x, 2, 'USDT', '100.01');
    }),
  ).rejects.toMatchObject({ code: '23514' });
});
it('paper-reservation: minimum and maximum Portfolio cash atoms persist exactly', async () => {
  for (const amount of ['0.000000000000000001', '99999999999999999999.999999999999999999'])
    await transaction(async (p) => {
      const x = await fixture(p, 'BUY');
      await parent(p, x, 1);
      await debit(p, x, 1, 'USDT', amount);
      await p.query('SET CONSTRAINTS ALL IMMEDIATE');
      const r = await p.query<{ amount: string }>(
        'SELECT amount::text FROM ctp_paper.reservation_debit WHERE reservation_id=$1',
        [x.reservation],
      );
      expect(r.rows).toEqual([{ amount }]);
    });
});
it.each(['UNRESOLVED', 'RELEASED'])(
  'paper-reservation: initial storage cannot manufacture a %s lifecycle outcome',
  async (status) => {
    await expect(
      transaction(async (p) => {
        const x = await fixture(p);
        await p.query(
          `INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"vectorSize",status,"expiresAt","updatedAt") VALUES($1,$2,$3,$4,$5,'PAPER',1,$6,now()+interval '1 hour',now())`,
          [x.reservation, x.tenant, x.decision, x.intent, x.account, status],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  },
);
it('paper-reservation: a one-base SELL is a stored shape, never proof of zero fees or admission', async () => {
  await transaction(async (p) => {
    const x = await fixture(p);
    await parent(p, x, 1);
    await debit(p, x, 1, 'BTC', '1');
    await p.query('SET CONSTRAINTS ALL IMMEDIATE');
    const r = await p.query<{ asset: string; amount: string }>(
      'SELECT asset,amount::text FROM ctp_paper.reservation_debit WHERE reservation_id=$1',
      [x.reservation],
    );
    expect(r.rows).toEqual([{ asset: 'BTC', amount: '1' }]);
  });
});
it('paper-reservation: concurrent alternative parents serialize to one complete original vector', async () => {
  const x = await transaction((p) => fixture(p));
  const first = await admin.connect();
  let second: PoolClient | undefined;
  try {
    second = await admin.connect();
    await first.query('BEGIN');
    await second.query('BEGIN');
    for (const p of [first, second])
      await p.query("SELECT set_config('app.tenant_id',$1,true)", [x.tenant]);
    await parent(first, x, 1);
    await debit(first, x, 1, 'BTC', '1');
    const decision = randomUUID(),
      reservation = randomUUID();
    await second.query(
      `INSERT INTO public.risk_decision(id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","permissionEpoch","expiresAt") SELECT $1::uuid,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","permissionEpoch","expiresAt" FROM public.risk_decision WHERE id=$2`,
      [decision, x.decision],
    );
    const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    let settled = false;
    const pending = parent(second, { ...x, decision, reservation }, 1).then(
      () => {
        settled = true;
        return { ok: true as const };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
    let blocked = false;
    const end = Date.now() + 2000;
    while (Date.now() < end && !blocked && !settled) {
      blocked = (
        await first.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') blocked",
          [pid],
        )
      ).rows[0]!.blocked;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    expect(settled).toBe(false);
    await first.query('COMMIT');
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: '23505' });
    await second.query('ROLLBACK');
    await first.query('BEGIN');
    await first.query("SELECT set_config('app.tenant_id',$1,true)", [x.tenant]);
    const r = await first.query<{ id: string }>(
      'SELECT id FROM public.risk_reservation WHERE "tenantId"=$1 AND "intentId"=$2',
      [x.tenant, x.intent],
    );
    expect(r.rows).toEqual([{ id: x.reservation }]);
    const d = await first.query<{ asset: string; amount: string }>(
      'SELECT asset,amount::text FROM ctp_paper.reservation_debit WHERE reservation_id=$1',
      [x.reservation],
    );
    expect(d.rows).toEqual([{ asset: 'BTC', amount: '1' }]);
    await first.query('COMMIT');
  } finally {
    const close = async (p: PoolClient) => {
      try {
        await p.query('ROLLBACK');
      } finally {
        p.release();
      }
    };
    await Promise.all([close(first), ...(second ? [close(second)] : [])]);
  }
});
it('paper-reservation: a new caller cannot manufacture a legacy scalar exemption', async () => {
  await expect(
    transaction(async (p) => {
      const x = await fixture(p),
        budget = randomUUID();
      await p.query(
        `INSERT INTO public.risk_budget(id,"tenantId","accountId","profileId",mode,scope,"scopeKey",asset,"windowStart","windowEnd","limitAmount","updatedAt") VALUES($1,$2,$3::uuid,$4,'PAPER','ACCOUNT',$3::text,'USDT',now(),now()+interval '1 day',1000,now())`,
        [budget, x.tenant, x.account, x.profile],
      );
      await p.query(
        `INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"paperLegacy","budgetId",asset,amount,"expiresAt","updatedAt") VALUES($1,$2,$3,$4,$5,'PAPER',true,$6,'USDT',100,now()+interval '1 hour',now())`,
        [x.reservation, x.tenant, x.decision, x.intent, x.account, budget],
      );
    }),
  ).rejects.toMatchObject({ code: '23514', message: 'PAPER_RESERVATION_LEGACY_WRITE_FORBIDDEN' });
});

it('paper-reservation: initial PLACE vector storage rejects PAPER AMEND without a scalar fallback', async () => {
  await expect(
    transaction(async (p) => {
      const x = await fixture(p),
        orderId = randomUUID(),
        intentId = randomUUID(),
        decisionId = randomUUID();
      await p.query(
        `INSERT INTO public."order" (id,"tenantId","intentId","accountId",mode,"instrumentId","ruleVersionId","clientIdNamespace","clientId",market,side,"orderType","quantityAsset","priceAsset",quantity,"limitPrice","updatedAt") SELECT $1::uuid,"tenantId",id,"accountId",mode,"instrumentId","ruleVersionId",'vector-fixture',$1::text,'SPOT',side,"orderType","quantityAsset","priceAsset",quantity,"limitPrice",now() FROM public.order_intent WHERE id=$2`,
        [orderId, x.intent],
      );
      await p.query(
        `INSERT INTO public.order_intent (id,"tenantId","accountId",mode,"instrumentId","ruleVersionId",origin,destination,operation,"idempotencyKey","commandHash",side,"orderType","quantityAsset","priceAsset",quantity,"limitPrice","targetOrderId") SELECT $1::uuid,"tenantId","accountId",mode,"instrumentId","ruleVersionId",origin,destination,'AMEND',$1::text,"commandHash",side,"orderType","quantityAsset","priceAsset",quantity,"limitPrice",$3::uuid FROM public.order_intent WHERE id=$2`,
        [intentId, x.intent, orderId],
      );
      await p.query(
        `INSERT INTO public.risk_decision (id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","permissionEpoch","expiresAt") SELECT $1::uuid,"tenantId",$2::uuid,"accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","permissionEpoch","expiresAt" FROM public.risk_decision WHERE id=$3`,
        [decisionId, intentId, x.decision],
      );
      const amended = { ...x, intent: intentId, decision: decisionId };
      await parent(p, amended);
      await debit(p, amended, 1, 'BTC', '1');
      await debit(p, amended, 2, 'USDT', '0.01');
    }),
  ).rejects.toMatchObject({ code: '23514', message: 'PAPER_RESERVATION_SCOPE' });
});
