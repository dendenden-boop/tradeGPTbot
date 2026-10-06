import { z } from 'zod';
import {
  idSchema,
  timestampSchema,
  marketScopeSchema,
  instrumentSchema,
  tradingRulesSchema,
  tickerSchema,
  orderBookSchema,
  sameMarketScope,
} from '@ctp/exchange-core';
import type { IoContext } from './ports.js';

export const marketSnapshotKeySchema = z.strictObject({
  scope: marketScopeSchema,
  instrumentId: idSchema,
  dbInstrumentId: z.uuid(),
  dbRuleId: z.uuid(),
});
export type MarketSnapshotKey = z.infer<typeof marketSnapshotKeySchema>;
const revision = (maximum: bigint) =>
  z.string().refine((v) => {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(v)) return false;
    const n = BigInt(v);
    return n.toString() === v && n <= maximum;
  });
const base = {
  id: z.uuid(),
  key: marketSnapshotKeySchema,
  expectedRevision: revision(9223372036854775806n),
  timestamp: timestampSchema,
};
export const marketSnapshotPublicationSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...base,
      kind: z.literal('GAP'),
      reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    }),
    z.strictObject({
      ...base,
      kind: z.literal('SNAPSHOT'),
      record: z.strictObject({ instrument: instrumentSchema, rules: tradingRulesSchema }),
      ticker: tickerSchema,
      book: orderBookSchema,
    }),
  ])
  .superRefine((p, c) => {
    if (p.kind === 'GAP') return;
    const records = [p.record.instrument, p.record.rules, p.ticker, p.book];
    if (
      records.some((r) => !sameMarketScope(r.scope, p.key.scope)) ||
      p.record.instrument.id !== p.key.instrumentId ||
      [p.record.rules, p.ticker, p.book].some((r) => r.instrumentId !== p.key.instrumentId) ||
      p.record.instrument.status !== 'TRADING' ||
      p.book.kind !== 'SNAPSHOT' ||
      p.book.stale ||
      p.book.previousSequence !== null ||
      p.ticker.freshness !== 'FRESH' ||
      (p.book.sourceSequence === null && p.book.exchangeTime === null) ||
      (p.book.sourceSequence !== null && !/^(0|[1-9][0-9]{0,127})$/.test(p.book.sourceSequence)) ||
      p.book.bids.length === 0 ||
      p.book.asks.length === 0 ||
      Buffer.byteLength(JSON.stringify(p)) > 1048576
    )
      c.addIssue({ code: 'custom', message: 'MARKET_EVIDENCE_INPUT' });
  });
export type MarketSnapshotPublication = z.infer<typeof marketSnapshotPublicationSchema>;
export const marketSnapshotReceiptSchema = z.strictObject({
  id: z.uuid(),
  revision: revision(9223372036854775807n).refine((v) => v !== '0'),
  status: z.enum(['APPLIED', 'DUPLICATE', 'RESYNC_REQUIRED']),
});
export type MarketSnapshotReceipt = z.infer<typeof marketSnapshotReceiptSchema>;
export interface DurableMarketSnapshot {
  readonly id: string;
  readonly revision: string;
  readonly hash: string;
  readonly publication: Extract<MarketSnapshotPublication, { kind: 'SNAPSHOT' }>;
}
/** Server Market Data publisher only. No tenant, balances, positions or Risk decisions are accepted. */
export interface DurableMarketSnapshots {
  publish(
    publication: MarketSnapshotPublication,
    io: IoContext,
  ): Promise<Readonly<MarketSnapshotReceipt>>;
  read(
    key: MarketSnapshotKey,
    io: IoContext,
    maxAgeMs?: number,
  ): Promise<Readonly<DurableMarketSnapshot>>;
  close(): Promise<void>;
}
