import { createHash } from 'node:crypto';
import { z } from 'zod';
import { immutable, newOrderSchema, timestampSchema, sameMarketScope } from '@ctp/exchange-core';
import { canonical } from '@ctp/portfolio';
import { marketSnapshotPublicationSchema, marketTradePublicationSchema } from '@ctp/market-data';
import { paperOwnerSchema } from './configuration-domain.js';
import { decodePaperBookSource, type PaperBookSource } from './book-source-domain.js';
import { calculatePaperRiskEnvelope } from './risk-envelope.js';
import type { PaperFundingIo } from './funding-domain.js';

export const paperOrderRiskRequestSchema = z.strictObject({
  owner: paperOwnerSchema,
  intentId: z.uuid().transform((v) => v.toLowerCase()),
});
export type PaperOrderRiskRequest = z.infer<typeof paperOrderRiskRequestSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const publication = z.strictObject({
  id: z.uuid(),
  revision: counter,
  hash: digest,
  publicationText: z.string().min(1).max(1048576),
});
const wire = z.strictObject({
  kind: z.literal('PAPER_ORDER_RISK_CAPTURE'),
  asOf: timestampSchema,
  book: z.unknown(),
  target: z.strictObject({
    orderId: z.uuid(),
    intentId: z.uuid(),
    dbInstrumentId: z.uuid(),
    dbRuleId: z.uuid(),
    bindingText: z.string().max(8192),
    commandText: z.string().max(8192),
    commandHash: digest,
  }),
  snapshot: publication,
  trade: publication,
});
type Reference = Readonly<{ id: string; revision: string; hash: string }>;
export interface PaperOrderRiskSource {
  readonly kind: 'PAPER_ORDER_RISK_SOURCE';
  readonly asOf: number;
  readonly validUntil: number;
  readonly hash: string;
  readonly request: PaperOrderRiskRequest;
  readonly book: PaperBookSource;
  readonly target: Readonly<{
    orderId: string;
    intentId: string;
    dbInstrumentId: string;
    dbRuleId: string;
    commandHash: string;
    command: z.infer<typeof newOrderSchema>;
  }>;
  readonly envelope: ReturnType<typeof calculatePaperRiskEnvelope>;
  readonly evidence: Readonly<{ snapshot: Reference; trade: Reference }>;
}
export interface PaperOrderRiskReader {
  read(request: PaperOrderRiskRequest, io: PaperFundingIo): Promise<PaperOrderRiskSource>;
  close(): Promise<void>;
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
/** Private content check. Only the fixed SQL capture proves source authority;
 * this value is never a certificate, Risk grant or allocation permission. */
export function decodePaperOrderRiskSource(
  raw: unknown,
  rawRequest: unknown,
  now: number,
): PaperOrderRiskSource {
  try {
    timestampSchema.parse(now);
    const request = paperOrderRiskRequestSchema.parse(rawRequest);
    if (Buffer.byteLength(canonical(raw)) > 1048576) throw new Error('PAPER_ORDER_RISK_CAPACITY');
    const w = wire.parse(raw),
      book = decodePaperBookSource(w.book, request.owner, now);
    if (w.asOf !== book.asOf || w.asOf > now) throw new Error();
    const cfg = book.origin.configuration.configuration,
      command = newOrderSchema.parse(JSON.parse(w.target.commandText)),
      binding: unknown = JSON.parse(w.target.bindingText);
    const expectedBinding = {
      ...request.owner,
      connectionId: null,
      externalAccountId: book.origin.configuration.accountIdentity.externalAccountId,
      profile: {
        ...cfg.source,
        accountMode: 'SIMULATED',
        endpointProfileId: 'paper-spot-v1',
        profileVersion: cfg.model.version,
      },
    };
    const d = book.drafts.find((v) => v.intentId === request.intentId);
    if (
      !d ||
      w.target.intentId !== request.intentId ||
      d.orderId !== w.target.orderId ||
      d.commandHash !== w.target.commandHash ||
      command.clientOrderId !== d.clientOrderId ||
      canonical(binding) !== canonical(expectedBinding) ||
      hash({ operation: 'createOrder', command, binding }) !== w.target.commandHash
    )
      throw new Error();
    function unpack(m: z.infer<typeof publication>) {
      if (createHash('sha256').update(m.publicationText).digest('hex') !== m.hash)
        throw new Error();
      return JSON.parse(m.publicationText) as unknown;
    }
    const s = marketSnapshotPublicationSchema.parse(unpack(w.snapshot)),
      t = marketTradePublicationSchema.parse(unpack(w.trade));
    if (
      s.kind !== 'SNAPSHOT' ||
      t.kind !== 'TRADE' ||
      s.id !== w.snapshot.id ||
      t.id !== w.trade.id ||
      BigInt(s.expectedRevision) >= BigInt(w.snapshot.revision) ||
      BigInt(t.expectedRevision) >= BigInt(w.trade.revision) ||
      canonical(s.record) !== canonical(t.record) ||
      !sameMarketScope(s.key.scope, cfg.source) ||
      !sameMarketScope(t.key.scope, cfg.source) ||
      s.key.dbInstrumentId !== w.target.dbInstrumentId ||
      t.key.dbInstrumentId !== w.target.dbInstrumentId ||
      s.key.dbRuleId !== w.target.dbRuleId ||
      t.key.dbRuleId !== w.target.dbRuleId ||
      s.key.instrumentId !== command.instrumentId ||
      t.key.instrumentId !== command.instrumentId ||
      s.ticker.last.state !== 'AVAILABLE'
    )
      throw new Error('PAPER_ORDER_RISK_MARKET');
    const age = Math.min(5000, cfg.model.maxEvidenceAgeMs);
    const times = [
      w.asOf,
      s.timestamp,
      t.timestamp,
      s.ticker.receivedAt,
      s.ticker.exchangeTime,
      s.book.receivedAt,
      s.book.exchangeTime,
      t.trade.receivedAt,
      t.trade.exchangeTime,
    ].filter((v): v is number => v !== null);
    if (times.some((v) => v > now || now - v > age)) throw new Error('PAPER_ORDER_RISK_STALE');
    const envelope = calculatePaperRiskEnvelope({
      now: w.asOf,
      model: cfg.model,
      record: s.record,
      book: s.book,
      trade: t.trade,
      order: command,
    });
    const validUntil = Math.min(envelope.validUntil, ...times.map((v) => v + age + 1));
    if (now >= validUntil) throw new Error('PAPER_ORDER_RISK_STALE');
    const ref = (v: z.infer<typeof publication>): Reference => ({
      id: v.id,
      revision: v.revision,
      hash: v.hash,
    });
    const target = { ...w.target, command };
    const { bindingText, commandText, ...safeTarget } = target;
    void bindingText;
    void commandText;
    const evidence = { snapshot: ref(w.snapshot), trade: ref(w.trade) };
    return immutable({
      kind: 'PAPER_ORDER_RISK_SOURCE',
      asOf: w.asOf,
      validUntil,
      hash: hash({ request, book: book.hash, target: safeTarget, evidence, envelope }),
      request,
      book,
      target: safeTarget,
      envelope,
      evidence,
    });
  } catch (error) {
    const code =
      error instanceof Error && /^PAPER_ORDER_RISK_(CAPACITY|MARKET|STALE)$/u.test(error.message)
        ? error.message
        : error instanceof Error && error.message === 'PAPER_BOOK_SOURCE_STALE'
          ? 'PAPER_ORDER_RISK_STALE'
          : 'PAPER_ORDER_RISK_CORRUPT';
    throw new Error(code, {
      // eslint-disable-next-line preserve-caught-error -- Never expose private stored commands or connection data.
      cause: new Error('PAPER_ORDER_RISK_INVALID'),
    });
  }
}
