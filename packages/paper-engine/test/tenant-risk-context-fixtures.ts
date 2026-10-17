import { stateSchema } from '@ctp/portfolio';
import { paperFundingReceiptSchema } from '../src/funding-domain.js';
import { paperConfigurationReceiptSchema } from '../src/configuration-domain.js';
import { receiptWire } from './initial-portfolio-fixtures.js';
import { riskContextFixture } from './risk-context-fixtures.js';
import { riskBook, uuid } from './risk-portfolio-fixtures.js';

/** Test-only sealed content. It does not simulate SQL completeness/authority. */
export function tenantRiskContextFixture(count = 2) {
  const f = riskContextFixture(),
    context = f.wire,
    books = [f.order.book, ...Array.from({ length: count - 1 }, (_, i) => riskBook(uuid(i + 2)))],
    fundingTimes: { accountId: string; ledgerId: string; effectiveAt: number }[] = [];
  for (const book of books) {
    const origin = JSON.parse(book.origin.receiptText) as {
      configuration: { receiptText: string; hash: string };
      funding: { receiptText: string; hash: string };
      stateText: string;
    };
    const cfg = paperConfigurationReceiptSchema.parse(JSON.parse(origin.configuration.receiptText)),
      funding = paperFundingReceiptSchema.parse(JSON.parse(origin.funding.receiptText)),
      state = stateSchema.parse(JSON.parse(origin.stateText));
    funding.funding.balances = funding.funding.balances.filter(
      (b) => b.asset === cfg.configuration.valuationAsset,
    );
    state.balances = state.balances.filter((b) => b.asset === cfg.configuration.valuationAsset);
    const sw = receiptWire(state);
    book.origin = receiptWire({
      ...origin,
      funding: receiptWire(funding),
      stateText: sw.receiptText,
      stateHash: sw.hash,
    });
    fundingTimes.push({
      accountId: cfg.configuration.owner.accountId,
      ledgerId: funding.ledgerTransactionId,
      effectiveAt: funding.createdAt,
    });
  }
  const loss = {
    kind: 'PAPER_RISK_LOSS_CAPTURE',
    inventory: {
      kind: 'PAPER_RISK_PORTFOLIO_SOURCE',
      owner: f.request.owner,
      asOf: 200000,
      accountIds: fundingTimes.map((t) => t.accountId),
      books,
    },
    fundingTimes,
  };
  return {
    ...f,
    context,
    loss,
    wire: { kind: 'PAPER_TENANT_RISK_CONTEXT_CAPTURE', asOf: 200000, context, loss },
  };
}
