import { z } from 'zod';
import {
  instrumentRecordSchema,
  tradeTickSchema,
  timestampSchema,
  sameMarketScope,
} from '@ctp/exchange-core';
import { marketSnapshotKeySchema } from './durable-snapshots.js';
import type { IoContext } from './ports.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
// This ingestion path supports the ASCII native identifiers used by the current
// Spot profiles. Unsupported identities reject; no normalization changes them.
const nativeId = z.string().refine((v) => /^[\x21-\x7e]{1,128}$/u.exec(v)?.[0] === v);
const revision = (maximum: bigint) =>
  z.string().refine((v) => /^(0|[1-9][0-9]{0,18})$/u.exec(v)?.[0] === v && BigInt(v) <= maximum);
export const marketTradeKeySchema = marketSnapshotKeySchema
  .extend({
    dbInstrumentId: uuid,
    dbRuleId: uuid,
    instrumentId: nativeId,
  })
  .refine((k) => k.scope.market === 'SPOT');
const base = {
  id: uuid,
  key: marketTradeKeySchema,
  expectedRevision: revision(9223372036854775806n),
  timestamp: timestampSchema,
};
export const marketTradePublicationSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...base,
      kind: z.literal('TRADE'),
      record: instrumentRecordSchema,
      trade: tradeTickSchema.safeExtend({
        tradeId: nativeId,
        identityScope: nativeId,
        sourceSequence: z
          .string()
          .refine((v) => /^(0|[1-9][0-9]{0,127})$/u.exec(v)?.[0] === v)
          .nullable(),
      }),
    }),
    z.strictObject({
      ...base,
      kind: z.literal('GAP'),
      reason: z.string().refine((v) => /^[A-Z][A-Z0-9_]{0,63}$/u.exec(v)?.[0] === v),
    }),
  ])
  .superRefine((p, c) => {
    if (Buffer.byteLength(JSON.stringify(p)) > 1048576)
      c.addIssue({ code: 'custom', message: 'MARKET_TRADE_INPUT' });
    if (p.kind === 'GAP') return;
    const { instrument: i, rules: r } = p.record;
    if (
      i.status !== 'TRADING' ||
      i.id !== p.key.instrumentId ||
      r.instrumentId !== i.id ||
      p.trade.instrumentId !== i.id ||
      ![i, r, p.trade].every((v) => sameMarketScope(v.scope, p.key.scope)) ||
      p.trade.quantityUnit !== 'BASE' ||
      r.quantityUnit !== 'BASE' ||
      i.contract !== null
    )
      c.addIssue({ code: 'custom', message: 'MARKET_TRADE_INPUT' });
  });
export type MarketTradePublication = z.infer<typeof marketTradePublicationSchema>;
export type MarketTradeKey = z.infer<typeof marketTradeKeySchema>;
export const marketTradeReceiptSchema = z.strictObject({
  id: uuid,
  revision: revision(9223372036854775807n).refine((v) => v !== '0'),
  status: z.enum(['APPLIED', 'DUPLICATE', 'RESYNC_REQUIRED']),
});
export type MarketTradeReceipt = z.infer<typeof marketTradeReceiptSchema>;
export const marketTradeHeadSchema = z.strictObject({
  revision: revision(9223372036854775807n),
  gap: z.boolean(),
});
export type MarketTradeHead = z.infer<typeof marketTradeHeadSchema>;
export interface DurableMarketTrade {
  readonly id: string;
  readonly revision: string;
  readonly hash: string;
  readonly publication: Extract<MarketTradePublication, { kind: 'TRADE' }>;
}
/** Public server ingestion only. Neither a source-shaped object nor its journal
 * receipt certifies ownership, Risk, reservations or liquidity allocation. */
export interface DurableMarketTrades {
  publish(
    publication: MarketTradePublication,
    io: IoContext,
  ): Promise<Readonly<MarketTradeReceipt>>;
  read(
    key: MarketTradeKey,
    io: IoContext,
    maxAgeMs?: number,
  ): Promise<Readonly<DurableMarketTrade>>;
  /** Restart/CAS progress only. It is deliberately NOT fresh execution evidence. */
  head(key: MarketTradeKey, io: IoContext): Promise<Readonly<MarketTradeHead>>;
  close(): Promise<void>;
}
