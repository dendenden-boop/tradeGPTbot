import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { canonical, createState, restorePortfolio, type PortfolioState } from '@ctp/portfolio';
import {
  paperOwnerSchema,
  paperConfigurationReceiptSchema,
  type PaperOwner,
  type PaperConfigurationReceipt,
} from './configuration-domain.js';
import {
  paperFundingReceiptSchema,
  type PaperFundingReceipt,
  type PaperFundingIo,
} from './funding-domain.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const wire = z.strictObject({ receiptText: z.string().max(65536), hash });
const receipt = z.strictObject({
  kind: z.literal('INITIAL_BOOK'),
  bookId: z.uuid(),
  revision: z.literal('1'),
  createdAt: timestampSchema,
  configuration: wire,
  funding: wire,
  stateText: z.string().max(32768),
  stateHash: hash,
});
export interface PaperPortfolioBootstrapReceipt {
  readonly kind: 'INITIAL_BOOK';
  readonly bookId: string;
  readonly revision: '1';
  readonly createdAt: number;
  readonly receiptHash: string;
  readonly configuration: PaperConfigurationReceipt;
  readonly funding: PaperFundingReceipt;
  readonly state: PortfolioState;
}
export interface PaperPortfolioBootstrap {
  initialize(owner: PaperOwner, io: PaperFundingIo): Promise<PaperPortfolioBootstrapReceipt>;
  read(owner: PaperOwner, io: PaperFundingIo): Promise<PaperPortfolioBootstrapReceipt>;
  close(): Promise<void>;
}
/** Content validation only. This historical projection never certifies current
 * balances/freshness, active holds or Risk. SQL owns retained original provenance. */
export function decodePaperPortfolioBootstrap(
  raw: unknown,
  rawOwner: PaperOwner,
  now: number,
): PaperPortfolioBootstrapReceipt {
  try {
    const owner = paperOwnerSchema.parse(rawOwner),
      w = wire.parse(raw);
    timestampSchema.parse(now);
    if (createHash('sha256').update(w.receiptText).digest('hex') !== w.hash) throw new Error();
    const r = receipt.parse(JSON.parse(w.receiptText));
    for (const part of [r.configuration, r.funding])
      if (createHash('sha256').update(part.receiptText).digest('hex') !== part.hash)
        throw new Error();
    const configuration = paperConfigurationReceiptSchema.parse(
        JSON.parse(r.configuration.receiptText),
      ),
      funding = paperFundingReceiptSchema.parse(JSON.parse(r.funding.receiptText));
    if (
      canonical(configuration.configuration.owner) !== canonical(owner) ||
      canonical(funding.funding.owner) !== canonical(owner) ||
      funding.funding.configurationId !== configuration.configuration.id ||
      funding.configurationHash !== r.configuration.hash ||
      funding.ledgerTransactionId !== funding.funding.id ||
      r.bookId !== funding.funding.id ||
      canonical(funding.accountIdentity) !== canonical(configuration.accountIdentity) ||
      configuration.createdAt > funding.createdAt ||
      funding.createdAt > r.createdAt ||
      r.createdAt > now ||
      createHash('sha256').update(r.stateText).digest('hex') !== r.stateHash
    )
      throw new Error();
    const state = restorePortfolio(JSON.parse(r.stateText) as unknown);
    const expected = restorePortfolio({
      ...createState({
        tenantId: owner.tenantId,
        accountId: owner.accountId,
        mode: 'PAPER',
        connectionId: null,
        externalAccountId: funding.accountIdentity.externalAccountId,
        walletId: 'paper-initial:' + funding.funding.id,
        scope: configuration.configuration.source,
      }),
      balances: funding.funding.balances.map((b) => ({
        asset: b.asset,
        total: b.amount,
        free: b.amount,
        available: b.amount,
        locked: '0',
      })),
      status: 'RECONCILED',
      snapshotId: 'paper-bootstrap:' + funding.funding.id,
      snapshotAt: r.createdAt,
    });
    if (canonical(state) !== canonical(expected)) throw new Error();
    return immutable({
      kind: r.kind,
      bookId: r.bookId,
      revision: r.revision,
      createdAt: r.createdAt,
      receiptHash: w.hash,
      configuration,
      funding,
      state,
    });
  } catch {
    throw new Error('PAPER_BOOK_CORRUPT');
  }
}
