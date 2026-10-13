import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createState, type PortfolioState } from '@ctp/portfolio';
import { decodePaperPortfolioBootstrap } from '../src/portfolio-bootstrap-domain.js';
import { initialPortfolioWire, receiptWire } from './initial-portfolio-fixtures.js';
import type { PaperFundingReceipt } from '../src/funding-domain.js';
import type { PaperConfigurationReceipt } from '../src/configuration-domain.js';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const f = initialPortfolioWire(),
    funding = JSON.parse(f.wire.funding.receiptText) as PaperFundingReceipt;
  const state: PortfolioState = {
    ...createState({
      tenantId: f.owner.tenantId,
      accountId: f.owner.accountId,
      mode: 'PAPER',
      connectionId: null,
      externalAccountId: funding.accountIdentity.externalAccountId,
      walletId: 'paper-initial:' + funding.funding.id,
      scope: { exchange: 'BINANCE', market: 'SPOT', region: 'global', environment: 'LIVE' },
    }),
    balances: funding.funding.balances.map((b) => ({
      asset: b.asset,
      total: b.amount,
      free: b.amount,
      available: b.amount,
      locked: '0',
    })),
    status: 'RECONCILED',
    snapshotId: 'paper-bootstrap:' + funding.funding.id,
    snapshotAt: 2000,
  };
  const stateText = JSON.stringify(state);
  return {
    owner: f.owner,
    state,
    r: {
      kind: 'INITIAL_BOOK',
      bookId: funding.funding.id,
      revision: '1',
      createdAt: 2000,
      configuration: f.wire.configuration,
      funding: f.wire.funding,
      stateText,
      stateHash: digest(stateText),
    },
  };
}
it('original conserved seed decodes to one exact common Portfolio snapshot with lossless amounts', () => {
  const f = fixture(),
    r = decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 2000);
  expect(r.state).toEqual(f.state);
  expect(r.bookId).toBe(f.r.bookId);
  expect(r.revision).toBe('1');
  expect(r.state.balances[1]?.total).toBe('9007199254740993');
  expect(r.state.balances[0]?.total).toBe('0.000000000000000001');
  expect(Object.isFrozen(r.state.balances)).toBe(true);
});
it('historical receipt replay preserves its original snapshot time and grants no current Risk or freshness', () => {
  const f = fixture(),
    r = decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 200000);
  expect(r.createdAt).toBe(2000);
  expect(r.state.snapshotAt).toBe(2000);
  expect(r.kind).toBe('INITIAL_BOOK');
  for (const k of ['asOf', 'grant', 'decisionId', 'reservationId', 'expiresAt', 'permissionEpoch'])
    expect(k in r).toBe(false);
});
it.each(['kind', 'bookId', 'revision', 'createdAt', 'stateHash'] as const)(
  'rejects inconsistent bootstrap %s',
  (key) => {
    const f = fixture();
    if (key === 'kind') f.r.kind = 'CURRENT';
    if (key === 'bookId') f.r.bookId = '55555555-5555-4555-8555-555555555555';
    if (key === 'revision') f.r.revision = '2';
    if (key === 'createdAt') f.r.createdAt = 2001;
    if (key === 'stateHash') f.r.stateHash = 'a'.repeat(64);
    expect(() => decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 3000)).toThrow(
      'PAPER_BOOK_CORRUPT',
    );
  },
);
it.each(['tenantId', 'accountId'] as const)('rejects a different requested %s', (key) => {
  const f = fixture();
  f.owner[key] = '55555555-5555-4555-8555-555555555555';
  expect(() => decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 2000)).toThrow(
    'PAPER_BOOK_CORRUPT',
  );
});
it.each(['configuration', 'funding'] as const)('rejects corrupted %s wire checksum', (key) => {
  const f = fixture();
  f.r[key].hash = 'a'.repeat(64);
  expect(() => decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 2000)).toThrow(
    'PAPER_BOOK_CORRUPT',
  );
});
it('rejects an outer checksum which does not match receipt text', () => {
  const f = fixture(),
    w = receiptWire(f.r);
  w.hash = 'a'.repeat(64);
  expect(() => decodePaperPortfolioBootstrap(w, f.owner, 2000)).toThrow('PAPER_BOOK_CORRUPT');
});
it.each([
  'configurationId',
  'configurationHash',
  'ledgerTransactionId',
  'accountIdentity',
  'createdAt',
] as const)('rejects coherently hashed funding %s disagreement', (key) => {
  const f = fixture(),
    r = JSON.parse(f.r.funding.receiptText) as PaperFundingReceipt;
  if (key === 'configurationId') r.funding.configurationId = '55555555-5555-4555-8555-555555555555';
  if (key === 'configurationHash') r.configurationHash = 'a'.repeat(64);
  if (key === 'ledgerTransactionId') r.ledgerTransactionId = '55555555-5555-4555-8555-555555555555';
  if (key === 'accountIdentity') r.accountIdentity.clientIdEpoch = 'changed';
  if (key === 'createdAt') r.createdAt = 2001;
  f.r.funding = receiptWire(r);
  expect(() => decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 3000)).toThrow(
    'PAPER_BOOK_CORRUPT',
  );
});
it('configuration cannot be created after the retained seed', () => {
  const f = fixture(),
    c = JSON.parse(f.r.configuration.receiptText) as PaperConfigurationReceipt;
  c.createdAt = 1002;
  f.r.configuration = receiptWire(c);
  const r = JSON.parse(f.r.funding.receiptText) as PaperFundingReceipt;
  r.configurationHash = f.r.configuration.hash;
  f.r.funding = receiptWire(r);
  expect(() => decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 2000)).toThrow(
    'PAPER_BOOK_CORRUPT',
  );
});
it.each([
  'balance',
  'wallet',
  'connection',
  'mode',
  'source',
  'positions',
  'holds',
  'pending',
  'economicTime',
  'snapshotId',
  'status',
] as const)('rejects coherent common state with unsupported %s', (key) => {
  const f = fixture(),
    s = structuredClone(f.state);
  if (key === 'balance') {
    const b = s.balances[1];
    if (!b) throw new Error();
    b.total = b.free = b.available = '9007199254740994';
  }
  if (key === 'wallet') s.binding.walletId = 'other';
  if (key === 'connection') s.binding.connectionId = '55555555-5555-4555-8555-555555555555';
  if (key === 'mode') s.binding.mode = 'LIVE';
  if (key === 'source') s.binding.scope = { ...s.binding.scope, environment: 'TESTNET' };
  if (key === 'positions')
    s.positions = [
      {
        instrumentId: 'BTCUSDT',
        positionSide: 'NET',
        bucket: 'SPOT',
        base: 'BTC',
        quote: 'USDT',
        quantity: '1',
        basis: '1',
        realizedGross: '0',
        feesQuote: '0',
        fundingQuote: '0',
        fees: {},
        funding: {},
      },
    ];
  if (key === 'holds')
    s.holds = [
      { id: 'later-hold', asset: 'USDT', amount: '1', status: 'UNKNOWN', reflected: false },
    ];
  if (key === 'pending') s.pending = ['later-event'];
  if (key === 'economicTime') s.lastEconomicAt = 1999;
  if (key === 'snapshotId') s.snapshotId = 'other';
  if (key === 'status') s.status = 'GAP';
  f.r.stateText = JSON.stringify(s);
  f.r.stateHash = digest(f.r.stateText);
  expect(() => decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 2000)).toThrow(
    'PAPER_BOOK_CORRUPT',
  );
});
it.each([-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid observation clock %s',
  (now) => {
    const f = fixture();
    expect(() => decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, now)).toThrow(
      'PAPER_BOOK_CORRUPT',
    );
  },
);
it('future original receipt is never accepted by moving freshness to the caller clock', () => {
  const f = fixture();
  expect(() => decodePaperPortfolioBootstrap(receiptWire(f.r), f.owner, 1999)).toThrow(
    'PAPER_BOOK_CORRUPT',
  );
});
it('unknown bootstrap fields cannot silently become authority', () => {
  const f = fixture();
  expect(() =>
    decodePaperPortfolioBootstrap(
      receiptWire({ ...f.r, riskGrant: { decisionId: 'invented' } }),
      f.owner,
      2000,
    ),
  ).toThrow('PAPER_BOOK_CORRUPT');
});
it('over-capacity bootstrap response is rejected before decoding its state', () => {
  const f = fixture();
  expect(() =>
    decodePaperPortfolioBootstrap(
      { receiptText: ' '.repeat(65537), hash: 'a'.repeat(64) },
      f.owner,
      2000,
    ),
  ).toThrow('PAPER_BOOK_CORRUPT');
});
