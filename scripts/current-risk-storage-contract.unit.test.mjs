import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = readFileSync(
  'packages/database/prisma/migrations/202611140001_paper_current_risk/migration.sql',
  'utf8',
).replace(/\s+/gu, ' ');
it('binds the loss head ID to the exact same tenant/execution/day/revision/hash checkpoint', () => {
  // Static schema prerequisite; real PostgreSQL rejection remains mandatory.
  expect(source).toContain(
    'FOREIGN KEY(tenant_id,execution_id,day_start_ms,revision,id,document_hash) REFERENCES ctp_paper.current_loss_checkpoint(tenant_id,execution_id,day_start_ms,revision,id,document_hash)',
  );
});
it('retains an exact prior-day checkpoint link at UTC rollover', () => {
  expect(source).toContain(
    'FOREIGN KEY(tenant_id,execution_id,previous_day_start_ms,previous_revision,previous_hash) REFERENCES ctp_paper.current_loss_checkpoint(tenant_id,execution_id,day_start_ms,revision,document_hash)',
  );
});
it('cannot persist a certificate without its exact durable loss checkpoint', () => {
  expect(source).toContain(
    'FOREIGN KEY(tenant_id,execution_id,loss_day_start_ms,loss_revision,loss_id,loss_hash) REFERENCES ctp_paper.current_loss_checkpoint(tenant_id,execution_id,day_start_ms,revision,id,document_hash)',
  );
});
it('does not reset native-clock identity at UTC midnight', () => {
  expect(source).toContain('PRIMARY KEY(tenant_id,execution_id,native_ms)');
});
