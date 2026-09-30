import { z } from 'zod';

/** External identifiers stay opaque; numeric-looking exchange IDs are never coerced. */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u);

/** Milliseconds since the UTC epoch within both the safe integer and Date ranges. */
export const timestampSchema = z.number().int().min(0).max(8_640_000_000_000_000);

export const exchangeIdSchema = z.enum(['BINANCE', 'BYBIT', 'OKX', 'HTX']);
export const marketTypeSchema = z.enum([
  'SPOT',
  'LINEAR_PERPETUAL',
  'INVERSE_PERPETUAL',
  'LINEAR_FUTURE',
  'INVERSE_FUTURE',
]);
export const environmentSchema = z.enum(['LIVE', 'TESTNET', 'DEMO']);
export type ExchangeId = z.infer<typeof exchangeIdSchema>;
export type MarketType = z.infer<typeof marketTypeSchema>;
export type ExchangeEnvironment = z.infer<typeof environmentSchema>;

const profileIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const accountModeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

const marketScopeFields = {
  exchange: exchangeIdSchema,
  region: profileIdentifierSchema,
  market: marketTypeSchema,
  environment: environmentSchema,
};

export const marketScopeSchema = z.strictObject(marketScopeFields).readonly();
export type MarketScope = z.infer<typeof marketScopeSchema>;

/**
 * Constructed from server-owned configuration. credentialRef is an opaque lookup
 * key, never credential material; syntax validation does not establish provenance.
 * Endpoint destinations are selected through endpointProfileId by the server.
 */
export const adapterProfileSchema = z
  .strictObject({
    ...marketScopeFields,
    accountMode: accountModeSchema,
    profileVersion: profileIdentifierSchema,
    endpointProfileId: profileIdentifierSchema,
    credentialRef: profileIdentifierSchema.optional(),
  })
  .readonly();
export type AdapterProfile = z.infer<typeof adapterProfileSchema>;

export const accountScopeSchema = z
  .strictObject({
    tenantId: z.uuid(),
    connectionId: z.uuid(),
    externalAccountId: idSchema,
  })
  .readonly();
export type AccountScope = z.infer<typeof accountScopeSchema>;

export const featureSchema = z.enum([
  'PUBLIC_READ',
  'ACCOUNT_READ',
  'ORDER_READ',
  'CANCEL_ORDER',
  'CANCEL_ALL_ORDERS',
  'PUBLIC_STREAM',
  'PRIVATE_STREAM',
  'MARKET_ORDER',
  'LIMIT_ORDER',
  'QUOTE_BUDGET_MARKET_BUY',
  'TRIGGER_ORDER',
  'STOP_LIMIT_ORDER',
  'OCO',
  'ATTACHED_TP_SL',
  'TRAILING_STOP',
  'REDUCE_ONLY',
  'CLOSE_POSITION',
  'AMEND_ORDER',
  'SET_LEVERAGE',
  'CHANGE_POSITION_MODE',
  'ORDER_LOOKUP_BY_CLIENT_ID',
  'ALGO_ORDERS',
  'HISTORICAL_CANDLES',
]);
export type Feature = z.infer<typeof featureSchema>;

const implementationSchema = z.enum(['NATIVE', 'SYNTHETIC']);
const capabilityConstraintsSchema = z
  .strictObject({
    // An explicitly empty allowlist permits no instrument/timeframe.
    instrumentIds: z.array(idSchema).max(10_000).readonly().optional(),
    timeframes: z.array(profileIdentifierSchema).max(256).readonly().optional(),
  })
  .readonly();
const evidenceUrlSchema = z
  .url({ protocol: /^https$/u })
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.username === '' && url.password === '' && !/[\s\p{Cc}]/u.test(value);
    } catch {
      return false;
    }
  }, 'INVALID_EVIDENCE_URL');

