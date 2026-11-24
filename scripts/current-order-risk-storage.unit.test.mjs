import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
const root = 'packages/database/prisma/migrations/';
const sql = (name) => readFileSync(root + name + '/migration.sql', 'utf8').replaceAll('\r\n', '\n');
const current = sql('202611150001_paper_current_order_risk');
function fn(text, name) {
  const start = text.indexOf('CREATE FUNCTION ctp_paper.' + name + '(');
  if (start < 0) throw Error('FUNCTION_REQUIRED');
  return text.slice(start, text.indexOf('END $$;', start) + 8);
}
it('retains every historical inventory guard except one explicitly authenticated untouched target', () => {
  const before = fn(sql('202611130001_paper_historical_inventory'), 'capture_historical_inventory');
  const expected = before
    .replace(
      'capture_historical_inventory(p jsonb)',
      'current_order_inventory(p jsonb,candidate jsonb)',
    )
    .replace('drafts integer:=1', 'drafts integer:=2')
    .replace('AND id<>x.order_id)', "AND id<>x.order_id AND id<>(candidate->>'orderId')::uuid)")
    .replace('AND id<>x.intent_id)', "AND id<>x.intent_id AND id<>(candidate->>'intentId')::uuid)")
    .replace(
      'IF (SELECT count(*) FROM ctp_paper.execution_commit WHERE tenant_id=t)<>1',
      '-- Only this independently authenticated untouched target may be outside the executed graph.\n PERFORM ctp_paper.current_order_target(p,candidate);\n IF (SELECT count(*) FROM ctp_paper.execution_commit WHERE tenant_id=t)<>1',
    );
  expect(fn(current, 'current_order_inventory')).toBe(expected);
});
it('preserves all native-clock ticker coherence and conflicting tie checks byte for byte', () => {
  const expected = fn(sql('202611140002_paper_current_risk_market_coherence'), 'current_risk_facts')
    .replace('current_risk_facts(p jsonb)', 'current_order_facts(p jsonb,candidate jsonb)')
    .replace(
      'ctp_paper.current_risk_facts_v69(p)',
      'ctp_paper.current_order_facts_base(p,candidate)',
    );
  expect(fn(current, 'current_order_facts')).toBe(expected);
});
it('preserves the complete durable loss/checkpoint/certificate operation without a second monetary writer', () => {
  const expected = fn(sql('202611140001_paper_current_risk'), 'current_risk_operation')
    .replace(
      'current_risk_operation(p jsonb)',
      'current_order_certificate(p jsonb,candidate jsonb)',
    )
    .replace('ctp_paper.current_risk_facts(p)', 'ctp_paper.current_order_facts(p,candidate)');
  expect(fn(current, 'current_order_certificate')).toBe(expected);
});
it('adds no role, table, index, sequence, financial row write or new runtime RPC grant', () => {
  const body = current.replace(/--[^\n]*/gu, '');
  expect(body).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|TABLE|INDEX|SEQUENCE)\b/iu);
  expect(body).not.toMatch(
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public|ctp_portfolio|ctp_execution)\./iu,
  );
  expect(body.match(/GRANT EXECUTE[^;]+;/gu)).toEqual([
    'GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;',
  ]);
  expect(body).not.toMatch(/\b(?:set_config|current_setting)\(/iu);
});
it('pins all seventy accepted migrations by name and repository LF bytes', () => {
  const names = readdirSync(root)
    .filter((n) => /^\d/u.test(n))
    .sort();
  expect(names[70]).toBe('202611150001_paper_current_order_risk');
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  expect(hash(JSON.stringify(names.slice(0, 70).map((n) => [n, hash(sql(n))])))).toBe(
    'b4d4f6b518c9e71e47f24590db3d222d412ee615a6746c5c26127ebe5dd3cf97',
  );
});
