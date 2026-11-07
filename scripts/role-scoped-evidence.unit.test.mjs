import { expect, it } from 'vitest';
import { discoverDatabaseFiles, planDatabaseCohorts } from './database-cohorts.mjs';
import { planRoleScopedCohorts } from './role-scoped-cohorts.mjs';
import { scopedMainManifestHash } from './native-main-scopes.mjs';
import { requireRoleScopedEvidence } from './role-scoped-evidence.mjs';
const original = await planRoleScopedCohorts(
  planDatabaseCohorts(await discoverDatabaseFiles(), { executionStartOverlap: true }),
);
function fixture() {
  const cohorts = original.map((c) => ({
    ...c,
    files: [...c.files],
    ...(c.after ? { after: [...c.after] } : {}),
    ...(c.afterAny ? { afterAny: [...c.afterAny] } : {}),
    database:
      c.id === 'main-scoped'
        ? 'ctp_p2_fresh_aabbcc11223300'
        : c.id === 'registry'
          ? 'ctp_p2_registry_aabbcc112233'
          : c.id === 'admission'
            ? 'ctp_p2_admission_aabbcc112233'
            : ['execution-start', 'execution-preview', 'execution-commit'].includes(c.id)
              ? 'ctp_p2_start_aabbcc112233'
              : 'ctp_p2_fresh_aabbcc112233',
  }));
  return {
    cohorts: {
      cohorts,
      roleScopedManifest: scopedMainManifestHash,
      elapsedMs: 10000,
      completed: cohorts.map((c, i) => ({
        id: c.id,
        startMs: i * 1000,
        settledMs: (i + 1) * 1000,
      })),
    },
    native: { testResults: cohorts.flatMap((c) => c.files).map((name) => ({ name })) },
  };
}
it('requires every unchanged native file and the reviewed fresh database under all nine physical barriers', () => {
  const e = fixture();
  expect(e.native.testResults).toHaveLength(49);
  expect(() => requireRoleScopedEvidence(e.cohorts, e.native)).not.toThrow();
});
it.each([
  'missing',
  'shared-db',
  'manifest',
  'early-scope',
  'early-writer',
  'early-roles',
  'dropped-file',
  'third-child',
  'early-start',
])(
  'rejects %s role-scoped proof instead of crediting an incomplete or unsafe native run',
  (kind) => {
    const e = fixture(),
      timing = (id) => e.cohorts.completed.find((c) => c.id === id);
    if (kind === 'missing')
      e.cohorts.completed = e.cohorts.completed.filter((c) => c.id !== 'main-scoped');
    if (kind === 'shared-db')
      e.cohorts.cohorts.find((c) => c.id === 'main-scoped').database = 'ctp_p2_fresh_aabbcc112233';
    if (kind === 'manifest') e.cohorts.roleScopedManifest = '0'.repeat(64);
    if (kind === 'early-scope') timing('main-scoped').startMs = 0;
    if (kind === 'early-writer') timing('execution-commit').startMs = 0;
    if (kind === 'early-roles') timing('roles').startMs = 0;
    if (kind === 'dropped-file') e.native.testResults.pop();
    if (kind === 'third-child') {
      timing('admission').startMs = 2000;
      timing('native-admission').startMs = 2000;
    }
    if (kind === 'early-start') timing('execution-start').startMs = 3500;
    expect(() => requireRoleScopedEvidence(e.cohorts, e.native)).toThrow();
  },
);
