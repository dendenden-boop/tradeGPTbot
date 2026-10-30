// Test-only reconstruction of every accepted69-case statement and overlap probe.
export function beforeAdmissionFixturePort(file, source) {
  const expected =
    file === 'packages/database/test/paper-admission.integration.test.ts'
      ? ['IMPORT', 'OPEN']
      : file === 'scripts/admission-overlap.unit.test.mjs'
        ? ['WATCH', 'REVIEW']
        : [];
  if (!expected.length) return source;
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN ADMISSION FIXTURE PORT ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END ADMISSION FIXTURE PORT \1\n/gm,
    ),
  ];
  if (!blocks.length && !source.includes('// BEGIN ADMISSION FIXTURE PORT ')) return source;
  if (
    blocks.length !== 2 ||
    blocks.some((b, i) => b[1] !== expected[i]) ||
    (source.match(/\/\/ BEGIN ADMISSION FIXTURE PORT /gu) ?? []).length !== 2
  )
    throw Error('ADMISSION_FIXTURE_PORT_BLOCKS');
  const original = `async function openAdmission() {
  const port = await createPostgresPaperOrderRiskPort({
    connectionString: required('DATABASE_PAPER_ADMISSION_URL'),
    environment: 'test',
  });
  handles.push(port);
  return port;
}
`;
  for (const b of blocks) source = source.replace(b[0], b[1] === 'OPEN' ? original : '');
  return source;
}
