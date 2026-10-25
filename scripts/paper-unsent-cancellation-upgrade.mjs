import assert from 'node:assert/strict';
import { capturePaperAdmissionUpgrade } from './paper-admission-upgrade.mjs';

export async function preparePaperUnsentCancellationUpgrade(db, runtime) {
  const row = (
    await db.query(`SELECT w.tenant_id::text tenant,
    jsonb_build_object('kind','PAPER_RELEASE_WITHDRAWN','admission',i.request,'reservationId',w.reservation_id::text,
     'withdrawalEventId',w.event_id::text,'eventId',gen_random_uuid()::text,'expectedRevision','1') request
    FROM ctp_paper.withdrawal_barrier w JOIN ctp_paper.admission_issuance i USING(tenant_id,reservation_id)
    WHERE NOT EXISTS(SELECT 1 FROM ctp_paper.withdrawal_release r WHERE r.tenant_id=w.tenant_id AND r.reservation_id=w.reservation_id)
    ORDER BY w.tenant_id,w.event_id LIMIT 1`)
  ).rows[0];
  assert(row, 'An actually issued pre56 withdrawal is required');
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [row.tenant]);
    const result = (
      await client.query('SELECT ctp_paper.evaluate_and_reserve($1::jsonb) result', [
        JSON.stringify(row.request),
      ])
    ).rows[0].result;
    await client.query('COMMIT');
    assert.equal(result.kind, 'RELEASED');
    assert.deepEqual(result.request, row.request);
    assert.equal(result.receipt.outcome, 'NOT_SENT');
    assert.equal(result.receipt.collateral, 'RELEASED');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// Exactly the published withdrawal guard, with only its authenticated four-row
// exception removed. This compares actual PostgreSQL function definitions.
export function beforeCancellationGuard(definition) {
  const blocks = [
    ...definition.matchAll(
      /  -- BEGIN EXACT CANCEL CAUSE\n[\s\S]*?  -- END EXACT CANCEL CAUSE\n/gu,
    ),
  ];
  assert.equal(blocks.length, 1);
  return definition
    .replace(
      'target uuid; paper boolean; x ctp_paper.unsent_cancellation%ROWTYPE; permitted boolean;',
      'target uuid; paper boolean;',
    )
    .replace(
      blocks[0][0],
      "  IF EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND order_id=target)\n  THEN RAISE EXCEPTION 'PAPER_WITHDRAWN_NOT_SENT' USING ERRCODE='23514'; END IF;\n",
    );
}

