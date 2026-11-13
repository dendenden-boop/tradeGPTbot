import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalSubtract,
  immutable,
  newOrderSchema,
  parseDecimal,
  positiveDecimalSchema,
  sameMarketScope,
  timestampSchema,
} from '@ctp/exchange-core';
import { canonical, type PortfolioState } from '@ctp/portfolio';
import { marketSnapshotPublicationSchema } from '@ctp/market-data';
import { deriveRiskExposure } from '@ctp/risk-engine';
import { openPaperAdmissionDatabase } from './admission-database.js';
import {
  lookupPaperExecutionCommitRequest,
  type PaperExecutionCommitRequest,
} from './postgres-execution-commit.js';
import { decodePaperExecutedValuationContents } from './postgres-executed-valuation.js';
import { decodePaperBookSource } from './book-source-domain.js';
import {
  paperConfigurationReceiptSchema,
  type PaperConfigurationReceipt,
} from './configuration-domain.js';
import { calculatePaperExecutedExposure } from './executed-exposure.js';
import type { PaperFundingIo } from './funding-domain.js';

export type PaperHistoricalInventoryRequest = Omit<PaperExecutionCommitRequest, 'kind'> & {
  kind: 'PAPER_HISTORICAL_INVENTORY_CAPTURE';
};
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .pipe(z.string().refine((v) => BigInt(v) <= 9223372036854775807n));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const accountState = z.strictObject({
  permissionEpoch: counter,
  reconciliationEpoch: counter,
  clientIdHighWatermark: counter,
  version: z.number().int().nonnegative().max(2147483647),
});
const packet = z.strictObject({
  kind: z.literal('PAPER_HISTORICAL_INVENTORY_CAPTURE'),
  request: z.unknown(),
  asOf: timestampSchema,
  accountIds: z.array(uuid).min(1).max(100),
  catalog: z
    .array(accountState.extend({ accountId: uuid }))
    .min(1)
    .max(100),
  executed: z.unknown(),
  books: z.array(z.strictObject({ accountId: uuid, book: z.unknown() })).max(99),
  markets: z
    .array(
      z.strictObject({
        id: uuid,
        revision: counter.refine((v) => v !== '0'),
        hash: digest,
        publicationText: z.string().min(1).max(1048576),
      }),
    )
    .max(300),
});
function fail(code = 'PAPER_ADMISSION_EVIDENCE'): never {
  throw Error(code);
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const sub = (a: string, b: string) => decimalSubtract(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));

