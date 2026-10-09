import { expect, it } from 'vitest';
import { paperConfigurationSchema } from '../src/configuration-domain.js';
import { fixture } from './fixtures.js';

export function configurationFixture() {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    owner: {
      tenantId: '11111111-1111-4111-8111-111111111111',
      accountId: '22222222-2222-4222-8222-222222222222',
      mode: 'PAPER' as const,
    },
    source: { exchange: 'BINANCE', region: 'global', market: 'SPOT', environment: 'LIVE' },
    valuationAsset: 'USDT',
    model: fixture().model,
  };
}

it('preserves exact signed 64-bit seed and credential-free PAPER/source identity', () => {
  expect(paperConfigurationSchema.parse(configurationFixture())).toEqual(configurationFixture());
});
it.each(['TESTNET', 'DEMO', 'LIVE', null])('rejects native destination mode %s', (mode) => {
  const c = configurationFixture();
  expect(paperConfigurationSchema.safeParse({ ...c, owner: { ...c.owner, mode } }).success).toBe(
    false,
  );
});
it.each(['connectionId', 'credentials', 'tenantId', 'funding', 'resetEpoch', 'url', 'grant'])(
  'rejects untrusted extra configuration field %s',
  (key) => {
    expect(
      paperConfigurationSchema.safeParse({ ...configurationFixture(), [key]: 'untrusted' }).success,
    ).toBe(false);
  },
);
it.each(['connectionId', 'externalAccountId', 'permissions', 'environment'])(
  'rejects extra owner field %s',
  (key) => {
    const c = configurationFixture();
    expect(
      paperConfigurationSchema.safeParse({ ...c, owner: { ...c.owner, [key]: 'untrusted' } })
        .success,
    ).toBe(false);
  },
);
it.each(['LINEAR_PERPETUAL', 'INVERSE_PERPETUAL'])('rejects unsupported source %s', (market) => {
  const c = configurationFixture();
  expect(
    paperConfigurationSchema.safeParse({ ...c, source: { ...c.source, market } }).success,
  ).toBe(false);
});
it.each(['usd', '', 'A'.repeat(33), 'USDT\n'])(
  'rejects invalid valuation asset %#',
  (valuationAsset) => {
    expect(
      paperConfigurationSchema.safeParse({ ...configurationFixture(), valuationAsset }).success,
    ).toBe(false);
  },
);
it.each(['1e3', '9223372036854775808', '1\n'])('rejects noncanonical seed %#', (seed) => {
  const c = configurationFixture();
  expect(paperConfigurationSchema.safeParse({ ...c, model: { ...c.model, seed } }).success).toBe(
    false,
  );
});
it.each(['TESTNET', 'DEMO', 'LIVE'])(
  'keeps public source environment %s independent of PAPER mode',
  (environment) => {
    const c = configurationFixture();
    expect(
      paperConfigurationSchema.parse({ ...c, source: { ...c.source, environment } }),
    ).toMatchObject({ owner: { mode: 'PAPER' }, source: { environment } });
  },
);
