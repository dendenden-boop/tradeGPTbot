// Test-only reconstruction of the complete published61 runner/native fixture.
export function beforeBookUpgradeRecovery(file, source) {
  const runner = file === 'scripts/test-database.mjs';
  const native = file === 'packages/database/test/paper-portfolio-bootstrap.integration.test.ts';
  if (!runner && !native) return source;
  const expected = runner
    ? ['IMPORT', 'STATE', 'INITIALIZE', 'REPLAY', 'READ', 'VERIFY']
    : ['NATIVE'];
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN BOOK UPGRADE RECOVERY ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END BOOK UPGRADE RECOVERY \1\n/gm,
    ),
  ];
  if (!blocks.length && !source.includes('// BEGIN BOOK UPGRADE RECOVERY ')) return source;
  if (
    blocks.length !== expected.length ||
    blocks.some((b, i) => b[1] !== expected[i]) ||
    (source.match(/\/\/ BEGIN BOOK UPGRADE RECOVERY /gu) ?? []).length !== expected.length
  )
    throw Error('BOOK_UPGRADE_RECOVERY_BLOCKS');
  const original = {
    INITIALIZE: `    const initialBook = await upgradedBook.initialize(paperInput.owner, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2500,
    });
`,
    REPLAY: `      await upgradedBook.initialize(paperInput.owner, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
`,
    READ: `      await upgradedBook.read(paperInput.owner, {
        signal: new AbortController().signal,
        deadline: Date.now() + 2500,
      }),
`,
  };
  for (const block of blocks) source = source.replace(block[0], original[block[1]] ?? '');
  return source;
}
