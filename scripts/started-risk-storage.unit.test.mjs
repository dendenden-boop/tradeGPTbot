import { expect, it } from 'vitest';
import { verifyPaperStartedRiskStorage } from './paper-started-risk-upgrade.mjs';
function database(admin = false, mutate = () => {}) {
  const rows = ['capture_started_risk', 'reconcile_admission', 'reconcile_admission_v63'].map(
    (proname) => ({
      proname,
      rolsuper: admin,
      rolbypassrls: admin,
      public: false,
      allowed: proname === 'reconcile_admission',
      prosecdef: proname !== 'capture_started_risk',
      proconfig:
        proname === 'capture_started_risk'
          ? ['search_path=pg_catalog', 'TimeZone=UTC']
          : ['search_path=pg_catalog'],
    }),
  );
  mutate(rows);
  return { query: async () => ({ rows }) };
}
it('started-risk reset storage evidence cannot masquerade as a non-bypass owner acceptance', async () => {
  await expect(
    verifyPaperStartedRiskStorage(database(true), { ownership: 'STORAGE_ONLY' }),
  ).resolves.toBeUndefined();
  await expect(
    verifyPaperStartedRiskStorage(database(true), { ownership: 'REQUIRE_NON_BYPASS' }),
  ).rejects.toThrow();
  await expect(
    verifyPaperStartedRiskStorage(database(), { ownership: 'REQUIRE_NON_BYPASS' }),
  ).resolves.toBeUndefined();
  await expect(verifyPaperStartedRiskStorage(database())).rejects.toThrow(
    'STARTED_RISK_OWNER_SCOPE_REQUIRED',
  );
});
it.each(['missing', 'public', 'runtime', 'search-path', 'definer'])(
  'started-risk storage proof rejects %s in either scope',
  async (defect) => {
    for (const ownership of ['STORAGE_ONLY', 'REQUIRE_NON_BYPASS']) {
      const db = database(false, (rows) => {
        if (defect === 'missing') rows.pop();
        if (defect === 'public') rows[0].public = true;
        if (defect === 'runtime') rows[0].allowed = true;
        if (defect === 'search-path') rows[0].proconfig = ['search_path=public'];
        if (defect === 'definer') rows[0].prosecdef = true;
      });
      await expect(verifyPaperStartedRiskStorage(db, { ownership })).rejects.toThrow();
    }
  },
);
