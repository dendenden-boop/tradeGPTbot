import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { paperOrderRiskRequestSchema } from './order-risk-domain.js';
import {
  decodePaperRiskContextSource,
  type PaperRiskContextRequest,
} from './risk-context-domain.js';
import { decodePaperRiskLossSource } from './risk-loss-domain.js';
import type { PaperFundingIo } from './funding-domain.js';

const wire = z.strictObject({
  kind: z.literal('PAPER_TENANT_RISK_CONTEXT_CAPTURE'),
  asOf: timestampSchema,
  context: z.unknown(),
  loss: z.unknown(),
});
export type PaperTenantRiskContextRequest = PaperRiskContextRequest;
export type PaperTenantRiskContextSource = ReturnType<typeof decodePaperTenantRiskContextSource>;
export interface PaperTenantRiskContextReader {
  read(
    request: PaperTenantRiskContextRequest,
    io: PaperFundingIo,
  ): Promise<PaperTenantRiskContextSource>;
  close(): Promise<void>;
}

/** Private content checks; only the fixed common SQL transaction proves source
 * provenance/completeness. No serialized object or hash is a Risk certificate. */
export function decodePaperTenantRiskContextSource(raw: unknown, rawRequest: unknown, now: number) {
  try {
    timestampSchema.parse(now);
    const request = paperOrderRiskRequestSchema.parse(rawRequest);
    if (Buffer.byteLength(canonical(raw), 'utf8') > 4194304)
      throw new Error('PAPER_TENANT_RISK_CONTEXT_CAPACITY');
    const w = wire.parse(raw),
      context = decodePaperRiskContextSource(w.context, request, now),
      loss = decodePaperRiskLossSource(w.loss, request.owner, now),
      target = loss.inventory.accounts.find(
        (a) => a.state.binding.accountId === request.owner.accountId,
      );
    if (
      !target ||
      target.hash !== context.authority.orderRisk.book.hash ||
      loss.asOf > context.asOf ||
      context.asOf > w.asOf ||
      w.asOf > now ||
      loss.evidence.scope.valuationAsset !== context.authority.policies.effective.valuationAsset
    )
      throw new Error('PAPER_TENANT_RISK_CONTEXT_CORRUPT');
    // A new enclosing read never renews the inventory proof, original runtime
    // facts, market evidence or the UTC baseline beyond its midnight boundary.
    const age = Math.min(
        5000,
        context.authority.policies.effective.maxEvidenceAgeMs,
        ...loss.inventory.accounts.map(
          (a) => a.origin.configuration.configuration.model.maxEvidenceAgeMs,
        ),
      ),
      validUntil = Math.min(context.validUntil, loss.validUntil, loss.asOf + age);
    if (now >= validUntil) throw new Error('PAPER_TENANT_RISK_CONTEXT_STALE');
    return immutable({
      kind: 'PAPER_TENANT_RISK_CONTEXT_SOURCE' as const,
      asOf: w.asOf,
      validUntil,
      request,
      context,
      loss,
      hash: createHash('sha256')
        .update(canonical({ request, context: context.hash, loss: loss.hash }))
        .digest('hex'),
    });
  } catch (error) {
    const code =
      error instanceof Error &&
      /^PAPER_(?:TENANT_RISK_CONTEXT|RISK_CONTEXT|RISK_LOSS)_(CAPACITY|STALE|CASH_ONLY|POLICY|MARKET|EPOCH)$/u.test(
        error.message,
      )
        ? error.message.replace(/^PAPER_(?:RISK_CONTEXT|RISK_LOSS)_/u, 'PAPER_TENANT_RISK_CONTEXT_')
        : 'PAPER_TENANT_RISK_CONTEXT_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Private tenant/account/history payloads stay inside the server boundary.
      cause: new Error('PAPER_TENANT_RISK_CONTEXT_INVALID'),
    });
  }
}
