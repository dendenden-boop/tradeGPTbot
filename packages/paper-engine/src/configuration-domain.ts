import { z } from 'zod';
import { marketScopeSchema, idSchema, timestampSchema } from '@ctp/exchange-core';
import { paperModelSchema } from './model.js';

export const paperOwnerSchema = z.strictObject({
  tenantId: z.uuid().transform((v) => v.toLowerCase()),
  accountId: z.uuid().transform((v) => v.toLowerCase()),
  mode: z.literal('PAPER'),
});
export const paperConfigurationSchema = z.strictObject({
  id: z.uuid().transform((v) => v.toLowerCase()),
  owner: paperOwnerSchema,
  source: marketScopeSchema.refine((s) => s.market === 'SPOT'),
  valuationAsset: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/u),
  model: paperModelSchema,
});
export type PaperConfiguration = z.infer<typeof paperConfigurationSchema>;
export type PaperOwner = z.infer<typeof paperOwnerSchema>;
export const paperConfigurationReceiptSchema = z.strictObject({
  configuration: paperConfigurationSchema,
  accountIdentity: z.strictObject({ externalAccountId: idSchema, clientIdEpoch: idSchema }),
  createdAt: timestampSchema,
});
export type PaperConfigurationReceipt = z.infer<typeof paperConfigurationReceiptSchema>;
export interface PaperConfigurationIo {
  readonly signal: AbortSignal;
  readonly deadline: number;
}
export interface PaperConfigurationStore {
  register(
    configuration: PaperConfiguration,
    io: PaperConfigurationIo,
  ): Promise<PaperConfigurationReceipt>;
  read(owner: PaperOwner, io: PaperConfigurationIo): Promise<PaperConfigurationReceipt>;
  close(): Promise<void>;
}
