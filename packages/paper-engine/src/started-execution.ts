import { z } from 'zod';
import { immutable, sameMarketScope, timestampSchema } from '@ctp/exchange-core';
import { stateSchema } from '@ctp/portfolio';
import { projectPristinePaperExecutionAttempt } from './execution-attempt.js';
import type { PaperExecutionAttempt } from './execution-attempt.js';
import { calculatePaperExecutionPortfolio } from './execution-portfolio.js';
import type { PaperExecutionPortfolioCalculation } from './execution-portfolio.js';
import { paperFrameSchema } from './model.js';

const inputSchema = z.strictObject({
  now: timestampSchema,
  attempt: z.unknown(),
  frame: paperFrameSchema,
  portfolio: stateSchema,
});
export interface PaperStartedExecutionPortfolioCalculation {
  readonly kind: 'PAPER_STARTED_EXECUTION_PORTFOLIO_CALCULATION';
  readonly version: 'paper-pristine-started-portfolio-v1';
  readonly attemptId: string;
  readonly startEventId: string;
  readonly startedAt: number;
  readonly calculation: PaperExecutionPortfolioCalculation;
}
function fail(code = 'INPUT'): never {
  throw Error('PAPER_STARTED_EXECUTION_' + code);
}
function bounded(raw: unknown) {
  const active = new WeakSet<object>();
  const arrays: Record<string, number> = {
    orderTypes: 4,
    timeInForce: 4,
    leverageTiers: 64,
    asks: 1000,
    bids: 1000,
    asksUsed: 1000,
    bidsUsed: 1000,
    balances: 1000,
    positions: 1000,
    holds: 1000,
    pending: 2000,
    differences: 2000,
  };
  let nodes = 0,
    bytes = 0;
  function visit(value: unknown, depth: number, name: string) {
    if (++nodes > 200000 || depth > 24) fail();
    if (typeof value === 'string') {
      if (value.length > 1048576) fail();
      bytes += Buffer.byteLength(value);
    } else if (value === null || typeof value === 'boolean') return;
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail();
    } else if (typeof value === 'object') {
      if (active.has(value)) fail();
      active.add(value);
      if (Array.isArray(value)) {
        if (
          !Object.hasOwn(arrays, name) ||
          value.length > arrays[name]! ||
          Reflect.ownKeys(value).length !== value.length + 1
        )
          fail();
        for (let n = 0; n < value.length; n++) {
          const field = Object.getOwnPropertyDescriptor(value, String(n));
          if (!field?.enumerable || !('value' in field)) fail();
          visit(field.value, depth + 1, '');
        }
      } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) fail();
        const keys = Reflect.ownKeys(value);
        if (keys.length > 64) fail();
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 64) fail();
          const field = Object.getOwnPropertyDescriptor(value, key);
          if (!field?.enumerable || !('value' in field)) fail();
          bytes += Buffer.byteLength(key);
          visit(field.value, depth + 1, key);
        }
      }
      active.delete(value);
    } else fail();
    if (bytes > 8388608) fail();
  }
  visit(raw, 0, '');
}

/** Pure first-execution composition. START content and plain hashes authenticate
 * no storage, Risk decision, complete history or unconsumed liquidity. A fixed
 * financial writer must reconstruct inputs from current trusted storage and
 * atomically own one-use authorization, allocation, replay and monetary effects.
 * Exact recalculation is deterministic; it is never a second execution grant.
 */
export function calculatePaperStartedExecutionPortfolio(
  raw: unknown,
): PaperStartedExecutionPortfolioCalculation {
  bounded(raw);
  const checked = inputSchema.safeParse(raw);
  if (!checked.success) fail();
  const { now, attempt: content, frame, portfolio } = checked.data;
  const candidate = projectPristinePaperExecutionAttempt({ state: content, now });
  // The existing projection validates the complete state/hash/event protocol.
  const attempt = content as PaperExecutionAttempt;
  const owner = attempt.request.admission.binding,
    book = portfolio.binding;
  if (
    book.tenantId !== owner.tenantId ||
    book.accountId !== owner.accountId ||
    book.mode !== owner.mode ||
    book.connectionId !== owner.connectionId ||
    book.externalAccountId !== owner.externalAccountId ||
    !sameMarketScope(book.scope, owner.profile)
  )
    fail('SCOPE');
  if (
    portfolio.positions.length ||
    portfolio.pending.length ||
    portfolio.lastEconomicAt !== null ||
    portfolio.holds.some((hold) => hold.status === 'UNKNOWN')
  )
    fail('HISTORY');
  const calculation = calculatePaperExecutionPortfolio({
    competition: { now, frame, orders: [candidate] },
    portfolio,
  });
  return immutable({
    kind: 'PAPER_STARTED_EXECUTION_PORTFOLIO_CALCULATION',
    version: 'paper-pristine-started-portfolio-v1',
    attemptId: attempt.request.attemptId,
    startEventId: attempt.lastEvent.id,
    startedAt: candidate.submittedAt,
    calculation,
  });
}
