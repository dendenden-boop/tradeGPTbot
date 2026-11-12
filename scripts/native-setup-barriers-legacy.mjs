// Reconstruct the complete accepted native fixture before independent setup.
// The exact reviewed block hash rejects changes hidden inside the marker range.
import { createHash } from 'node:crypto';
import { beforeAdmissionFundingLane } from './admission-funding-lane-legacy.mjs';
import { beforeExecutionStart } from './execution-start-legacy.mjs';
const original = `async function tenantReady(liquid = false) {
  const f = await fixture(),
    fundingId = await fundCash(f.c),
    orders = await openOrders(),
    order = await orders.create(
      f.binding,
      liquid
        ? draftSchema.parse({
            ...f.draft,
            order: { ...f.draft.order, type: 'LIMIT', limitPrice: '10.5', timeInForce: 'GTC' },
          })
        : f.draft,
      io(),
    );
  await (await openBook()).initialize(f.c.owner, io());
  // BEGIN PUBLIC MARKET FIXTURE USE
  const snapshots = await publicMarketFixturePorts.snapshots(),
    trades = await publicMarketFixturePorts.trades();
  // END PUBLIC MARKET FIXTURE USE
  await ensurePolicies(f.c.owner.tenantId);
  const now = Date.now();
  f.f.s.timestamp = f.f.p.timestamp = now;
  for (const v of [f.f.s.ticker, f.f.s.book, f.f.p.trade]) v.receivedAt = v.exchangeTime = now;
  if (liquid) {
    f.f.s.book.bids = f.f.s.book.bids.map((v) => ({ ...v, quantity: parseDecimal('100') }));
    f.f.s.book.asks = f.f.s.book.asks.map((v) => ({ ...v, quantity: parseDecimal('100') }));
    f.f.p.trade.quantity = parseDecimal('100');
  }
  await snapshots.publish(f.f.s, io());
  await trades.publish(f.f.p, io());
  return {
    ...f,
    fundingId,
    orders,
    order,
    snapshots,
    trades,
    request: { owner: f.c.owner, intentId: order.intentId },
  };
}
`;
export function beforeNativeSetupBarriers(file, source) {
  try {
    source = beforeAdmissionFundingLane(file, source);
  } catch {
    throw Error('NATIVE_SETUP_REVIEW_REQUIRED');
  }
  source = beforeExecutionStart(file, source);
  if (
    file !== 'packages/database/test/paper-admission.integration.test.ts' ||
    !source.includes('NATIVE SETUP BARRIERS')
  )
    return source;
  const blocks = source.match(
    /^\/\/ BEGIN NATIVE SETUP BARRIERS\n[\s\S]*?^\/\/ END NATIVE SETUP BARRIERS\n/gm,
  );
  if (
    blocks?.length !== 1 ||
    (source.match(/NATIVE SETUP BARRIERS/gu) ?? []).length !== 2 ||
    createHash('sha256').update(blocks[0]).digest('hex') !==
      'd04882d809f229152c5b99f30d09ea622a47e5155ad4d5d7176fe49eb897dad0'
  )
    throw Error('NATIVE_SETUP_REVIEW_REQUIRED');
  return source.replace(blocks[0], original);
}