export const capabilityRecordSchema = z
  .strictObject({
    profile: adapterProfileSchema,
    feature: featureSchema,
    support: z.enum(['SUPPORTED', 'UNSUPPORTED', 'UNVERIFIED']),
    implementation: implementationSchema,
    constraints: capabilityConstraintsSchema,
    evidenceUrl: evidenceUrlSchema,
    checkedAt: timestampSchema,
    expiresAt: timestampSchema,
    adapterVersion: idSchema,
  })
  .refine((value) => value.expiresAt > value.checkedAt, {
    message: 'INVALID_VALIDITY_INTERVAL',
    path: ['expiresAt'],
  })
  .readonly();
export type CapabilityRecord = z.infer<typeof capabilityRecordSchema>;

export type CapabilityEvaluationInput = {
  readonly profile: unknown;
  readonly record: unknown;
  readonly feature: Feature;
  readonly now: number;
  readonly adapterVersion: string;
  readonly instrumentId?: string;
  readonly timeframe?: string;
  readonly allowSynthetic?: boolean;
};
export type CapabilityDenialCode =
  | 'MALFORMED'
  | 'SCOPE_MISMATCH'
  | 'UNSUPPORTED'
  | 'UNVERIFIED'
  | 'EXPIRED'
  | 'VERSION_MISMATCH'
  | 'CONSTRAINT'
  | 'SYNTHETIC_DISABLED';
export type CapabilityEvaluationResult =
  | { readonly allowed: true; readonly implementation: z.infer<typeof implementationSchema> }
  | { readonly allowed: false; readonly code: CapabilityDenialCode };

const evaluationInputSchema = z.strictObject({
  profile: adapterProfileSchema,
  record: capabilityRecordSchema,
  feature: featureSchema,
  now: timestampSchema,
  adapterVersion: idSchema,
  instrumentId: idSchema.optional(),
  timeframe: profileIdentifierSchema.optional(),
  allowSynthetic: z.boolean().optional(),
});

const profileFields = [
  'exchange',
  'region',
  'market',
  'environment',
  'accountMode',
  'profileVersion',
  'endpointProfileId',
  'credentialRef',
] as const satisfies readonly (keyof AdapterProfile)[];

function denied(code: CapabilityDenialCode): CapabilityEvaluationResult {
  return Object.freeze({ allowed: false, code });
}

/**
 * Fail-closed eligibility from dated evidence for exactly one adapter profile.
 * Evidence is valid only in [checkedAt, expiresAt); this never grants account
 * permissions, authorizes an order, resolves a destination, or performs I/O.
 */
export function evaluateCapability(input: CapabilityEvaluationInput): CapabilityEvaluationResult {
  try {
    const parsed = evaluationInputSchema.safeParse(input);
    if (!parsed.success) return denied('MALFORMED');
    const {
      profile,
      record,
      feature,
      now,
      adapterVersion,
      instrumentId,
      timeframe,
      allowSynthetic,
    } = parsed.data;

    if (
      feature !== record.feature ||
      profileFields.some((field) => profile[field] !== record.profile[field])
    ) {
      return denied('SCOPE_MISMATCH');
    }
    if (record.support === 'UNSUPPORTED') return denied('UNSUPPORTED');
    if (record.support === 'UNVERIFIED') return denied('UNVERIFIED');
    if (now < record.checkedAt || now >= record.expiresAt) return denied('EXPIRED');
    if (adapterVersion !== record.adapterVersion) return denied('VERSION_MISMATCH');

    const { instrumentIds, timeframes } = record.constraints;
    if (
      (instrumentIds !== undefined &&
        (instrumentId === undefined || !instrumentIds.includes(instrumentId))) ||
      (timeframes !== undefined && (timeframe === undefined || !timeframes.includes(timeframe)))
    ) {
      return denied('CONSTRAINT');
    }
    if (record.implementation === 'SYNTHETIC' && allowSynthetic !== true) {
      return denied('SYNTHETIC_DISABLED');
    }
    return Object.freeze({ allowed: true, implementation: record.implementation });
  } catch {
    // Even hostile object accessors produce a static error without echoing input.
    return denied('MALFORMED');
  }
}
