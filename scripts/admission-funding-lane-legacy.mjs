// Test-only exact predecessor reconstruction; no native operation or assertion is omitted.
import { createHash } from 'node:crypto';
import { beforeRiskSeedSetup } from './risk-seed-setup-legacy.mjs';
const original =
  "// BEGIN NATIVE SETUP BARRIERS\nasync function tenantReady(liquid = false) {\n  const f = await fixture(),\n    fundingId = await fundCash(f.c);\n  const [{ orders, order }, { snapshots, trades }] = await runIndependentFixtureSetup([\n    async () => {\n      const orders = await openOrders();\n      const order = await orders.create(\n        f.binding,\n        liquid\n          ? draftSchema.parse({\n              ...f.draft,\n              order: { ...f.draft.order, type: 'LIMIT', limitPrice: '10.5', timeInForce: 'GTC' },\n            })\n          : f.draft,\n        io(),\n      );\n      return { orders, order };\n    },\n    async () => {\n      // BEGIN PUBLIC MARKET FIXTURE USE\n      const snapshots = await publicMarketFixturePorts.snapshots(),\n        trades = await publicMarketFixturePorts.trades();\n      // END PUBLIC MARKET FIXTURE USE\n      const now = Date.now();\n      f.f.s.timestamp = f.f.p.timestamp = now;\n      for (const v of [f.f.s.ticker, f.f.s.book, f.f.p.trade]) v.receivedAt = v.exchangeTime = now;\n      if (liquid) {\n        f.f.s.book.bids = f.f.s.book.bids.map((v) => ({ ...v, quantity: parseDecimal('100') }));\n        f.f.s.book.asks = f.f.s.book.asks.map((v) => ({ ...v, quantity: parseDecimal('100') }));\n        f.f.p.trade.quantity = parseDecimal('100');\n      }\n      await snapshots.publish(f.f.s, io());\n      await trades.publish(f.f.p, io());\n      return { snapshots, trades };\n    },\n    () => ensurePolicies(f.c.owner.tenantId),\n  ]);\n  // Both funding and the complete genuine DRAFT must precede bootstrap. Never\n  // race book_activity against draft creation or return after a partial setup.\n  await (await openBook()).initialize(f.c.owner, io());\n  return {\n    ...f,\n    fundingId,\n    orders,\n    order,\n    snapshots,\n    trades,\n    request: { owner: f.c.owner, intentId: order.intentId },\n  };\n}\n// END NATIVE SETUP BARRIERS\n";
export function beforeAdmissionFundingLane(file, source) {
  source = beforeRiskSeedSetup(file, source);
  if (file === 'scripts/database-cohorts.mjs') {
    const current =
      "[admission, '9e27194b1d8bf053090f6621098a663d03aa06c55b074133d15618a3ea566c87']";
    const previous =
      "[admission, 'c9fe097d55c5e8d2e61d0311a99b5d44595a53e01f8ec1b17c364bd1030ed374']";
    if (!source.includes(current)) return source;
    if (source.split(current).length !== 2) throw Error('ADMISSION_FUNDING_REVIEW_REQUIRED');
    return source.replace(current, previous);
  }
  if (
    file !== 'packages/database/test/paper-admission.integration.test.ts' ||
    !source.includes('ADMISSION FUNDING LANE')
  )
    return source;
  const blocks = source.match(
    /^\/\/ BEGIN ADMISSION FUNDING LANE\n[\s\S]*?^\/\/ END ADMISSION FUNDING LANE\n/gm,
  );
  if (
    blocks?.length !== 1 ||
    (source.match(/ADMISSION FUNDING LANE/gu) ?? []).length !== 2 ||
    createHash('sha256').update(blocks[0]).digest('hex') !==
      '83e5a0c8f6ead10cf86d083e8983707fd56de5e4d5c932d1d63b89b397fb26d5'
  )
    throw Error('ADMISSION_FUNDING_REVIEW_REQUIRED');
  return source.replace(blocks[0], original);
}
