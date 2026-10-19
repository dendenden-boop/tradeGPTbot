import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createPaperReservationFixture as fixture } from './fixtures/paper-reservation.js';

if (!/^ctp-integration-\d+-[a-f0-9]{12}$/u.test(process.env['CTP_TEST_PROJECT'] ?? ''))
  throw Error('ISOLATED_PAPER_STATE_RUNNER_REQUIRED');
const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) throw Error('ISOLATED_PAPER_STATE_DATABASE_REQUIRED');
const isolated = new URL(url);
if (
  process.env['NODE_ENV'] !== 'test' ||
  !['postgres:', 'postgresql:'].includes(isolated.protocol) ||
  isolated.hostname !== '127.0.0.1' ||
  !/^\/ctp_p2_(fresh|owner)_[a-f0-9]{12}$/u.test(isolated.pathname) ||
  !isolated.port
)
  throw Error('ISOLATED_PAPER_STATE_DATABASE_REQUIRED');
const admin = new Pool({ connectionString: url, max: 4, query_timeout: 5000 });
afterAll(() => admin.end());
async function tx<T>(work: (p: PoolClient) => Promise<T>) {
  const p = await admin.connect();
  try {
    await p.query('BEGIN');
    const result = await work(p);
    await p.query('COMMIT');
    return result;
  } catch (error) {
    await p.query('ROLLBACK');
    throw error;
  } finally {
    p.release();
  }
}
type Fixture = Awaited<ReturnType<typeof ready>>;
async function context(p: PoolClient, tenant: string) {
  await p.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
}
async function ready(p: PoolClient) {
  const x = await fixture(p);
  await p.query(
    `INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"vectorSize","expiresAt","updatedAt") VALUES($1,$2,$3,$4,$5,'PAPER',2,now()+interval '1 hour',now())`,
    [x.reservation, x.tenant, x.decision, x.intent, x.account],
  );
  for (const [ordinal, asset, amount] of [
    [1, 'BTC', '1'],
    [2, 'USDT', '0.01'],
  ])
    await p.query(
      `INSERT INTO ctp_paper.reservation_debit(tenant_id,reservation_id,intent_id,account_id,mode,ordinal,asset,amount,hold_id) VALUES($1,$2,$3,$4,'PAPER',$5,$6,$7::numeric,$8)`,
      [x.tenant, x.reservation, x.intent, x.account, ordinal, asset, amount, randomUUID()],
    );
  await p.query('SET CONSTRAINTS ALL IMMEDIATE');
  const r = await p.query<{ stamp: string }>(
    `SELECT floor(extract(epoch FROM "createdAt")*1000)::text stamp FROM public.risk_reservation WHERE id=$1`,
    [x.reservation],
  );
  return { ...x, stamp: r.rows[0]!.stamp };
}
async function append(
  p: PoolClient,
  x: Fixture,
  event = randomUUID(),
  expected = '0',
  status = 'ACTIVE',
  stamp = x.stamp,
) {
  const r = await p.query<{ record: Record<string, string> }>(
    `SELECT ctp_paper.append_reservation_state($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::bigint) record`,
    [x.tenant, x.reservation, event, expected, status, stamp],
  );
  return r.rows[0]!.record;
}
async function rows(p: PoolClient, x: Fixture) {
  return (
    await p.query<{ event_id: string; revision: string; status: string; observed_ms: string }>(
      `SELECT event_id::text,revision::text,status,observed_ms::text FROM ctp_paper.reservation_state_event WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY revision`,
      [x.tenant, x.reservation],
    )
  ).rows;
}
async function initialized() {
  return tx(async (p) => {
    const x = await ready(p),
      event = randomUUID(),
      record = await append(p, x, event);
    return { x, event, record };
  });
}
async function unknown() {
  const a = await initialized(),
    event = randomUUID(),
    stamp = (BigInt(a.x.stamp) + 1n).toString();
  const record = await tx(async (p) => {
    await context(p, a.x.tenant);
    return append(p, a.x, event, '1', 'UNKNOWN', stamp);
  });
  return { ...a, unknownEvent: event, unknownRecord: record, unknownStamp: stamp };
}
const denied = { code: '23514' };
it('paper-state: immutable initial receipt retains exact shared scope and produces no financial effects', async () => {
  await tx(async (p) => {
    const x = await ready(p),
      event = randomUUID();
    const before = (
      await p.query('SELECT to_jsonb(r) row FROM public.risk_reservation r WHERE id=$1', [
        x.reservation,
      ])
    ).rows;
    const debits = (
      await p.query(
        'SELECT to_jsonb(d) row FROM ctp_paper.reservation_debit d WHERE reservation_id=$1 ORDER BY ordinal',
        [x.reservation],
      )
    ).rows;
    expect(await append(p, x, event)).toEqual({
      kind: 'PAPER_RESERVATION_STATE_RECORD',
      tenantId: x.tenant,
      reservationId: x.reservation,
      intentId: x.intent,
      accountId: x.account,
      mode: 'PAPER',
      eventId: event,
      revision: '1',
      status: 'ACTIVE',
      observedAt: x.stamp,
    });
    expect(
      (
        await p.query('SELECT to_jsonb(r) row FROM public.risk_reservation r WHERE id=$1', [
          x.reservation,
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (
        await p.query(
          'SELECT to_jsonb(d) row FROM ctp_paper.reservation_debit d WHERE reservation_id=$1 ORDER BY ordinal',
          [x.reservation],
        )
      ).rows,
    ).toEqual(debits);
    expect(
      (
        await p.query(
          `SELECT (SELECT count(*)::int FROM public.ledger_transaction WHERE "tenantId"=$1) ledger,(SELECT count(*)::int FROM public.ledger_entry WHERE "tenantId"=$1) entries,(SELECT count(*)::int FROM public.outbox_event WHERE "tenantId"=$1) outbox,(SELECT count(*)::int FROM public.submission_attempt WHERE "tenantId"=$1) attempts,(SELECT count(*)::int FROM ctp_portfolio.evidence WHERE "tenantId"=$1) portfolio`,
          [x.tenant],
        )
      ).rows,
    ).toEqual([{ ledger: 0, entries: 0, outbox: 0, attempts: 0, portfolio: 0 }]);
  });
});
it('paper-state: exact replay is permanent after UNKNOWN and cannot misrepresent the latest revision', async () => {
  const a = await unknown();
  await tx(async (p) => {
    await context(p, a.x.tenant);
    expect(await append(p, a.x, a.event)).toEqual(a.record);
    expect(await append(p, a.x, a.unknownEvent, '1', 'UNKNOWN', a.unknownStamp)).toEqual(
      a.unknownRecord,
    );
    expect(await rows(p, a.x)).toEqual([
      { event_id: a.event, revision: '1', status: 'ACTIVE', observed_ms: a.x.stamp },
      { event_id: a.unknownEvent, revision: '2', status: 'UNKNOWN', observed_ms: a.unknownStamp },
    ]);
  });
});
it('paper-state: committed UNKNOWN survives physical connection replacement without releasing collateral', async () => {
  const a = await unknown(),
    restarted = new Pool({ connectionString: url, max: 1, query_timeout: 5000 });
  const p = await restarted.connect();
  try {
    await p.query('BEGIN');
    await context(p, a.x.tenant);
    expect((await rows(p, a.x)).at(-1)?.status).toBe('UNKNOWN');
    expect(await append(p, a.x, a.unknownEvent, '1', 'UNKNOWN', a.unknownStamp)).toEqual(
      a.unknownRecord,
    );
    expect(
      (
        await p.query(
          'SELECT asset,amount::text FROM ctp_paper.reservation_debit WHERE reservation_id=$1 ORDER BY ordinal',
          [a.x.reservation],
        )
      ).rows,
    ).toEqual([
      { asset: 'BTC', amount: '1' },
      { asset: 'USDT', amount: '0.01' },
    ]);
    await p.query('COMMIT');
  } finally {
    await p.query('ROLLBACK');
    p.release();
    await restarted.end();
  }
});
it.each(['status', 'timestamp', 'expected', 'reservation'] as const)(
  'paper-state: event key semantic conflict %s rejects before a new record',
  async (field) => {
    const a = await initialized();
    await expect(
      tx(async (p) => {
        await context(p, a.x.tenant);
        return append(
          p,
          field === 'reservation' ? { ...a.x, reservation: randomUUID() } : a.x,
          a.event,
          field === 'expected' ? '1' : '0',
          field === 'status' ? 'UNKNOWN' : 'ACTIVE',
          field === 'timestamp' ? (BigInt(a.x.stamp) + 1n).toString() : a.x.stamp,
        );
      }),
    ).rejects.toMatchObject({ ...denied, message: 'PAPER_RESERVATION_STATE_CONFLICT' });
  },
);
it.each([
  ['missing initial', '1', 'UNKNOWN'],
  ['UNKNOWN cannot initialize', '0', 'UNKNOWN'],
])('paper-state: %s is not a valid initial transition', async (_name, revision, status) => {
  await expect(
    tx(async (p) => {
      const x = await ready(p);
      return append(p, x, randomUUID(), revision, status);
    }),
  ).rejects.toMatchObject({ ...denied, message: 'PAPER_RESERVATION_STATE_ORDERING' });
});
it('paper-state: stale new key cannot replace the current revision', async () => {
  const a = await initialized();
  await expect(
    tx(async (p) => {
      await context(p, a.x.tenant);
      return append(p, a.x, randomUUID(), '0', 'UNKNOWN', (BigInt(a.x.stamp) + 1n).toString());
    }),
  ).rejects.toMatchObject({ ...denied, message: 'PAPER_RESERVATION_STATE_ORDERING' });
});
it.each(['ACTIVE', 'UNKNOWN', 'RELEASED'])(
  'paper-state: UNKNOWN cannot be weakened or extended by %s, even under a new key',
  async (status) => {
    const a = await unknown();
    await expect(
      tx(async (p) => {
        await context(p, a.x.tenant);
        return append(p, a.x, randomUUID(), '2', status, (BigInt(a.unknownStamp) + 1n).toString());
      }),
    ).rejects.toMatchObject(denied);
    await tx(async (p) => {
      await context(p, a.x.tenant);
      expect((await rows(p, a.x)).map((r) => r.status)).toEqual(['ACTIVE', 'UNKNOWN']);
    });
  },
);
it.each(['RELEASED', 'RESOLVED', 'EXPIRED'])(
  'paper-state: no unproven %s resolution can reduce a reservation',
  async (status) => {
    await expect(
      tx(async (p) => {
        const x = await ready(p);
        return append(p, x, randomUUID(), '0', status);
      }),
    ).rejects.toMatchObject({ ...denied, message: 'PAPER_RESERVATION_STATE_INPUT' });
  },
);
it.each(['equal', 'older'] as const)(
  'paper-state: %s observed time cannot create a conflicting transition',
  async (kind) => {
    const a = await initialized(),
      stamp = (BigInt(a.x.stamp) - (kind === 'older' ? 1n : 0n)).toString();
    await expect(
      tx(async (p) => {
        await context(p, a.x.tenant);
        return append(p, a.x, randomUUID(), '1', 'UNKNOWN', stamp);
      }),
    ).rejects.toMatchObject({ ...denied, message: 'PAPER_RESERVATION_STATE_ORDERING' });
  },
);
it.each([
  ['negative time', '0', 'ACTIVE', '-1'],
  ['future time', '0', 'ACTIVE', '8640000000000000'],
  ['negative revision', '-1', 'ACTIVE', null],
])('paper-state: invalid %s fails closed', async (_name, revision, status, stamp) => {
  await expect(
    tx(async (p) => {
      const x = await ready(p);
      return append(p, x, randomUUID(), revision, status, stamp ?? x.stamp);
    }),
  ).rejects.toMatchObject({ ...denied, message: 'PAPER_RESERVATION_STATE_INPUT' });
});
it.each(['missing', 'wrong'])(
  'paper-state: %s tenant context denies owner publication',
  async (kind) => {
    await expect(
      tx(async (p) => {
        const x = await ready(p);
        await context(p, kind === 'wrong' ? randomUUID() : '');
        return append(p, x);
      }),
    ).rejects.toMatchObject({ ...denied, message: 'PAPER_RESERVATION_STATE_SCOPE' });
  },
);
it.each(['account', 'intent', 'mode'] as const)(
  'paper-state: direct owner insert cannot substitute %s scope',
  async (field) => {
    await expect(
      tx(async (p) => {
        const x = await ready(p);
        await p.query(
          `INSERT INTO ctp_paper.reservation_state_event(tenant_id,reservation_id,intent_id,account_id,mode,event_id,revision,status,observed_ms) VALUES($1,$2,$3,$4,$5::public."TradingMode",$6,1,'ACTIVE',$7::bigint)`,
          [
            x.tenant,
            x.reservation,
            field === 'intent' ? randomUUID() : x.intent,
            field === 'account' ? randomUUID() : x.account,
            field === 'mode' ? 'TESTNET' : 'PAPER',
            randomUUID(),
            x.stamp,
          ],
        );
      }),
    ).rejects.toMatchObject(denied);
  },
);
it.each([
  'UPDATE ctp_paper.reservation_state_event SET status=status WHERE reservation_id=$1',
  'DELETE FROM ctp_paper.reservation_state_event WHERE reservation_id=$1',
])('paper-state: journal rows cannot be overwritten or deleted: %s', async (sql) => {
  const a = await initialized();
  await expect(
    tx(async (p) => {
      await context(p, a.x.tenant);
      await p.query(sql, [a.x.reservation]);
    }),
  ).rejects.toMatchObject(denied);
});
it('paper-state: journal truncate is forbidden to its owner', async () => {
  await expect(
    tx((p) => p.query('TRUNCATE ctp_paper.reservation_state_event')),
  ).rejects.toMatchObject(denied);
});
it('paper-state: no runtime group gains table or append authority; RLS remains forced', async () => {
  const r = await admin.query(
    `SELECT rolname FROM pg_roles WHERE left(rolname,4)='ctp_' AND NOT rolsuper AND NOT oid=(SELECT relowner FROM pg_class WHERE oid='ctp_paper.reservation_state_event'::regclass) AND (has_table_privilege(oid,'ctp_paper.reservation_state_event','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(oid,'ctp_paper.reservation_state_event','SELECT,INSERT,UPDATE,REFERENCES') OR has_function_privilege(oid,'ctp_paper.append_reservation_state(uuid,uuid,uuid,bigint,text,bigint)','EXECUTE'))`,
  );
  expect(r.rows).toEqual([]);
  expect(
    (
      await admin.query(
        `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ctp_paper.reservation_state_event'::regclass`,
      )
    ).rows,
  ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
});
it('paper-state: rollback retains no event and leaves the original vector unchanged', async () => {
  const x = await tx(ready);
  await expect(
    tx(async (p) => {
      await context(p, x.tenant);
      await append(p, x);
      throw Error('ROLLBACK_STORAGE_PROBE');
    }),
  ).rejects.toThrow('ROLLBACK_STORAGE_PROBE');
  await tx(async (p) => {
    await context(p, x.tenant);
    expect(await rows(p, x)).toEqual([]);
    expect(
      (
        await p.query(
          'SELECT count(*)::int n FROM ctp_paper.reservation_debit WHERE reservation_id=$1',
          [x.reservation],
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  });
});
it.each(['same event', 'competing event'])(
  'paper-state: real two-session %s serialization has one immutable initial record',
  async (kind) => {
    const x = await tx(ready),
      first = await admin.connect(),
      second = await admin.connect(),
      event = randomUUID();
    try {
      for (const p of [first, second]) {
        await p.query('BEGIN');
        await context(p, x.tenant);
      }
      const receipt = await append(first, x, event),
        pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      let settled = false;
      const pending = append(second, x, kind === 'same event' ? event : randomUUID())
        .then(
          (record) => ({ ok: true as const, record }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          settled = true;
        });
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked = (
          await first.query<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') blocked`,
            [pid],
          )
        ).rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(settled).toBe(false);
      await first.query('COMMIT');
      const result = await pending;
      if (kind === 'same event') {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.record).toEqual(receipt);
        await second.query('COMMIT');
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error).toMatchObject({
            ...denied,
            message: 'PAPER_RESERVATION_STATE_ORDERING',
          });
        await second.query('ROLLBACK');
      }
      await first.query('BEGIN');
      await context(first, x.tenant);
      expect(await rows(first, x)).toEqual([
        { event_id: event, revision: '1', status: 'ACTIVE', observed_ms: x.stamp },
      ]);
      await first.query('COMMIT');
    } finally {
      for (const p of [first, second]) {
        try {
          await p.query('ROLLBACK');
        } finally {
          p.release();
        }
      }
    }
  },
);
