// Test-only reconstruction: preserve the complete accepted native fixture.
export function beforeOrderFixturePort(file, source) {
  if (file === 'scripts/admission-overlap.unit.test.mjs') {
    const blocks = [
      ...source.matchAll(
        /^[ \t]*\/\/ BEGIN ORDER FIXTURE PORT ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END ORDER FIXTURE PORT \1\n/gm,
      ),
    ];
    if (!blocks.length && !source.includes('// BEGIN ORDER FIXTURE PORT ')) return source;
    if (
      blocks.length !== 2 ||
      blocks[0][1] !== 'WATCH' ||
      blocks[1][1] !== 'REVIEW' ||
      (source.match(/\/\/ BEGIN ORDER FIXTURE PORT /gu) ?? []).length !== 2
    )
      throw Error('ORDER_FIXTURE_PORT_BLOCKS');
    for (const b of blocks) source = source.replace(b[0], '');
    return source;
  }
  if (file !== 'packages/database/test/paper-admission.integration.test.ts') return source;
  const blocks = [
    ...source.matchAll(
      /^\/\/ BEGIN ORDER FIXTURE PORT ([A-Z_]+)\n[\s\S]*?^\/\/ END ORDER FIXTURE PORT \1\n/gm,
    ),
  ];
  if (!blocks.length && !source.includes('// BEGIN ORDER FIXTURE PORT ')) return source;
  if (
    blocks.length !== 2 ||
    blocks[0][1] !== 'IMPORT' ||
    blocks[1][1] !== 'OPEN' ||
    (source.match(/\/\/ BEGIN ORDER FIXTURE PORT /gu) ?? []).length !== 2
  )
    throw Error('ORDER_FIXTURE_PORT_BLOCKS');
  return source.replace(blocks[0][0], '').replace(
    blocks[1][0],
    `async function openOrders() {
  const h = await createPostgresOrderStore({
    connectionString: required('DATABASE_EXECUTION_URL'),
    environment: 'test',
  });
  handles.push(h);
  return h;
}
`,
  );
}
