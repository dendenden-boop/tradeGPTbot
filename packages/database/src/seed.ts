import type { PrismaClient } from './generated/client.js';
import { decimalText } from './decimal.js';

export const developmentIds = Object.freeze({
  user: '019ec414-0000-7000-8000-000000000001',
  account: '019ec414-0000-7000-8000-000000000002',
  paper: '019ec414-0000-7000-8000-000000000003',
  instrument: '019ec414-0000-7000-8000-000000000004',
  rule: '019ec414-0000-7000-8000-000000000005',
});

/** Explicit development fixtures. No passwords, sessions, credentials or active trading. */
export async function seedDevelopment(client: PrismaClient): Promise<void> {
  await client.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(1900202602)`;
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${developmentIds.user}, true)`;
      await transaction.$executeRaw`
      INSERT INTO "user" (id, "emailNormalized", status, "updatedAt")
      VALUES (${developmentIds.user}::uuid, 'developer@example.invalid', 'SUSPENDED', now())
      ON CONFLICT (id) DO NOTHING`;
      await transaction.$executeRaw`
      INSERT INTO exchange_account (id, "tenantId", exchange, mode, "externalAccountId", region,
        "accountMode", status, "clientIdEpoch", "updatedAt")
      VALUES (${developmentIds.account}::uuid, ${developmentIds.user}::uuid, 'BINANCE', 'PAPER',
        'development-paper-fixture', 'development', 'SIMULATED', 'DISABLED', 'development-only', now())
      ON CONFLICT (id) DO NOTHING`;
      await transaction.$executeRaw`
      INSERT INTO paper_account (id, "tenantId", "accountId", mode, "modelVersion", seed,
        "valuationAsset", "initialCapital", "slippageModel", "feeModel")
      VALUES (${developmentIds.paper}::uuid, ${developmentIds.user}::uuid, ${developmentIds.account}::uuid,
        'PAPER', 'development-fixture-not-executable', 1, 'USDT', ${decimalText('10000', 'aggregate')}::numeric,
        '{"fixture":true}', '{"fixture":true}') ON CONFLICT (id) DO NOTHING`;
      await transaction.$executeRaw`
      INSERT INTO instrument (id, exchange, market, mode, "exchangeSymbol", "baseAsset", "quoteAsset", active, "updatedAt")
      VALUES (${developmentIds.instrument}::uuid, 'BINANCE', 'SPOT', 'PAPER', 'DEV_BTC_USDT', 'BTC', 'USDT', false, now())
      ON CONFLICT (id) DO NOTHING`;
      await transaction.$executeRaw`
      INSERT INTO instrument_rule_version (id, "instrumentId", version, "isCurrent", "effectiveAt", "fetchedAt",
        "sourceHash", "priceTick", "quantityStep", "minQuantity", rules)
      VALUES (${developmentIds.rule}::uuid, ${developmentIds.instrument}::uuid, 1, true,
        '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', decode(repeat('00',32),'hex'), 0.01, 0.000001, 0.000001,
        '{"source":"development-fixture","verifiedForTrading":false}') ON CONFLICT (id) DO NOTHING`;
    },
    { maxWait: 5000, timeout: 10000 },
  );
}
