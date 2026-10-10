import { expect, it } from 'vitest';
import { restorePortfolio, valuePortfolio } from '@ctp/portfolio';
import { decodePaperInitialPortfolio } from '../src/initial-portfolio-domain.js';
import { initialPortfolioWire, receiptWire } from './initial-portfolio-fixtures.js';
import type { PaperFundingReceipt } from '../src/funding-domain.js';
import type { PaperConfigurationReceipt } from '../src/configuration-domain.js';

it('sealed initial funding projects exact common Portfolio balances without a second credit', () => {
  const f = initialPortfolioWire(),
    s = decodePaperInitialPortfolio(f.wire, f.owner, 2000);
  expect(restorePortfolio(s.state)).toEqual(s.state);
  expect(s.state.binding).toMatchObject({
    mode: 'PAPER',
    connectionId: null,
    walletId: 'paper-initial:44444444-4444-4444-8444-444444444444',
  });
  expect(s.state.balances).toEqual([
    {
      asset: 'BTC',
      total: '0.000000000000000001',
      free: '0.000000000000000001',
      available: '0.000000000000000001',
      locked: '0',
    },
    {
      asset: 'USDT',
      total: '9007199254740993',
      free: '9007199254740993',
      available: '9007199254740993',
      locked: '0',
    },
  ]);
  expect(s.state.positions).toEqual([]);
  expect(s.state.holds).toEqual([]);
  expect(s.state.pending).toEqual([]);
  expect(Object.isFrozen(s.state.balances)).toBe(true);
  expect(
    valuePortfolio(
      [s.state],
      [
        {
          asset: 'BTC',
          quote: 'USDT',
          price: '1',
          kind: 'LAST',
          asOf: 2000,
          sourceId: 'real-price',
          fresh: true,
        },
      ],
      { quote: 'USDT', now: 2000, reconciledAfterRestart: true },
    ).total,
  ).toBe('9007199254740993.000000000000000001');
});
it('funded balances do not invent FX or certify a stale valuation', () => {
  const f = initialPortfolioWire(),
    s = decodePaperInitialPortfolio(f.wire, f.owner, 2000);
  expect(
    valuePortfolio([s.state], [], { quote: 'USDT', now: 2000, reconciledAfterRestart: true }).total,
  ).toBeNull();
});
it.each(['configuration', 'funding'] as const)('rejects %s wire corruption', (side) => {
  const f = initialPortfolioWire();
  f.wire[side].hash = 'a'.repeat(64);
  expect(() => decodePaperInitialPortfolio(f.wire, f.owner, 2000)).toThrow(
    'PAPER_PORTFOLIO_CORRUPT',
  );
});
it.each(['tenantId', 'accountId'] as const)('rejects different authoritative %s', (key) => {
  const f = initialPortfolioWire();
  f.owner[key] = '55555555-5555-4555-8555-555555555555';
  expect(() => decodePaperInitialPortfolio(f.wire, f.owner, 2000)).toThrow(
    'PAPER_PORTFOLIO_CORRUPT',
  );
});
it.each([
  'configurationId',
  'configurationHash',
  'ledgerTransactionId',
  'identity',
  'createdAt',
] as const)('rejects coherent wire with funding %s disagreement', (key) => {
  const f = initialPortfolioWire(),
    r = JSON.parse(f.wire.funding.receiptText) as PaperFundingReceipt;
  if (key === 'configurationId') r.funding.configurationId = '55555555-5555-4555-8555-555555555555';
  if (key === 'configurationHash') r.configurationHash = 'a'.repeat(64);
  if (key === 'ledgerTransactionId') r.ledgerTransactionId = '55555555-5555-4555-8555-555555555555';
  if (key === 'identity') r.accountIdentity.clientIdEpoch = 'replaced';
  if (key === 'createdAt') r.createdAt = 2001;
  f.wire.funding = receiptWire(r);
  expect(() => decodePaperInitialPortfolio(f.wire, f.owner, 2000)).toThrow(
    'PAPER_PORTFOLIO_CORRUPT',
  );
});
it('rejects a configuration created after its funding', () => {
  const f = initialPortfolioWire(),
    r = JSON.parse(f.wire.configuration.receiptText) as PaperConfigurationReceipt;
  r.createdAt = 1002;
  f.wire.configuration = receiptWire(r);
  const fund = JSON.parse(f.wire.funding.receiptText) as PaperFundingReceipt;
  fund.configurationHash = f.wire.configuration.hash;
  f.wire.funding = receiptWire(fund);
  expect(() => decodePaperInitialPortfolio(f.wire, f.owner, 2000)).toThrow(
    'PAPER_PORTFOLIO_CORRUPT',
  );
});
it.each([2001, -1, 0, Number.NaN, Number.MAX_SAFE_INTEGER])(
  'rejects future/invalid/stale capture %s',
  (asOf) => {
    const f = initialPortfolioWire(asOf);
    expect(() => decodePaperInitialPortfolio(f.wire, f.owner, 2000)).toThrow(
      'PAPER_PORTFOLIO_CORRUPT',
    );
  },
);
it('old source is stale even when the seed remains immutable', () => {
  const f = initialPortfolioWire();
  expect(() => decodePaperInitialPortfolio(f.wire, f.owner, 7001)).toThrow(
    'PAPER_PORTFOLIO_CORRUPT',
  );
});
it.each(['permissionEpoch', 'reconciliationEpoch'] as const)(
  'rejects rounded or negative %s',
  (key) => {
    const f = initialPortfolioWire();
    f.wire.accountState[key] = '9223372036854775808';
    expect(() => decodePaperInitialPortfolio(f.wire, f.owner, 2000)).toThrow(
      'PAPER_PORTFOLIO_CORRUPT',
    );
  },
);
it('retains lossless current epochs and has no grants/monetary postings', () => {
  const f = initialPortfolioWire();
  f.wire.accountState.permissionEpoch = '9007199254740993';
  const s = decodePaperInitialPortfolio(f.wire, f.owner, 2000);
  expect(s.accountState.permissionEpoch).toBe('9007199254740993');
  expect(Object.keys(s).sort()).toEqual([
    'accountState',
    'asOf',
    'configuration',
    'funding',
    'kind',
    'state',
  ]);
});
