import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { requireRealServicesSuccess } from './real-services-gate.mjs';

it('separates isolated native and container suites under a fail-closed required context', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  expect(workflow).toMatch(/needs: \[native, smoke\]/u);
  expect(workflow).toContain('name: Real services and Docker smoke');
  expect(workflow).toContain('if: always()');
});
it('accepts only two definitive successful child results', () => {
  expect(() => requireRealServicesSuccess({ native: 'success', smoke: 'success' })).not.toThrow();
});
it.each(
  ['native', 'smoke'].flatMap((key) =>
    ['failure', 'cancelled', 'skipped', '', 'unknown'].map((value) => ({ key, value })),
  ),
)('rejects $key=$value rather than turning partial evidence into acceptance', ({ key, value }) => {
  expect(() =>
    requireRealServicesSuccess({ native: 'success', smoke: 'success', [key]: value }),
  ).toThrow('REAL_SERVICES_INCOMPLETE');
});
it.each([null, {}, { native: 'success', smoke: 'success', override: true }])(
  'rejects missing or unexpected result inputs %#',
  (results) => {
    expect(() => requireRealServicesSuccess(results)).toThrow('REAL_SERVICES_INCOMPLETE');
  },
);
it.each(['success', 'cancelled'])('actual gate process exits fail closed for smoke=%s', (smoke) => {
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./real-services-gate.mjs', import.meta.url))],
    {
      encoding: 'utf8',
      env: { ...process.env, CTP_NATIVE_RESULT: 'success', CTP_SMOKE_RESULT: smoke },
      windowsHide: true,
    },
  );
  expect(r.status).toBe(smoke === 'success' ? 0 : 1);
  if (smoke !== 'success') expect(r.stderr.trim()).toBe('REAL_SERVICES_INCOMPLETE');
});
it('retains every suite and operation budget while bounding isolated CI jobs', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const native = workflow.slice(
    workflow.indexOf('\n  native:\n'),
    workflow.indexOf('\n  smoke:\n'),
  );
  const smoke = workflow.slice(workflow.indexOf('\n  smoke:\n'), workflow.indexOf('\n  docker:\n'));
  const gate = workflow.slice(workflow.indexOf('\n  docker:\n'));
  expect(native).toContain('timeout-minutes: 20');
  expect(native).toContain('run: pnpm test:integration');
  expect(native).toContain('name: bootstrap-docker');
  expect(smoke).toContain('timeout-minutes: 10');
  expect(smoke).toContain('run: pnpm test:smoke');
  expect(smoke).toContain('name: bootstrap-smoke');
  expect(gate).toContain('timeout-minutes: 1');
  expect(gate).toContain('if: always()');
  expect(gate).toContain('CTP_NATIVE_RESULT: ${{ needs.native.result }}');
  expect(gate).toContain('CTP_SMOKE_RESULT: ${{ needs.smoke.result }}');
  expect(gate).toContain('run: node scripts/real-services-gate.mjs');
  expect(workflow.match(/run: pnpm test:integration/gu) ?? []).toHaveLength(1);
  expect(workflow.match(/run: pnpm test:smoke/gu) ?? []).toHaveLength(1);
});
