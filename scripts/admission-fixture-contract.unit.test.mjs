// Parent1020s CI deadline is the RED performance reproduction. This guard only
// permits fixture-handle lifetime changes; no assertion, fresh operation,
// reader/restart lifecycle, producer payload or deadline may be removed.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { format, resolveConfig } from 'prettier';
import { expect, it } from 'vitest';
import { beforePaperAttemptJournal } from './paper-attempt-journal-legacy.mjs';
import { beforePublicMarketWriters } from './public-market-fixture-legacy.mjs';
import { beforePreparedExecutionSource } from './prepared-execution-source-legacy.mjs';
const path = 'packages/database/test/paper-admission.integration.test.ts';
const fixtureOnly = new Set([
  'updatePolicy',
  'updateControl',
  'fixture',
  'fundCash',
  'openBook',
  'runtimeEvidence',
  'ownWriter',
  'configurationPort',
  'fundingPort',
  'runtimePort',
]);
const caches = new Set([
  'configurationWriter',
  'fundingWriter',
  'bookWriter',
  'runtimeWriter',
  'policyWriters',
  'controlWriters',
]);
const cancellationHelpers = new Set([
  'openUnsentCancellation',
  'cancellationRequest',
  'cancellationFixture',
  'cancellationRows',
]);
const factories = new Set([
  'createPostgresPaperConfiguration',
  'createPostgresPaperFunding',
  'createPostgresPaperPortfolioBootstrap',
  'createPostgresPolicies',
  'createPostgresControls',
  'createPostgresPaperRuntimeObservations',
]);
// Keep the exact historical hashes/assertions below. Reconstruct only the
// reviewed additive58 blocks and six new cases; their raw required coverage,
// owner counts, migration and unchanged deadlines have a separate contract.
function beforeExecutionSource(file, source) {
  source = beforePaperAttemptJournal(file, source);
  if (![path, 'scripts/test-database.mjs'].includes(file)) return source;
  source = source.replace(
    /^[ \t]*\/\/ BEGIN PAPER EXECUTION SOURCE ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER EXECUTION SOURCE \1\n/gm,
    '',
  );
  if (file === 'scripts/test-database.mjs')
    source = source
      .replace('paperAdmissionOwner.numPassedTests, 53', 'paperAdmissionOwner.numPassedTests, 47')
      .replace('beforeUnknownTests.numPendingTests, 36', 'beforeUnknownTests.numPendingTests, 30')
      .replace(
        'beforeWithdrawalTests.numPendingTests, 51',
        'beforeWithdrawalTests.numPendingTests, 45',
      )
      .replace('beforeReleaseTests.numPendingTests, 52', 'beforeReleaseTests.numPendingTests, 46');
  return source;
}
const text = (file) =>
  beforeExecutionSource(
    file,
    beforePublicMarketWriters(
      file,
      beforePreparedExecutionSource(
        file,
        fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
      ),
    ),
  );
const source = () =>
  ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const hash = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const printer = ts.createPrinter({ removeComments: true });
