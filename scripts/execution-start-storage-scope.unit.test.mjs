import { it, expect } from 'vitest';
import {
  executionStartFunctions,
  verifyPaperExecutionStartStorage,
} from './paper-execution-start-upgrade.mjs';
// Model catalog evidence independently: an administrative reset and a genuine
// NOBYPASSRLS owner are different proof producers, with identical storage ACLs.
function catalog({ superuser = false, leaked = false, missing = false } = {}) {
  return {
    async query(sql) {
      if (sql.includes('relrowsecurity'))
        return { rows: [{ relrowsecurity: true, relforcerowsecurity: true }] };
      if (sql.includes('has_table_privilege')) return { rows: [{ allowed: false }] };
      if (sql.includes('FROM pg_proc'))
        return {
          rows: executionStartFunctions
            .filter((_, i) => !missing || i !== 0)
            .map((proname) => ({
              proname,
              rolsuper: superuser,
              rolbypassrls: false,
              public: false,
              allowed:
                ['evaluate_and_reserve', 'reconcile_admission'].includes(proname) ||
                (leaked && proname === 'execution_start'),
            })),
        };
      if (sql.includes('FROM pg_trigger'))
        return {
          rows: [
            'derive_execution_start',
            'execution_start_immutable',
            'execution_start_no_truncate',
          ].map((tgname) => ({ tgname })),
        };
      throw Error('Unexpected catalog query');
    },
  };
}
it('execution-start administrative reset proves storage without masquerading as the owner project', async () => {
  await expect(
    verifyPaperExecutionStartStorage(catalog({ superuser: true }), { ownership: 'STORAGE_ONLY' }),
  ).resolves.toBeUndefined();
});
it('execution-start dedicated owner proof still rejects an administrative or bypass owner', async () => {
  await expect(
    verifyPaperExecutionStartStorage(catalog({ superuser: true }), {
      ownership: 'REQUIRE_NON_BYPASS',
    }),
  ).rejects.toThrow();
  await expect(
    verifyPaperExecutionStartStorage(catalog(), { ownership: 'REQUIRE_NON_BYPASS' }),
  ).resolves.toBeUndefined();
});
it.each(['STORAGE_ONLY', 'REQUIRE_NON_BYPASS'])(
  'execution-start %s retains private ACL and complete-function checks',
  async (ownership) => {
    await expect(
      verifyPaperExecutionStartStorage(catalog({ leaked: true }), { ownership }),
    ).rejects.toThrow();
    await expect(
      verifyPaperExecutionStartStorage(catalog({ missing: true }), { ownership }),
    ).rejects.toThrow();
  },
);
it('execution-start proof producer must explicitly select its ownership scope', async () => {
  await expect(verifyPaperExecutionStartStorage(catalog())).rejects.toThrow(
    'EXECUTION_START_OWNER_SCOPE_REQUIRED',
  );
  await expect(
    verifyPaperExecutionStartStorage(catalog(), { ownership: 'IMPLICIT_SKIP' }),
  ).rejects.toThrow('EXECUTION_START_OWNER_SCOPE_REQUIRED');
});
