import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decimalAdd, immutable, parseDecimal, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { reconstructUtcLoss, utcLossEvidenceSchema, type UtcLossEvidence } from '@ctp/risk-engine';
import { paperOwnerSchema, type PaperOwner } from './configuration-domain.js';
import {
  decodePaperRiskPortfolioSource,
  type PaperRiskPortfolioSource,
} from './risk-portfolio-domain.js';
import type { PaperFundingIo } from './funding-domain.js';

const wire = z.strictObject({
  kind: z.literal('PAPER_RISK_LOSS_CAPTURE'),
  inventory: z.unknown(),
  fundingTimes: z
    .array(
      z.strictObject({ accountId: z.uuid(), ledgerId: z.uuid(), effectiveAt: timestampSchema }),
    )
    .min(1)
    .max(100),
});
export interface PaperRiskLossSource {
  readonly kind: 'PAPER_RISK_LOSS_SOURCE';
  readonly asOf: number;
  readonly validUntil: number;
  /** Content identity, never a certificate or permission. */
  readonly hash: string;
  readonly actualEquity: string;
  readonly inventory: PaperRiskPortfolioSource;
  readonly evidence: UtcLossEvidence;
}
export interface PaperRiskLossReader {
  read(owner: PaperOwner, io: PaperFundingIo): Promise<PaperRiskLossSource>;
  close(): Promise<void>;
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
/** Private content validation only. The fixed restricted SQL capture, not this
 * decoder or a serialized hash, proves complete retained pristine cash history. */
export function decodePaperRiskLossSource(
  raw: unknown,
  rawOwner: unknown,
  now: number,
): PaperRiskLossSource {
  try {
    timestampSchema.parse(now);
    const owner = paperOwnerSchema.parse(rawOwner);
    if (Buffer.byteLength(canonical(raw), 'utf8') > 1048576)
      throw new Error('PAPER_RISK_LOSS_CAPACITY');
    const w = wire.parse(raw),
      inventory = decodePaperRiskPortfolioSource(w.inventory, owner, now);
    if (w.fundingTimes.length !== inventory.accounts.length) throw new Error();
    const quote = inventory.accounts[0]!.origin.configuration.configuration.valuationAsset;
    const age = Math.min(
      5000,
      ...inventory.accounts.map((a) => a.origin.configuration.configuration.model.maxEvidenceAgeMs),
    );
    const day = Math.floor(inventory.asOf / 86400000) * 86400000;
    const validUntil = Math.min(inventory.asOf + age, day + 86400000);
    if (now >= validUntil) throw new Error('PAPER_RISK_LOSS_STALE');
    const funds = inventory.accounts
      .map((a, i) => {
        const f = a.origin.funding,
          balance = f.funding.balances[0]!,
          time = w.fundingTimes[i]!;
        if (
          a.origin.configuration.configuration.valuationAsset !== quote ||
          f.funding.balances.length !== 1 ||
          balance.asset !== quote
        )
          throw new Error('PAPER_RISK_LOSS_CASH_ONLY');
        if (
          time.accountId !== inventory.accountIds[i] ||
          time.ledgerId !== f.ledgerTransactionId ||
          time.effectiveAt !== f.createdAt ||
          time.effectiveAt > inventory.asOf
        )
          throw new Error();
        return { id: f.funding.id, at: time.effectiveAt, amount: balance.amount };
      })
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (new Set(funds.map((f) => f.id)).size !== funds.length) throw new Error();
    let opening = parseDecimal('0'),
      equity = parseDecimal('0');
    for (const f of funds) {
      equity = decimalAdd(equity, f.amount);
      if (f.at < day) opening = decimalAdd(opening, f.amount);
    }
    const scope = { tenantId: owner.tenantId, mode: 'PAPER' as const, valuationAsset: quote };
    const identity = hash({ scope, day, inventory: inventory.hash, funds });
    const events: UtcLossEvidence['events'] = [];
    let sequence = 1n;
    for (const f of funds.filter((f) => f.at >= day))
      events.push({
        id: 'paper:flow:' + f.id,
        sequence: String(++sequence),
        at: f.at,
        kind: 'FLOW',
        amount: f.amount,
      });
    events.push({
      id: 'paper:equity:' + hash({ identity, at: inventory.asOf, equity }),
      sequence: String(++sequence),
      at: inventory.asOf,
      kind: 'EQUITY',
      amount: equity,
    });
    const evidence = utcLossEvidenceSchema.parse({
      scope,
      utcDayStart: day,
      coveredThrough: inventory.asOf,
      complete: true,
      opening: { id: 'paper:opening:' + identity, sequence: '1', at: day, equity: opening },
      events,
    });
    const loss = reconstructUtcLoss(evidence, scope, now, age);
    if (
      loss.adjustedCurrentEquity !== opening ||
      loss.adjustedPeakEquity !== opening ||
      loss.dailyNetRealizedPnl !== '0'
    )
      throw new Error();
    return immutable({
      kind: 'PAPER_RISK_LOSS_SOURCE',
      asOf: inventory.asOf,
      validUntil,
      hash: hash({ identity, evidence }),
      actualEquity: equity,
      inventory,
      evidence,
    });
  } catch (error) {
    const code =
      error instanceof Error && /^PAPER_RISK_LOSS_(CAPACITY|STALE|CASH_ONLY)$/u.test(error.message)
        ? error.message
        : error instanceof Error && error.message === 'PAPER_RISK_PORTFOLIO_STALE'
          ? 'PAPER_RISK_LOSS_STALE'
          : 'PAPER_RISK_LOSS_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Private history and credentials must not cross the source port.
      cause: new Error('PAPER_RISK_LOSS_INVALID'),
    });
  }
}
