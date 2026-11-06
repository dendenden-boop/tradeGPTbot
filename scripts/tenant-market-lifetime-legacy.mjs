const file = 'packages/database/test/paper-risk-authority.integration.test.ts';
const replacement = `  // BEGIN TENANT MARKET PRODUCER LIFETIME
  const [snapshots, trades] = await marketPorts();
  // END TENANT MARKET PRODUCER LIFETIME
`;
const previous = `  const snapshots = await createPostgresMarketSnapshots({
      connectionString: required('DATABASE_MARKET_SNAPSHOT_URL'),
      environment: 'test',
    }),
    trades = await createPostgresMarketTrades({
      connectionString: required('DATABASE_MARKET_TRADE_URL'),
      environment: 'test',
    });
  handles.push(snapshots, trades);
`;
export function beforeTenantMarketLifetime(path, source) {
  if (path !== file || !source.includes('TENANT MARKET PRODUCER LIFETIME')) return source;
  if (
    source.split(replacement).length !== 2 ||
    (source.match(/TENANT MARKET PRODUCER LIFETIME/g) ?? []).length !== 2
  )
    throw Error('TENANT_MARKET_LIFETIME_REVIEW_REQUIRED');
  return source.replace(replacement, previous);
}
