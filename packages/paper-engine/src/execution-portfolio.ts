import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decimalCompare,
  decimalAdd,
  immutable,
  newOrderSchema,
  nonNegativeAmountSchema,
  parseDecimal,
  sameMarketScope,
  timestampSchema,
} from '@ctp/exchange-core';
import {
  canonical,
  paperFillEventSchema,
  reducePortfolio,
  restorePortfolio,
  stateSchema,
  type PaperFillEvent,
  type PortfolioState,
  type Posting,
} from '@ctp/portfolio';
import {
  calculatePaperExecutionLedger,
  type PaperExecutionLedgerCalculation,
} from './execution-ledger.js';
import { paperFrameSchema } from './model.js';
import { PAPER_COMPETITION_MAX_ORDERS } from './competition.js';

const version = 'spot-l2-taker-portfolio-v1' as const;
const candidate = z.strictObject({
  orderId: z.uuid().transform((v) => v.toLowerCase()),
  admissionSequence: z
    .string()
    .refine((v) => /^[1-9][0-9]{0,18}$/u.test(v) && BigInt(v) < 2n ** 63n),
  order: newOrderSchema,
  submittedAt: timestampSchema,
  executedQuantity: nonNegativeAmountSchema,
  triggeredAt: timestampSchema.nullable(),
});
const inputSchema = z.strictObject({
  competition: z.strictObject({
    now: timestampSchema,
    frame: paperFrameSchema,
    orders: z.array(candidate).min(1).max(PAPER_COMPETITION_MAX_ORDERS),
  }),
  portfolio: stateSchema,
});

