import { beforeStartedPreview } from './started-preview-legacy.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
const pinned = {
  domain: 'packages/paper-engine/src/execution-risk-domain.ts',
  originalHash: '60bbc079e720fc384a324fe9cc88f8b7a03843f9316ff995a385a2741434d1ae',
  middleHash: '1b5a77cd3496160116489c8a0ac506d1730453e7244987cb45385056888568bc',
  originalHead:
    'export function decodePaperExecutionRiskSource(\n  raw: unknown,\n  request: PaperExecutionRiskSourceRequest,\n  now: number,\n) {\n',
  changedJournal:
    '    if (started && !same(source, started.source)) fail();\n    const preparation = preparationEvidence(w.journal, request, started),\n',
  originalJournal:
    "    const journalRequest = {\n      kind: 'PAPER_ATTEMPT_PREPARE' as const,\n      key: request.preparationKey,\n      admission: request.admission,\n      authorization: request.authorization,\n    };\n    const journal = decodePaperAttemptJournalView(w.journal, journalRequest, 'COMMITTED');\n    if (\n      journal.kind !== 'COMMITTED' ||\n      journal.withdrawal !== null ||\n      journal.state.phase !== 'PREPARED'\n    )\n      fail();\n    const preparation = journal.preparation,\n",
  wrapperPath: 'packages/paper-engine/src/postgres-started-source.ts',
  wrapper:
    '/** Internal content decoder. Only the fixed locked SQL call establishes origin. */\nexport function decodePaperStartedExecutionSourceWire(\n  raw: unknown,\n  request: PaperStartedExecutionSourceRequest,\n  now: number,\n) {\n  return decode(raw, lookup(request), now);\n}\n\n',
  wrapperHash: '36845b9bb8e51109be32ee5385199b02abe520cb7e4b45349600ac2ca48d7c1a',
  originalWrapperHash: '69bab215367dda2608695d61deaed87fc77bd984d7bc99c94c65ed29a6d81dc8',
  fixturePath: 'scripts/started-source-harness.unit.test.mjs',
  fixtureDecl:
    "  const files = (await cohorts.discoverDatabaseFiles()).filter(\n    (file) => file !== 'packages/database/test/paper-started-risk.integration.test.ts',\n  );\n",
  originalFixtureDecl: '  const files = await cohorts.discoverDatabaseFiles();\n',
  originalFixtureHash: '84994ab9f0b3b75d6227b3de67722ac88e1868b92582265baa5cee09783cbdb5',
  migrationDigest: 'e6a16c7f01442e28b0fc33c453cd79864f54e7b8511ad072099a052377893eb3',
};
const rawRead = (p) =>
  fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const read = (p) => beforeStartedPreview(p, rawRead(p));
const hash = (s) => createHash('sha256').update(s).digest('hex');
function oldRisk(source) {
  const first = source.indexOf('export function decodePaperExecutionRiskSource('),
    last = source.indexOf('function decodeRiskEvidence('),
    end = source.indexOf(') {\n', last) + 4;
  expect(first).toBeGreaterThan(0);
  expect(last).toBeGreaterThan(first);
  expect(end).toBeGreaterThan(last);
  expect(hash(source.slice(first, end))).toBe(pinned.middleHash);
  source = source.slice(0, first) + pinned.originalHead + source.slice(end);
  const addedImport =
    "import type { PaperStartedExecutionSource } from './postgres-started-source.js';\n";
  expect(source.split(addedImport)).toHaveLength(2);
  expect(source.split(pinned.changedJournal)).toHaveLength(2);
  return source.replace(addedImport, '').replace(pinned.changedJournal, pinned.originalJournal);
}
it('retains every accepted PREPARED Risk guard and statement through the internal START refactor', () => {
  const source = read(pinned.domain);
  expect(hash(oldRisk(source))).toBe(pinned.originalHash);
  expect(() =>
    oldRisk(
      source.replace(
        'return decodeRiskEvidence(raw, request, now);',
        'return decodeRiskEvidence(raw, request, now, undefined);',
      ),
    ),
  ).toThrow();
  expect(hash(oldRisk(source + '\n// outside edit\n'))).not.toBe(pinned.originalHash);
});
it('the accepted known-START source only adds a pinned internal decoder wrapper', () => {
  const source = read(pinned.wrapperPath);
  expect(hash(pinned.wrapper)).toBe(pinned.wrapperHash);
  expect(source.split(pinned.wrapper)).toHaveLength(2);
  expect(hash(source.replace(pinned.wrapper, ''))).toBe(pinned.originalWrapperHash);
});
it('the predecessor scheduling contract retains every original assertion with only the new file projected out', () => {
  const source = read(pinned.fixturePath);
  expect(source.split(pinned.fixtureDecl)).toHaveLength(2);
  expect(hash(source.replace(pinned.fixtureDecl, pinned.originalFixtureDecl))).toBe(
    pinned.originalFixtureHash,
  );
});
it('all 63 published migration bodies remain unchanged and in their original order', () => {
  const names = fs
    .readdirSync(new URL('../packages/database/prisma/migrations/', import.meta.url))
    .filter((n) => /^\d/u.test(n))
    .sort()
    .slice(0, 63);
  expect(names).toHaveLength(63);
  expect(names[62]).toBe('202611030001_paper_started_execution_source');
  const content = names
    .map((n) => {
      const p = 'packages/database/prisma/migrations/' + n + '/migration.sql';
      return p + '\0' + hash(read(p)) + '\n';
    })
    .join('');
  expect(hash(content)).toBe(pinned.migrationDigest);
});
it('the new SQL path reuses the complete accepted current-Risk acquisition body without financial writes', () => {
  const old = read(
      'packages/database/prisma/migrations/202610280001_paper_execution_risk_source/migration.sql',
    ),
    next = read(
      'packages/database/prisma/migrations/202611030002_paper_started_risk_source/migration.sql',
    );
  const body = (s) => s.slice(s.indexOf(' now_ms:=floor('), s.indexOf('\nEXCEPTION WHEN'));
  let current = body(next).replace("'request',risk_request,", "'request',p,");
  const a = current.indexOf(" result:=jsonb_build_object('kind','PAPER_STARTED_RISK_CAPTURE'"),
    b = current.indexOf(' RETURN result;', a);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  current = current.slice(0, a) + current.slice(b);
  expect(current).toBe(body(old));
});
