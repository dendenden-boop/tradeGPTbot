import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, timestampSchema } from '@ctp/exchange-core';
import { createState, restorePortfolio, canonical, type PortfolioState } from '@ctp/portfolio';
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
const receipt = z.strictObject({ receiptText: z.string().max(8192), hash });
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const envelope = z.strictObject({
  kind: z.literal('INITIAL_FUNDING_ONLY'),
  asOf: timestampSchema,
  configuration: receipt,
  funding: receipt,
  accountState: z.strictObject({
    permissionEpoch: counter,
    reconciliationEpoch: counter,
    version: z.number().int().nonnegative().max(2147483647),
  }),
});
export interface PaperInitialPortfolioSource {
  readonly kind: 'INITIAL_FUNDING_ONLY';
  readonly asOf: number;
  readonly accountState: z.infer<typeof envelope>['accountState'];
  readonly configuration: PaperConfigurationReceipt;
  readonly funding: PaperFundingReceipt;
  readonly state: PortfolioState;
}
export interface PaperInitialPortfolioReader {
  read(owner: PaperOwner, io: PaperFundingIo): Promise<PaperInitialPortfolioSource>;
  close(): Promise<void>;
}
/** Wire/semantic validation only. SQL provenance and the server-owned reader
 * establish the source; this decoder never certifies caller data for Risk. */
export function decodePaperInitialPortfolio(
  raw: unknown,
  inputOwner: PaperOwner,
  now: number,
): PaperInitialPortfolioSource {
  try {
    const owner = paperOwnerSchema.parse(inputOwner),
      w = envelope.parse(raw);
    timestampSchema.parse(now);
    for (const r of [w.configuration, w.funding])
      if (createHash('sha256').update(r.receiptText).digest('hex') !== r.hash) throw new Error();
    const configuration = paperConfigurationReceiptSchema.parse(
      JSON.parse(w.configuration.receiptText),
    );
    const funding = paperFundingReceiptSchema.parse(JSON.parse(w.funding.receiptText));
    if (
      canonical(configuration.configuration.owner) !== canonical(owner) ||
      canonical(funding.funding.owner) !== canonical(owner) ||
      funding.funding.configurationId !== configuration.configuration.id ||
      funding.configurationHash !== w.configuration.hash ||
      funding.ledgerTransactionId !== funding.funding.id ||
      canonical(funding.accountIdentity) !== canonical(configuration.accountIdentity) ||
      configuration.createdAt > funding.createdAt ||
      funding.createdAt > w.asOf ||
      w.asOf > now ||
      now - w.asOf > 5000
    )
      throw new Error();
    const initial = createState({
      tenantId: owner.tenantId,
      accountId: owner.accountId,
      mode: 'PAPER',
      connectionId: null,
      externalAccountId: funding.accountIdentity.externalAccountId,
      walletId: 'paper-initial:' + funding.funding.id,
      scope: configuration.configuration.source,
    });
    const state = restorePortfolio({
      ...initial,
      balances: funding.funding.balances.map((b) => ({
        asset: b.asset,
        total: b.amount,
        free: b.amount,
        available: b.amount,
        locked: '0',
      })),
      status: 'RECONCILED',
      snapshotId: funding.funding.id,
      snapshotAt: w.asOf,
    });
    return immutable({
      kind: w.kind,
      asOf: w.asOf,
      accountState: w.accountState,
      configuration,
      funding,
      state,
    });
  } catch {
    throw new Error('PAPER_PORTFOLIO_CORRUPT');
  }
}
