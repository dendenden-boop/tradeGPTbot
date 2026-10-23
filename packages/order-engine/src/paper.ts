import { z } from 'zod';
import {
  decimalCompare,
  idSchema,
  immutable,
  operations,
  parseDecimal,
  positiveAmountSchema,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical, hash, stateSchema } from './domain.js';

const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .pipe(z.string().refine((value) => BigInt(value) <= 9007199254740991n));
const withdrawal = z.strictObject({
  outcome: z.literal('NOT_SENT'),
  collateral: z.literal('RETAINED'),
  eventId: uuid,
  reservationId: uuid,
  orderId: uuid,
  intentId: uuid,
  decisionId: uuid,
  commandHash: digest,
  stateRevision: z.literal('1'),
  observedAt: timestampSchema,
  bookId: uuid,
  bookRevision: revision,
  bookHash: digest,
});
const release = z.strictObject({
  outcome: z.literal('NOT_SENT'),
  collateral: z.literal('RELEASED'),
  eventId: uuid,
  withdrawalEventId: uuid,
  reservationId: uuid,
  orderId: uuid,
  intentId: uuid,
  decisionId: uuid,
  commandHash: digest,
  releaseVersion: z.literal('1'),
  releasedAt: timestampSchema,
  bookId: uuid,
  bookRevision: revision,
  bookHash: digest,
  debits: z
    .array(
      z.strictObject({
        asset: z.string().min(1).max(32),
        amount: positiveAmountSchema,
        holdId: uuid,
      }),
    )
    .length(1),
});
const input = z.strictObject({
  kind: z.literal('PAPER_PREPARE_UNSENT_CANCEL'),
  key: idSchema,
  state: stateSchema,
  withdrawal,
  release,
});

/** Pure content preparation, deliberately outside native cancellation and the
 * root export. Receipt-shaped JSON and its hashes prove no private issuance,
 * ownership, permission, committed cancellation or transport authority. A future
 * durable bridge must look up permanent replay and authenticate private causes
 * under lock; it must never persist a caller's plan as an acknowledgement. */
export function preparePaperUnsentCancellation(raw: unknown, now: number) {
  const parsed = input.safeParse(raw);
  if (!parsed.success || !timestampSchema.safeParse(now).success)
    throw new Error('ORDER_PAPER_CANCEL_INPUT');
  const { state: s, key, withdrawal: w, release: r } = parsed.data;
  const b = s.binding;
  const command = s.command;
  if (
    b.mode !== 'PAPER' ||
    b.connectionId !== null ||
    b.profile.market !== 'SPOT' ||
    b.profile.accountMode !== 'SIMULATED' ||
    b.profile.endpointProfileId !== 'paper-spot-v1' ||
    b.profile.profileVersion !== 'spot-l2-taker-v1' ||
    b.profile.credentialRef !== undefined ||
    command.side !== 'BUY' ||
    !['MARKET', 'LIMIT'].includes(command.type) ||
    command.trigger !== null ||
    command.reduceOnly ||
    command.size.kind !== 'BASE_QUANTITY' ||
    command.timeInForce === 'POST_ONLY' ||
    (command.type === 'MARKET' && command.timeInForce !== null)
  )
    throw new Error('ORDER_PAPER_CANCEL_UNSUPPORTED');
  const { clientOrderId: originalClientId, ...originalDraft } = command;
  if (
    s.status !== 'CREATED' ||
    s.version !== 0 ||
    s.reconciliation !== 'REQUIRED' ||
    s.effectiveCommand !== undefined ||
    s.activeAttemptId !== null ||
    s.activeOperation !== null ||
    s.exchangeOrderId !== null ||
    s.lastNativeStatus !== null ||
    s.lastExchangeAt !== null ||
    s.lastObservationHash !== null ||
    s.averageFillPrice !== null ||
    decimalCompare(s.filledQuantity, parseDecimal('0')) !== 0 ||
    decimalCompare(s.executedQuantity, parseDecimal('0')) !== 0 ||
    decimalCompare(s.executionNotional, parseDecimal('0')) !== 0 ||
    canonical(s.draft.order) !== canonical(originalDraft)
  )
    throw new Error('ORDER_PAPER_CANCEL_TARGET');
  const placeHash = hash({ operation: 'createOrder', command, binding: b });
  if (
    w.orderId !== s.id ||
    r.orderId !== s.id ||
    w.intentId !== s.intentId ||
    r.intentId !== s.intentId ||
    w.commandHash !== placeHash ||
    r.commandHash !== placeHash ||
    w.reservationId !== r.reservationId ||
    w.decisionId !== r.decisionId ||
    w.bookId !== r.bookId ||
    r.withdrawalEventId !== w.eventId ||
    r.eventId === w.eventId ||
    w.observedAt < s.createdAt ||
    r.releasedAt < w.observedAt ||
    r.releasedAt <= s.createdAt ||
    r.releasedAt > now ||
    BigInt(r.bookRevision) <= BigInt(w.bookRevision)
  )
    throw new Error('ORDER_PAPER_CANCEL_EVIDENCE');
  const cancellation = {
    instrumentId: command.instrumentId,
    locator: { kind: 'CLIENT_ID' as const, id: originalClientId },
  };
  // Reuse command content, never the native account/connection hash or permit.
  operations.cancelOrder.input.shape.command.parse(cancellation);
  return immutable({
    kind: 'PAPER_UNSENT_CANCEL_PLAN' as const,
    request: { binding: b, orderId: s.id, operation: 'CANCEL' as const, key },
    requestHash: hash({ binding: b, orderId: s.id, operation: 'CANCEL' }),
    command: cancellation,
    commandHash: hash({ operation: 'cancelOrder', command: cancellation, binding: b }),
    placeCommandHash: placeHash,
    evidence: { withdrawalHash: hash(w), releaseHash: hash(r) },
    transition: {
      previousVersion: '0',
      nextVersion: '1',
      from: 'CREATED',
      to: 'CANCELED',
      source: 'PAPER_NOT_SENT_CANCEL',
    } as const,
  });
}
export type PaperUnsentCancellationPlan = ReturnType<typeof preparePaperUnsentCancellation>;
