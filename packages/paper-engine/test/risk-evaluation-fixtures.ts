import { createHash } from 'node:crypto';
import { parseDecimal } from '@ctp/exchange-core';
import { tenantRiskContextFixture } from './tenant-risk-context-fixtures.js';

/** Test-only previous-day cash funding, fresh original market/runtime facts. */
export function riskEvaluationFixture(count = 2, now = 86400000 + 200000) {
  const f = tenantRiskContextFixture(count);
  f.wire.asOf = f.context.asOf = f.order.asOf = f.runtime.asOf = f.loss.inventory.asOf = now;
  f.loss.inventory.books.forEach((b) => {
    b.asOf = now;
  });
  f.runtime.publication.publishedAt = now;
  Object.values(f.publication.observation.health).forEach((v) => {
    v.asOf = now;
  });
  const pack = (value: { id: string }) => {
    const publicationText = JSON.stringify(value);
    return {
      id: value.id,
      revision: '1',
      publicationText,
      hash: createHash('sha256').update(publicationText).digest('hex'),
    };
  };
  const seal = () => {
    f.seal();
    f.order.snapshot = pack(f.f.s);
    f.order.trade = pack(f.f.p);
  };
  for (const p of [f.f.s, f.f.p]) {
    p.timestamp = now;
    p.record.rules = { ...p.record.rules, effectiveAt: now - 1000, expiresAt: now + 60000 };
  }
  for (const v of [f.f.s.book, f.f.s.ticker, f.f.p.trade]) {
    v.receivedAt = v.exchangeTime = now;
  }
  f.f.s.book.bids = [{ price: parseDecimal('9.95'), quantity: parseDecimal('100') }];
  f.f.s.book.asks = [{ price: parseDecimal('10.05'), quantity: parseDecimal('100') }];
  f.f.p.trade.quantity = parseDecimal('100');
  seal();
  return { ...f, seal, now, input: { now, request: f.request, capture: f.wire } };
}
