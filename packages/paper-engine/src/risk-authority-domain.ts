import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema, immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { marketSnapshotPublicationSchema, marketTradePublicationSchema } from '@ctp/market-data';
import { controlScopeSchema, intersectRiskLimits, policyHeadSchema } from '@ctp/risk-engine';
import { paperOwnerSchema } from './configuration-domain.js';
import {
  decodePaperOrderRiskSource,
  paperOrderRiskRequestSchema,
  type PaperOrderRiskRequest,
} from './order-risk-domain.js';
import type { PaperFundingIo } from './funding-domain.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const epoch = z
  .string()
  .refine((v) => /^(0|[1-9][0-9]{0,18})$/u.exec(v)?.[0] === v && BigInt(v) <= 9223372036854775807n);
const head = z
  .strictObject({
    scope: controlScopeSchema,
    kind: z.enum(['KILL_SWITCH', 'CIRCUIT']),
    key: z.string().refine((v) => /^[a-z][a-z0-9_]{0,63}$/u.exec(v)?.[0] === v),
    state: z.enum(['RUNNING', 'PAUSED', 'OPEN', 'CLOSED', 'HALF_OPEN']),
    epoch: epoch.refine((v) => v !== '0'),
  })
  .refine((h) =>
    h.kind === 'KILL_SWITCH'
      ? h.key === 'kill' && ['RUNNING', 'PAUSED'].includes(h.state)
      : ['OPEN', 'CLOSED', 'HALF_OPEN'].includes(h.state),
  );
const controlsSchema = z.strictObject({
  global: z.array(head).max(10000),
  tenant: z.array(head).max(10000),
  activePauses: z.array(z.uuid()).max(10000),
  circuits: z
    .array(z.strictObject({ id: z.uuid(), state: z.enum(['OPEN', 'CLOSED', 'HALF_OPEN']) }))
    .max(10000),
});
const wire = z.strictObject({
  kind: z.literal('PAPER_RISK_AUTHORITY_CAPTURE'),
  orderRisk: z.unknown(),
  identity: paperOwnerSchema.extend({
    connectionId: z.null(),
    externalAccountId: idSchema,
    userSessionEpoch: epoch.refine(
      (v) => /^(0|[1-9][0-9]{0,9})$/u.exec(v)?.[0] === v && BigInt(v) <= 2147483647n,
    ),
    permissionEpoch: epoch,
    accountVersion: z.number().int().nonnegative().safe(),
  }),
  policies: z.tuple([policyHeadSchema, policyHeadSchema]),
  controls: z.strictObject({ text: z.string().max(1048576), hash: digest }),
});
const publications = z.object({
  snapshot: z.object({ publicationText: z.string() }),
  trade: z.object({ publicationText: z.string() }),
});
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const unique = (values: string[]) => {
  if (new Set(values).size !== values.length) throw new Error('PAPER_RISK_AUTHORITY_CORRUPT');
};
export type PaperRiskAuthorityRequest = PaperOrderRiskRequest;
export type PaperRiskAuthoritySource = ReturnType<typeof decodePaperRiskAuthoritySource>;
export interface PaperRiskAuthorityReader {
  read(request: PaperRiskAuthorityRequest, io: PaperFundingIo): Promise<PaperRiskAuthoritySource>;
  close(): Promise<void>;
}

/** Private wire validation. Only the fixed SQL transaction proves current source
 * authority; a serialized object/hash is neither a certificate nor approval. */
