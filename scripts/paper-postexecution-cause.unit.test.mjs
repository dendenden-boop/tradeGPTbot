import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const root = 'packages/database/prisma/migrations';
const migration = read(root + '/202611240001_paper_postexecution_reservation/migration.sql');
const boundary = migration.indexOf('CREATE FUNCTION ctp_paper.derive_postexecution_risk');
const candidate = migration.slice(0, boundary);
const writer = migration.slice(boundary);
const original = read(root + '/202611060002_paper_execution_commit/migration.sql');

function validator(sql) {
  const name = 'FUNCTION ctp_paper.validate_committed_execution(t uuid,k text)';
  const start = sql.indexOf(name);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('END $$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 7);
}

it('retains all immutable first-execution checks beneath the direct successor branch', () => {
  const amendments = [
    [
      ' successor ctp_paper.postexecution_commitment%ROWTYPE; expected_revision bigint;\n expected_hash bytea; expected_state text; companion_count integer:=0;\n',
      '',
    ],
    [
      ' SELECT * INTO successor FROM ctp_paper.postexecution_commitment WHERE tenant_id=t AND execution_id=x.execution_id;\n IF FOUND THEN companion_count:=1; END IF;\n',
      '',
    ],
    [
      'WHERE tenant_id=t AND book_id=x.book_id)<>1+companion_count\n  OR EXISTS',
      'WHERE tenant_id=t AND book_id=x.book_id)<>1\n  OR EXISTS',
    ],
    [
      ' expected_revision:=x.revision;expected_hash:=x.state_hash;expected_state:=e.state_text;\n IF companion_count=1 THEN\n  expected_state:=ctp_paper.validate_postexecution_commitment(x,successor);\n  expected_revision:=successor.revision;expected_hash:=successor.state_hash;\n END IF;\n',
      '',
    ],
    [
      'ROW(x.account_id,\'PAPER\'::public."TradingMode",expected_revision,expected_hash,expected_state)',
      'ROW(x.account_id,\'PAPER\'::public."TradingMode",x.revision,x.state_hash,e.state_text)',
    ],
    [
      'book_id=x.book_id AND revision=expected_revision AND state_hash=expected_hash)',
      'book_id=x.book_id AND revision=x.revision AND state_hash=x.state_hash)',
    ],
    ['AND book=x.book_id)<>1+companion_count', 'AND book=x.book_id)<>1'],
  ];
  let reconstructed = validator(candidate);
  for (const [newText, oldText] of amendments) {
    expect(reconstructed.split(newText)).toHaveLength(2);
    reconstructed = reconstructed.replace(newText, oldText);
  }
  expect(reconstructed).toBe(validator(original));
});

it('restricts the persistent cause to a single immutable successor', () => {
  const sql = candidate.replace(/--[^\n]*/gu, '');
  expect(sql).not.toMatch(/\bGRANT\b/iu);
  expect(sql).not.toMatch(
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public|ctp_portfolio|ctp_paper)\./iu,
  );
  for (const required of [
    'PRIMARY KEY(tenant_id,idempotency_key)',
    'UNIQUE(tenant_id,execution_id)',
    'UNIQUE(tenant_id,intent_id)',
    'CREATE TRIGGER postexecution_immutable',
    'CREATE TRIGGER postexecution_no_truncate',
    'FORCE ROW LEVEL SECURITY',
    'DEFERRABLE INITIALLY DEFERRED',
    'AND v.ledger IS NULL',
  ])
    expect(sql).toContain(required);
});

it('requires the fixed current proofs before issuing a decision and keeps the two restricted RPC grants', () => {
  const decision = writer.indexOf('INSERT INTO public.risk_decision');
  const capture = writer.indexOf('captured:=ctp_paper.current_order_risk_operation(');
  const replay = writer.indexOf(
    "RETURN jsonb_build_object('kind','REPLAYED','receipt',ctp_paper.postexecution_receipt(s,i));",
  );
  const deferredChecks = writer.indexOf('SET CONSTRAINTS ALL IMMEDIATE;');
  const sealedWrite = writer.indexOf("RETURN jsonb_build_object('kind','WRITTEN'");
  expect(replay).toBeGreaterThan(0);
  expect(capture).toBeGreaterThan(replay);
  expect(decision).toBeGreaterThan(capture);
  expect(deferredChecks).toBeGreaterThan(decision);
  expect(sealedWrite).toBeGreaterThan(deferredChecks);
  const checks = writer.slice(capture, decision);
  for (const proof of [
    'rulesAllowed',
    'capabilityReady',
    'runtimeReady',
    'tradingReady',
    'withinLimits',
    'marketAllowed',
    'lossAllowed',
    'nextRevision',
  ])
    expect(checks).toContain(proof);
  expect(writer.match(/^GRANT EXECUTE.*$/gmu)).toEqual([
    'GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;',
  ]);
  expect(writer).not.toMatch(
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:ledger_\w+|fill|submission_attempt)\b/iu,
  );
  expect(writer).not.toContain('pg_temp.');
});
