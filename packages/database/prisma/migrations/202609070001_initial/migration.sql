-- Generated from the 59-model schema; reviewed RANGE partition addition for candles.
BEGIN;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'TESTNET', 'DEMO', 'LIVE');

-- CreateEnum
CREATE TYPE "Exchange" AS ENUM ('BINANCE', 'BYBIT', 'OKX', 'HTX');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('SPOT', 'MARGIN', 'PERPETUAL', 'FUTURES', 'OPTION');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'RECONCILIATION_REQUIRED', 'DISABLED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETION_REQUESTED', 'PSEUDONYMIZED');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('NET', 'LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT_MARKET', 'TAKE_PROFIT_LIMIT', 'TRAILING_STOP');

-- CreateEnum
CREATE TYPE "TimeInForce" AS ENUM ('GTC', 'IOC', 'FOK', 'POST_ONLY');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'RISK_APPROVED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'EXPIRED', 'UNKNOWN', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "ReconciliationState" AS ENUM ('REQUIRED', 'IN_PROGRESS', 'CONSISTENT', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "IntentOrigin" AS ENUM ('USER', 'STRATEGY', 'EXTERNAL', 'RISK_REDUCTION');

-- CreateEnum
CREATE TYPE "Destination" AS ENUM ('PAPER_ENGINE', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "SubmissionOperation" AS ENUM ('PLACE', 'CANCEL', 'AMEND');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('DISPATCHING', 'ACKNOWLEDGED', 'REJECTED', 'UNKNOWN', 'RECONCILED');

-- CreateEnum
CREATE TYPE "StrategyStatus" AS ENUM ('DRAFT', 'STOPPED', 'STARTING', 'RUNNING', 'PAUSED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "RiskVerdict" AS ENUM ('APPROVE', 'REJECT', 'REDUCE_ONLY');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "RiskScope" AS ENUM ('USER', 'ACCOUNT', 'STRATEGY', 'INSTRUMENT');

-- CreateEnum
CREATE TYPE "LedgerCause" AS ENUM ('FILL', 'FEE', 'FUNDING', 'DEPOSIT', 'WITHDRAWAL_OBSERVED', 'TRANSFER', 'PAPER_SEED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerBucket" AS ENUM ('AVAILABLE', 'RESERVED', 'POSITION', 'FEE', 'FUNDING', 'EXTERNAL', 'EQUITY');

-- CreateEnum
CREATE TYPE "LiquidityRole" AS ENUM ('MAKER', 'TAKER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FeeKind" AS ENUM ('CHARGE', 'REBATE');

-- CreateEnum
CREATE TYPE "DataQuality" AS ENUM ('VERIFIED', 'PROVISIONAL', 'GAP', 'INVALID');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "CircuitStatus" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "emailNormalized" VARCHAR(320),
    "passwordHash" VARCHAR(512),
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "passwordChangedAt" TIMESTAMPTZ(3),
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "deletionRequestedAt" TIMESTAMPTZ(3),
    "pseudonymizedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "stepUpAt" TIMESTAMPTZ(3),
    "sessionEpoch" INTEGER NOT NULL,
    "userAgentHash" BYTEA,
    "ipPrefixHash" BYTEA,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "emailNormalized" VARCHAR(320) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "sessionEpoch" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "kmsKeyId" VARCHAR(512) NOT NULL,
    "kmsKeyVersion" VARCHAR(256) NOT NULL,
    "encryptionVersion" INTEGER NOT NULL,
    "aadVersion" INTEGER NOT NULL,
    "lastAcceptedStep" BIGINT,
    "enabledAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_code" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "twoFactorConfigId" UUID NOT NULL,
    "codeHash" BYTEA NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "exchange" "Exchange" NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "externalAccountId" VARCHAR(128) NOT NULL,
    "region" VARCHAR(32) NOT NULL,
    "accountMode" VARCHAR(32) NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING',
    "reconciliationEpoch" BIGINT NOT NULL DEFAULT 0,
    "permissionEpoch" BIGINT NOT NULL DEFAULT 0,
    "clientIdEpoch" VARCHAR(64) NOT NULL,
    "clientIdHighWatermark" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "reconciledAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_connection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING',
    "permissionsVersion" INTEGER NOT NULL DEFAULT 0,
    "permissionsVerifiedAt" TIMESTAMPTZ(3),
    "permissions" JSONB NOT NULL,
    "withdrawalPermissionDetected" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encrypted_credential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "kmsKeyId" VARCHAR(512) NOT NULL,
    "kmsKeyVersion" VARCHAR(256) NOT NULL,
    "encryptionVersion" INTEGER NOT NULL,
    "aadVersion" INTEGER NOT NULL,
    "activatedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encrypted_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_grant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "riskProfileId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'LIVE',
    "credentialVersion" INTEGER NOT NULL,
    "permissionsVersion" INTEGER NOT NULL,
    "riskPolicyVersion" INTEGER NOT NULL,
    "permissionEpoch" BIGINT NOT NULL,
    "stepUpAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exchange" "Exchange" NOT NULL,
    "market" "MarketType" NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "exchangeSymbol" VARCHAR(128) NOT NULL,
    "baseAsset" VARCHAR(32) NOT NULL,
    "quoteAsset" VARCHAR(32) NOT NULL,
    "settlementAsset" VARCHAR(32),
    "expiryAt" TIMESTAMPTZ(3),
    "isInverse" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_rule_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instrumentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceHash" BYTEA NOT NULL,
    "priceTick" DECIMAL NOT NULL,
    "quantityStep" DECIMAL NOT NULL,
    "minQuantity" DECIMAL NOT NULL,
    "maxQuantity" DECIMAL,
    "minNotional" DECIMAL,
    "contractSize" DECIMAL,
    "contractUnit" VARCHAR(32),
    "rules" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instrument_rule_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exchange" "Exchange" NOT NULL,
    "market" "MarketType" NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "region" VARCHAR(32) NOT NULL,
    "accountMode" VARCHAR(32) NOT NULL,
    "version" INTEGER NOT NULL,
    "profileVersion" VARCHAR(64) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "capabilities" JSONB NOT NULL,
    "evidenceHash" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capability_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "stateVersionId" UUID NOT NULL,
    "asset" VARCHAR(32) NOT NULL,
    "total" DECIMAL NOT NULL,
    "available" DECIMAL NOT NULL,
    "reserved" DECIMAL NOT NULL,
    "borrowed" DECIMAL NOT NULL DEFAULT 0,
    "sourceAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "instrumentId" UUID NOT NULL,
    "ruleVersionId" UUID NOT NULL,
    "positionSide" "PositionSide" NOT NULL,
    "positionBucket" VARCHAR(64) NOT NULL,
    "asset" VARCHAR(32) NOT NULL,
    "quantity" DECIMAL NOT NULL DEFAULT 0,
    "averageEntryPrice" DECIMAL NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL NOT NULL DEFAULT 0,
    "unrealizedPnl" DECIMAL NOT NULL DEFAULT 0,
    "feesPaid" DECIMAL NOT NULL DEFAULT 0,
    "fundingPaid" DECIMAL NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "sourceAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_state_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "version" BIGINT NOT NULL,
    "sourceCursor" VARCHAR(512) NOT NULL,
    "sourceAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "reconciledAt" TIMESTAMPTZ(3),
    "reconciliationEpoch" BIGINT NOT NULL,
    "stateHash" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_state_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transaction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "cause" "LedgerCause" NOT NULL,
    "causeIdentity" VARCHAR(256) NOT NULL,
    "fillId" UUID,
    "fundingPaymentId" UUID,
    "correctionOfId" UUID,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "postedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "descriptionCode" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "entryIndex" INTEGER NOT NULL,
    "asset" VARCHAR(32) NOT NULL,
    "bucket" "LedgerBucket" NOT NULL,
    "amount" DECIMAL NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_valuation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "ledgerTransactionId" UUID,
    "instrumentId" UUID,
    "baseAsset" VARCHAR(32) NOT NULL,
    "quoteAsset" VARCHAR(32) NOT NULL,
    "price" DECIMAL NOT NULL,
    "baseAmount" DECIMAL NOT NULL,
    "quoteAmount" DECIMAL NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "sourceIdentity" VARCHAR(256) NOT NULL,
    "valuedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_valuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_intent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "connectionId" UUID,
    "instrumentId" UUID NOT NULL,
    "ruleVersionId" UUID NOT NULL,
    "signalId" UUID,
    "origin" "IntentOrigin" NOT NULL,
    "destination" "Destination" NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "commandHash" BYTEA NOT NULL,
    "side" "OrderSide" NOT NULL,
    "positionSide" "PositionSide" NOT NULL DEFAULT 'NET',
    "orderType" "OrderType" NOT NULL,
    "timeInForce" "TimeInForce",
    "quantityAsset" VARCHAR(32) NOT NULL,
    "priceAsset" VARCHAR(32) NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "limitPrice" DECIMAL,
    "triggerPrice" DECIMAL,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" BYTEA NOT NULL,
    "intentId" UUID,
    "responseCode" INTEGER,
    "responseResourceId" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "retainUntil" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "connectionId" UUID,
    "instrumentId" UUID NOT NULL,
    "ruleVersionId" UUID NOT NULL,
    "parentAlgoOrderId" UUID,
    "tradeId" UUID,
    "clientIdNamespace" VARCHAR(64) NOT NULL,
    "clientId" VARCHAR(128) NOT NULL,
    "exchangeOrderId" VARCHAR(128),
    "market" "MarketType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "reconciliationState" "ReconciliationState" NOT NULL DEFAULT 'REQUIRED',
    "side" "OrderSide" NOT NULL,
    "positionSide" "PositionSide" NOT NULL DEFAULT 'NET',
    "orderType" "OrderType" NOT NULL,
    "timeInForce" "TimeInForce",
    "quantityAsset" VARCHAR(32) NOT NULL,
    "priceAsset" VARCHAR(32) NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "filledQuantity" DECIMAL NOT NULL DEFAULT 0,
    "limitPrice" DECIMAL,
    "averageFillPrice" DECIMAL NOT NULL DEFAULT 0,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastExchangeAt" TIMESTAMPTZ(3),
    "terminalAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "algo_order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "instrumentId" UUID NOT NULL,
    "algoKind" VARCHAR(32) NOT NULL,
    "exchangeAlgoId" VARCHAR(128),
    "triggerSource" VARCHAR(32) NOT NULL,
    "triggerPrice" DECIMAL,
    "trailingRate" DECIMAL,
    "triggeredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "algo_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_attempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "operationVersion" INTEGER NOT NULL,
    "operation" "SubmissionOperation" NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'DISPATCHING',
    "permissionEpoch" BIGINT NOT NULL,
    "reservationId" UUID,
    "workerId" VARCHAR(128) NOT NULL,
    "commandHash" BYTEA NOT NULL,
    "permitConsumedAt" TIMESTAMPTZ(3) NOT NULL,
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "transportStartedAt" TIMESTAMPTZ(3),
    "responseReceivedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "responseCode" VARCHAR(64),
    "evidenceHash" BYTEA,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "attemptId" UUID,
    "version" INTEGER NOT NULL,
    "previousStatus" "OrderStatus",
    "status" "OrderStatus" NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "sourceIdentity" VARCHAR(256) NOT NULL,
    "evidenceHash" BYTEA NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "instrumentId" UUID NOT NULL,
    "strategyRunId" UUID,
    "positionSide" "PositionSide" NOT NULL,
    "pnlAsset" VARCHAR(32) NOT NULL,
    "grossPnl" DECIMAL NOT NULL DEFAULT 0,
    "netPnl" DECIMAL NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "instrumentId" UUID NOT NULL,
    "ruleVersionId" UUID NOT NULL,
    "tradeId" UUID,
    "market" "MarketType" NOT NULL,
    "executionIdentity" VARCHAR(256) NOT NULL,
    "exchangeTradeId" VARCHAR(128),
    "side" "OrderSide" NOT NULL,
    "liquidityRole" "LiquidityRole" NOT NULL DEFAULT 'UNKNOWN',
    "baseAsset" VARCHAR(32) NOT NULL,
    "quoteAsset" VARCHAR(32) NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "price" DECIMAL NOT NULL,
    "quoteAmount" DECIMAL NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "evidenceHash" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "fillId" UUID NOT NULL,
    "ledgerTransactionId" UUID,
    "feeIdentity" VARCHAR(128) NOT NULL,
    "asset" VARCHAR(32) NOT NULL,
    "kind" "FeeKind" NOT NULL,
    "amount" DECIMAL NOT NULL,
    "rate" DECIMAL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "instrumentId" UUID NOT NULL,
    "positionId" UUID,
    "paymentIdentity" VARCHAR(256) NOT NULL,
    "asset" VARCHAR(32) NOT NULL,
    "amount" DECIMAL NOT NULL,
    "rate" DECIMAL NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_definition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "implementationHash" BYTEA NOT NULL,
    "parameterSchemaVersion" INTEGER NOT NULL,
    "minimumWarmupBars" INTEGER NOT NULL,
    "allowedMarkets" "MarketType"[],
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_parameter" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "definitionId" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "valueType" VARCHAR(32) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "defaultValue" JSONB,
    "validation" JSONB NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_parameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_instance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "definitionId" UUID NOT NULL,
    "riskProfileId" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "status" "StrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "parameters" JSONB NOT NULL,
    "instrumentSelection" JSONB NOT NULL,
    "selectionHash" BYTEA NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "definitionId" UUID NOT NULL,
    "instanceVersion" INTEGER NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "parametersSnapshot" JSONB NOT NULL,
    "instrumentSnapshot" JSONB NOT NULL,
    "modelVersion" VARCHAR(64) NOT NULL,
    "inputCursor" VARCHAR(512),
    "inputVersion" BIGINT NOT NULL DEFAULT 0,
    "seed" BIGINT NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "failureCode" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,
    "inputCursor" VARCHAR(512) NOT NULL,
    "state" JSONB NOT NULL,
    "stateHash" BYTEA NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "instrumentId" UUID NOT NULL,
    "ruleVersionId" UUID NOT NULL,
    "inputIdentity" VARCHAR(256) NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "signalKind" VARCHAR(64) NOT NULL,
    "side" "OrderSide",
    "payloadSchemaVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "commandHash" BYTEA NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL,
    "policyHash" BYTEA NOT NULL,
    "valuationAsset" VARCHAR(32) NOT NULL,
    "maxNotional" DECIMAL NOT NULL,
    "maxDailyLoss" DECIMAL NOT NULL,
    "maxDrawdownRate" DECIMAL NOT NULL,
    "maxOpenOrders" INTEGER NOT NULL,
    "policy" JSONB NOT NULL,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "retiredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_decision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "profileId" UUID NOT NULL,
    "stateVersionId" UUID NOT NULL,
    "ruleVersionId" UUID NOT NULL,
    "capabilitySnapshotId" UUID NOT NULL,
    "verdict" "RiskVerdict" NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "commandHash" BYTEA NOT NULL,
    "reasonCodes" TEXT[],
    "permissionEpoch" BIGINT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "decisionId" UUID,
    "accountId" UUID,
    "profileId" UUID,
    "scope" "RiskScope" NOT NULL,
    "scopeKey" VARCHAR(256) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "severity" "Severity" NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "details" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_reservation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "decisionId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "budgetId" UUID NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "asset" VARCHAR(32) NOT NULL,
    "amount" DECIMAL NOT NULL,
    "consumedAmount" DECIMAL NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_budget" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID,
    "profileId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "scope" "RiskScope" NOT NULL,
    "scopeKey" VARCHAR(256) NOT NULL,
    "asset" VARCHAR(32) NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "limitAmount" DECIMAL NOT NULL,
    "reservedAmount" DECIMAL NOT NULL DEFAULT 0,
    "consumedAmount" DECIMAL NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_pause" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID,
    "strategyInstanceId" UUID,
    "instrumentId" UUID,
    "scope" "RiskScope" NOT NULL,
    "scopeKey" VARCHAR(256) NOT NULL,
    "epoch" BIGINT NOT NULL,
    "reasonCode" VARCHAR(64) NOT NULL,
    "initiator" VARCHAR(64) NOT NULL,
    "pausedAt" TIMESTAMPTZ(3) NOT NULL,
    "resumedAt" TIMESTAMPTZ(3),
    "evidenceHash" BYTEA,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_pause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circuit_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID,
    "scope" "RiskScope" NOT NULL,
    "scopeKey" VARCHAR(256) NOT NULL,
    "circuitKey" VARCHAR(64) NOT NULL,
    "status" "CircuitStatus" NOT NULL DEFAULT 'OPEN',
    "epoch" BIGINT NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMPTZ(3),
    "nextProbeAt" TIMESTAMPTZ(3),
    "reasonCode" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "circuit_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "modelVersion" VARCHAR(64) NOT NULL,
    "seed" BIGINT NOT NULL,
    "valuationAsset" VARCHAR(32) NOT NULL,
    "initialCapital" DECIMAL NOT NULL,
    "slippageModel" JSONB NOT NULL,
    "feeModel" JSONB NOT NULL,
    "resetEpoch" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paperAccountId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "modelVersion" VARCHAR(64) NOT NULL,
    "seed" BIGINT NOT NULL,
    "inputIdentity" VARCHAR(256) NOT NULL,
    "eligibleAfter" TIMESTAMPTZ(3) NOT NULL,
    "slippageRate" DECIMAL NOT NULL,
    "simulationEvidenceHash" BYTEA,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_position" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "paperAccountId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "modelVersion" VARCHAR(64) NOT NULL,
    "resetEpoch" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "datasetManifestId" UUID NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "parameters" JSONB NOT NULL,
    "parametersHash" BYTEA NOT NULL,
    "rulesManifestHash" BYTEA NOT NULL,
    "engineVersion" VARCHAR(64) NOT NULL,
    "slippageModelVersion" VARCHAR(64) NOT NULL,
    "feeModelVersion" VARCHAR(64) NOT NULL,
    "seed" BIGINT NOT NULL,
    "valuationAsset" VARCHAR(32) NOT NULL,
    "initialCapital" DECIMAL NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "artifactUri" VARCHAR(2048),
    "artifactHash" BYTEA,
    "failureCode" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_trade" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "backtestId" UUID NOT NULL,
    "instrumentId" UUID NOT NULL,
    "ruleVersionId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "side" "OrderSide" NOT NULL,
    "baseAsset" VARCHAR(32) NOT NULL,
    "quoteAsset" VARCHAR(32) NOT NULL,
    "pnlAsset" VARCHAR(32) NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "entryPrice" DECIMAL NOT NULL,
    "exitPrice" DECIMAL,
    "netPnl" DECIMAL NOT NULL,
    "fees" DECIMAL NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_metric" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "backtestId" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "value" DECIMAL NOT NULL,
    "sampleCount" BIGINT NOT NULL,
    "calculationVersion" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_manifest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "artifactUri" VARCHAR(2048) NOT NULL,
    "artifactHash" BYTEA NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "sourceVersion" VARCHAR(128) NOT NULL,
    "rulesManifestHash" BYTEA NOT NULL,
    "quality" "DataQuality" NOT NULL,
    "rowCount" BIGINT NOT NULL,
    "provenance" JSONB NOT NULL,
    "sealedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_manifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candle" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instrumentId" UUID NOT NULL,
    "ruleVersionId" UUID NOT NULL,
    "timeframeSeconds" INTEGER NOT NULL,
    "openTime" TIMESTAMPTZ(3) NOT NULL,
    "closeTime" TIMESTAMPTZ(3) NOT NULL,
    "open" DECIMAL NOT NULL,
    "high" DECIMAL NOT NULL,
    "low" DECIMAL NOT NULL,
    "close" DECIMAL NOT NULL,
    "baseVolume" DECIMAL NOT NULL,
    "quoteVolume" DECIMAL NOT NULL,
    "tradeCount" BIGINT NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "quality" "DataQuality" NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "sourceHash" BYTEA NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candle_pkey" PRIMARY KEY ("id","openTime")
) PARTITION BY RANGE ("openTime");

-- CreateTable
CREATE TABLE "market_gap" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instrumentId" UUID NOT NULL,
    "stream" VARCHAR(64) NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3),
    "expectedCursor" VARCHAR(512),
    "observedCursor" VARCHAR(512),
    "reasonCode" VARCHAR(64) NOT NULL,
    "repairedAt" TIMESTAMPTZ(3),
    "repairEvidenceHash" BYTEA,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_gap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_checkpoint" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instrumentId" UUID NOT NULL,
    "stream" VARCHAR(64) NOT NULL,
    "cursor" VARCHAR(512) NOT NULL,
    "eventAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceRevision" BIGINT NOT NULL,
    "ownerEpoch" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instrumentId" UUID NOT NULL,
    "stream" VARCHAR(64) NOT NULL,
    "workerId" VARCHAR(128) NOT NULL,
    "ownerEpoch" BIGINT NOT NULL,
    "leaseExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "eventType" VARCHAR(128) NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "aggregateType" VARCHAR(64) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "aggregateVersion" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" VARCHAR(128),
    "claimExpiresAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_inbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "consumer" VARCHAR(128) NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" VARCHAR(128) NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "payloadHash" BYTEA NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainUntil" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumer_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "eventId" UUID,
    "channel" VARCHAR(32) NOT NULL,
    "templateKey" VARCHAR(64) NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "parameters" JSONB NOT NULL,
    "deduplicationKey" VARCHAR(256) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "readAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "actorType" VARCHAR(32) NOT NULL,
    "actorIdentity" VARCHAR(128) NOT NULL,
    "action" VARCHAR(128) NOT NULL,
    "resourceType" VARCHAR(64) NOT NULL,
    "resourceId" UUID,
    "requestId" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "details" JSONB NOT NULL,
    "previousHash" BYTEA,
    "entryHash" BYTEA NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service" VARCHAR(64) NOT NULL,
    "eventType" VARCHAR(128) NOT NULL,
    "severity" "Severity" NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "correlationId" VARCHAR(128),
    "details" JSONB NOT NULL,
    "evidenceHash" BYTEA,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "connectionId" UUID,
    "market" "MarketType" NOT NULL,
    "epoch" BIGINT NOT NULL,
    "state" "ReconciliationState" NOT NULL DEFAULT 'REQUIRED',
    "trigger" VARCHAR(64) NOT NULL,
    "startCursor" VARCHAR(512),
    "endCursor" VARCHAR(512),
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "unresolvedCount" INTEGER NOT NULL DEFAULT 0,
    "evidenceHash" BYTEA,
    "failureCode" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_emailNormalized_key" ON "user"("emailNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "user_session_tokenHash_key" ON "user_session"("tokenHash");

-- CreateIndex
CREATE INDEX "user_session_tenantId_revokedAt_expiresAt_idx" ON "user_session"("tenantId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_session_tenantId_id_key" ON "user_session"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_token_tokenHash_key" ON "email_verification_token"("tokenHash");

-- CreateIndex
CREATE INDEX "email_verification_token_tenantId_expiresAt_idx" ON "email_verification_token"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_token_tenantId_id_key" ON "email_verification_token"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_tokenHash_key" ON "password_reset_token"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_token_tenantId_expiresAt_idx" ON "password_reset_token"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_tenantId_id_key" ON "password_reset_token"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_config_tenantId_id_key" ON "two_factor_config"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_config_tenantId_key" ON "two_factor_config"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_code_codeHash_key" ON "recovery_code"("codeHash");

-- CreateIndex
CREATE INDEX "recovery_code_tenantId_twoFactorConfigId_idx" ON "recovery_code"("tenantId", "twoFactorConfigId");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_code_tenantId_id_key" ON "recovery_code"("tenantId", "id");

-- CreateIndex
CREATE INDEX "exchange_account_tenantId_status_idx" ON "exchange_account"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_account_tenantId_id_key" ON "exchange_account"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_account_tenantId_id_mode_key" ON "exchange_account"("tenantId", "id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_account_tenantId_exchange_mode_region_externalAcco_key" ON "exchange_account"("tenantId", "exchange", "mode", "region", "externalAccountId");

-- CreateIndex
CREATE INDEX "exchange_connection_tenantId_accountId_status_idx" ON "exchange_connection"("tenantId", "accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_connection_tenantId_id_key" ON "exchange_connection"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_connection_tenantId_id_mode_key" ON "exchange_connection"("tenantId", "id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "connection_account_scope" ON "exchange_connection"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "encrypted_credential_tenantId_id_key" ON "encrypted_credential"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "encrypted_credential_tenantId_connectionId_version_key" ON "encrypted_credential"("tenantId", "connectionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "credential_connection_version" ON "encrypted_credential"("tenantId", "id", "connectionId", "version");

-- CreateIndex
CREATE INDEX "live_grant_tenantId_connectionId_expiresAt_idx" ON "live_grant"("tenantId", "connectionId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "live_grant_tenantId_id_key" ON "live_grant"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_exchange_market_mode_exchangeSymbol_key" ON "instrument"("exchange", "market", "mode", "exchangeSymbol");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_id_market_key" ON "instrument"("id", "market");

-- CreateIndex
CREATE INDEX "instrument_rule_version_instrumentId_effectiveAt_idx" ON "instrument_rule_version"("instrumentId", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_rule_version_instrumentId_version_key" ON "instrument_rule_version"("instrumentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_rule_version_id_instrumentId_key" ON "instrument_rule_version"("id", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_rule_version_scope" ON "instrument_rule_version"("id", "instrumentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "capability_snapshot_exchange_market_mode_region_accountMode_key" ON "capability_snapshot"("exchange", "market", "mode", "region", "accountMode", "version");

-- CreateIndex
CREATE INDEX "balance_snapshot_tenantId_accountId_sourceAt_idx" ON "balance_snapshot"("tenantId", "accountId", "sourceAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "balance_snapshot_tenantId_id_key" ON "balance_snapshot"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "balance_snapshot_tenantId_accountId_mode_stateVersionId_ass_key" ON "balance_snapshot"("tenantId", "accountId", "mode", "stateVersionId", "asset");

-- CreateIndex
CREATE UNIQUE INDEX "position_tenantId_id_key" ON "position"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "position_tenantId_accountId_mode_instrumentId_positionSide__key" ON "position"("tenantId", "accountId", "mode", "instrumentId", "positionSide", "positionBucket");

-- CreateIndex
CREATE UNIQUE INDEX "position_full_account_scope" ON "position"("tenantId", "id", "accountId", "mode", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "position_account_scope" ON "position"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "account_state_version_tenantId_id_key" ON "account_state_version"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_state_version_tenantId_accountId_mode_version_key" ON "account_state_version"("tenantId", "accountId", "mode", "version");

-- CreateIndex
CREATE UNIQUE INDEX "account_state_version_tenantId_id_accountId_mode_key" ON "account_state_version"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE INDEX "ledger_transaction_tenantId_accountId_effectiveAt_id_idx" ON "ledger_transaction"("tenantId", "accountId", "effectiveAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transaction_tenantId_id_key" ON "ledger_transaction"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transaction_tenantId_accountId_mode_cause_causeIdent_key" ON "ledger_transaction"("tenantId", "accountId", "mode", "cause", "causeIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transaction_tenantId_id_accountId_mode_key" ON "ledger_transaction"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE INDEX "ledger_entry_tenantId_accountId_mode_asset_createdAt_id_idx" ON "ledger_entry"("tenantId", "accountId", "mode", "asset", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_tenantId_id_key" ON "ledger_entry"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_tenantId_transactionId_entryIndex_key" ON "ledger_entry"("tenantId", "transactionId", "entryIndex");

-- CreateIndex
CREATE INDEX "asset_valuation_tenantId_accountId_valuedAt_id_idx" ON "asset_valuation"("tenantId", "accountId", "valuedAt" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_valuation_tenantId_id_key" ON "asset_valuation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "order_intent_tenantId_createdAt_id_idx" ON "order_intent"("tenantId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "order_intent_tenantId_id_key" ON "order_intent"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_intent_tenantId_operation_idempotencyKey_key" ON "order_intent"("tenantId", "operation", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "intent_full_account_scope" ON "order_intent"("tenantId", "id", "accountId", "mode", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "intent_account_scope" ON "order_intent"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_tenantId_id_key" ON "idempotency_record"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_tenantId_operation_idempotencyKey_key" ON "idempotency_record"("tenantId", "operation", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "order_intentId_key" ON "order"("intentId");

-- CreateIndex
CREATE INDEX "order_tenantId_createdAt_id_idx" ON "order"("tenantId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "order_tenantId_connectionId_status_instrumentId_idx" ON "order"("tenantId", "connectionId", "status", "instrumentId");

-- CreateIndex
CREATE INDEX "order_tenantId_connectionId_reconciliationState_updatedAt_idx" ON "order"("tenantId", "connectionId", "reconciliationState", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "order_tenantId_id_key" ON "order"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_client_identity" ON "order"("tenantId", "accountId", "mode", "clientIdNamespace", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "order_exchange_identity" ON "order"("tenantId", "accountId", "mode", "market", "instrumentId", "exchangeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "order_unique_intent_scope" ON "order"("tenantId", "intentId", "accountId", "mode", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "order_full_account_scope" ON "order"("tenantId", "id", "accountId", "mode", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "order_account_scope" ON "order"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "algo_order_orderId_key" ON "algo_order"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "algo_order_tenantId_id_key" ON "algo_order"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "algo_order_tenantId_orderId_key" ON "algo_order"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "algo_exchange_identity" ON "algo_order"("tenantId", "accountId", "mode", "instrumentId", "exchangeAlgoId");

-- CreateIndex
CREATE UNIQUE INDEX "algo_unique_order_scope" ON "algo_order"("tenantId", "orderId", "accountId", "mode", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "algo_full_account_scope" ON "algo_order"("tenantId", "id", "accountId", "mode", "instrumentId");

-- CreateIndex
CREATE INDEX "submission_attempt_tenantId_status_createdAt_idx" ON "submission_attempt"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "submission_attempt_tenantId_id_key" ON "submission_attempt"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_attempt_tenantId_orderId_operationVersion_key" ON "submission_attempt"("tenantId", "orderId", "operationVersion");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_order_scope" ON "submission_attempt"("tenantId", "id", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "order_event_tenantId_id_key" ON "order_event"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "order_event_tenantId_orderId_version_key" ON "order_event"("tenantId", "orderId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "order_event_tenantId_orderId_source_sourceIdentity_key" ON "order_event"("tenantId", "orderId", "source", "sourceIdentity");

-- CreateIndex
CREATE INDEX "trade_tenantId_openedAt_id_idx" ON "trade"("tenantId", "openedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "trade_tenantId_id_key" ON "trade"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trade_full_account_scope" ON "trade"("tenantId", "id", "accountId", "mode", "instrumentId");

-- CreateIndex
CREATE INDEX "fill_tenantId_orderId_timestamp_id_idx" ON "fill"("tenantId", "orderId", "timestamp", "id");

-- CreateIndex
CREATE INDEX "fill_tenantId_instrumentId_timestamp_id_idx" ON "fill"("tenantId", "instrumentId", "timestamp" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "fill_tenantId_id_key" ON "fill"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fill_execution_identity" ON "fill"("tenantId", "accountId", "mode", "market", "instrumentId", "executionIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "fill_tenantId_id_accountId_mode_key" ON "fill"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "fee_tenantId_id_key" ON "fee"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_tenantId_fillId_feeIdentity_key" ON "fee"("tenantId", "fillId", "feeIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "funding_payment_tenantId_id_key" ON "funding_payment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "funding_payment_identity" ON "funding_payment"("tenantId", "accountId", "mode", "instrumentId", "paymentIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "funding_payment_tenantId_id_accountId_mode_key" ON "funding_payment"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_definition_key_version_key" ON "strategy_definition"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_parameter_definitionId_name_key" ON "strategy_parameter"("definitionId", "name");

-- CreateIndex
CREATE INDEX "strategy_instance_tenantId_status_id_idx" ON "strategy_instance"("tenantId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_instance_tenantId_id_key" ON "strategy_instance"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_instance_tenantId_id_accountId_mode_key" ON "strategy_instance"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE INDEX "strategy_run_tenantId_instanceId_createdAt_idx" ON "strategy_run"("tenantId", "instanceId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "strategy_run_tenantId_id_key" ON "strategy_run"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_run_tenantId_id_accountId_mode_key" ON "strategy_run"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_state_runId_key" ON "strategy_state"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_state_tenantId_id_key" ON "strategy_state"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_state_tenantId_runId_key" ON "strategy_state"("tenantId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "signal_tenantId_id_key" ON "signal"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_input_identity" ON "signal"("tenantId", "runId", "instrumentId", "inputIdentity", "ruleVersion", "signalKind");

-- CreateIndex
CREATE UNIQUE INDEX "risk_profile_tenantId_id_key" ON "risk_profile"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "risk_profile_tenantId_name_version_key" ON "risk_profile"("tenantId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "risk_profile_version_scope" ON "risk_profile"("tenantId", "id", "version");

-- CreateIndex
CREATE INDEX "risk_decision_tenantId_intentId_createdAt_idx" ON "risk_decision"("tenantId", "intentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "risk_decision_tenantId_id_key" ON "risk_decision"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "risk_decision_intent_scope" ON "risk_decision"("tenantId", "id", "intentId", "accountId", "mode");

-- CreateIndex
CREATE INDEX "risk_event_tenantId_occurredAt_id_idx" ON "risk_event"("tenantId", "occurredAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "risk_event_tenantId_id_key" ON "risk_event"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "risk_reservation_decisionId_key" ON "risk_reservation"("decisionId");

-- CreateIndex
CREATE INDEX "risk_reservation_tenantId_accountId_status_expiresAt_idx" ON "risk_reservation"("tenantId", "accountId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "risk_reservation_tenantId_id_key" ON "risk_reservation"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "risk_reservation_tenantId_decisionId_key" ON "risk_reservation"("tenantId", "decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_decision_scope" ON "risk_reservation"("tenantId", "decisionId", "intentId", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "risk_budget_tenantId_id_key" ON "risk_budget"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "risk_budget_scope_window" ON "risk_budget"("tenantId", "mode", "scope", "scopeKey", "asset", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "risk_budget_asset_scope" ON "risk_budget"("tenantId", "id", "mode", "asset");

-- CreateIndex
CREATE INDEX "trading_pause_tenantId_resumedAt_idx" ON "trading_pause"("tenantId", "resumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "trading_pause_tenantId_id_key" ON "trading_pause"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trading_pause_tenantId_scope_scopeKey_epoch_key" ON "trading_pause"("tenantId", "scope", "scopeKey", "epoch");

-- CreateIndex
CREATE UNIQUE INDEX "circuit_state_tenantId_id_key" ON "circuit_state"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "circuit_state_tenantId_scope_scopeKey_circuitKey_key" ON "circuit_state"("tenantId", "scope", "scopeKey", "circuitKey");

-- CreateIndex
CREATE UNIQUE INDEX "paper_account_accountId_key" ON "paper_account"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_account_tenantId_id_key" ON "paper_account"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "paper_account_tenantId_accountId_key" ON "paper_account"("tenantId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_account_tenantId_accountId_mode_key" ON "paper_account"("tenantId", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "paper_account_scope" ON "paper_account"("tenantId", "id", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "paper_order_orderId_key" ON "paper_order"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_order_tenantId_id_key" ON "paper_order"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "paper_order_tenantId_orderId_key" ON "paper_order"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_order_tenantId_orderId_accountId_mode_key" ON "paper_order"("tenantId", "orderId", "accountId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "paper_position_positionId_key" ON "paper_position"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_position_tenantId_id_key" ON "paper_position"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "paper_position_tenantId_positionId_key" ON "paper_position"("tenantId", "positionId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_position_tenantId_positionId_accountId_mode_key" ON "paper_position"("tenantId", "positionId", "accountId", "mode");

-- CreateIndex
CREATE INDEX "backtest_tenantId_createdAt_id_idx" ON "backtest"("tenantId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "backtest_tenantId_id_key" ON "backtest"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "backtest_trade_tenantId_id_key" ON "backtest_trade"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "backtest_trade_tenantId_backtestId_sequence_key" ON "backtest_trade"("tenantId", "backtestId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "backtest_metric_tenantId_id_key" ON "backtest_metric"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "backtest_metric_tenantId_backtestId_name_key" ON "backtest_metric"("tenantId", "backtestId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_manifest_artifactHash_key" ON "dataset_manifest"("artifactHash");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_manifest_name_version_key" ON "dataset_manifest"("name", "version");

-- CreateIndex
CREATE INDEX "candle_openTime_idx" ON "candle"("openTime");

-- CreateIndex
CREATE UNIQUE INDEX "candle_instrumentId_timeframeSeconds_openTime_key" ON "candle"("instrumentId", "timeframeSeconds", "openTime");

-- CreateIndex
CREATE INDEX "market_gap_instrumentId_repairedAt_startAt_idx" ON "market_gap"("instrumentId", "repairedAt", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "market_checkpoint_instrumentId_stream_key" ON "market_checkpoint"("instrumentId", "stream");

-- CreateIndex
CREATE INDEX "subscription_assignment_workerId_leaseExpiresAt_idx" ON "subscription_assignment"("workerId", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_assignment_instrumentId_stream_key" ON "subscription_assignment"("instrumentId", "stream");

-- CreateIndex
CREATE INDEX "outbox_event_tenantId_deliveredAt_availableAt_id_idx" ON "outbox_event"("tenantId", "deliveredAt", "availableAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_tenantId_id_key" ON "outbox_event"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_aggregate_event" ON "outbox_event"("tenantId", "aggregateType", "aggregateId", "aggregateVersion", "eventType");

-- CreateIndex
CREATE INDEX "consumer_inbox_tenantId_processedAt_idx" ON "consumer_inbox"("tenantId", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_inbox_tenantId_id_key" ON "consumer_inbox"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_inbox_consumer_eventId_key" ON "consumer_inbox"("consumer", "eventId");

-- CreateIndex
CREATE INDEX "notification_tenantId_createdAt_id_idx" ON "notification"("tenantId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_tenantId_id_key" ON "notification"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_tenantId_channel_deduplicationKey_key" ON "notification"("tenantId", "channel", "deduplicationKey");

-- CreateIndex
CREATE INDEX "audit_log_tenantId_createdAt_id_idx" ON "audit_log"("tenantId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_tenantId_id_key" ON "audit_log"("tenantId", "id");

-- CreateIndex
CREATE INDEX "system_event_eventType_occurredAt_id_idx" ON "system_event"("eventType", "occurredAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "reconciliation_run_tenantId_state_startedAt_idx" ON "reconciliation_run"("tenantId", "state", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_run_tenantId_id_key" ON "reconciliation_run"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_run_tenantId_accountId_mode_market_epoch_key" ON "reconciliation_run"("tenantId", "accountId", "mode", "market", "epoch");

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "two_factor_config" ADD CONSTRAINT "two_factor_config_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_tenantId_twoFactorConfigId_fkey" FOREIGN KEY ("tenantId", "twoFactorConfigId") REFERENCES "two_factor_config"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exchange_account" ADD CONSTRAINT "exchange_account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exchange_connection" ADD CONSTRAINT "exchange_connection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exchange_connection" ADD CONSTRAINT "exchange_connection_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_tenantId_connectionId_fkey" FOREIGN KEY ("tenantId", "connectionId") REFERENCES "exchange_connection"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_tenantId_connectionId_mode_fkey" FOREIGN KEY ("tenantId", "connectionId", "mode") REFERENCES "exchange_connection"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_tenantId_credentialId_connectionId_credentialVe_fkey" FOREIGN KEY ("tenantId", "credentialId", "connectionId", "credentialVersion") REFERENCES "encrypted_credential"("tenantId", "id", "connectionId", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_tenantId_riskProfileId_riskPolicyVersion_fkey" FOREIGN KEY ("tenantId", "riskProfileId", "riskPolicyVersion") REFERENCES "risk_profile"("tenantId", "id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_tenantId_stateVersionId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "stateVersionId", "accountId", "mode") REFERENCES "account_state_version"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "position" ADD CONSTRAINT "position_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "position" ADD CONSTRAINT "position_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "position" ADD CONSTRAINT "position_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "position" ADD CONSTRAINT "position_ruleVersionId_instrumentId_fkey" FOREIGN KEY ("ruleVersionId", "instrumentId") REFERENCES "instrument_rule_version"("id", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_state_version" ADD CONSTRAINT "account_state_version_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_state_version" ADD CONSTRAINT "account_state_version_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_tenantId_fillId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "fillId", "accountId", "mode") REFERENCES "fill"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_tenantId_fundingPaymentId_accountId_mod_fkey" FOREIGN KEY ("tenantId", "fundingPaymentId", "accountId", "mode") REFERENCES "funding_payment"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transaction" ADD CONSTRAINT "ledger_transaction_tenantId_correctionOfId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "correctionOfId", "accountId", "mode") REFERENCES "ledger_transaction"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_tenantId_transactionId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "transactionId", "accountId", "mode") REFERENCES "ledger_transaction"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_tenantId_ledgerTransactionId_accountId_mod_fkey" FOREIGN KEY ("tenantId", "ledgerTransactionId", "accountId", "mode") REFERENCES "ledger_transaction"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_ruleVersionId_instrumentId_fkey" FOREIGN KEY ("ruleVersionId", "instrumentId") REFERENCES "instrument_rule_version"("id", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_tenantId_connectionId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "connectionId", "accountId", "mode") REFERENCES "exchange_connection"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_tenantId_signalId_fkey" FOREIGN KEY ("tenantId", "signalId") REFERENCES "signal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_tenantId_intentId_fkey" FOREIGN KEY ("tenantId", "intentId") REFERENCES "order_intent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_instrumentId_market_fkey" FOREIGN KEY ("instrumentId", "market") REFERENCES "instrument"("id", "market") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_ruleVersionId_instrumentId_fkey" FOREIGN KEY ("ruleVersionId", "instrumentId") REFERENCES "instrument_rule_version"("id", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenantId_connectionId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "connectionId", "accountId", "mode") REFERENCES "exchange_connection"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenantId_intentId_accountId_mode_instrumentId_fkey" FOREIGN KEY ("tenantId", "intentId", "accountId", "mode", "instrumentId") REFERENCES "order_intent"("tenantId", "id", "accountId", "mode", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenantId_parentAlgoOrderId_accountId_mode_instrument_fkey" FOREIGN KEY ("tenantId", "parentAlgoOrderId", "accountId", "mode", "instrumentId") REFERENCES "algo_order"("tenantId", "id", "accountId", "mode", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_tenantId_tradeId_accountId_mode_instrumentId_fkey" FOREIGN KEY ("tenantId", "tradeId", "accountId", "mode", "instrumentId") REFERENCES "trade"("tenantId", "id", "accountId", "mode", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "algo_order" ADD CONSTRAINT "algo_order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "algo_order" ADD CONSTRAINT "algo_order_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "algo_order" ADD CONSTRAINT "algo_order_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "algo_order" ADD CONSTRAINT "algo_order_tenantId_orderId_accountId_mode_instrumentId_fkey" FOREIGN KEY ("tenantId", "orderId", "accountId", "mode", "instrumentId") REFERENCES "order"("tenantId", "id", "accountId", "mode", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_tenantId_reservationId_fkey" FOREIGN KEY ("tenantId", "reservationId") REFERENCES "risk_reservation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_tenantId_attemptId_orderId_fkey" FOREIGN KEY ("tenantId", "attemptId", "orderId") REFERENCES "submission_attempt"("tenantId", "id", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trade" ADD CONSTRAINT "trade_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trade" ADD CONSTRAINT "trade_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trade" ADD CONSTRAINT "trade_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trade" ADD CONSTRAINT "trade_tenantId_strategyRunId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "strategyRunId", "accountId", "mode") REFERENCES "strategy_run"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fill" ADD CONSTRAINT "fill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fill" ADD CONSTRAINT "fill_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fill" ADD CONSTRAINT "fill_instrumentId_market_fkey" FOREIGN KEY ("instrumentId", "market") REFERENCES "instrument"("id", "market") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fill" ADD CONSTRAINT "fill_ruleVersionId_instrumentId_fkey" FOREIGN KEY ("ruleVersionId", "instrumentId") REFERENCES "instrument_rule_version"("id", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fill" ADD CONSTRAINT "fill_tenantId_orderId_accountId_mode_instrumentId_fkey" FOREIGN KEY ("tenantId", "orderId", "accountId", "mode", "instrumentId") REFERENCES "order"("tenantId", "id", "accountId", "mode", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fill" ADD CONSTRAINT "fill_tenantId_tradeId_accountId_mode_instrumentId_fkey" FOREIGN KEY ("tenantId", "tradeId", "accountId", "mode", "instrumentId") REFERENCES "trade"("tenantId", "id", "accountId", "mode", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee" ADD CONSTRAINT "fee_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee" ADD CONSTRAINT "fee_tenantId_fillId_fkey" FOREIGN KEY ("tenantId", "fillId") REFERENCES "fill"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee" ADD CONSTRAINT "fee_tenantId_ledgerTransactionId_fkey" FOREIGN KEY ("tenantId", "ledgerTransactionId") REFERENCES "ledger_transaction"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "funding_payment" ADD CONSTRAINT "funding_payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "funding_payment" ADD CONSTRAINT "funding_payment_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "funding_payment" ADD CONSTRAINT "funding_payment_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "funding_payment" ADD CONSTRAINT "funding_payment_tenantId_positionId_accountId_mode_instrum_fkey" FOREIGN KEY ("tenantId", "positionId", "accountId", "mode", "instrumentId") REFERENCES "position"("tenantId", "id", "accountId", "mode", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_parameter" ADD CONSTRAINT "strategy_parameter_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "strategy_definition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_instance" ADD CONSTRAINT "strategy_instance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_instance" ADD CONSTRAINT "strategy_instance_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_instance" ADD CONSTRAINT "strategy_instance_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "strategy_definition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_instance" ADD CONSTRAINT "strategy_instance_tenantId_riskProfileId_fkey" FOREIGN KEY ("tenantId", "riskProfileId") REFERENCES "risk_profile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_run" ADD CONSTRAINT "strategy_run_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_run" ADD CONSTRAINT "strategy_run_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_run" ADD CONSTRAINT "strategy_run_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "strategy_definition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_run" ADD CONSTRAINT "strategy_run_tenantId_instanceId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "instanceId", "accountId", "mode") REFERENCES "strategy_instance"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_state" ADD CONSTRAINT "strategy_state_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "strategy_state" ADD CONSTRAINT "strategy_state_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "strategy_run"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_ruleVersionId_instrumentId_ruleVersion_fkey" FOREIGN KEY ("ruleVersionId", "instrumentId", "ruleVersion") REFERENCES "instrument_rule_version"("id", "instrumentId", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "signal" ADD CONSTRAINT "signal_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "strategy_run"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_profile" ADD CONSTRAINT "risk_profile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "instrument_rule_version"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_tenantId_stateVersionId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "stateVersionId", "accountId", "mode") REFERENCES "account_state_version"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_tenantId_intentId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "intentId", "accountId", "mode") REFERENCES "order_intent"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_tenantId_profileId_policyVersion_fkey" FOREIGN KEY ("tenantId", "profileId", "policyVersion") REFERENCES "risk_profile"("tenantId", "id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_capabilitySnapshotId_fkey" FOREIGN KEY ("capabilitySnapshotId") REFERENCES "capability_snapshot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_event" ADD CONSTRAINT "risk_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_event" ADD CONSTRAINT "risk_event_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "exchange_account"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_event" ADD CONSTRAINT "risk_event_tenantId_decisionId_fkey" FOREIGN KEY ("tenantId", "decisionId") REFERENCES "risk_decision"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_event" ADD CONSTRAINT "risk_event_tenantId_profileId_fkey" FOREIGN KEY ("tenantId", "profileId") REFERENCES "risk_profile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_reservation" ADD CONSTRAINT "risk_reservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_reservation" ADD CONSTRAINT "risk_reservation_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_reservation" ADD CONSTRAINT "risk_reservation_tenantId_decisionId_intentId_accountId_mo_fkey" FOREIGN KEY ("tenantId", "decisionId", "intentId", "accountId", "mode") REFERENCES "risk_decision"("tenantId", "id", "intentId", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_reservation" ADD CONSTRAINT "risk_reservation_tenantId_intentId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "intentId", "accountId", "mode") REFERENCES "order_intent"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_reservation" ADD CONSTRAINT "risk_reservation_tenantId_budgetId_mode_asset_fkey" FOREIGN KEY ("tenantId", "budgetId", "mode", "asset") REFERENCES "risk_budget"("tenantId", "id", "mode", "asset") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_budget" ADD CONSTRAINT "risk_budget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_budget" ADD CONSTRAINT "risk_budget_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "risk_budget" ADD CONSTRAINT "risk_budget_tenantId_profileId_fkey" FOREIGN KEY ("tenantId", "profileId") REFERENCES "risk_profile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trading_pause" ADD CONSTRAINT "trading_pause_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trading_pause" ADD CONSTRAINT "trading_pause_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "exchange_account"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trading_pause" ADD CONSTRAINT "trading_pause_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "trading_pause" ADD CONSTRAINT "trading_pause_tenantId_strategyInstanceId_fkey" FOREIGN KEY ("tenantId", "strategyInstanceId") REFERENCES "strategy_instance"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "circuit_state" ADD CONSTRAINT "circuit_state_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "circuit_state" ADD CONSTRAINT "circuit_state_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "exchange_account"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "paper_account" ADD CONSTRAINT "paper_account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "paper_account" ADD CONSTRAINT "paper_account_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "paper_order" ADD CONSTRAINT "paper_order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "paper_order" ADD CONSTRAINT "paper_order_tenantId_orderId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "orderId", "accountId", "mode") REFERENCES "order"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "paper_order" ADD CONSTRAINT "paper_order_tenantId_paperAccountId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "paperAccountId", "accountId", "mode") REFERENCES "paper_account"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "paper_position" ADD CONSTRAINT "paper_position_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "paper_position" ADD CONSTRAINT "paper_position_tenantId_positionId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "positionId", "accountId", "mode") REFERENCES "position"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "paper_position" ADD CONSTRAINT "paper_position_tenantId_paperAccountId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "paperAccountId", "accountId", "mode") REFERENCES "paper_account"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest" ADD CONSTRAINT "backtest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest" ADD CONSTRAINT "backtest_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "strategy_definition"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest" ADD CONSTRAINT "backtest_datasetManifestId_fkey" FOREIGN KEY ("datasetManifestId") REFERENCES "dataset_manifest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_ruleVersionId_instrumentId_fkey" FOREIGN KEY ("ruleVersionId", "instrumentId") REFERENCES "instrument_rule_version"("id", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_tenantId_backtestId_fkey" FOREIGN KEY ("tenantId", "backtestId") REFERENCES "backtest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest_metric" ADD CONSTRAINT "backtest_metric_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "backtest_metric" ADD CONSTRAINT "backtest_metric_tenantId_backtestId_fkey" FOREIGN KEY ("tenantId", "backtestId") REFERENCES "backtest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "candle" ADD CONSTRAINT "candle_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "candle" ADD CONSTRAINT "candle_ruleVersionId_instrumentId_fkey" FOREIGN KEY ("ruleVersionId", "instrumentId") REFERENCES "instrument_rule_version"("id", "instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "market_gap" ADD CONSTRAINT "market_gap_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "market_checkpoint" ADD CONSTRAINT "market_checkpoint_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "subscription_assignment" ADD CONSTRAINT "subscription_assignment_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "consumer_inbox" ADD CONSTRAINT "consumer_inbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "consumer_inbox" ADD CONSTRAINT "consumer_inbox_tenantId_eventId_fkey" FOREIGN KEY ("tenantId", "eventId") REFERENCES "outbox_event"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenantId_eventId_fkey" FOREIGN KEY ("tenantId", "eventId") REFERENCES "outbox_event"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_tenantId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "accountId", "mode") REFERENCES "exchange_account"("tenantId", "id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_tenantId_connectionId_accountId_mode_fkey" FOREIGN KEY ("tenantId", "connectionId", "accountId", "mode") REFERENCES "exchange_connection"("tenantId", "id", "accountId", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE candle_2026_09 PARTITION OF candle FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z');
CREATE TABLE candle_2026_10 PARTITION OF candle FOR VALUES FROM ('2026-10-01T00:00:00Z') TO ('2026-11-01T00:00:00Z');
CREATE TABLE candle_default PARTITION OF candle DEFAULT;

COMMIT;
