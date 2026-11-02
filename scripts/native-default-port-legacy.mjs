// Strictly reconstruct the original 69 native cases before fixture composition.
const helpers = [
  ['LIFECYCLE', 'openLifecycle'],
  ['WITHDRAWAL', 'openWithdrawal'],
  ['RELEASE', 'openWithdrawalRelease'],
  ['CANCELLATION', 'openUnsentCancellation'],
  ['EXECUTION', 'openExecutionSource'],
  ['ATTEMPT', 'openAttemptJournal'],
  ['CURRENT_RISK', 'openCurrentExecutionRisk'],
  ['INVENTORY', 'openPreparationInventory'],
  ['CONTEXT', 'openExecutionContext'],
];
export function beforeNativeDefaultPort(file, source) {
  const native = file === 'packages/database/test/paper-admission.integration.test.ts';
  const overlap = file === 'scripts/admission-overlap.unit.test.mjs';
  if (!native && !overlap) return source;
  if (!source.includes('NATIVE DEFAULT PORT')) return source;
  const blocks = [
    ...source.matchAll(
      /^\/\/ BEGIN NATIVE DEFAULT PORT ([A-Z_]+)\n([\s\S]*?)^\/\/ END NATIVE DEFAULT PORT \1\n/gm,
    ),
  ];
  const expected = native ? ['IMPORT', ...helpers.map(([tag]) => tag)] : ['WATCH', 'REVIEW'];
  if (
    blocks.length !== expected.length ||
    blocks.some((b, i) => b[1] !== expected[i]) ||
    (source.match(/\/\/ BEGIN NATIVE DEFAULT PORT /gu) ?? []).length !== expected.length
  )
    throw Error('NATIVE_DEFAULT_PORT_REVIEW_REQUIRED');
  for (const block of blocks) {
    let original = '';
    if (native && block[1] !== 'IMPORT') {
      const name = helpers.find(([tag]) => tag === block[1])[1];
      const prefix = `const ${name} = createNativeDefaultFixturePort(\n`;
      const suffix = ",\n  () => required('DATABASE_PAPER_ADMISSION_URL'),\n);\n";
      if (!block[2].startsWith(prefix) || !block[2].endsWith(suffix))
        throw Error('NATIVE_DEFAULT_PORT_REVIEW_REQUIRED');
      const inner = block[2].slice(prefix.length, -suffix.length);
      if (!inner.startsWith(`  async function ${name}(`) || !inner.endsWith('\n  }'))
        throw Error('NATIVE_DEFAULT_PORT_REVIEW_REQUIRED');
      original =
        inner
          .split('\n')
          .map((line) =>
            line.startsWith('  ')
              ? line.slice(2)
              : line === ''
                ? line
                : (() => {
                    throw Error('NATIVE_DEFAULT_PORT_REVIEW_REQUIRED');
                  })(),
          )
          .join('\n') + '\n';
    }
    source = source.replace(block[0], original);
  }
  if (source.includes('NATIVE DEFAULT PORT')) throw Error('NATIVE_DEFAULT_PORT_REVIEW_REQUIRED');
  return source;
}
