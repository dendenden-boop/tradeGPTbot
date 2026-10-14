import { stateSchema } from '@ctp/portfolio';
import { parseDecimal } from '@ctp/exchange-core';
import { paperFundingReceiptSchema } from '../src/funding-domain.js';
import { paperConfigurationReceiptSchema } from '../src/configuration-domain.js';
import { receiptWire } from './initial-portfolio-fixtures.js';
import { riskPortfolioFixture } from './risk-portfolio-fixtures.js';

/** Pure content fixture, never a source-authority or historical DB substitute. */
export function cashLossFixture(
  times = [1001],
  asOf = 86401000,
  amount = '1000',
  quotes: readonly string[] = [],
) {
  const inventory = riskPortfolioFixture(times.length);
  const fundingTimes: { accountId: string; ledgerId: string; effectiveAt: number }[] = [];
  inventory.asOf = asOf;
  inventory.books.forEach((book, index) => {
    const origin = JSON.parse(book.origin.receiptText) as {
      configuration: { receiptText: string; hash: string };
      funding: { receiptText: string; hash: string };
      stateText: string;
    };
    const funding = paperFundingReceiptSchema.parse(JSON.parse(origin.funding.receiptText));
    const configuration = paperConfigurationReceiptSchema.parse(
      JSON.parse(origin.configuration.receiptText),
    );
    const at = times[index]!;
    configuration.createdAt = Math.min(1000, at);
    configuration.configuration.valuationAsset =
      quotes[index] ?? configuration.configuration.valuationAsset;
    const cw = receiptWire(configuration);
    funding.createdAt = at;
    funding.configurationHash = cw.hash;
    funding.funding.balances = [
      { asset: configuration.configuration.valuationAsset, amount: parseDecimal(amount) },
    ];
    const state = stateSchema.parse(JSON.parse(origin.stateText));
    state.snapshotAt = Math.max(2000, at);
    state.balances = funding.funding.balances.map((b) => ({
      asset: b.asset,
      total: b.amount,
      free: b.amount,
      available: b.amount,
      locked: '0',
    }));
    const sw = receiptWire(state);
    book.asOf = asOf;
    book.drafts = [];
    book.accountState.clientIdHighWatermark = '0';
    book.origin = receiptWire({
      kind: 'INITIAL_BOOK',
      bookId: funding.funding.id,
      revision: '1',
      createdAt: state.snapshotAt,
      configuration: cw,
      funding: receiptWire(funding),
      stateText: sw.receiptText,
      stateHash: sw.hash,
    });
    fundingTimes.push({
      accountId: inventory.accountIds[index]!,
      ledgerId: funding.ledgerTransactionId,
      effectiveAt: at,
    });
  });
  return {
    kind: 'PAPER_RISK_LOSS_CAPTURE',
    inventory,
    fundingTimes,
  };
}
