import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { paperOwnerSchema, type PaperOwner } from './configuration-domain.js';
import { decodePaperBookSource, type PaperBookSource } from './book-source-domain.js';
import type { PaperFundingIo } from './funding-domain.js';

const envelope = z.strictObject({
  kind: z.literal('PAPER_RISK_PORTFOLIO_SOURCE'),
  owner: paperOwnerSchema,
  asOf: timestampSchema,
  accountIds: z
    .array(z.uuid().refine((v) => v === v.toLowerCase()))
    .min(1)
    .max(100),
  books: z.array(z.unknown()).min(1).max(100),
});
export interface PaperRiskPortfolioSource {
  readonly kind: 'PAPER_RISK_PORTFOLIO_SOURCE';
  readonly owner: PaperOwner;
  readonly asOf: number;
  /** Stable inventory identity; not a certificate, permission or financial grant. */
  readonly hash: string;
  readonly accountIds: readonly string[];
  readonly accounts: readonly PaperBookSource[];
}
export interface PaperRiskPortfolioReader {
  read(owner: PaperOwner, io: PaperFundingIo): Promise<PaperRiskPortfolioSource>;
  close(): Promise<void>;
}

/** Private content validation only. Complete inventory authority belongs to the
 * fixed SQL capture, never caller-provided account IDs, hashes or source values. */
export function decodePaperRiskPortfolioSource(
  raw: unknown,
  rawOwner: unknown,
  now: number,
): PaperRiskPortfolioSource {
  try {
    const owner = paperOwnerSchema.parse(rawOwner),
      w = envelope.parse(raw);
    timestampSchema.parse(now);
    if (
      Buffer.byteLength(canonical(w), 'utf8') > 1048576 ||
      w.asOf > now ||
      canonical(owner) !== canonical(w.owner) ||
      w.accountIds.length !== w.books.length ||
      new Set(w.accountIds).size !== w.accountIds.length ||
      canonical(w.accountIds) !== canonical([...w.accountIds].sort()) ||
      !w.accountIds.includes(owner.accountId)
    )
      throw new Error();
    if (now - w.asOf > 5000) throw new Error('PAPER_RISK_PORTFOLIO_STALE');
    const accounts = w.books.map((rawBook, i) => {
      const accountId = w.accountIds[i];
      if (!accountId) throw new Error();
      const book = decodePaperBookSource(rawBook, { ...owner, accountId }, now);
      if (book.asOf !== w.asOf) throw new Error();
      return book;
    });
    if (new Set(accounts.map((b) => b.bookId)).size !== accounts.length) throw new Error();
    const drafts = accounts.flatMap((b) => b.drafts);
    if (
      drafts.length > 1000 ||
      new Set(drafts.map((d) => d.orderId)).size !== drafts.length ||
      new Set(drafts.map((d) => d.intentId)).size !== drafts.length
    )
      throw new Error();
    const content = {
      kind: w.kind,
      owner,
      accountIds: w.accountIds,
      accounts: accounts.map((b) => b.hash),
    };
    return immutable({
      kind: w.kind,
      owner,
      asOf: w.asOf,
      hash: createHash('sha256').update(canonical(content)).digest('hex'),
      accountIds: w.accountIds,
      accounts,
    });
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'PAPER_RISK_PORTFOLIO_STALE'
        ? error.message
        : 'PAPER_RISK_PORTFOLIO_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Private stored account payloads must not cross the source boundary.
      cause: new Error('PAPER_RISK_PORTFOLIO_INVALID'),
    });
  }
}
