// Test-only reconstruction of the complete pre-fix native fixture at 61e5af6a74884f35652012c7d92cc2f6f5035fcb.
// Pin every reviewed block, then run all earlier assertion/payload/read probes unchanged.
import { createHash } from 'node:crypto';
import { beforeTenantMarketLifetime } from './tenant-market-lifetime-legacy.mjs';
const path = 'packages/database/test/paper-risk-authority.integration.test.ts';
const expected = [
  ['IMPORT', '694a848525e1ad4e081c7a939629a78566c5e0be6a851dd7ab08e0a28ef56ab5', ''],
  [
    'ORDERS',
    '69c9cacf46ccbf08ab8369bcbbfbf2379caedc65fd8f61b9f54aede63dbb5aa3',
    "async function openOrders() {\n  const h = await createPostgresOrderStore({\n    connectionString: required('DATABASE_EXECUTION_URL'),\n    environment: 'test',\n  });\n  handles.push(h);\n  return h;\n}\n",
  ],
  [
    'PREPARED',
    '99d25a8681aea6824d28c516a27e5282fc47ede9085139120304ef40ceb67c7c',
    "async function prepared({\n  draft = true,\n  fund = true,\n  region,\n}: { draft?: boolean; fund?: boolean; region?: string } = {}) {\n  const f = await fixture(region ? { region } : {});\n  const fundingId = randomUUID();\n  if (fund) {\n    const funding = await fundingPort();\n    await funding.initialize(\n      paperFundingSchema.parse({\n        id: fundingId,\n        owner: f.c.owner,\n        configurationId: f.c.id,\n        balances: [\n          { asset: 'BTC', amount: '0.000000000000000001' },\n          { asset: 'USDT', amount: '9007199254740993' },\n        ],\n      }),\n      io(),\n    );\n  }\n  const orders = await openOrders();\n  const order = draft ? await orders.create(f.binding, f.draft, io()) : null;\n  return { ...f, fundingId, orders, order };\n}\n",
  ],
  [
    'READY',
    '5df133ea7b10bf755efae44e47f4dbae3cc3c5f8058a7985d66483efe439ef79',
    'async function ready(withPolicies = true) {\n  const f = await prepared();\n  await (await openBook()).initialize(f.c.owner, io());\n  const [snapshots, trades] = await marketPorts();\n  if (withPolicies) await ensurePolicies(f.c.owner.tenantId);\n  const now = Date.now();\n  f.f.s.timestamp = f.f.p.timestamp = now;\n  for (const v of [f.f.s.ticker, f.f.s.book, f.f.p.trade]) v.receivedAt = v.exchangeTime = now;\n  await snapshots.publish(f.f.s, io());\n  await trades.publish(f.f.p, io());\n  const request = { owner: f.c.owner, intentId: f.order!.intentId };\n  return { ...f, snapshots, trades, request };\n}\n',
  ],
];
export function beforeAuthoritySetup(file, source) {
  source = beforeTenantMarketLifetime(file, source);
  if (file !== path || !source.includes('AUTHORITY FIXTURE SETUP')) return source;
  const blocks = [
    ...source.matchAll(
      /^\/\/ BEGIN AUTHORITY FIXTURE SETUP ([A-Z_]+)\n[\s\S]*?^\/\/ END AUTHORITY FIXTURE SETUP \1\n/gm,
    ),
  ];
  if (
    blocks.length !== expected.length ||
    (source.match(/AUTHORITY FIXTURE SETUP/gu) ?? []).length !== expected.length * 2
  )
    throw Error('AUTHORITY_SETUP_REVIEW_REQUIRED');
  for (const [index, block] of blocks.entries()) {
    const [tag, hash, original] = expected[index];
    if (block[1] !== tag || createHash('sha256').update(block[0]).digest('hex') !== hash)
      throw Error('AUTHORITY_SETUP_REVIEW_REQUIRED');
    source = source.replace(block[0], original);
  }
  if (source.includes('AUTHORITY FIXTURE SETUP')) throw Error('AUTHORITY_SETUP_REVIEW_REQUIRED');
  return source;
}