/** Actual populated56 retention and use of a release predating additive57. */
export async function verifyPaperUnsentCancellationUpgrade(db, before, runtime) {
  assert.equal(before.functions.length, 205);
  const after = await capturePaperAdmissionUpgrade(db);
  assert.equal(after.functions.length, 214);
  const renamed = new Set(['evaluate_and_reserve', 'reconcile_admission', 'admission_inventory']);
  for (const f of before.functions) {
    const name = /^ctp_paper\.([a-z_]+)\(/u.exec(f.signature)?.[1];
    if (name === 'guard_withdrawal') {
      const current = after.functions.find((x) => x.signature === f.signature);
      assert(current);
      assert.equal(beforeCancellationGuard(current.definition), f.definition);
      continue;
    }
    const expected = renamed.has(name)
      ? {
          signature: f.signature.replace(`ctp_paper.${name}(`, `ctp_paper.${name}_v56(`),
          definition: f.definition.replace(
            `FUNCTION ctp_paper.${name}(`,
            `FUNCTION ctp_paper.${name}_v56(`,
          ),
        }
      : f;
    assert.deepEqual(
      after.functions.find((x) => x.signature === expected.signature),
      expected,
    );
  }
  for (const table of before.rows)
    assert.deepEqual(
      after.rows.find((x) => x.name === table.name),
      table,
    );
  assert.deepEqual(
    after.rows.filter((x) => !before.rows.some((old) => old.name === x.name)),
    [{ name: '"ctp_paper"."unsent_cancellation"', rows: [] }],
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ctp_paper.unsent_cancellation'::regclass",
      )
    ).rows,
    [{ relrowsecurity: true, relforcerowsecurity: true }],
  );
  for (const role of ['ctp_paper_risk_admission', 'ctp_execution', 'ctp_portfolio', 'ctp_api'])
    assert.equal(
      (
        await db.query('SELECT has_table_privilege($1,$2,$3) allowed', [
          role,
          'ctp_paper.unsent_cancellation',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES',
        ])
      ).rows[0].allowed,
      false,
    );
  for (const signature of [
    'ctp_paper.evaluate_and_reserve_v56(jsonb)',
    'ctp_paper.reconcile_admission_v56(jsonb)',
    'ctp_paper.admission_inventory_v56(jsonb,bigint)',
    'ctp_paper.unsent_cancel_state(jsonb,ctp_execution.command)',
    'ctp_paper.unsent_cancel_after(ctp_paper.unsent_cancellation)',
    'ctp_paper.validate_unsent_cancel_origin(uuid,uuid)',
    'ctp_paper.validate_unsent_cancellation(uuid,uuid)',
    'ctp_paper.check_unsent_cancellation()',
    'ctp_paper.cancel_unsent(jsonb,boolean)',
  ])
    assert.equal(
      (
        await db.query(
          "SELECT has_function_privilege('ctp_paper_risk_admission',$1,'EXECUTE') allowed",
          [signature],
        )
      ).rows[0].allowed,
      false,
    );
  const oldRelease = (
    await db.query(`SELECT r.tenant_id::text tenant,r.order_id::text id,
    jsonb_build_object('kind','PAPER_CANCEL_UNSENT','binding',i.request->'binding','orderId',r.order_id::text,
     'key','upgrade-cancel:'||r.order_id::text,'authorization',jsonb_build_object('permissionEpoch',a."permissionEpoch"::text,'userSessionEpoch',u."sessionEpoch"::text)) request
    FROM ctp_paper.withdrawal_release r JOIN ctp_paper.admission_issuance i USING(tenant_id,reservation_id)
    JOIN public.exchange_account a ON a."tenantId"=r.tenant_id AND a.id=r.account_id JOIN public."user" u ON u.id=r.tenant_id
    ORDER BY r.tenant_id,r.order_id LIMIT 1`)
  ).rows[0];
  assert(oldRelease, 'A genuine pre57 release is required, not an empty schema');
  const moneyNames = [
    '"ctp_portfolio"."book"',
    '"ctp_portfolio"."hold_watermark"',
    '"ctp_portfolio"."evidence"',
    '"ctp_portfolio"."outbox"',
    '"public"."risk_reservation"',
    '"public"."risk_decision"',
    '"public"."ledger_transaction"',
    '"public"."ledger_entry"',
    '"public"."exchange_account"',
  ];
  let receipt;
  const semantic = {
    binding: oldRelease.request.binding,
    orderId: oldRelease.id,
    operation: 'CANCEL',
    key: oldRelease.request.key,
  };
  for (const readonly of [false, true, false]) {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [oldRelease.tenant]);
      const result = (
        await client.query(
          readonly
            ? 'SELECT ctp_paper.reconcile_admission($1::jsonb) result'
            : 'SELECT ctp_paper.evaluate_and_reserve($1::jsonb) result',
          [JSON.stringify(oldRelease.request)],
        )
      ).rows[0].result;
      await client.query('COMMIT');
      assert.equal(result.kind, readonly ? 'COMMITTED' : 'CANCELED');
      assert.deepEqual(result.request, semantic);
      if (receipt === undefined) receipt = result.receipt;
      else assert.deepEqual(result.receipt, receipt);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  assert.equal(receipt.status, 'CANCELED');
  assert.equal(receipt.outcome, 'NOT_SENT');
  const completed = await capturePaperAdmissionUpgrade(db);
  for (const name of moneyNames)
    assert.deepEqual(
      completed.rows.find((x) => x.name === name),
      before.rows.find((x) => x.name === name),
    );
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM ctp_paper.unsent_cancellation')).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        'SELECT status,version,"reconciliationState" FROM public."order" WHERE "tenantId"=$1 AND id=$2',
        [oldRelease.tenant, oldRelease.id],
      )
    ).rows[0].status,
    'CANCELED',
  );
}
