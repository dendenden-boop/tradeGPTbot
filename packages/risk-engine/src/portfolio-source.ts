import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema, idSchema, exchangeIdSchema } from '@ctp/exchange-core';
import { canonical, restorePortfolio } from '@ctp/portfolio';
import { policyModeSchema } from './policies.js';
import { riskEvidenceHash } from './coordinator.js';

export const riskPortfolioScopeSchema = z.strictObject({
  tenantId: z.uuid(),
  mode: policyModeSchema,
  targetAccountId: z.uuid(),
  maxEvidenceAgeMs: z.number().int().min(1).max(5000),
});
export type RiskPortfolioScope = z.infer<typeof riskPortfolioScopeSchema>;
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = z.strictObject({
  scope: riskPortfolioScopeSchema.pick({ tenantId: true, mode: true }),
  accounts: z
    .array(
      z.strictObject({
        id: z.uuid(),
        exchange: exchangeIdSchema,
        region: idSchema,
        externalAccountId: idSchema,
        accountMode: idSchema,
        status: z.string().min(1).max(32),
        permissionEpoch: counter,
        reconciliationEpoch: counter,
        version: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(100),
  books: z
    .array(
      z.strictObject({
        id: z.uuid(),
        accountId: z.uuid(),
        wallet: idSchema,
        revision: counter,
        stateText: z.string().max(1048576),
        hash,
        holdWatermarks: z
          .array(
            z.strictObject({
              holdId: idSchema,
              timestamp: counter,
              fingerprint: hash,
              released: z.boolean(),
              unknown: z.boolean(),
            }),
          )
          .max(1000),
      }),
    )
    .max(300),
});

/** Decode Portfolio's own immutable/checksummed representation; never rebuild its ledger. */
export function decodeRiskPortfolioSource(raw: unknown, rawScope: RiskPortfolioScope, now: number) {
  try {
    const scope = riskPortfolioScopeSchema.parse(rawScope),
      e = envelope.parse(raw);
    timestampSchema.parse(now);
    if (
      e.scope.tenantId !== scope.tenantId ||
      e.scope.mode !== scope.mode ||
      !e.accounts.some((a) => a.id === scope.targetAccountId) ||
      new Set(e.accounts.map((a) => a.id)).size !== e.accounts.length ||
      new Set(e.books.map((b) => b.id)).size !== e.books.length ||
      new Set(e.books.map((b) => JSON.stringify([b.accountId, b.wallet]))).size !== e.books.length
    )
      throw new Error('RISK_PORTFOLIO_SCOPE');
    const accounts = new Map(e.accounts.map((a) => [a.id, a]));
    let bytes = 0;
    const books = e.books.map(({ stateText, ...b }) => {
      bytes += Buffer.byteLength(stateText, 'utf8');
      if (bytes > 1048576) throw new Error('RISK_PORTFOLIO_CAPACITY');
      if (createHash('sha256').update(stateText).digest('hex') !== b.hash)
        throw new Error('RISK_PORTFOLIO_CORRUPT');
      const state = restorePortfolio(JSON.parse(stateText) as unknown),
        a = accounts.get(b.accountId);
      if (
        !a ||
        state.binding.tenantId !== scope.tenantId ||
        state.binding.mode !== scope.mode ||
        state.binding.accountId !== b.accountId ||
        state.binding.walletId !== b.wallet ||
        state.binding.scope.exchange !== a.exchange ||
        state.binding.scope.region !== a.region ||
        state.binding.externalAccountId !== a.externalAccountId
      )
        throw new Error('RISK_PORTFOLIO_SCOPE');
      if (
        state.status !== 'RECONCILED' ||
        state.pending.length ||
        state.differences.length ||
        state.snapshotAt === null ||
        state.snapshotId === null ||
        state.snapshotAt > now ||
        now - state.snapshotAt > scope.maxEvidenceAgeMs ||
        BigInt(b.revision) === 0n
      )
        throw new Error('RISK_PORTFOLIO_INCOMPLETE');
      if (
        new Set(b.holdWatermarks.map((h) => h.holdId)).size !== b.holdWatermarks.length ||
        b.holdWatermarks.length !== state.holds.length
      )
        throw new Error('RISK_PORTFOLIO_HOLD_HISTORY');
      for (const hold of state.holds) {
        const h = b.holdWatermarks.find((h) => h.holdId === hold.id);
        if (
          !h ||
          h.released ||
          BigInt(h.timestamp) > BigInt(now) ||
          h.fingerprint !==
            createHash('sha256')
              .update(canonical({ type: 'COMMITMENT', hold }))
              .digest('hex') ||
          (h.unknown && hold.status !== 'UNKNOWN') ||
          (hold.status === 'UNKNOWN' && !h.unknown)
        )
          throw new Error('RISK_PORTFOLIO_HOLD_HISTORY');
      }
      return { ...b, state };
    });
    if (e.accounts.some((a) => !books.some((b) => b.accountId === a.id)))
      throw new Error('RISK_PORTFOLIO_INCOMPLETE');
    const value = {
      kind: 'PORTFOLIO_SOURCE' as const,
      scope: e.scope,
      accounts: e.accounts,
      books,
      asOf: Math.min(...books.map((b) => b.state.snapshotAt as number)),
    };
    // Content/revision identity, not a certificate or proof of current policies/health.
    return immutable({ ...value, hash: riskEvidenceHash(value) });
  } catch (error) {
    const code =
      error instanceof Error && /^RISK_PORTFOLIO_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'RISK_PORTFOLIO_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Invalid private checkpoint content must not be included in caller diagnostics.
      cause: new Error('RISK_PORTFOLIO_SOURCE_INVALID'),
    });
  }
}
export type RiskPortfolioSource = ReturnType<typeof decodeRiskPortfolioSource>;
