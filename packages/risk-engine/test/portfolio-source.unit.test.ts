import { expect, it } from 'vitest';
import * as risk from '../src/index.js';
import { createHash } from 'node:crypto';
import { canonical, createState, reducePortfolio } from '@ctp/portfolio';
import { binding, snapshot } from '../../portfolio/test/fixtures.js';
import { decodeRiskPortfolioSource, type RiskPortfolioScope } from '../src/portfolio-source.js';

function fixture() {
  const b = binding(),
    now = 1000;
  const state = reducePortfolio(createState(b), snapshot(), { now: () => now }).state;
  const scope: RiskPortfolioScope = {
    tenantId: b.tenantId,
    mode: b.mode,
    targetAccountId: b.accountId,
    maxEvidenceAgeMs: 5000,
  };
  const stateText = canonical(state);
  const raw = {
    scope: { tenantId: b.tenantId, mode: b.mode },
    accounts: [
      {
        id: b.accountId,
        exchange: 'BINANCE',
        region: 'global',
        externalAccountId: b.externalAccountId,
        accountMode: 'SPOT',
        status: 'DISABLED',
        permissionEpoch: '9007199254740993',
        reconciliationEpoch: '9007199254740994',
        version: 1,
      },
    ],
    books: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        accountId: b.accountId,
        wallet: b.walletId,
        revision: '9007199254740991',
        hash: createHash('sha256').update(stateText).digest('hex'),
        stateText,
        holdWatermarks: [] as {
          holdId: string;
          timestamp: string;
          fingerprint: string;
          released: boolean;
          unknown: boolean;
        }[],
      },
    ],
  };
  const replace = () => {
    raw.books[0]!.stateText = canonical(state);
    raw.books[0]!.hash = createHash('sha256').update(raw.books[0]!.stateText).digest('hex');
  };
  return { b, state, scope, raw, now, replace };
}

it('provides a physical Portfolio authority reader rather than accepting caller-owned Risk sources', () => {
  expect(risk).toHaveProperty('createPostgresRiskPortfolioReader', expect.any(Function));
});

it('preserves durable source identity and native cash balances across restart/read time without certifying health', () => {
  const f = fixture(),
    first = decodeRiskPortfolioSource(f.raw, f.scope, f.now);
  expect(decodeRiskPortfolioSource(structuredClone(f.raw), f.scope, f.now + 100)).toEqual(first);
  expect(first.books[0]?.state.balances[0]?.total).toBe('1000');
  expect(first.accounts[0]?.permissionEpoch).toBe('9007199254740993');
  expect(first.asOf).toBe(999);
  expect(first).not.toHaveProperty('complete');
  expect(first).not.toHaveProperty('decisionId');
  expect(first).not.toHaveProperty('health');
});
it.each(['tenantId', 'mode', 'targetAccountId'] as const)(
  'rejects contradictory %s scope',
  (field) => {
    const f = fixture();
    const scope = {
      ...f.scope,
      [field]: field === 'mode' ? 'DEMO' : '55555555-5555-4555-8555-555555555555',
    };
    expect(() => decodeRiskPortfolioSource(f.raw, scope, f.now)).toThrow('RISK_PORTFOLIO_SCOPE');
  },
);
it('cannot omit an owned peer account without a reconciled book', () => {
  const f = fixture();
  f.raw.accounts.push({ ...f.raw.accounts[0]!, id: '55555555-5555-4555-8555-555555555555' });
  expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow(
    'RISK_PORTFOLIO_INCOMPLETE',
  );
});
it.each(['GAP', 'AWAITING_SNAPSHOT', 'UNRECONCILED'] as const)(
  'denies %s Portfolio source',
  (status) => {
    const f = fixture();
    f.state.status = status;
    f.replace();
    expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow(
      'RISK_PORTFOLIO_INCOMPLETE',
    );
  },
);
it.each(['pending', 'differences'] as const)(
  'denies nonempty %s even if status says RECONCILED',
  (field) => {
    const f = fixture();
    f.state[field].push('unresolved');
    f.replace();
    expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow(
      'RISK_PORTFOLIO_INCOMPLETE',
    );
  },
);
it.each([998, 6000])('rejects future or expired original source at time %s', (now) => {
  const f = fixture();
  expect(() => decodeRiskPortfolioSource(f.raw, f.scope, now)).toThrow('RISK_PORTFOLIO_INCOMPLETE');
});
it('rejects changed payload despite unchanged supplied hash', () => {
  const f = fixture();
  f.raw.books[0]!.stateText += ' ';
  expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow('RISK_PORTFOLIO_CORRUPT');
});
it.each(['id', 'wallet'] as const)(
  'rejects duplicate book %s without counting its money twice',
  (field) => {
    const f = fixture();
    f.raw.books.push({
      ...f.raw.books[0]!,
      id: field === 'id' ? f.raw.books[0]!.id : '55555555-5555-4555-8555-555555555555',
    });
    expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow('RISK_PORTFOLIO_SCOPE');
  },
);
it('retains UNKNOWN commitment and its durable watermark exactly once', () => {
  const f = fixture();
  f.state.holds.push({
    id: 'hold',
    asset: 'USDT',
    amount: '10',
    status: 'UNKNOWN',
    reflected: false,
  });
  f.replace();
  f.raw.books[0]!.holdWatermarks.push({
    holdId: 'hold',
    timestamp: '1000',
    fingerprint: createHash('sha256')
      .update(canonical({ type: 'COMMITMENT', hold: f.state.holds[0] }))
      .digest('hex'),
    released: false,
    unknown: true,
  });
  expect(decodeRiskPortfolioSource(f.raw, f.scope, f.now).books[0]?.state.holds).toHaveLength(1);
  f.raw.books[0]!.holdWatermarks[0]!.released = true;
  expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow(
    'RISK_PORTFOLIO_HOLD_HISTORY',
  );
});
it('rejects a changed hold amount whose durable COMMITMENT fingerprint still names the old hold', () => {
  const f = fixture();
  f.state.holds.push({
    id: 'hold',
    asset: 'USDT',
    amount: '10',
    status: 'RESERVED',
    reflected: false,
  });
  f.raw.books[0]!.holdWatermarks.push({
    holdId: 'hold',
    timestamp: '1000',
    fingerprint: createHash('sha256')
      .update(canonical({ type: 'COMMITMENT', hold: f.state.holds[0] }))
      .digest('hex'),
    released: false,
    unknown: false,
  });
  f.replace();
  expect(decodeRiskPortfolioSource(f.raw, f.scope, f.now).books[0]?.state.holds[0]?.amount).toBe(
    '10',
  );
  f.state.holds[0]!.amount = '1';
  f.replace();
  expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow(
    'RISK_PORTFOLIO_HOLD_HISTORY',
  );
});
it('cannot weaken UNKNOWN by changing only the book or omit hold history', () => {
  const f = fixture();
  f.state.holds.push({
    id: 'hold',
    asset: 'USDT',
    amount: '10',
    status: 'RESERVED',
    reflected: false,
  });
  f.replace();
  expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow(
    'RISK_PORTFOLIO_HOLD_HISTORY',
  );
  f.raw.books[0]!.holdWatermarks.push({
    holdId: 'hold',
    timestamp: '1000',
    fingerprint: 'a'.repeat(64),
    released: false,
    unknown: true,
  });
  expect(() => decodeRiskPortfolioSource(f.raw, f.scope, f.now)).toThrow(
    'RISK_PORTFOLIO_HOLD_HISTORY',
  );
});
