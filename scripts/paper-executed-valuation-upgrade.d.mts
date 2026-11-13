import type { ExecutionCommitProofDatabase } from './paper-execution-commit-upgrade.mjs';
export function verifyPaperExecutedValuationStorage(
  db: ExecutionCommitProofDatabase,
  options: { ownership: 'STORAGE_ONLY' | 'REQUIRE_NON_BYPASS' },
): Promise<void>;
export function verifyPaperExecutedValuationUpgrade(
  db: ExecutionCommitProofDatabase,
  before: unknown,
): Promise<void>;
export function verifyCompiledExecutedValuation(
  db: ExecutionCommitProofDatabase,
  env: Record<string, string>,
): Promise<unknown>;
