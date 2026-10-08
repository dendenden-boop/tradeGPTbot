import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  adapterProfileSchema,
  idSchema,
  timestampSchema,
  newOrderSchema,
  orderSchema,
  mutationOutcomeSchema,
  nonNegativeAmountSchema,
  positiveAmountSchema,
  decimalCompare,
  type InPlaceAmendment,
} from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
export { canonical };
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const bindingSchema = z
  .strictObject({
    tenantId: z.uuid(),
    accountId: z.uuid(),
    connectionId: z.uuid().nullable(),
    externalAccountId: idSchema,
    mode: z.enum(['PAPER', 'TESTNET', 'DEMO', 'LIVE']),
    profile: adapterProfileSchema,
  })
  .superRefine((b, c) => {
    if (
      (b.mode === 'PAPER') !== (b.connectionId === null) ||
      (b.mode !== 'PAPER' && b.mode !== b.profile.environment) ||
      !['SPOT', 'LINEAR_PERPETUAL'].includes(b.profile.market)
    )
      c.addIssue({ code: 'custom', message: 'ORDER_SCOPE' });
  });
export type OrderBinding = z.infer<typeof bindingSchema>;
const { clientOrderId: generated, ...fields } = newOrderSchema.shape;
void generated;
export const orderDraftSchema = z.strictObject(fields).superRefine((o, c) => {
  if (
    !newOrderSchema.safeParse({ ...o, clientOrderId: 'server' }).success ||
    o.size.kind !== 'BASE_QUANTITY'
  )
    c.addIssue({ code: 'custom', message: 'ORDER_COMMAND' });
});
export const draftSchema = z.strictObject({
  key: idSchema,
  dbInstrumentId: z.uuid(),
  dbRuleId: z.uuid(),
  positionSide: z.literal('NET'),
  bucket: idSchema,
  order: orderDraftSchema,
});
export type OrderDraft = z.infer<typeof draftSchema>;
/** A caller requests semantics; server composition supplies the fresh native target proof. */
export const amendDraftSchema = z.strictObject({
  key: idSchema,
  expectedVersion: z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/)
    .refine((v) => BigInt(v) <= 2147483646n && BigInt(v).toString() === v),
  dbRuleId: z.uuid(),
  replacement: orderDraftSchema,
});
export type AmendDraft = z.infer<typeof amendDraftSchema>;
export const nativeAmendTargetSchema = z.strictObject({
  order: orderSchema,
  receivedAt: timestampSchema,
});
export type NativeAmendTarget = z.infer<typeof nativeAmendTargetSchema>;
export interface StoredAmendment {
  state: OrderState;
  intentId: string;
  commandHash: string;
  command: InPlaceAmendment;
  dispatched: boolean;
}
export const statusSchema = z.enum([
  'CREATED',
  'RISK_APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCEL_PENDING',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
  'RECONCILIATION_REQUIRED',
]);
export type OrderStatus = z.infer<typeof statusSchema>;
export const stateSchema = z
  .strictObject({
    id: z.uuid(),
    intentId: z.uuid(),
    binding: bindingSchema,
    draft: draftSchema,
    command: newOrderSchema,
    /** Derived from durable causal applications; the original PLACE stays immutable. */
    effectiveCommand: newOrderSchema.optional(),
    status: statusSchema,
    reconciliation: z.enum(['REQUIRED', 'CONSISTENT']),
    version: z.number().int().min(0).max(2147483646),
    exchangeOrderId: idSchema.nullable(),
    filledQuantity: nonNegativeAmountSchema,
    executedQuantity: nonNegativeAmountSchema,
    executionNotional: nonNegativeAmountSchema,
    averageFillPrice: positiveAmountSchema.nullable(),
    lastNativeStatus: statusSchema.nullable(),
    lastExchangeAt: timestampSchema.nullable(),
    lastObservationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    activeAttemptId: z.uuid().nullable(),
    activeOperation: z.enum(['PLACE', 'CANCEL', 'AMEND']).nullable(),
    createdAt: timestampSchema,
  })
  .superRefine((s, c) => {
    const effective = s.effectiveCommand;
    if (effective === undefined) return;
    const original = s.command;
    if (
      s.binding.mode !== 'TESTNET' ||
      s.binding.profile.exchange !== 'BINANCE' ||
      s.binding.profile.market !== 'SPOT' ||
      original.type !== 'LIMIT' ||
      effective.type !== 'LIMIT' ||
      original.timeInForce !== 'GTC' ||
      effective.timeInForce !== 'GTC' ||
      original.reduceOnly ||
      effective.reduceOnly ||
      original.trigger !== null ||
      effective.trigger !== null ||
      effective.instrumentId !== original.instrumentId ||
      effective.side !== original.side ||
      effective.limitPrice !== original.limitPrice ||
      effective.clientOrderId === original.clientOrderId ||
      original.size.kind !== 'BASE_QUANTITY' ||
      effective.size.kind !== 'BASE_QUANTITY' ||
      effective.size.asset !== original.size.asset ||
      decimalCompare(effective.size.value, original.size.value) >= 0
    )
      c.addIssue({ code: 'custom', message: 'ORDER_EFFECTIVE_SCOPE' });
  });
