import { z } from 'zod';
import { idSchema, positiveAmountSchema, timestampSchema } from '@ctp/exchange-core';
import { paperOwnerSchema } from './configuration-domain.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
/** Canonical ASCII asset order is semantic identity; no caller-selected buckets or FX sum. */
export const paperFundingSchema = z.strictObject({
  id: uuid,
  owner: paperOwnerSchema,
  configurationId: uuid,
  balances: z
    .array(
      z.strictObject({
        asset: z.string().refine((s) => /^[A-Z0-9][A-Z0-9._-]{0,31}$/u.exec(s)?.[0] === s),
        amount: positiveAmountSchema,
      }),
    )
    .min(1)
    .max(32)
    .refine((b) => b.every((v, i) => i === 0 || b[i - 1]!.asset < v.asset)),
});
export type PaperFunding = z.infer<typeof paperFundingSchema>;
export const paperFundingReceiptSchema = z.strictObject({
  funding: paperFundingSchema,
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/u),
  accountIdentity: z.strictObject({ externalAccountId: idSchema, clientIdEpoch: idSchema }),
  ledgerTransactionId: uuid,
  createdAt: timestampSchema,
});
export type PaperFundingReceipt = z.infer<typeof paperFundingReceiptSchema>;
export interface PaperFundingIo {
  readonly signal: AbortSignal;
  readonly deadline: number;
}
export interface PaperFundingStore {
  initialize(funding: PaperFunding, io: PaperFundingIo): Promise<PaperFundingReceipt>;
  read(owner: z.infer<typeof paperOwnerSchema>, io: PaperFundingIo): Promise<PaperFundingReceipt>;
  close(): Promise<void>;
}
