import { restorePortfolio } from '@ctp/portfolio';
import { preparePaperFrame } from '../src/model.js';
import { admissionWire, wireNow } from './admission-wire-fixtures.js';
import { executionStartFixture } from './execution-start-fixtures.js';
import { preparedSourceFixture } from './prepared-execution-source-fixtures.js';

// Calculation content only: no SQL provenance, current Risk or durable allocation.
export function startedExecutionFixture(evidenceAt = wireNow + 100) {
  const source = preparedSourceFixture().packet;
  return {
    now: evidenceAt,
    attempt: { ...structuredClone(executionStartFixture().started) },
    frame: structuredClone(
      preparePaperFrame({
        now: evidenceAt,
        model: source.model,
        record: source.market.record,
        book: { ...source.market.book, receivedAt: evidenceAt, exchangeTime: evidenceAt },
        trade: { ...source.market.trade, receivedAt: evidenceAt, exchangeTime: evidenceAt },
      }),
    ),
    portfolio: structuredClone(
      restorePortfolio(JSON.parse(admissionWire().packet.portfolio.afterText)),
    ),
  };
}
