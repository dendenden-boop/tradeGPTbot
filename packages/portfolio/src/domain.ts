import { z } from 'zod';
import {
  decimalSchema,
  positiveAmountSchema,
  marketScopeSchema,
  timestampSchema,
  idSchema,
} from '@ctp/exchange-core';

const money = z.string().refine((v) => decimalSchema.safeParse(v).success, 'INVALID_DECIMAL');
const positive = z
  .string()
  .refine((v) => positiveAmountSchema.safeParse(v).success, 'INVALID_AMOUNT');
const nonnegative = money.refine((v) => !v.startsWith('-'), 'NEGATIVE_AMOUNT');
const asset = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/u);
export const bindingSchema = z
  .strictObject({
    tenantId: z.uuid(),
    accountId: z.uuid(),
    connectionId: z.uuid(),
    externalAccountId: idSchema,
    mode: z.enum(['PAPER', 'TESTNET', 'DEMO', 'LIVE']),
    walletId: idSchema,
    scope: marketScopeSchema,
  })
  .superRefine((b, c) => {
    if (
      !['SPOT', 'LINEAR_PERPETUAL'].includes(b.scope.market) ||
      (b.mode !== 'PAPER' && b.mode !== b.scope.environment)
    )
      c.addIssue({ code: 'custom', message: 'UNSUPPORTED_ACCOUNT_PROFILE' });
  });
export type Binding = z.infer<typeof bindingSchema>;
export const balanceSchema = z.strictObject({
  asset,
  total: money,
  free: money.nullable(),
  locked: nonnegative.nullable(),
  available: money.nullable(),
});
export type PortfolioBalance = z.infer<typeof balanceSchema>;
const positionFields = {
  instrumentId: idSchema,
  positionSide: z.enum(['NET', 'LONG', 'SHORT']),
  bucket: idSchema,
  base: asset,
  quote: asset,
};
export const positionObservationSchema = z.strictObject({
  ...positionFields,
  quantity: money,
  entryPrice: positive.nullable(),
});
export const positionStateSchema = z.strictObject({
  ...positionFields,
  quantity: money,
  basis: nonnegative.nullable(),
  realizedGross: money.nullable(),
  feesQuote: money.nullable(),
  fundingQuote: money,
  fees: z.record(asset, money),
  funding: z.record(asset, money),
});
export type PortfolioPosition = z.infer<typeof positionStateSchema>;
export const holdSchema = z.strictObject({
  id: idSchema,
  asset,
  amount: nonnegative,
  status: z.enum(['PENDING', 'UNKNOWN', 'RESERVED']),
  reflected: z.boolean(),
});
const baseEvent = { id: idSchema, timestamp: timestampSchema };
export const fillEventSchema = z.strictObject({
  ...baseEvent,
  type: z.literal('FILL'),
  ...positionFields,
  internalOrderId: z.uuid(),
  native: z.strictObject({ fillId: idSchema, identityScope: idSchema, exchangeOrderId: idSchema }),
  metadataVersion: idSchema,
  ruleVersion: idSchema,
  side: z.enum(['BUY', 'SELL']),
  quantity: positive,
  price: positive,
  fees: z
    .array(
      z.strictObject({
        asset,
        amount: money,
        quoteEquivalent: money.nullable(),
        fx: z
          .strictObject({ rate: positive, asOf: timestampSchema, sourceId: idSchema })
          .optional(),
      }),
    )
    .max(20),
});
export const snapshotEventSchema = z.strictObject({
  ...baseEvent,
  type: z.literal('SNAPSHOT'),
  proof: z.literal('RECONCILED_HISTORY'),
  covered: z.array(idSchema).max(2000),
  balances: z.array(balanceSchema).max(1000),
  positions: z.array(positionObservationSchema).max(1000),
  repairFrom: idSchema.optional(),
});
export const eventSchema = z.discriminatedUnion('type', [
  fillEventSchema,
  snapshotEventSchema,
  z.strictObject({
    ...baseEvent,
    type: z.literal('FUNDING'),
    positionKey: z.string().min(1).max(512),
    asset,
    amount: money,
    native: z.strictObject({ fundingId: idSchema, identityScope: idSchema }),
  }),
  z.strictObject({ ...baseEvent, type: z.literal('COMMITMENT'), hold: holdSchema }),
  z.strictObject({
    ...baseEvent,
    type: z.literal('RELEASE'),
    holdId: idSchema,
    resolved: z.boolean(),
  }),
  z.strictObject({ ...baseEvent, type: z.literal('GAP') }),
]);
export type PortfolioEvent = z.infer<typeof eventSchema>;
export type FillEvent = z.infer<typeof fillEventSchema>;
export type SnapshotEvent = z.infer<typeof snapshotEventSchema>;
export const stateSchema = z.strictObject({
  binding: bindingSchema,
  balances: z.array(balanceSchema).max(1000),
  positions: z.array(positionStateSchema).max(1000),
  holds: z.array(holdSchema).max(1000),
  pending: z.array(idSchema).max(2000),
  status: z.enum(['AWAITING_SNAPSHOT', 'RECONCILED', 'GAP', 'UNRECONCILED']),
  snapshotAt: timestampSchema.nullable(),
  snapshotId: idSchema.nullable(),
  lastEconomicAt: timestampSchema.nullable(),
  differences: z.array(z.string().max(512)).max(2000),
});
export type PortfolioState = z.infer<typeof stateSchema>;
export interface Posting {
  asset: string;
  bucket: 'AVAILABLE' | 'EXTERNAL' | 'FEE' | 'FUNDING';
  amount: string;
}
export interface Reduction {
  state: PortfolioState;
  postings: Posting[];
  holdWatermark?: HoldWatermark;
  ignored?: boolean;
}
export interface HoldWatermark {
  timestamp: number;
  fingerprint: string;
  released: boolean;
  unknown: boolean;
}
export interface IoContext {
  signal: AbortSignal;
  deadline: number;
}
export interface Checkpoint {
  revision: number;
  state: PortfolioState;
}
export interface PortfolioEvidence {
  event: PortfolioEvent;
  ledgerId: string | null;
}
export interface PortfolioStore {
  evidence(
    binding: Binding,
    ids: readonly string[],
    context: IoContext,
  ): Promise<readonly PortfolioEvidence[]>;
  read(binding: Binding, context: IoContext): Promise<Checkpoint>;
  apply(
    binding: Binding,
    event: PortfolioEvent,
    expectedRevision: number,
    context: IoContext,
  ): Promise<{ checkpoint: Checkpoint; duplicate: boolean }>;
  events(
    binding: Binding,
    limit: number,
    context: IoContext,
  ): Promise<
    readonly { id: string; eventId: string; revision: number; type: PortfolioEvent['type'] }[]
  >;
  acknowledge(binding: Binding, ids: readonly string[], context: IoContext): Promise<void>;
  close(): Promise<void>;
}
export function walletKey(b: Binding): string {
  return JSON.stringify([b.tenantId, b.accountId, b.mode, b.walletId]);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((k) => object[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
    .join(',')}}`;
}