function bounded(raw: unknown) {
  let bytes = 0,
    nodes = 0;
  const active = new WeakSet<object>();
  function visit(v: unknown, depth: number, name: string) {
    if (++nodes > 400000 || depth > 40) fail('PAPER_ADMISSION_LIMIT');
    if (typeof v === 'string') {
      if (v.length > 1048576) fail('PAPER_ADMISSION_LIMIT');
      bytes += Buffer.byteLength(v);
    } else if (v === null || typeof v === 'boolean') return;
    else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) fail();
    } else if (typeof v === 'object') {
      if (active.has(v)) fail();
      active.add(v);
      if (Array.isArray(v)) {
        const limit =
          name === 'accountIds' || name === 'catalog' || name === 'books'
            ? 100
            : name === 'markets'
              ? 300
              : 3200;
        if (v.length > limit || Reflect.ownKeys(v).length !== v.length + 1)
          fail('PAPER_ADMISSION_LIMIT');
        for (let n = 0; n < v.length; n++) {
          const d = Object.getOwnPropertyDescriptor(v, String(n));
          if (!d?.enumerable || !('value' in d)) fail();
          visit(d.value, depth + 1, name);
        }
      } else {
        const proto = Object.getPrototypeOf(v) as unknown,
          keys = Reflect.ownKeys(v);
        if ((proto !== Object.prototype && proto !== null) || keys.length > 64) fail();
        for (const k of keys) {
          if (typeof k !== 'string' || k.length > 128) fail();
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d?.enumerable || !('value' in d)) fail();
          bytes += Buffer.byteLength(k);
          visit(d.value, depth + 1, k);
        }
      }
      active.delete(v);
    } else fail();
    if (bytes > 16777216) fail('PAPER_ADMISSION_LIMIT');
  }
  visit(raw, 0, '');
}
type Account = {
  accountId: string;
  bookId: string;
  revision: string;
  sourceHash: string;
  state: PortfolioState;
  accountState: z.infer<typeof accountState>;
  configuration: PaperConfigurationReceipt;
};
function decode(raw: unknown, request: PaperExecutionCommitRequest, now: number) {
  try {
    bounded(raw);
    const w = packet.parse(raw),
      selection = { ...request, kind: 'PAPER_HISTORICAL_INVENTORY_CAPTURE' as const };
    if (!same(w.request, selection) || w.asOf > now || now - w.asOf > 5000) fail();
    const owner = {
      tenantId: request.admission.binding.tenantId,
      accountId: request.admission.binding.accountId,
      mode: 'PAPER' as const,
    };
    if (
      new Set(w.accountIds).size !== w.accountIds.length ||
      !same(w.accountIds, [...w.accountIds].sort()) ||
      !w.accountIds.includes(owner.accountId) ||
      !same(
        w.catalog.map((c) => c.accountId),
        w.accountIds,
      ) ||
      !same(
        w.books.map((b) => b.accountId),
        w.accountIds.filter((id) => id !== owner.accountId),
      )
    )
      fail();
    const catalog = new Map(w.catalog.map(({ accountId, ...state }) => [accountId, state]));
    if (catalog.get(owner.accountId)?.permissionEpoch !== request.authorization.permissionEpoch)
      fail();
    const executed = decodePaperExecutedValuationContents(w.executed, request, now);
    const historical = z
      .object({
        execution: z.object({
          input: z.unknown(),
          source: z.object({
            started: z.object({
              context: z.object({
                configuration: z.object({ receiptText: z.string().max(65536) }),
              }),
            }),
          }),
        }),
      })
      .parse(w.executed);
    const admitted = z
      .object({
        attempt: z.object({
          request: z.object({
            admission: z.object({
              dbInstrumentId: uuid,
              command: newOrderSchema,
            }),
          }),
        }),
      })
      .parse(historical.execution.input).attempt.request.admission;
    const configuration = paperConfigurationReceiptSchema.parse(
      JSON.parse(historical.execution.source.started.context.configuration.receiptText),
    );
    if (
      !same(configuration.configuration.owner, owner) ||
      configuration.configuration.id !== executed.book.content.configurationId ||
      executed.asOf > w.asOf ||
      executed.book.content.evaluatedAt > w.asOf
    )
      fail();
    const accounts: Account[] = [
      {
        accountId: owner.accountId,
        bookId: executed.book.content.book.bookId,
        revision: executed.book.content.book.revision,
        sourceHash: executed.book.hash,
        state: executed.book.content.portfolio,
        accountState: catalog.get(owner.accountId)!,
        configuration,
      },
    ];
    let draftCount = 1;
    const draftIds = new Set([request.admission.orderId]),
      intentIds = new Set([request.admission.intentId]);
    for (const b of w.books) {
      const book = decodePaperBookSource(b.book, { ...owner, accountId: b.accountId }, now);
      if (book.asOf !== w.asOf || !same(book.accountState, catalog.get(b.accountId))) fail();
      draftCount += book.drafts.length;
      if (draftCount > 1000) fail('PAPER_ADMISSION_LIMIT');
      for (const d of book.drafts) {
        if (draftIds.has(d.orderId) || intentIds.has(d.intentId)) fail();
        draftIds.add(d.orderId);
        intentIds.add(d.intentId);
      }
      accounts.push({
        accountId: b.accountId,
        bookId: book.bookId,
        revision: book.revision,
        sourceHash: book.hash,
        state: book.state,
        accountState: book.accountState,
        configuration: book.origin.configuration,
      });
    }
    accounts.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
    if (new Set(accounts.map((a) => a.bookId)).size !== accounts.length) fail();
    const quote = configuration.configuration.valuationAsset;
    if (
      accounts.some(
        (a) =>
          a.configuration.configuration.valuationAsset !== quote ||
          a.state.binding.scope.market !== 'SPOT',
      )
    )
      fail();
    const age = Math.min(
      5000,
      ...accounts.map((a) => a.configuration.configuration.model.maxEvidenceAgeMs),
    );
    let validUntil = Math.min(w.asOf + age + 1, executed.validUntil);
    const markets = w.markets.map((m) => {
      if (createHash('sha256').update(m.publicationText).digest('hex') !== m.hash) fail();
      const p = marketSnapshotPublicationSchema.parse(JSON.parse(m.publicationText));
      if (
        p.kind !== 'SNAPSHOT' ||
        p.id !== m.id ||
        p.key.scope.market !== 'SPOT' ||
        p.record.instrument.quoteAsset !== quote ||
        p.ticker.last.state !== 'AVAILABLE' ||
        BigInt(p.expectedRevision) >= BigInt(m.revision) ||
        p.record.rules.effectiveAt > now ||
        p.record.rules.expiresAt <= now
      )
        fail();
      const price = positiveDecimalSchema.parse(p.ticker.last.value);
      const times = [
        p.timestamp,
        p.ticker.exchangeTime,
        p.ticker.receivedAt,
        p.book.exchangeTime,
        p.book.receivedAt,
      ].filter((t): t is number => t !== null);
      if (times.some((t) => t > now || now - t > age)) fail('PAPER_ADMISSION_EXPIRED');
      const at = Math.min(...times);
      validUntil = Math.min(validUntil, at + age + 1, p.record.rules.expiresAt);
      return {
        m,
        p,
        price,
        at,
        reference: {
          id: m.id,
          revision: m.revision,
          hash: m.hash,
          dbInstrumentId: p.key.dbInstrumentId,
          dbRuleId: p.key.dbRuleId,
          asOf: at,
          expiresAt: p.record.rules.expiresAt,
        },
      };
    });
    if (
      new Set(markets.map((x) => x.m.id)).size !== markets.length ||
      new Set(
        markets.map((x) =>
          canonical([
            x.p.key.scope,
            x.p.record.instrument.baseAsset,
            x.p.record.instrument.quoteAsset,
          ]),
        ),
      ).size !== markets.length
    )
      fail();
    for (const ref of executed.markets) {
      const found = markets.find((x) => x.m.id === ref.id);
      if (!found || !same(ref, found.reference)) fail();
    }
    const target = markets.filter(
      (x) =>
        x.p.key.dbInstrumentId === admitted.dbInstrumentId &&
        x.p.key.instrumentId === admitted.command.instrumentId &&
        sameMarketScope(x.p.key.scope, configuration.configuration.source),
    );
    if (target.length !== 1) fail();
    const mark = target[0]!,
      used = new Set([mark.m.id]);
    const contribution = calculatePaperExecutedExposure({
      now,
      asOf: w.asOf,
      executionInput: historical.execution.input,
      currentMarket: mark.p,
    });
    const values = accounts.map((a) => {
      let equity = '0';
      const balances = a.state.balances.map((b) => {
        if (cmp(b.total, '0') < 0) fail();
        let price = '1';
        if (b.asset !== quote) {
          const found = markets.filter(
            (x) =>
              x.p.record.instrument.baseAsset === b.asset &&
              sameMarketScope(x.p.key.scope, a.configuration.configuration.source),
          );
          if (found.length !== 1) fail();
          used.add(found[0]!.m.id);
          price = found[0]!.price;
        }
        const value = mul(b.total, price),
          held = a.state.holds
            .filter((h) => h.asset === b.asset && !h.reflected)
            .reduce((n, h) => add(n, h.amount), '0'),
          spendable = b.available === null ? null : sub(b.available, held);
        if (spendable !== null && cmp(spendable, '0') < 0) fail();
        equity = add(equity, value);
        return { ...b, value, held, spendable };
      });
      return {
        accountId: a.accountId,
        equity,
        balances,
        positions: a.accountId === owner.accountId ? executed.valuation.positions : [],
      };
    });
    if (used.size !== markets.length) fail();
    const targetValue = values.find((a) => a.accountId === owner.accountId)!;
    if (targetValue.equity !== executed.valuation.equity || contribution.validUntil <= now) fail();
    validUntil = Math.min(validUntil, contribution.validUntil);
    if (validUntil <= now) fail('PAPER_ADMISSION_EXPIRED');
    const pending = contribution.pending,
      collateral = contribution.collateral;
    const effect = {
      accountId: owner.accountId,
      instrumentId: contribution.instrumentId,
      base: mark.p.record.instrument.baseAsset,
      notional: pending?.notional ?? '0',
      reductionQuantity: '0',
    };
    const scope = { tenantId: owner.tenantId, mode: 'PAPER' as const, valuationAsset: quote };
    const evidence = {
      scope,
      now,
      maxEvidenceAgeMs: age,
      accountIds: w.accountIds,
      complete: true,
      positions:
        contribution.position.quantity === '0'
          ? []
          : [
              {
                id: 'paper-position:' + executed.book.content.book.bookId,
                accountId: owner.accountId,
                instrumentId: contribution.instrumentId,
                base: mark.p.record.instrument.baseAsset,
                quantity: contribution.position.quantity,
                price: contribution.position.price,
                priceAsset: quote,
                at: mark.at,
                fx: {
                  from: quote,
                  to: quote,
                  rate: '1',
                  kind: 'IDENTITY' as const,
                  sourceId: 'paper-identity-fx',
                  at: mark.at,
                },
              },
            ],
      orders: pending ? [{ id: pending.orderId, ...effect, status: 'OPEN' as const }] : [],
      reservations:
        pending && collateral
          ? [
              {
                id: pending.reservationId,
                orderId: pending.orderId,
                ...effect,
                asset: collateral.asset,
                amount: collateral.amount,
                holdId: collateral.holdId,
                unknown: false,
              },
            ]
          : [],
      holds: collateral
        ? [
            {
              id: collateral.holdId,
              accountId: owner.accountId,
              asset: collateral.asset,
              amount: collateral.amount,
              unknown: false,
              reflected: false,
            },
          ]
        : [],
    };
    const exposure = deriveRiskExposure(
      evidence,
      scope,
      owner.accountId,
      contribution.instrumentId,
      mark.p.record.instrument.baseAsset,
    );
    const valuation = {
      quote,
      equity: values.reduce((n, a) => add(n, a.equity), '0'),
      accounts: values,
    };
    const references = markets
      .map((x) => x.reference)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return immutable({
      kind: 'PAPER_HISTORICAL_INVENTORY_SOURCE' as const,
      complete: true as const,
      availabilityComplete: values.every((a) => a.balances.every((b) => b.available !== null)),
      coverage: 'ONE_EXECUTED_BOOK_WITH_PRISTINE_SIBLINGS' as const,
      asOf: Math.min(w.asOf, ...markets.map((m) => m.at)),
      validUntil,
      accountIds: w.accountIds,
      accounts,
      valuation,
      exposure,
      evidence,
      markets: references,
      hash: hash({
        owner,
        authorization: request.authorization,
        accountIds: w.accountIds,
        accounts,
        valuation,
        exposure,
        markets: references,
      }),
    });
  } catch (error) {
    if (error instanceof Error && /^PAPER_ADMISSION_(EVIDENCE|LIMIT|EXPIRED)$/u.test(error.message))
      throw error;
    fail();
  }
}
export type PaperHistoricalInventorySource = ReturnType<typeof decode>;
// Internal content validation only; absent from every package entrypoint.
export { decode as decodePaperHistoricalInventoryContents };
export interface PaperHistoricalInventoryReader {
  read(
    request: PaperHistoricalInventoryRequest,
    io: PaperFundingIo,
  ): Promise<
    Readonly<{ kind: 'MISSING' } | { kind: 'CAPTURED'; source: PaperHistoricalInventorySource }>
  >;
  close(): Promise<void>;
}