export interface PaperExecutionPortfolioFill {
  readonly orderId: string;
  readonly admissionSequence: string;
  readonly fillId: string;
  readonly event: PaperFillEvent;
  readonly postings: readonly Posting[];
}
export interface PaperExecutionPortfolioCalculation {
  readonly kind: 'PAPER_EXECUTION_PORTFOLIO_CALCULATION';
  readonly version: typeof version;
  readonly ledger: PaperExecutionLedgerCalculation;
  readonly before: PortfolioState;
  readonly state: PortfolioState;
  readonly fills: readonly PaperExecutionPortfolioFill[];
}
function fields(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}
function bounded(raw: unknown) {
  const input = fields(raw),
    competition = fields(input?.competition),
    book = fields(fields(competition?.frame)?.book),
    portfolio = fields(input?.portfolio);
  for (const [array, max, min] of [
    [competition?.orders, PAPER_COMPETITION_MAX_ORDERS, 1],
    [book?.asks, 1000, 0],
    [book?.bids, 1000, 0],
    [portfolio?.balances, 1000, 0],
    [portfolio?.positions, 1000, 0],
    [portfolio?.holds, 1000, 0],
    [portfolio?.pending, 2000, 0],
    [portfolio?.differences, 2000, 0],
  ] as const)
    if (!Array.isArray(array) || array.length > max || array.length < min)
      throw new Error('PAPER_EXECUTION_PORTFOLIO_INPUT');
}
function cashBounds(state: PortfolioState) {
  for (const balance of state.balances)
    for (const amount of [balance.total, balance.free, balance.available])
      if (amount !== null && decimalCompare(parseDecimal(amount), parseDecimal('0')) < 0)
        throw new Error('PAPER_EXECUTION_PORTFOLIO_BALANCE');
}
function knownState(state: PortfolioState, now: number) {
  if (
    state.status !== 'RECONCILED' ||
    state.snapshotAt === null ||
    state.snapshotId === null ||
    state.snapshotAt > now ||
    (state.lastEconomicAt !== null && state.lastEconomicAt > now) ||
    state.differences.length ||
    state.positions.some(
      (p) =>
        p.positionSide !== 'NET' ||
        p.bucket !== 'SPOT' ||
        p.basis === null ||
        p.realizedGross === null ||
        p.feesQuote === null,
    )
  )
    throw new Error('PAPER_EXECUTION_PORTFOLIO_STATE');
  const inventory = new Map<string, string>(),
    balances = new Map(state.balances.map((b) => [b.asset, b.total]));
  for (const p of state.positions)
    inventory.set(
      p.base,
      decimalAdd(parseDecimal(inventory.get(p.base) ?? '0'), parseDecimal(p.quantity)),
    );
  for (const [asset, amount] of inventory)
    if (amount !== (balances.get(asset) ?? '0')) throw new Error('PAPER_EXECUTION_PORTFOLIO_STATE');
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Pure single-scenario content/accounting calculation, never a financial writer.
 * The supplied book, candidates and plain correlation hashes authenticate no
 * source, ownership, issuance, complete history, reservation or dispatch permit.
 * A future fixed private writer must reconstruct these inputs from trusted
 * storage and commit permanent replay, shared allocation, postings, Portfolio,
 * order progress and authenticated hold changes together. No callback/IO here.
 */
export function calculatePaperExecutionPortfolio(raw: unknown): PaperExecutionPortfolioCalculation {
  bounded(raw);
  const checked = inputSchema.safeParse(raw);
  if (!checked.success) throw new Error('PAPER_EXECUTION_PORTFOLIO_INPUT');
  const { competition, portfolio } = checked.data,
    { now, frame } = competition,
    before = restorePortfolio(portfolio);
  if (
    before.binding.mode !== 'PAPER' ||
    before.binding.connectionId !== null ||
    before.binding.scope.market !== 'SPOT' ||
    !sameMarketScope(before.binding.scope, frame.record.instrument.scope)
  )
    throw new Error('PAPER_EXECUTION_PORTFOLIO_SCOPE');
  knownState(before, now);
  cashBounds(before);
  const ledger = calculatePaperExecutionLedger(competition);
  const commands = new Map(competition.orders.map((c) => [c.orderId, c.order]));
  const fills: PaperExecutionPortfolioFill[] = [];
  const bindingHash = hash(before.binding);
  let state = before;
  for (let index = 0; index < ledger.execution.executions.length; index++) {
    const execution = ledger.execution.executions[index]!,
      transactions = ledger.orders[index]!;
    const command = commands.get(execution.orderId);
    if (
      !command ||
      transactions.orderId !== execution.orderId ||
      transactions.transactions.length !== execution.fills.length
    )
      throw new Error('PAPER_EXECUTION_PORTFOLIO_DIVERGENCE');
    for (let n = 0; n < execution.fills.length; n++) {
      const fill = execution.fills[n]!,
        transaction = transactions.transactions[n]!;
      const event = paperFillEventSchema.parse({
        type: 'PAPER_FILL',
        id: `paper-fill:${fill.id}`,
        timestamp: now,
        internalOrderId: execution.orderId,
        instrumentId: frame.record.instrument.id,
        metadataVersion: frame.record.instrument.metadataVersion,
        ruleVersion: frame.record.rules.version,
        base: frame.record.instrument.baseAsset,
        quote: frame.record.instrument.quoteAsset,
        positionSide: 'NET',
        bucket: 'SPOT',
        side: command.side,
        quantity: fill.quantity,
        price: fill.price,
        fees:
          fill.quoteFee === '0'
            ? []
            : [
                {
                  asset: frame.record.instrument.quoteAsset,
                  amount: fill.quoteFee,
                  quoteEquivalent: fill.quoteFee,
                },
              ],
        paper: {
          fillId: fill.id,
          modelVersion: frame.model.version,
          scope: frame.record.instrument.scope,
        },
      });
      if (transaction.fillId !== fill.id || transaction.causeIdentity !== event.id)
        throw new Error('PAPER_EXECUTION_PORTFOLIO_DIVERGENCE');
      // Plain hashes correlate a pure calculation only. They are deliberately
      // not returned as trusted evidence, a certificate or a source capability.
      const reduced = reducePortfolio(state, event, {
        now: () => now,
        paperExecutionEvidence: { eventId: event.id, fingerprint: hash(event), bindingHash },
      });
      if (
        reduced.ignored ||
        reduced.holdWatermark !== undefined ||
        canonical(reduced.postings) !== canonical(transaction.postings)
      )
        throw new Error('PAPER_EXECUTION_PORTFOLIO_DIVERGENCE');
      cashBounds(reduced.state);
      knownState(reduced.state, now);
      state = reduced.state;
      fills.push({
        orderId: execution.orderId,
        admissionSequence: transactions.admissionSequence,
        fillId: fill.id,
        event,
        postings: transaction.postings,
      });
    }
  }
  return immutable({
    kind: 'PAPER_EXECUTION_PORTFOLIO_CALCULATION',
    version,
    ledger,
    before,
    state,
    fills,
  });
}
