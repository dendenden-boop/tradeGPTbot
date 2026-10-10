import { createHash } from 'node:crypto';
import { paperConfigurationSchema } from '../src/configuration-domain.js';
import { fixture } from './fixtures.js';
export const receiptWire = (v: unknown) => {
  const receiptText = JSON.stringify(v);
  return { receiptText, hash: createHash('sha256').update(receiptText).digest('hex') };
};
export function initialPortfolioWire(asOf = 2000) {
  const owner = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    mode: 'PAPER' as const,
  };
  const accountIdentity = { externalAccountId: 'paper-account', clientIdEpoch: 'paper-epoch' };
  const configuration = receiptWire({
    configuration: paperConfigurationSchema.parse({
      id: '33333333-3333-4333-8333-333333333333',
      owner,
      source: { exchange: 'BINANCE', market: 'SPOT', region: 'global', environment: 'LIVE' },
      valuationAsset: 'USDT',
      model: fixture().model,
    }),
    accountIdentity,
    createdAt: 1000,
  });
  const funding = receiptWire({
    funding: {
      id: '44444444-4444-4444-8444-444444444444',
      owner,
      configurationId: '33333333-3333-4333-8333-333333333333',
      balances: [
        { asset: 'BTC', amount: '0.000000000000000001' },
        { asset: 'USDT', amount: '9007199254740993' },
      ],
    },
    configurationHash: configuration.hash,
    accountIdentity,
    ledgerTransactionId: '44444444-4444-4444-8444-444444444444',
    createdAt: 1001,
  });
  return {
    owner,
    wire: {
      kind: 'INITIAL_FUNDING_ONLY' as const,
      asOf,
      accountState: { permissionEpoch: '0', reconciliationEpoch: '0', version: 0 },
      configuration,
      funding,
    },
  };
}