function root(node) {
  while (
    ts.isCallExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  )
    node = node.expression;
  return ts.isIdentifier(node) ? node.text : null;
}
it('retains all72 original non-fixture statements, all33 test bodies, readers, restart helpers and cleanup', () => {
  const file = source();
  const kept = file.statements
    .filter(
      (s) =>
        !(ts.isFunctionDeclaration(s) && cancellationHelpers.has(s.name?.text)) &&
        !(ts.isTypeAliasDeclaration(s) && s.name.text === 'UnsentCancellation') &&
        !(ts.isExpressionStatement(s) && s.getText(file).startsWith("it('paper-cancel:")) &&
        !(ts.isFunctionDeclaration(s) && fixtureOnly.has(s.name?.text)) &&
        !(
          ts.isVariableStatement(s) &&
          s.declarationList.declarations.every(
            (d) => ts.isIdentifier(d.name) && caches.has(d.name.text),
          )
        ),
    )
    .map((s) => s.getText(file));
  expect(kept).toHaveLength(82);
  expect(hash(kept.slice(0, 72))).toBe(
    'b40e952b8a9dcdf422ecaa6a7d221de59e396962a151b8af4638c4b6487bc8c9',
  );
  expect(kept.slice(72).filter((s) => s.startsWith("it('paper-release:"))).toHaveLength(6);
});
it.each([
  ['updatePolicy', 2, '3deb5ffdd5c335fdfdb3e8d50c3c1be9640f4701e93eda5c98df039770580dbb'],
  ['updateControl', 3, '2de99fb8459dd23bc0b9d9b04c2f1c671696f7afba3d21f7216135a6b1aca8c4'],
  ['fixture', 9, 'd723ac654aea53e5536a8785e95f723d56c84d53f3d58e73d85eae156fb328dd'],
  ['fundCash', 3, 'ea68480a356ae6913aa0d92246a2bb9027c54dc432e748de581474403215288d'],
  ['openBook', 0, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'],
  ['runtimeEvidence', 5, 'dfb561375252d5bf8d89855f45785fd1721cecf28e19cd19153b0e1995e3bd2b'],
])(
  'preserves every fresh %s query/command/publication and its original parameters',
  (name, count, digest) => {
    const file = source(),
      fn = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name),
      calls = [];
    expect(fn).toBeDefined();
    const scan = (n) => {
      if (ts.isCallExpression(n)) {
        const key = root(n.expression);
        if (
          factories.has(key) ||
          fixtureOnly.has(key) ||
          caches.has(key) ||
          key === 'required' ||
          key === 'handles' ||
          (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'close')
        )
          return;
        calls.push(printer.printNode(ts.EmitHint.Unspecified, n, file));
        return;
      }
      ts.forEachChild(n, scan);
    };
    scan(fn);
    expect(calls).toHaveLength(count);
    expect(hash(calls)).toBe(digest);
  },
);
it('bounds fixture caches to eight server-owned handles and drains each through the original afterAll', () => {
  const file = source(),
    own = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'ownWriter');
  expect(own, 'Bounded shared fixture handle owner is required').toBeDefined();
  const names = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) =>
      s.declarationList.declarations
        .filter((d) => ts.isIdentifier(d.name) && caches.has(d.name.text))
        .map((d) => d.name.text),
    );
  expect(names.sort()).toEqual([...caches].sort());
  const tracked = [],
    constructors = [];
  const scan = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      root(n.expression) === 'handles' &&
      n.expression.name.text === 'push'
    )
      tracked.push(n);
    if (ts.isCallExpression(n) && root(n.expression) === 'ownWriter') constructors.push(n);
    ts.forEachChild(n, scan);
  };
  scan(own);
  expect(tracked).toHaveLength(1);
  scan(file);
  for (const call of constructors) expect(factories.has(root(call.arguments[0]))).toBe(true);
  expect(constructors).toHaveLength(7); // Four singleton writers + two maps with2authorities; foreign book URL stays fresh.
});
it('retains the whole native runner, all owner/cohort assertions and1020s/480s/90s budgets', async () => {
  expect(
    createHash('sha256')
      .update(
        beforeReleaseRunner(
          await format(legacyNativeRunner(text('scripts/test-database.mjs')), {
            ...(await resolveConfig('scripts/test-database.mjs')),
            filepath: 'scripts/test-database.mjs',
          }),
        ),
      )
      .digest('hex'),
  ).toBe('613552de72cbe9aa7e7476a52fa52b152cf21d5bbfa829342c014cb8eb7165ad');
  expect(
    createHash('sha256')
      .update(
        await format(legacyIntegrationProof(text('scripts/integration-proof.mjs')), {
          ...(await resolveConfig('scripts/integration-proof.mjs')),
          filepath: 'scripts/integration-proof.mjs',
        }),
      )
      .digest('hex'),
  ).toBe('0b5859334fc36a31c68211e1bee7e26fbd487644d5621c16a0f6a5b5846f596e');
});

// Remove only the explicit CI partition controls, then prove the complete old
// runner byte-for-byte after canonical formatting. No original assertion or SQL
// statement is normalized away; both physical groups execute the same prelude.
function legacyNativeRunner(source) {
  const markers = [...source.matchAll(/\/\/ BEGIN NATIVE PARTITION ([A-Z_]+)/gu)]
    .map((m) => m[1])
    .sort();
  expect(markers).toEqual([
    'COHORT_REPORT',
    'IMPORT',
    'OWNER_REPORT',
    'OWNER_WRAPPER',
    'REPORT_NAME',
    'REPORT_WINDOW',
    'WINDOW',
  ]);
  source = source.replace(
    / {2}\/\/ BEGIN NATIVE PARTITION OWNER_WRAPPER\n {2}if \(proof.mode !== 'cohorts'\) \{\n([\s\S]*?) {2}\}\n {2}\/\/ END NATIVE PARTITION OWNER_WRAPPER\n/u,
    // Prettier restores JS indentation; never dedent raw SQL template contents.
    (_, body) => body,
  );
  source = source.replace(
    /^[ \t]*\/\/ BEGIN NATIVE PARTITION ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END NATIVE PARTITION \1\n/gmu,
    '',
  );
  return source.replace(
    'await report(reportName, {',
    "await report(proof.mode === 'auth' ? 'database-auth' : 'database', {",
  );
}

