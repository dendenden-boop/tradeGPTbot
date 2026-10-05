import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import {
  decimalAdd,
  decimalSubtract,
  decimalMultiply,
  decimalCompare,
  parseDecimal,
} from '@ctp/exchange-core';
import {
  bindingSchema,
  eventSchema,
  stateSchema,
  canonical,
  type Binding,
  type PortfolioState,
  type PortfolioPosition,
  type PortfolioEvent,
  type Reduction,
  type Posting,
  type HoldWatermark,
} from './domain.js';
const D = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_EVEN,
  minE: -100,
  maxE: 100,
  toExpNeg: -100,
  toExpPos: 100,
  crypto: false,
});
const add = (a: string, b: string) => decimalAdd(parseDecimal(a), parseDecimal(b));
const sub = (a: string, b: string) => decimalSubtract(parseDecimal(a), parseDecimal(b));
const mul = (a: string, b: string) => decimalMultiply(parseDecimal(a), parseDecimal(b));
const cmp = (a: string, b: string) => decimalCompare(parseDecimal(a), parseDecimal(b));
const neg = (s: string) => sub('0', s);
const abs = (s: string) => (s.startsWith('-') ? s.slice(1) : s);
export function ratio(amount: string, numerator: string, denominator: string): string {
  if (cmp(denominator, '0') <= 0) throw new Error('INVALID_DENOMINATOR');
  const r = new D(parseDecimal(amount))
    .mul(parseDecimal(numerator))
    .div(parseDecimal(denominator))
    .toDecimalPlaces(18);
  return parseDecimal(r.isZero() ? '0' : r.toFixed());
}
export function positionKey(
  p: Pick<PortfolioPosition, 'instrumentId' | 'positionSide' | 'bucket'>,
): string {
  return JSON.stringify([p.instrumentId, p.positionSide, p.bucket]);
}
export function createState(binding: Binding): PortfolioState {
  return {
    binding: bindingSchema.parse(binding),
    balances: [],
    positions: [],
    holds: [],
    pending: [],
    status: 'AWAITING_SNAPSHOT',
    snapshotAt: null,
    snapshotId: null,
    lastEconomicAt: null,
    differences: [],
  };
}
function assertUnique<T>(items: readonly T[], key: (x: T) => string) {
  if (new Set(items.map(key)).size !== items.length) throw new Error('DUPLICATE_COMPONENT');
}
export function restorePortfolio(input: unknown): PortfolioState {
  const s = stateSchema.parse(input);
  assertUnique(s.balances, (b) => b.asset);
  assertUnique(s.positions, positionKey);
  assertUnique(s.holds, (h) => h.id);
  assertUnique(s.pending, (x) => x);
  for (const b of s.balances)
    if (b.free !== null && b.locked !== null && add(b.free, b.locked) !== b.total)
      throw new Error('BALANCE_COMPONENTS');
  for (const p of s.positions) {
    if (
      (p.quantity === '0' && p.basis !== null && p.basis !== '0') ||
      (p.positionSide === 'LONG' && p.quantity.startsWith('-')) ||
      (p.positionSide === 'SHORT' && cmp(p.quantity, '0') > 0) ||
      (s.binding.scope.market === 'SPOT' &&
        (p.positionSide !== 'NET' || p.quantity.startsWith('-')))
    )
      throw new Error('CORRUPT_POSITION');
  }
  if (Buffer.byteLength(canonical(s)) > 1048576) throw new Error('PORTFOLIO_CAPACITY');
  return s;
}
function trade(
  p: PortfolioPosition,
  signedQty: string,
  price: string,
  spot: boolean,
): string | null {
  const old = p.quantity,
    next = add(old, signedQty);
  if (
    (spot && cmp(next, '0') < 0) ||
    (p.positionSide === 'LONG' && cmp(next, '0') < 0) ||
    (p.positionSide === 'SHORT' && cmp(next, '0') > 0)
  )
    throw new Error('POSITION_DIRECTION');
  let realized: string | null = '0';
  if (old === '0' || old.startsWith('-') === signedQty.startsWith('-')) {
    p.basis = p.basis === null ? null : add(p.basis, mul(abs(signedQty), price));
  } else {
    const closing = cmp(abs(old), abs(signedQty)) <= 0 ? abs(old) : abs(signedQty);
    const allocated =
      p.basis === null ? null : closing === abs(old) ? p.basis : ratio(p.basis, closing, abs(old));
    realized =
      allocated === null
        ? null
        : old.startsWith('-')
          ? sub(allocated, mul(closing, price))
          : sub(mul(closing, price), allocated);
    if (next === '0') p.basis = '0';
    else if (old.startsWith('-') !== next.startsWith('-')) p.basis = mul(abs(next), price);
    else p.basis = p.basis === null || allocated === null ? null : sub(p.basis, allocated);
  }
  p.quantity = next;
  p.realizedGross =
    p.realizedGross === null || realized === null ? null : add(p.realizedGross, realized);
  return realized;
}
export function reducePortfolio(
  input: PortfolioState,
  raw: PortfolioEvent,
  context: { now: () => number; holdWatermark?: HoldWatermark | null },
): Reduction {
  const s = restorePortfolio(input),
    e = eventSchema.parse(raw),
    postings: Posting[] = [];
  const now = context.now();
  if (!Number.isSafeInteger(now) || e.timestamp > now) throw new Error('FUTURE_EVENT');
  let holdWatermark: HoldWatermark | undefined;
  if (e.type === 'COMMITMENT' || e.type === 'RELEASE') {
    if (context.holdWatermark === undefined) throw new Error('HOLD_HISTORY_REQUIRED');
    const previous = context.holdWatermark;
    const fingerprint = createHash('sha256')
      .update(
        canonical(
          e.type === 'COMMITMENT'
            ? { type: e.type, hold: e.hold }
            : { type: e.type, holdId: e.holdId, resolved: e.resolved },
        ),
      )
      .digest('hex');
    if (previous && e.timestamp < previous.timestamp)
      return { state: s, postings, holdWatermark: previous, ignored: true };
    if (previous && e.timestamp === previous.timestamp) {
      if (fingerprint !== previous.fingerprint) throw new Error('HOLD_VERSION_CONFLICT');
      return { state: s, postings, holdWatermark: previous, ignored: true };
    }
    if (previous?.released && e.type === 'COMMITMENT') throw new Error('HOLD_CLOSED');
    if (
      previous?.unknown &&
      (e.type === 'RELEASE' ? !e.resolved : fingerprint !== previous.fingerprint)
    )
      throw new Error('UNKNOWN_COMMITMENT');
    const active = s.holds.find((h) => h.id === (e.type === 'COMMITMENT' ? e.hold.id : e.holdId));
    if (active && !previous) throw new Error('HOLD_HISTORY_REQUIRED');
    holdWatermark = {
      timestamp: e.timestamp,
      fingerprint,
      released: e.type === 'RELEASE',
      unknown: e.type === 'COMMITMENT' && e.hold.status === 'UNKNOWN',
    };
  }
  const cash = (
    asset: string,
    amount: string,
    counter: 'EXTERNAL' | 'FEE' | 'FUNDING' = 'EXTERNAL',
  ) => {
    if (amount === '0') return;
    let b = s.balances.find((x) => x.asset === asset);
    if (!b) {
      b = { asset, total: '0', free: null, locked: null, available: null };
      s.balances.push(b);
    }
    b.total = add(b.total, amount);
    b.free = b.free === null ? null : add(b.free, amount);
    b.available = b.available === null ? null : add(b.available, amount);
    postings.push(
      { asset, bucket: 'AVAILABLE', amount },
      { asset, bucket: counter, amount: neg(amount) },
    );
  };
  if (e.type === 'GAP') {
    s.status = 'GAP';
  } else if (e.type === 'COMMITMENT') {
    const old = s.holds.findIndex((h) => h.id === e.hold.id);
    const previous = s.holds[old];
    if (previous?.status === 'UNKNOWN' && canonical(previous) !== canonical(e.hold))
      throw new Error('UNKNOWN_COMMITMENT');
    if (old < 0) s.holds.push(e.hold);
    else s.holds[old] = e.hold;
  } else if (e.type === 'RELEASE') {
    const old = s.holds.find((h) => h.id === e.holdId);
    if (old?.status === 'UNKNOWN' && !e.resolved) throw new Error('UNKNOWN_COMMITMENT');
    s.holds = s.holds.filter((h) => h.id !== e.holdId);
  } else if (e.type === 'SNAPSHOT') {
    assertUnique(e.balances, (b) => b.asset);
    assertUnique(e.positions, positionKey);
    assertUnique(e.covered, (x) => x);
    if (
      canonical([...e.covered].sort()) !== canonical([...s.pending].sort()) ||
      (s.lastEconomicAt !== null && e.timestamp < s.lastEconomicAt) ||
      (s.snapshotAt !== null && e.timestamp < s.snapshotAt)
    )
      throw new Error('INCOMPLETE_COVERAGE');
    const first = s.snapshotAt === null,
      repair = e.repairFrom !== undefined;
    if (repair && e.repairFrom !== s.snapshotId) throw new Error('RECONCILIATION_REPAIR_CONFLICT');
    s.differences = repair
      ? []
      : s.differences.filter((d) => d.startsWith('BALANCE:') || d.startsWith('POSITION_IMPORT:'));
    for (const asset of new Set([
      ...s.balances.map((b) => b.asset),
      ...e.balances.map((b) => b.asset),
    ])) {
      const delta = sub(
        e.balances.find((b) => b.asset === asset)?.total ?? '0',
        s.balances.find((b) => b.asset === asset)?.total ?? '0',
      );
      if (delta === '0') continue;
      postings.push(
        { asset, bucket: 'AVAILABLE', amount: delta },
        { asset, bucket: 'EXTERNAL', amount: neg(delta) },
      );
      if (!first && !repair && !s.differences.includes(`BALANCE:${asset}`))
        s.differences.push(`BALANCE:${asset}`);
    }
    for (const p of e.positions) {
      const old = s.positions.find((x) => positionKey(x) === positionKey(p));
      if (old) {
        if (old.base !== p.base || old.quote !== p.quote) throw new Error('POSITION_UNITS');
        if (old.quantity !== p.quantity || old.basis === null) {
          if (repair) {
            old.quantity = p.quantity;
            old.basis =
              p.quantity === '0'
                ? '0'
                : p.entryPrice === null
                  ? null
                  : mul(abs(p.quantity), p.entryPrice);
            old.realizedGross = null;
          } else if (old.quantity !== p.quantity) s.differences.push(positionKey(p));
        }
      } else {
        s.positions.push({
          instrumentId: p.instrumentId,
          positionSide: p.positionSide,
          bucket: p.bucket,
          base: p.base,
          quote: p.quote,
          quantity: p.quantity,
          basis:
            p.quantity === '0'
              ? '0'
              : p.entryPrice === null
                ? null
                : mul(abs(p.quantity), p.entryPrice),
          realizedGross: first ? '0' : null,
          feesQuote: '0',
          fundingQuote: '0',
          fees: {},
          funding: {},
        });
        if (!first && !repair) s.differences.push(`POSITION_IMPORT:${positionKey(p)}`);
      }
    }
    for (const p of s.positions)
      if (p.quantity !== '0' && !e.positions.some((x) => positionKey(x) === positionKey(p))) {
        if (repair) {
          p.quantity = '0';
          p.basis = '0';
          p.realizedGross = null;
        } else s.differences.push(positionKey(p));
      }
    if (s.binding.scope.market === 'SPOT')
      for (const p of s.positions) {
        const total = e.balances.find((b) => b.asset === p.base)?.total ?? '0';
        const inventory = s.positions
          .filter((x) => x.base === p.base)
          .reduce((n, x) => add(n, x.quantity), '0');
        if (total !== inventory && !s.differences.includes(positionKey(p)))
          s.differences.push(positionKey(p));
      }
    s.balances = e.balances;
    s.pending = [];
    s.snapshotAt = e.timestamp;
    s.snapshotId = e.id;
    s.status = s.differences.length ? 'UNRECONCILED' : 'RECONCILED';
  } else {
    if (s.snapshotAt === null) throw new Error('NEEDS_SNAPSHOT');
    if (
      e.timestamp <= s.snapshotAt ||
      (s.lastEconomicAt !== null && e.timestamp < s.lastEconomicAt)
    )
      throw new Error('OUT_OF_ORDER_ECONOMIC');
    if (s.pending.includes(e.id)) throw new Error('EVIDENCE_ALREADY_PENDING');
    if (e.type === 'FILL') {
      const key = positionKey(e);
      let p = s.positions.find((x) => positionKey(x) === key);
      if (!p) {
        p = {
          instrumentId: e.instrumentId,
          positionSide: e.positionSide,
          bucket: e.bucket,
          base: e.base,
          quote: e.quote,
          quantity: '0',
          basis: '0',
          realizedGross: '0',
          feesQuote: '0',
          fundingQuote: '0',
          fees: {},
          funding: {},
        };
        s.positions.push(p);
      }
      if (p.base !== e.base || p.quote !== e.quote) throw new Error('POSITION_UNITS');
      const spot = s.binding.scope.market === 'SPOT',
        q = e.side === 'BUY' ? e.quantity : neg(e.quantity),
        gross = trade(p, q, e.price, spot);
      if (spot) {
        cash(e.base, q);
        cash(e.quote, neg(mul(q, e.price)));
      } else if (gross !== null) cash(e.quote, gross);
      else s.status = 'UNRECONCILED';
      for (const fee of e.fees) {
        const expected =
          fee.asset === e.quote
            ? fee.amount
            : fee.asset === e.base
              ? mul(fee.amount, e.price)
              : fee.fx && fee.fx.asOf <= now && Math.abs(fee.fx.asOf - e.timestamp) <= 5000
                ? mul(fee.amount, fee.fx.rate)
                : null;
        if (fee.quoteEquivalent !== expected) throw new Error('UNPROVEN_FEE_CONVERSION');
        p.fees[fee.asset] = add(p.fees[fee.asset] ?? '0', fee.amount);
        p.feesQuote = p.feesQuote === null || expected === null ? null : add(p.feesQuote, expected);
        if (spot && fee.asset === p.base) trade(p, neg(fee.amount), e.price, true);
        else if (spot)
          for (const other of s.positions)
            if (other.base === fee.asset && other.quantity !== '0') other.basis = null;
        cash(fee.asset, neg(fee.amount), 'FEE');
      }
    } else {
      if (s.binding.scope.market === 'SPOT') throw new Error('SPOT_FUNDING_UNSUPPORTED');
      const p = s.positions.find((x) => positionKey(x) === e.positionKey);
      if (!p || p.quote !== e.asset) throw new Error('FUNDING_UNITS');
      p.funding[e.asset] = add(p.funding[e.asset] ?? '0', e.amount);
      p.fundingQuote = add(p.fundingQuote, e.amount);
      cash(e.asset, e.amount, 'FUNDING');
    }
    s.pending.push(e.id);
    s.lastEconomicAt = Math.max(s.lastEconomicAt ?? 0, e.timestamp);
  }
  return { state: restorePortfolio(s), postings, ...(holdWatermark ? { holdWatermark } : {}) };
}
