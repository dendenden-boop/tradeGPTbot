import { createHash } from 'node:crypto';
import { z } from 'zod';
import { riskLimitsSchema } from './policy.js';

const versionPattern = /^(0|[1-9][0-9]{0,18})$/;
const version = z
  .string()
  .regex(versionPattern)
  .refine((v) => versionPattern.test(v) && BigInt(v) <= 9223372036854775807n);
export const policyModeSchema = z.enum(['PAPER', 'TESTNET', 'DEMO', 'LIVE']);
export const policyScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('PLATFORM') }),
  z.strictObject({ kind: z.literal('USER'), tenantId: z.uuid() }),
]);
export const policyUpdateSchema = z.strictObject({
  scope: policyScopeSchema,
  mode: policyModeSchema,
  eventId: z.uuid(),
  expectedVersion: version.refine(
    (v) => versionPattern.test(v) && BigInt(v) < 9223372036854775807n,
  ),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  limits: riskLimitsSchema,
});
export type PolicyUpdate = z.infer<typeof policyUpdateSchema>;
/** Canonical text used by both immutable SQL evidence and its content hash. */
export function policyLimitsText(raw: unknown): string {
  const limits = riskLimitsSchema.parse(raw);
  return JSON.stringify(
    Object.fromEntries(Object.entries(limits).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}
export function policyFingerprint(raw: unknown): string {
  return createHash('sha256').update(policyLimitsText(raw)).digest('hex');
}
export const policyHeadSchema = z
  .strictObject({
    scope: policyScopeSchema,
    mode: policyModeSchema,
    version: version.refine((v) => v !== '0'),
    eventId: z.uuid(),
    limits: riskLimitsSchema,
    limitsHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (h) =>
      riskLimitsSchema.safeParse(h.limits).success && h.limitsHash === policyFingerprint(h.limits),
    'RISK_POLICY_CONTENT_HASH',
  );
export type PolicyHead = z.infer<typeof policyHeadSchema>;
