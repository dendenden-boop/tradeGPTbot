import { z } from 'zod';
import { decimalCompare, nonNegativeAmountSchema } from './decimal.js';
import { newOrderSchema } from './domain.js';
import { idSchema, timestampSchema } from './scope.js';

/** Server-built target evidence. Parsing proves shape/semantics, never source authority. */
export const inPlaceAmendmentSchema = z
  .strictObject({
    semantics: z.literal('IN_PLACE'),
    identity: z.strictObject({
      exchangeOrderId: z.literal('PRESERVED'),
      clientOrderId: z.literal('REPLACED'),
    }),
    locator: z.strictObject({
      instrumentId: idSchema,
      locator: z.strictObject({ kind: z.literal('EXCHANGE_ID'), id: idSchema }),
    }),
    target: z.strictObject({
      internalOrderId: z.uuid(),
      placeIntentId: z.uuid(),
      revision: z.string().regex(/^[1-9][0-9]{0,63}$/),
      observedAt: timestampSchema,
      nativeUpdatedAt: timestampSchema,
      current: newOrderSchema,
      filledQuantity: nonNegativeAmountSchema,
    }),
    replacement: newOrderSchema,
  })
  .superRefine((v, ctx) => {
    const before = v.target.current,
      after = v.replacement;
    if (
      v.locator.instrumentId !== before.instrumentId ||
      before.instrumentId !== after.instrumentId ||
      before.side !== after.side ||
      before.type !== after.type ||
      before.reduceOnly !== after.reduceOnly ||
      before.timeInForce !== after.timeInForce ||
      JSON.stringify(before.trigger) !== JSON.stringify(after.trigger) ||
      before.clientOrderId === after.clientOrderId ||
      before.size.kind === 'QUOTE_BUDGET' ||
      after.size.kind === 'QUOTE_BUDGET' ||
      before.size.kind !== after.size.kind ||
      ('asset' in before.size &&
        (!('asset' in after.size) || before.size.asset !== after.size.asset)) ||
      ('contractSpecVersion' in before.size &&
        (!('contractSpecVersion' in after.size) ||
          before.size.contractSpecVersion !== after.size.contractSpecVersion)) ||
      v.target.nativeUpdatedAt > v.target.observedAt ||
      decimalCompare(v.target.filledQuantity, before.size.value) >= 0 ||
      decimalCompare(v.target.filledQuantity, after.size.value) >= 0
    )
      ctx.addIssue({ code: 'custom', message: 'INVALID_NATIVE_AMENDMENT' });
  });
export type InPlaceAmendment = z.infer<typeof inPlaceAmendmentSchema>;