/** Fixed server-owned readonly complete supported PAPER catalog capture. This
 * authenticates source content, not current Risk policy/loss or financial
 * authority. No adoption, mutation, retry, grant or transport permit is exposed. */
export async function createPostgresPaperHistoricalInventorySource(
  options: unknown,
): Promise<PaperHistoricalInventoryReader> {
  const database = await openPaperAdmissionDatabase(options);
  return Object.freeze({
    async read(raw: PaperHistoricalInventoryRequest, io: PaperFundingIo) {
      const request = lookupPaperExecutionCommitRequest(raw, 'PAPER_HISTORICAL_INVENTORY_CAPTURE');
      const selection = { ...request, kind: 'PAPER_HISTORICAL_INVENTORY_CAPTURE' as const };
      const result = await database.transaction(
        request.admission.binding.tenantId,
        io,
        async (sql) => {
          const rows = await sql.query<{ result: unknown }>(
            'SELECT ctp_paper.reconcile_admission($1::jsonb) AS result',
            [canonical(selection)],
          );
          if (rows.rows.length !== 1) fail();
          const value = rows.rows[0]!.result;
          bounded(value);
          const missing = z
            .strictObject({ kind: z.literal('MISSING'), request: z.unknown() })
            .safeParse(value);
          if (missing.success) {
            if (!same(missing.data.request, selection)) fail();
            return immutable({ kind: 'MISSING' as const });
          }
          return immutable({
            kind: 'CAPTURED' as const,
            source: decode(value, request, Date.now()),
          });
        },
      );
      if (io.signal.aborted || Date.now() >= io.deadline) fail('PAPER_ADMISSION_ABORTED');
      if (result.kind === 'CAPTURED' && Date.now() >= result.source.validUntil)
        fail('PAPER_ADMISSION_EXPIRED');
      return result;
    },
    close: database.close,
  });
}
