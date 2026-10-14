import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, sameMarketScope, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { marketSnapshotPublicationSchema } from '@ctp/market-data';
import { paperOwnerSchema, type PaperOwner } from './configuration-domain.js';
import {
  decodePaperRiskPortfolioSource,
  type PaperRiskPortfolioSource,
} from './risk-portfolio-domain.js';
import { calculatePaperInventoryValuation } from './inventory-valuation.js';
import type { PaperFundingIo } from './funding-domain.js';

const counter = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((v) => /^[1-9][0-9]{0,18}$/u.test(v) && BigInt(v) <= 9223372036854775807n);
const marketWire = z.strictObject({
  id: z.uuid(),
  revision: counter,
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  publicationText: z.string().min(1).max(1048576),
});
const wire = z.strictObject({
  kind: z.literal('PAPER_RISK_VALUATION_CAPTURE'),
  inventory: z.unknown(),
  markets: z.array(marketWire).max(300),
});
export interface PaperRiskValuationSource {
  readonly kind: 'PAPER_RISK_VALUATION_SOURCE';
  readonly asOf: number;
  readonly hash: string;
  readonly validUntil: number;
  readonly inventory: PaperRiskPortfolioSource;
  readonly valuation: ReturnType<typeof calculatePaperInventoryValuation>;
  readonly markets: readonly {
    id: string;
    revision: string;
    hash: string;
    dbInstrumentId: string;
    dbRuleId: string;
    asOf: number;
    expiresAt: number;
  }[];
}
export interface PaperRiskValuationReader {
  read(owner: PaperOwner, io: PaperFundingIo): Promise<PaperRiskValuationSource>;
  close(): Promise<void>;
}

/** Private content validation. Source authority belongs to the fixed SQL RPC;
 * hashes, caller objects and this projection are never a Risk certificate. */
export function decodePaperRiskValuationSource(
  raw: unknown,
  rawOwner: unknown,
  now: number,
): PaperRiskValuationSource {
  try {
    timestampSchema.parse(now);
    const owner = paperOwnerSchema.parse(rawOwner);
    if (Buffer.byteLength(canonical(raw), 'utf8') > 1048576)
      throw new Error('PAPER_RISK_VALUATION_CAPACITY');
    const w = wire.parse(raw),
      inventory = decodePaperRiskPortfolioSource(w.inventory, owner, now);
    const configurations = inventory.accounts.map((a) => a.origin.configuration.configuration);
    const quote = configurations[0]!.valuationAsset;
    if (configurations.some((c) => c.valuationAsset !== quote))
      throw new Error('PAPER_RISK_VALUATION_CORRUPT');
    const maxAge = Math.min(5000, ...configurations.map((c) => c.model.maxEvidenceAgeMs));
    const markets = w.markets.map((m) => {
      if (createHash('sha256').update(m.publicationText, 'utf8').digest('hex') !== m.hash)
        throw new Error('PAPER_RISK_VALUATION_CORRUPT');
      const p = marketSnapshotPublicationSchema.parse(JSON.parse(m.publicationText));
      if (
        p.kind !== 'SNAPSHOT' ||
        p.id !== m.id ||
        p.key.scope.market !== 'SPOT' ||
        p.ticker.last.state !== 'AVAILABLE' ||
        BigInt(p.expectedRevision) >= BigInt(m.revision) ||
        p.record.rules.effectiveAt > now ||
        p.record.rules.expiresAt <= now
      )
        throw new Error('PAPER_RISK_VALUATION_MARKET');
      const times = [
        p.timestamp,
        p.ticker.receivedAt,
        p.ticker.exchangeTime,
        p.book.receivedAt,
        p.book.exchangeTime,
      ].filter((v): v is number => v !== null);
      if (times.some((t) => t > now || now - t > maxAge))
        throw new Error('PAPER_RISK_VALUATION_STALE');
      return { m, p, at: Math.min(...times) };
    });
    if (
      new Set(markets.map(({ m }) => m.id)).size !== markets.length ||
      new Set(
        markets.map(({ p }) =>
          canonical([p.key.scope, p.record.instrument.baseAsset, p.record.instrument.quoteAsset]),
        ),
      ).size !== markets.length
    )
      throw new Error('PAPER_RISK_VALUATION_MARKET');
    const used = new Set<string>();
    const prices = inventory.accounts.flatMap((a) =>
      a.state.balances
        .filter((b) => b.asset !== quote)
        .map((b) => {
          const m = markets.find(
            ({ p }) =>
              sameMarketScope(p.key.scope, a.state.binding.scope) &&
              p.record.instrument.baseAsset === b.asset &&
              p.record.instrument.quoteAsset === quote,
          );
          if (!m) throw new Error('PAPER_RISK_VALUATION_MARKET');
          used.add(m.m.id);
          return {
            accountId: a.state.binding.accountId,
            asset: b.asset,
            quote,
            price: m.p.ticker.last.state === 'AVAILABLE' ? m.p.ticker.last.value : '0',
            kind: 'LAST' as const,
            asOf: m.at,
            sourceId: m.m.id,
            scope: m.p.key.scope,
          };
        }),
    );
    if (used.size !== markets.length) throw new Error('PAPER_RISK_VALUATION_MARKET');
    const valuation = calculatePaperInventoryValuation({
      inventory,
      now,
      maxEvidenceAgeMs: maxAge,
      quote,
      prices,
    });
    const references = markets
      .map(({ m, p, at }) => ({
        id: m.id,
        revision: m.revision,
        hash: m.hash,
        dbInstrumentId: p.key.dbInstrumentId,
        dbRuleId: p.key.dbRuleId,
        asOf: at,
        expiresAt: p.record.rules.expiresAt,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const validUntil = Math.min(valuation.validUntil, ...references.map((m) => m.expiresAt));
    if (validUntil <= now) throw new Error('PAPER_RISK_VALUATION_STALE');
    return immutable({
      kind: 'PAPER_RISK_VALUATION_SOURCE',
      asOf: inventory.asOf,
      hash: createHash('sha256')
        .update(canonical({ portfolioHash: inventory.hash, markets: references, quote }))
        .digest('hex'),
      validUntil,
      inventory,
      valuation,
      markets: references,
    });
  } catch (error) {
    const code =
      error instanceof Error &&
      /^PAPER_RISK_VALUATION_(CAPACITY|CORRUPT|MARKET|STALE)$/u.test(error.message)
        ? error.message
        : 'PAPER_RISK_VALUATION_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Source payloads and SQL details stay inside the server boundary.
      cause: new Error('PAPER_RISK_VALUATION_INVALID'),
    });
  }
}
