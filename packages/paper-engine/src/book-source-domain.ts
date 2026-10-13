import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { paperOwnerSchema, type PaperOwner } from './configuration-domain.js';
import {
  decodePaperPortfolioBootstrap,
  type PaperPortfolioBootstrapReceipt,
} from './portfolio-bootstrap-domain.js';
import type { PaperFundingIo } from './funding-domain.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const draft = z.strictObject({
  orderId: z.uuid(),
  intentId: z.uuid(),
  clientOrderId: counter.refine((v) => v !== '0'),
  commandHash: hash,
  createdAt: timestampSchema,
});
const envelope = z.strictObject({
  kind: z.literal('PAPER_BOOK_SOURCE'),
  asOf: timestampSchema,
  origin: z.strictObject({ receiptText: z.string().max(65536), hash }),
  accountState: z.strictObject({
    permissionEpoch: counter,
    reconciliationEpoch: counter,
    clientIdHighWatermark: counter,
    version: z.number().int().nonnegative().max(2147483647),
  }),
  drafts: z.array(draft).max(1000),
});
export interface PaperBookSource {
  readonly kind: 'PAPER_BOOK_SOURCE';
  readonly asOf: number;
  /** Stable content identity excludes capture time; it is not authorization. */
  readonly hash: string;
  readonly bookId: string;
  readonly revision: '1';
  readonly origin: PaperPortfolioBootstrapReceipt;
  readonly state: PaperPortfolioBootstrapReceipt['state'];
  readonly accountState: z.infer<typeof envelope>['accountState'];
  readonly drafts: readonly z.infer<typeof draft>[];
}
export interface PaperBookSourceReader {
  read(owner: PaperOwner, io: PaperFundingIo): Promise<PaperBookSource>;
  close(): Promise<void>;
}
/** Private content validation. Only the fixed SQL capture proves current
 * provenance/inventory. Historical snapshot time is never rewritten here. */
export function decodePaperBookSource(
  raw: unknown,
  rawOwner: PaperOwner,
  now: number,
): PaperBookSource {
  try {
    const owner = paperOwnerSchema.parse(rawOwner),
      w = envelope.parse(raw);
    timestampSchema.parse(now);
    if (Buffer.byteLength(canonical(w), 'utf8') > 524288 || w.asOf > now) throw new Error();
    if (now - w.asOf > 5000) throw new Error('PAPER_BOOK_SOURCE_STALE');
    const origin = decodePaperPortfolioBootstrap(w.origin, owner, now);
    if (w.asOf < origin.createdAt) throw new Error();
    for (const key of ['orderId', 'intentId', 'clientOrderId'] as const)
      if (new Set(w.drafts.map((d) => d[key])).size !== w.drafts.length) throw new Error();
    let previous = 0n;
    for (const d of w.drafts) {
      const sequence = BigInt(d.clientOrderId);
      if (
        sequence <= previous ||
        sequence > BigInt(w.accountState.clientIdHighWatermark) ||
        d.createdAt < origin.configuration.createdAt ||
        d.createdAt > w.asOf
      )
        throw new Error();
      previous = sequence;
    }
    const content = {
      kind: w.kind,
      origin: w.origin,
      accountState: w.accountState,
      drafts: w.drafts,
    };
    return immutable({
      kind: w.kind,
      asOf: w.asOf,
      hash: createHash('sha256').update(canonical(content)).digest('hex'),
      bookId: origin.bookId,
      revision: origin.revision,
      origin,
      state: origin.state,
      accountState: w.accountState,
      drafts: w.drafts,
    });
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'PAPER_BOOK_SOURCE_STALE'
        ? error.message
        : 'PAPER_BOOK_SOURCE_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Private stored payloads must not cross the source boundary.
      cause: new Error('PAPER_BOOK_SOURCE_INVALID'),
    });
  }
}
