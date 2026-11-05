// Strict test-only reconstruction before reviewed producer constructor ownership.
import { createHash } from 'node:crypto';
const pins = {
  'packages/database/test/paper-risk-portfolio.integration.test.ts': [
    ['IMPORT', '3a26c4bca75849378138759dce07a4d14b94a4c18676980c887b8ad421342a5f', ''],
    [
      'ORDERS',
      '38a13fe66bae558b9c09e92cc5f0e7fda9b1253b5d8f436410de4369ca84e8dc',
      "async function openOrders() {\n  const h = await createPostgresOrderStore({\n    connectionString: required('DATABASE_EXECUTION_URL'),\n    environment: 'test',\n  });\n  handles.push(h);\n  return h;\n}\n",
    ],
  ],
  'packages/database/test/paper-book-source.integration.test.ts': [
    ['IMPORT', '3a26c4bca75849378138759dce07a4d14b94a4c18676980c887b8ad421342a5f', ''],
    ['OWNERS', 'cf7764f958a88c66bcc89d963e7c83b0a4b53e708ddb1dc465e10d43fe4fd2e8', ''],
    [
      'ORDERS',
      'a110637c5fd80f49498c474c7df9985ff8d74d23be651d4e1c1343133e60b9ce',
      "async function openOrders() {\n  const h = await createPostgresOrderStore({\n    connectionString: required('DATABASE_EXECUTION_URL'),\n    environment: 'test',\n  });\n  handles.push(h);\n  return h;\n}\n",
    ],
    [
      'CONFIGURATION',
      '3d52a30524231c90f10a16236f56c99ba71ea31cbd08484e52a2884abb284d2e',
      "  const config = await createPostgresPaperConfiguration({\n    connectionString: required('DATABASE_PAPER_CONFIGURATION_URL'),\n    environment: 'test',\n  });\n  try {\n    if (configure) await config.register(c, io());\n  } finally {\n    await config.close();\n  }\n",
    ],
    [
      'FUNDING',
      '036f71714f51242c874b3fc3ef49b1b2ab065b60263479121c9895b2b5771cd6',
      "    const funding = await createPostgresPaperFunding({\n      connectionString: required('DATABASE_PAPER_FUNDING_URL'),\n      environment: 'test',\n    });\n    try {\n      await funding.initialize(\n        paperFundingSchema.parse({\n          id: fundingId,\n          owner: f.c.owner,\n          configurationId: f.c.id,\n          balances: [\n            { asset: 'BTC', amount: '0.000000000000000001' },\n            { asset: 'USDT', amount: '9007199254740993' },\n          ],\n        }),\n        io(),\n      );\n    } finally {\n      await funding.close();\n    }\n",
    ],
    [
      'BOOK',
      '0d48d2effd3ba58512f48b478b3568a3960218eab877c2432113483d0f31241c',
      "async function openBook(connectionString = required('DATABASE_PAPER_BOOK_URL')) {\n  const h = await createPostgresPaperPortfolioBootstrap({ connectionString, environment: 'test' });\n  handles.push(h);\n  return h;\n}\n",
    ],
  ],
};
export function beforeNativeProducerLifetime(file, source) {
  const expected = pins[file];
  if (!expected || !source.includes('NATIVE PRODUCER LIFETIME')) return source;
  const blocks = [
    ...source.matchAll(
      /^[ \t]*\/\/ BEGIN NATIVE PRODUCER LIFETIME ([A-Z_]+)\n[\s\S]*?^[ \t]*\/\/ END NATIVE PRODUCER LIFETIME \1\n/gm,
    ),
  ];
  if (
    blocks.length !== expected.length ||
    (source.match(/NATIVE PRODUCER LIFETIME/gu) ?? []).length !== expected.length * 2
  )
    throw Error('NATIVE_PRODUCER_LIFETIME_REVIEW_REQUIRED');
  for (const [index, block] of blocks.entries()) {
    const [tag, hash, old] = expected[index];
    if (block[1] !== tag || createHash('sha256').update(block[0]).digest('hex') !== hash)
      throw Error('NATIVE_PRODUCER_LIFETIME_REVIEW_REQUIRED');
    source = source.replace(block[0], old);
  }
  if (source.includes('NATIVE PRODUCER LIFETIME'))
    throw Error('NATIVE_PRODUCER_LIFETIME_REVIEW_REQUIRED');
  return source;
}