export function decodePaperRiskAuthoritySource(raw: unknown, rawRequest: unknown, now: number) {
  try {
    timestampSchema.parse(now);
    const request = paperOrderRiskRequestSchema.parse(rawRequest);
    if (Buffer.byteLength(canonical(raw), 'utf8') > 2097152)
      throw new Error('PAPER_RISK_AUTHORITY_CAPACITY');
    const w = wire.parse(raw),
      orderRisk = decodePaperOrderRiskSource(w.orderRisk, request, now),
      config = orderRisk.book.origin.configuration,
      [platform, user] = w.policies;
    const identity = w.identity;
    if (
      identity.tenantId !== request.owner.tenantId ||
      identity.accountId !== request.owner.accountId ||
      identity.externalAccountId !== config.accountIdentity.externalAccountId ||
      identity.permissionEpoch !== orderRisk.book.accountState.permissionEpoch ||
      identity.accountVersion !== orderRisk.book.accountState.version
    )
      throw new Error('PAPER_RISK_AUTHORITY_CORRUPT');
    if (
      platform.scope.kind !== 'PLATFORM' ||
      user.scope.kind !== 'USER' ||
      user.scope.tenantId !== request.owner.tenantId ||
      platform.mode !== 'PAPER' ||
      user.mode !== 'PAPER'
    )
      throw new Error('PAPER_RISK_AUTHORITY_POLICY');
    let effective;
    try {
      effective = intersectRiskLimits(platform.limits, user.limits);
    } catch {
      throw new Error('PAPER_RISK_AUTHORITY_POLICY');
    }
    if (effective.valuationAsset !== config.configuration.valuationAsset)
      throw new Error('PAPER_RISK_AUTHORITY_POLICY');
    if (createHash('sha256').update(w.controls.text).digest('hex') !== w.controls.hash)
      throw new Error('PAPER_RISK_AUTHORITY_CORRUPT');
    const c = controlsSchema.parse(JSON.parse(w.controls.text));
    if (
      c.global.some((h) => h.scope.kind !== 'GLOBAL') ||
      c.tenant.some((h) => h.scope.kind === 'GLOBAL' || h.scope.tenantId !== request.owner.tenantId)
    )
      throw new Error('PAPER_RISK_AUTHORITY_CORRUPT');
    const all = [...c.global, ...c.tenant];
    unique(all.map((h) => canonical([h.scope, h.kind, h.key])));
    unique(c.activePauses);
    unique(c.circuits.map((c) => c.id));
    const globalKill = c.global.find((h) => h.kind === 'KILL_SWITCH' && h.key === 'kill') ?? null;
    const pauses = {
      global: globalKill === null || globalKill.state !== 'RUNNING',
      user:
        c.activePauses.length > 0 ||
        c.tenant.some(
          (h) => h.scope.kind === 'USER' && h.kind === 'KILL_SWITCH' && h.state !== 'RUNNING',
        ),
      strategy: c.tenant.some(
        (h) => h.scope.kind === 'STRATEGY' && h.kind === 'KILL_SWITCH' && h.state !== 'RUNNING',
      ),
    };
    const circuits = [...all.filter((h) => h.kind === 'CIRCUIT'), ...c.circuits];
    const circuit = circuits.some((c) => c.state === 'OPEN')
      ? ('OPEN' as const)
      : circuits.some((c) => c.state === 'HALF_OPEN')
        ? ('HALF_OPEN' as const)
        : ('CLOSED' as const);
    // Apply the stricter policy age to EACH original witness without rewriting
    // the immutable model or extending any observation/rules timestamp.
    const p = publications.parse(w.orderRisk),
      s = marketSnapshotPublicationSchema.parse(JSON.parse(p.snapshot.publicationText)),
      t = marketTradePublicationSchema.parse(JSON.parse(p.trade.publicationText));
    if (s.kind !== 'SNAPSHOT' || t.kind !== 'TRADE')
      throw new Error('PAPER_RISK_AUTHORITY_CORRUPT');
    const times = [
      orderRisk.asOf,
      s.timestamp,
      t.timestamp,
      s.book.receivedAt,
      s.book.exchangeTime,
      s.ticker.receivedAt,
      s.ticker.exchangeTime,
      t.trade.receivedAt,
      t.trade.exchangeTime,
    ].filter((v): v is number => v !== null);
    const age = Math.min(config.configuration.model.maxEvidenceAgeMs, effective.maxEvidenceAgeMs);
    const validUntil = Math.min(orderRisk.validUntil, ...times.map((t) => t + age + 1));
    if (times.some((t) => t > now || now - t > age) || now >= validUntil)
      throw new Error('PAPER_RISK_AUTHORITY_STALE');
    const policies = { platform, user, effective },
      controls = { ...c, fingerprint: w.controls.hash, globalKill, pauses, circuit };
    return immutable({
      kind: 'PAPER_RISK_AUTHORITY_SOURCE' as const,
      asOf: orderRisk.asOf,
      validUntil,
      request,
      orderRisk,
      identity,
      policies,
      controls,
      hash: hash({ request, orderRisk: orderRisk.hash, identity, policies, controls }),
    });
  } catch (error) {
    const code =
      error instanceof Error &&
      /^PAPER_RISK_AUTHORITY_(CAPACITY|STALE|POLICY)$/u.test(error.message)
        ? error.message
        : error instanceof Error &&
            /^PAPER_ORDER_RISK_(CAPACITY|STALE|MARKET)$/u.test(error.message)
          ? error.message.replace('PAPER_ORDER_RISK_', 'PAPER_RISK_AUTHORITY_')
          : 'PAPER_RISK_AUTHORITY_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Private authority/account/market contents must not cross the source error boundary.
      cause: new Error('PAPER_RISK_AUTHORITY_INVALID'),
    });
  }
}
