import { decimalAdd, decimalSubtract, immutable, parseDecimal } from '@ctp/exchange-core';
import type { Posting } from '@ctp/portfolio';
import { calculatePaperCompetition, type PaperCompetitionCalculation } from './competition.js';

const version = 'spot-l2-taker-ledger-v1' as const;
const zero = parseDecimal('0');
const negate = (amount: string) => decimalSubtract(zero, parseDecimal(amount));

export interface PaperExecutionLedgerTransaction {
  readonly fillId: string;
  /** Deterministic calculation identity, not a committed ledger transaction. */
  readonly causeIdentity: string;
  readonly postings: readonly Posting[];
}
export interface PaperExecutionLedgerOrder {
  readonly orderId: string;
  readonly admissionSequence: string;
  readonly transactions: readonly PaperExecutionLedgerTransaction[];
  readonly availableDeltas: readonly { readonly asset: string; readonly amount: string }[];
}
export interface PaperExecutionLedgerCalculation {
  readonly kind: 'PAPER_EXECUTION_LEDGER_CALCULATION';
  readonly version: typeof version;
  readonly execution: PaperCompetitionCalculation;
  readonly orders: readonly PaperExecutionLedgerOrder[];
}

/** Pure bounded calculation over the existing complete competition input.
 * Recomputes fills; caller-supplied fills/postings are never accepted.
 *
 * No source, ownership, funds, reservation or durable liquidity is authenticated
 * here. The future fixed writer must commit current authorization, one-use
 * dispatch, permanent fill replay, shared consumption, balanced postings and
 * order/Portfolio/hold progress together. Neither these identities nor JSON
 * replay authorize a mutation or prove that a transaction committed.
 */
export function calculatePaperExecutionLedger(raw: unknown): PaperExecutionLedgerCalculation {
  const execution = calculatePaperCompetition(raw);
  const { baseAsset, quoteAsset } = execution.frame.record.instrument;
  const orders: PaperExecutionLedgerOrder[] = [];
  for (const order of execution.executions) {
    const totals = new Map<string, string>();
    const transactions: PaperExecutionLedgerTransaction[] = [];
    for (const fill of order.fills) {
      const postings: Posting[] = [];
      const cash = (asset: string, amount: string, counter: 'EXTERNAL' | 'FEE' = 'EXTERNAL') => {
        if (amount === '0') return;
        postings.push(
          { asset, bucket: 'AVAILABLE', amount },
          { asset, bucket: counter, amount: negate(amount) },
        );
        totals.set(asset, decimalAdd(parseDecimal(totals.get(asset) ?? '0'), parseDecimal(amount)));
      };
      cash(baseAsset, fill.baseDelta);
      // quoteDelta already includes the fee. Restore signed principal before
      // posting the fee separately, exactly as the existing Portfolio reducer.
      cash(quoteAsset, decimalAdd(parseDecimal(fill.quoteDelta), parseDecimal(fill.quoteFee)));
      cash(quoteAsset, negate(fill.quoteFee), 'FEE');
      transactions.push({
        fillId: fill.id,
        // Accounting implementation changes must not mint a second cause for
        // the same original fill. A future writer must compare all semantics.
        causeIdentity: `paper-fill:${fill.id}`,
        postings,
      });
    }
    orders.push({
      orderId: order.orderId,
      admissionSequence: order.admissionSequence,
      transactions,
      availableDeltas: [...totals]
        .filter(([, amount]) => amount !== '0')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([asset, amount]) => ({ asset, amount })),
    });
  }
  return immutable({ kind: 'PAPER_EXECUTION_LEDGER_CALCULATION', version, execution, orders });
}
