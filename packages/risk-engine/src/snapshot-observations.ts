import { z } from 'zod';
import {
  idSchema,
  timestampSchema,
  positiveDecimalSchema,
  positiveAmountSchema,
  rateDecimalSchema,
  decimalCompare,
  parseDecimal,
} from '@ctp/exchange-core';
import { riskSnapshotKeySchema } from './coordinator.js';

const fact = { sourceId: idSchema, asOf: timestampSchema };
const healthFact = z.strictObject({ ...fact, status: z.enum(['HEALTHY', 'FAILED', 'UNKNOWN']) });
/** Normalized collector facts only: never a caller's policy, Portfolio or exposure totals. */
export const riskNativeObservationSchema = z.strictObject({
  key: riskSnapshotKeySchema.omit({ intentId: true }),
  permissionEpoch: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  permissionsVersion: z.number().int().nonnegative().max(2147483647),
  positionMode: z.enum(['SPOT', 'ONE_WAY', 'HEDGE']),
  leverage: positiveAmountSchema,
  health: z.strictObject({
    database: healthFact,
    limiter: healthFact,
    authentication: healthFact,
    exchangeRest: healthFact,
    privateStream: healthFact,
    clock: healthFact,
    latency: healthFact,
    rejectRate: healthFact,
    maintenance: healthFact,
  }),
  fee: z.strictObject({
    ...fact,
    asset: idSchema,
    maxRate: rateDecimalSchema.refine(
      (v) =>
        decimalCompare(parseDecimal(v), parseDecimal('0')) >= 0 &&
        decimalCompare(parseDecimal(v), parseDecimal('1')) <= 0,
    ),
  }),
  fx: z
    .array(
      z.strictObject({
        ...fact,
        from: idSchema,
        to: idSchema,
        rate: positiveDecimalSchema,
        kind: z.enum(['IDENTITY', 'OBSERVED']),
      }),
    )
    .min(1)
    .max(1000),
  valuations: z
    .array(
      z.strictObject({
        accountId: z.uuid(),
        bookId: z.uuid(),
        snapshotId: idSchema,
        instrumentId: idSchema,
        marketId: z.uuid(),
      }),
    )
    .max(30000),
  /** Native derivative MARK observations; LAST is never substituted for MARK. */
  marks: z
    .array(
      z.strictObject({
        ...fact,
        marketId: z.uuid(),
        price: positiveAmountSchema,
        priceAsset: idSchema,
      }),
    )
    .max(1000),
  execution: z.strictObject({
    marketId: z.uuid(),
    lowerPrice: positiveAmountSchema,
    upperPrice: positiveAmountSchema,
    boundEnforced: z.boolean(),
    ...fact,
  }),
});
export type RiskNativeObservation = z.infer<typeof riskNativeObservationSchema>;
