import { wireNow } from './admission-wire-fixtures.js';
import { startedRiskFixture } from './started-risk-fixtures.js';

// Wire fixtures only. Source/Risk content is authenticated only by fixed SQL.
export function startedPreviewFixture(count = 1, eligible = true) {
  const f = startedRiskFixture(count);
  const now = eligible ? wireNow + 100 : wireNow + 1;
  if (eligible) {
    const capture = f.packet.started.capture;
    capture.asOf = now;
    for (const market of [capture.market, f.packet.risk.market]) {
      market.book.receivedAt = market.book.exchangeTime = now;
      market.trade.receivedAt = market.trade.exchangeTime = now;
      market.snapshotAt = market.tradeAt = now;
    }
    capture.validUntil = Math.min(
      now + capture.maxEvidenceAgeMs + 1,
      capture.market.record.rules.expiresAt,
    );
    f.packet.started.asOf = f.packet.started.context.asOf = now;
    f.packet.risk.asOf = f.packet.risk.runtime.asOf = f.packet.asOf = now;
    f.packet.started.validUntil = Math.min(
      capture.validUntil,
      ...capture.candidates.map((c) => c.original.expiresAt),
    );
  }
  return { ...f, now };
}
