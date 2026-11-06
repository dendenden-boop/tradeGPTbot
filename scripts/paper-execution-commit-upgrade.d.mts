export interface ExecutionCommitProofDatabase {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export const executionMathFunctions: readonly string[];
export const executionCommitFunctions: readonly string[];
export function verifyPaperExecutionCommitStorage(
  db: ExecutionCommitProofDatabase,
  options: { ownership: 'STORAGE_ONLY' | 'REQUIRE_NON_BYPASS' },
): Promise<void>;
export function verifyPaperExecutionCommitUpgrade(
  db: ExecutionCommitProofDatabase,
  before: unknown,
): Promise<void>;
