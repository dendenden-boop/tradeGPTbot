import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { paperOrderRiskRequestSchema } from './order-risk-domain.js';
import {
  decodePaperRiskAuthoritySource,
  type PaperRiskAuthorityRequest,
} from './risk-authority-domain.js';
import { decodePaperRuntimeSource, paperRuntimeDependencies } from './runtime-domain.js';
import type { PaperFundingIo } from './funding-domain.js';

const wire = z.strictObject({
  kind: z.literal('PAPER_RISK_CONTEXT_CAPTURE'),
  asOf: timestampSchema,
  authority: z.unknown(),
  runtime: z.unknown(),
});
export type PaperRiskContextRequest = PaperRiskAuthorityRequest;
export type PaperRiskContextSource = ReturnType<typeof decodePaperRiskContextSource>;
export interface PaperRiskContextReader {
  read(request: PaperRiskContextRequest, io: PaperFundingIo): Promise<PaperRiskContextSource>;
  close(): Promise<void>;
}

/** Private decoder. Only the fixed locked SQL transaction proves provenance;
 * this evidence object/hash is never a certificate, reservation or approval. */
export function decodePaperRiskContextSource(raw: unknown, rawRequest: unknown, now: number) {
  try {
    timestampSchema.parse(now);
    const request = paperOrderRiskRequestSchema.parse(rawRequest);
    if (Buffer.byteLength(canonical(raw), 'utf8') > 3145728)
      throw new Error('PAPER_RISK_CONTEXT_CAPACITY');
    const w = wire.parse(raw),
      authority = decodePaperRiskAuthoritySource(w.authority, request, now),
      runtime = decodePaperRuntimeSource(w.runtime, request.owner, now),
      configuration = authority.orderRisk.book.origin.configuration,
      identity = authority.identity;
    if (
      canonical(configuration) !== canonical(runtime.configuration) ||
      authority.orderRisk.book.origin.funding.configurationHash !== runtime.configurationHash ||
      identity.externalAccountId !== runtime.current.externalAccountId ||
      configuration.accountIdentity.clientIdEpoch !== runtime.current.clientIdEpoch ||
      authority.asOf > w.asOf ||
      runtime.asOf > w.asOf ||
      w.asOf > now
    )
      throw new Error('PAPER_RISK_CONTEXT_CORRUPT');
    if (
      identity.permissionEpoch !== runtime.current.permissionEpoch ||
      identity.userSessionEpoch !== runtime.current.userSessionEpoch ||
      identity.accountVersion !== runtime.current.accountVersion
    )
      throw new Error('PAPER_RISK_CONTEXT_EPOCH');
    const age = Math.min(
        5000,
        configuration.configuration.model.maxEvidenceAgeMs,
        authority.policies.effective.maxEvidenceAgeMs,
      ),
      facts = paperRuntimeDependencies.map((k) => runtime.health[k]),
      validUntil = Math.min(
        authority.validUntil,
        runtime.validUntil,
        ...facts.map((f) => f.asOf + age + 1),
      );
    if (facts.some((f) => f.asOf > now || now - f.asOf > age) || now >= validUntil)
      throw new Error('PAPER_RISK_CONTEXT_STALE');
    return immutable({
      kind: 'PAPER_RISK_CONTEXT_SOURCE' as const,
      asOf: w.asOf,
      validUntil,
      request,
      authority,
      runtime,
      hash: createHash('sha256')
        .update(canonical({ request, authority: authority.hash, runtime: runtime.hash }))
        .digest('hex'),
    });
  } catch (error) {
    const code =
      error instanceof Error &&
      /^PAPER_(?:RISK_CONTEXT|RISK_AUTHORITY|RUNTIME)_(CAPACITY|STALE|POLICY|MARKET|EPOCH)$/u.test(
        error.message,
      )
        ? error.message.replace(/^PAPER_(?:RISK_AUTHORITY|RUNTIME)_/u, 'PAPER_RISK_CONTEXT_')
        : 'PAPER_RISK_CONTEXT_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Private account/probe/order contents stay inside the server source.
      cause: new Error('PAPER_RISK_CONTEXT_INVALID'),
    });
  }
}
