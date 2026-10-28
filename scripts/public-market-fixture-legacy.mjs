// Test-only reconstruction: retain the complete published59 fixture byte for byte.
export const priorPublicWriterConstruction =
  "  const snapshots = await createPostgresMarketSnapshots({\n      connectionString: required('DATABASE_MARKET_SNAPSHOT_URL'),\n      environment: 'test',\n    }),\n    trades = await createPostgresMarketTrades({\n      connectionString: required('DATABASE_MARKET_TRADE_URL'),\n      environment: 'test',\n    });\n  handles.push(snapshots, trades);\n";
export function beforePublicMarketWriters(file, source) {
  if (file !== 'packages/database/test/paper-admission.integration.test.ts') return source;
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN PUBLIC MARKET FIXTURE ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END PUBLIC MARKET FIXTURE \1\n/gm,
    ),
  ];
  if (blocks.length === 0) return source;
  const names = blocks.map((b) => b[1]).sort();
  if (JSON.stringify(names) !== JSON.stringify(['CACHE', 'IMPORT', 'USE']))
    throw Error('PUBLIC_MARKET_FIXTURE_BLOCKS');
  for (const block of blocks)
    source = source.replace(block[0], block[1] === 'USE' ? priorPublicWriterConstruction : '');
  return source;
}
