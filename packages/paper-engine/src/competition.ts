import { z } from 'zod';
import {
  immutable,
  newOrderSchema,
  nonNegativeAmountSchema,
  timestampSchema,
} from '@ctp/exchange-core';
import { evaluatePaperOrder, paperFrameSchema } from './model.js';
import type { PaperExecutionCalculation, PaperFrame } from './model.js';

export const PAPER_COMPETITION_MAX_ORDERS = 300;
const admissionSequence = z
  .string()
  .refine((value) => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) < 2n ** 63n);
const candidateSchema = z.strictObject({
  admissionSequence,
  orderId: z.uuid().transform((value) => value.toLowerCase()),
  order: newOrderSchema,
  submittedAt: timestampSchema,
  executedQuantity: nonNegativeAmountSchema,
  triggeredAt: timestampSchema.nullable(),
});
const inputSchema = z.strictObject({
  now: timestampSchema,
  frame: paperFrameSchema,
  orders: z.array(candidateSchema).min(1).max(PAPER_COMPETITION_MAX_ORDERS),
});
export type PaperCompetitionCandidate = z.infer<typeof candidateSchema>;
export interface PaperCompetitionExecution extends Omit<PaperExecutionCalculation, 'frame'> {
  readonly orderId: string;
  readonly admissionSequence: string;
}
export interface PaperCompetitionCalculation {
  readonly version: 'spot-l2-admission-fifo-v1';
  readonly executions: readonly PaperCompetitionExecution[];
  readonly frame: PaperFrame;
}
function fields(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Pure bounded calculation, never durable allocation, Risk authorization or
 * dispatch. The future server worker must certify these inputs and atomically
 * persist native identity, priority, allocation and financial effects. */
export function calculatePaperCompetition(raw: unknown): PaperCompetitionCalculation {
  const input = fields(raw),
    book = fields(fields(input?.frame)?.book);
  // Bound collections before Zod walks individual contenders/depth elements.
  if (
    !Array.isArray(input?.orders) ||
    input.orders.length < 1 ||
    input.orders.length > PAPER_COMPETITION_MAX_ORDERS ||
    !Array.isArray(book?.asks) ||
    book.asks.length > 1000 ||
    !Array.isArray(book?.bids) ||
    book.bids.length > 1000
  )
    throw new Error('PAPER_COMPETITION_INPUT');
  const checked = inputSchema.safeParse(raw);
  if (!checked.success) throw new Error('PAPER_COMPETITION_INPUT');
  const { now, orders } = checked.data;
  const ids = new Set<string>(),
    sequences = new Set<string>(),
    clientIds = new Set<string>();
  for (const order of orders) {
    if (
      ids.has(order.orderId) ||
      sequences.has(order.admissionSequence) ||
      clientIds.has(order.order.clientOrderId)
    )
      throw new Error('PAPER_COMPETITION_IDENTITY');
    ids.add(order.orderId);
    sequences.add(order.admissionSequence);
    clientIds.add(order.order.clientOrderId);
  }
  orders.sort((a, b) => (BigInt(a.admissionSequence) < BigInt(b.admissionSequence) ? -1 : 1));
  let frame = checked.data.frame;
  const executions: PaperCompetitionExecution[] = [];
  for (const { admissionSequence, ...order } of orders) {
    const { frame: next, ...execution } = evaluatePaperOrder({ ...order, frame, now });
    frame = next;
    executions.push({ ...execution, orderId: order.orderId, admissionSequence });
  }
  // No partial result escapes if any later contender fails admission/calculation.
  return immutable({ version: 'spot-l2-admission-fifo-v1', executions, frame });
}