function legacyIntegrationProof(source) {
  // The new scope-specific report branches are additive. Reconstruct the old
  // admission predicates exactly; the hash below still pins every legacy path.
  const start = source.indexOf("    (mode === 'auth' && report.tests !== undefined)");
  const end = source.indexOf('\n  )\n    throw', start);
  if (start < 0 || end < start) throw new Error('LEGACY_PROOF_RECONSTRUCTION');
  source =
    source.slice(0, start) +
    "    (mode === 'auth' && report.tests !== undefined)" +
    source.slice(end);
  source = source
    .replace(
      /const parentDeadlines = Object.freeze\(\{\n {2}full: 1020000,\n {2}database: 1020000,\n {2}auth: 360000,\n {2}owners: 1020000,\n {2}cohorts: 1020000,\n\}\);/u,
      'const parentDeadlines = Object.freeze({ full: 1020000, database: 1020000, auth: 360000 });',
    )
    .replace(/\|owners\|cohorts/gu, '')
    .replace(
      "const delegated = ['database', 'owners', 'cohorts'].includes(mode);",
      "const delegated = mode === 'database';",
    )
    .replace("  const partial = ['owners', 'cohorts'].includes(mode);\n", '')
    .replace("report.status !== (partial ? 'PARTIAL' : 'PASS')", "report.status !== 'PASS'");
  return source;
}

function releaseBlocks(source) {
  return [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN PAPER RELEASE ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER RELEASE \1\n/gm,
    ),
  ];
}
function beforeReleaseRunner(source) {
  for (const block of cancellationBlocks(source)) source = source.replace(block[0], '');
  source = source
    .replace('paperAdmissionOwner.numPassedTests, 47', 'paperAdmissionOwner.numPassedTests, 39')
    .replace('beforeUnknownTests.numPendingTests, 30', 'beforeUnknownTests.numPendingTests, 22')
    .replace(
      'beforeWithdrawalTests.numPendingTests, 45',
      'beforeWithdrawalTests.numPendingTests, 37',
    )
    .replace('beforeReleaseTests.numPendingTests, 46', 'beforeReleaseTests.numPendingTests, 38');
  for (const block of releaseBlocks(source)) source = source.replace(block[0], '');
  return source
    .replace('paperAdmissionOwner.numPassedTests, 39', 'paperAdmissionOwner.numPassedTests, 33')
    .replace('beforeUnknownTests.numPendingTests, 22', 'beforeUnknownTests.numPendingTests, 16')
    .replace(
      'beforeWithdrawalTests.numPendingTests, 37',
      'beforeWithdrawalTests.numPendingTests, 31',
    );
}
it('requires exactly the reviewed additive56 owner, upgrade and reset extensions without altering the complete prior runner', () => {
  expect(
    releaseBlocks(text('scripts/test-database.mjs'))
      .map((b) => b[1])
      .sort(),
  ).toEqual(['FLAGS', 'IMPORT', 'MIGRATION', 'OWNER', 'RESET_AFTER', 'RESET_BEFORE', 'UPGRADE']);
});

function cancellationBlocks(source) {
  return [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN PAPER CANCEL ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PAPER CANCEL \1\n/gm,
    ),
  ];
}
it('requires the exact additive57 extensions, seven new cancellation contracts and no shared financial fixture cache', () => {
  expect(
    cancellationBlocks(text('scripts/test-database.mjs'))
      .map((b) => b[1])
      .sort(),
  ).toEqual(['FLAGS', 'IMPORT', 'MIGRATION', 'OWNER', 'RESET_AFTER', 'RESET_BEFORE', 'UPGRADE']);
  const file = source();
  expect(
    file.statements.filter(
      (s) => ts.isExpressionStatement(s) && s.getText(file).startsWith("it('paper-cancel:"),
    ),
  ).toHaveLength(8);
  expect(
    file.statements.filter(
      (s) => ts.isFunctionDeclaration(s) && cancellationHelpers.has(s.name?.text),
    ),
  ).toHaveLength(4);
  expect(
    file.statements.filter(
      (s) => ts.isTypeAliasDeclaration(s) && s.name.text === 'UnsentCancellation',
    ),
  ).toHaveLength(1);
});
