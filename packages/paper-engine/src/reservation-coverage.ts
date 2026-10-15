import { z } from 'zod';
import {
  decimalCompare,
  decimalSubtract,
  idSchema,
  immutable,
  instrumentRecordSchema,
  newOrderSchema,
  nonNegativeAmountSchema,
  orderBookSchema,
  parseDecimal,
  timestampSchema,
  tradeTickSchema,
} from '@ctp/exchange-core';
import { paperModelSchema } from './model.js';
import { calculatePaperRiskEnvelope, type PaperRiskEnvelopeCalculation } from './risk-envelope.js';

const input = z.strictObject({
  now: timestampSchema,
  model: paperModelSchema,
  record: instrumentRecordSchema,
  book: orderBookSchema,
  trade: tradeTickSchema,
  order: newOrderSchema,
  balances: z
    .array(z.strictObject({ asset: idSchema, available: nonNegativeAmountSchema }))
    .min(1)
    .max(32),
});

export interface PaperReservationCoverageCalculation {
  readonly kind: 'PAPER_RESERVATION_COVERAGE_CALCULATION';
  readonly version: 'spot-l2-taker-vector-v1';
  readonly computedAt: number;
  readonly validUntil: number;
  readonly envelope: PaperRiskEnvelopeCalculation;
  /** Positive liabilities only. No future proceeds, currency conversion or
   * cross-account pooling can cover an asset's own principal/commission. */
  readonly debits: readonly {
    readonly asset: string;
    readonly amount: string;
    readonly available: string;
    readonly remaining: string;
  }[];
}

/** Pure all-or-nothing arithmetic, never Risk approval or a durable reservation.
 * The future financial gateway must capture each account's actual availability
 * after holds, certify all evidence and persist the complete vector atomically.
 * A caller object, this calculation or its JSON replay proves no authority. */
export function calculatePaperReservationCoverage(
  raw: unknown,
): PaperReservationCoverageCalculation {
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new Error('PAPER_COVERAGE_INPUT');
  const { balances, ...market } = parsed.data;
  if (new Set(balances.map((b) => b.asset)).size !== balances.length)
    throw new Error('PAPER_COVERAGE_INPUT');
  let envelope: PaperRiskEnvelopeCalculation;
  try {
    // Never accept a caller envelope, fee vector or scalar Risk proposal.
    envelope = calculatePaperRiskEnvelope(market);
  } catch {
    throw new Error('PAPER_COVERAGE_EVIDENCE');
  }
  const available = new Map(balances.map((b) => [b.asset, b.available]));
  const debits = envelope.debits
    .filter((d) => d.amount !== '0')
    .map((d) => {
      const balance = available.get(d.asset);
      if (balance === undefined || decimalCompare(balance, parseDecimal(d.amount)) < 0)
        throw new Error('PAPER_COVERAGE_INSUFFICIENT');
      return {
        ...d,
        available: balance,
        remaining: nonNegativeAmountSchema.parse(decimalSubtract(balance, parseDecimal(d.amount))),
      };
    });
  return immutable({
    kind: 'PAPER_RESERVATION_COVERAGE_CALCULATION',
    version: 'spot-l2-taker-vector-v1',
    computedAt: envelope.computedAt,
    validUntil: envelope.validUntil,
    envelope,
    debits,
  });
}