export type OrderState = z.infer<typeof stateSchema>;
export const grantSchema = z.strictObject({
  decisionId: z.uuid(),
  reservationId: z.uuid(),
  permissionEpoch: z.string().regex(/^\d{1,19}$/),
  expiresAt: timestampSchema,
});
export type RiskGrant = z.infer<typeof grantSchema>;
export interface IoContext {
  signal: AbortSignal;
  deadline: number;
}
export const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('APPROVE') }),
  z.strictObject({
    type: z.literal('DISPATCH'),
    operation: z.enum(['PLACE', 'CANCEL', 'AMEND']),
    attemptId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('RESULT'),
    operation: z.enum(['PLACE', 'CANCEL', 'AMEND']),
    attemptId: z.uuid(),
    outcome: mutationOutcomeSchema,
  }),
  z.strictObject({ type: z.literal('NATIVE'), order: orderSchema }),
  z.strictObject({
    type: z.literal('EXECUTION'),
    quantity: positiveAmountSchema,
    price: positiveAmountSchema,
  }),
  z.strictObject({ type: z.literal('GAP') }),
  z.strictObject({ type: z.literal('COMPLETE') }),
]);
export type OrderEngineEvent = z.infer<typeof eventSchema>;
export interface DispatchClaim {
  state: OrderState;
  intentId: string;
  attemptId: string;
  operation: 'PLACE' | 'CANCEL' | 'AMEND';
  commandHash: string;
  command: unknown;
  expiresAt: number;
}
export interface OrderStore {
  /** Authorized durable lookup: exact replay, conflict, or null for a new key; never admits risk. */
  findCreate(
    binding: OrderBinding,
    draft: OrderDraft,
    context: IoContext,
  ): Promise<OrderState | null>;
  create(binding: OrderBinding, draft: OrderDraft, context: IoContext): Promise<OrderState>;
  findAmend(
    binding: OrderBinding,
    id: string,
    request: AmendDraft,
    context: IoContext,
  ): Promise<StoredAmendment | null>;
  /** Permanent exact replay precedes target/current-rule admission. No transport permission. */
  amendIntent(
    binding: OrderBinding,
    id: string,
    request: AmendDraft,
    evidence: NativeAmendTarget,
    context: IoContext,
  ): Promise<StoredAmendment>;
  read(binding: OrderBinding, id: string, context: IoContext): Promise<OrderState>;
  cancelIntent(
    binding: OrderBinding,
    id: string,
    key: string,
    context: IoContext,
  ): Promise<{
    state: OrderState;
    intentId: string;
    commandHash: string;
    ruleVersion: string;
    dispatched: boolean;
  }>;
  begin(
    binding: OrderBinding,
    id: string,
    intentId: string,
    grant: RiskGrant,
    context: IoContext,
  ): Promise<DispatchClaim | null>;
  result(
    binding: OrderBinding,
    claim: DispatchClaim,
    outcome: unknown,
    context: IoContext,
  ): Promise<OrderState>;
  observe(
    binding: OrderBinding,
    id: string,
    order: unknown,
    context: IoContext,
  ): Promise<OrderState>;
  gap(binding: OrderBinding, id: string, context: IoContext): Promise<OrderState>;
  complete(
    binding: OrderBinding,
    id: string,
    order: unknown,
    context: IoContext,
  ): Promise<OrderState>;
  adopt(
    binding: OrderBinding,
    id: string,
    bookId: string,
    eventId: string,
    context: IoContext,
  ): Promise<OrderState>;
  authorize(operation: unknown, input: unknown, context: unknown): Promise<boolean>;
  close(): Promise<void>;
}
