-- PHASE 2 integrity, tenant isolation and query indexes. PostgreSQL 17.
BEGIN;

ALTER TABLE "user" ADD CONSTRAINT "user_sessionEpoch_nonnegative" CHECK ("sessionEpoch">=0);

ALTER TABLE "user_session" ADD CONSTRAINT "user_session_tokenHash_length" CHECK (octet_length("tokenHash")=32);

ALTER TABLE "user_session" ADD CONSTRAINT "user_session_userAgentHash_length" CHECK (octet_length("userAgentHash")=32);

ALTER TABLE "user_session" ADD CONSTRAINT "user_session_ipPrefixHash_length" CHECK (octet_length("ipPrefixHash")=32);

ALTER TABLE "user_session" ADD CONSTRAINT "user_session_sessionEpoch_nonnegative" CHECK ("sessionEpoch">=0);

ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_tokenHash_length" CHECK (octet_length("tokenHash")=32);

ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_tokenHash_length" CHECK (octet_length("tokenHash")=32);

ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_sessionEpoch_nonnegative" CHECK ("sessionEpoch">=0);

ALTER TABLE "two_factor_config" ADD CONSTRAINT "two_factor_config_ciphertext_length" CHECK (octet_length("ciphertext") BETWEEN 1 AND 16384);

ALTER TABLE "two_factor_config" ADD CONSTRAINT "two_factor_config_nonce_length" CHECK (octet_length(nonce)=12);

ALTER TABLE "two_factor_config" ADD CONSTRAINT "two_factor_config_tag_length" CHECK (octet_length(tag)=16);

ALTER TABLE "two_factor_config" ADD CONSTRAINT "two_factor_config_wrappedDek_length" CHECK (octet_length("wrappedDek") BETWEEN 1 AND 16384);

ALTER TABLE "two_factor_config" ADD CONSTRAINT "two_factor_config_encryptionVersion_nonnegative" CHECK ("encryptionVersion">=0);

ALTER TABLE "two_factor_config" ADD CONSTRAINT "two_factor_config_aadVersion_nonnegative" CHECK ("aadVersion">=0);

ALTER TABLE "two_factor_config" ADD CONSTRAINT "two_factor_config_lastAcceptedStep_nonnegative" CHECK ("lastAcceptedStep">=0);

ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_codeHash_length" CHECK (octet_length("codeHash")=32);

ALTER TABLE "exchange_account" ADD CONSTRAINT "exchange_account_reconciliationEpoch_nonnegative" CHECK ("reconciliationEpoch">=0);

ALTER TABLE "exchange_account" ADD CONSTRAINT "exchange_account_permissionEpoch_nonnegative" CHECK ("permissionEpoch">=0);

ALTER TABLE "exchange_account" ADD CONSTRAINT "exchange_account_clientIdHighWatermark_nonnegative" CHECK ("clientIdHighWatermark">=0);

ALTER TABLE "exchange_account" ADD CONSTRAINT "exchange_account_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "exchange_connection" ADD CONSTRAINT "exchange_connection_permissionsVersion_nonnegative" CHECK ("permissionsVersion">=0);

ALTER TABLE "exchange_connection" ADD CONSTRAINT "exchange_connection_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_ciphertext_length" CHECK (octet_length("ciphertext") BETWEEN 1 AND 16384);

ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_nonce_length" CHECK (octet_length(nonce)=12);

ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_tag_length" CHECK (octet_length(tag)=16);

ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_wrappedDek_length" CHECK (octet_length("wrappedDek") BETWEEN 1 AND 16384);

ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_encryptionVersion_nonnegative" CHECK ("encryptionVersion">=0);

ALTER TABLE "encrypted_credential" ADD CONSTRAINT "encrypted_credential_aadVersion_nonnegative" CHECK ("aadVersion">=0);

ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_credentialVersion_nonnegative" CHECK ("credentialVersion">=0);

ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_permissionsVersion_nonnegative" CHECK ("permissionsVersion">=0);

ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_riskPolicyVersion_nonnegative" CHECK ("riskPolicyVersion">=0);

ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_permissionEpoch_nonnegative" CHECK ("permissionEpoch">=0);

-- InstrumentRuleVersion.priceTick: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_priceTick_decimal" CHECK ("priceTick">-(10::numeric^20) AND "priceTick"<(10::numeric^20) AND scale("priceTick")<=18 AND "priceTick">0);

-- InstrumentRuleVersion.quantityStep: quantity 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_quantityStep_decimal" CHECK ("quantityStep">-(10::numeric^20) AND "quantityStep"<(10::numeric^20) AND scale("quantityStep")<=18 AND "quantityStep">0);

-- InstrumentRuleVersion.minQuantity: quantity 38,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_minQuantity_decimal" CHECK ("minQuantity">-(10::numeric^20) AND "minQuantity"<(10::numeric^20) AND scale("minQuantity")<=18 AND "minQuantity">=0);

-- InstrumentRuleVersion.maxQuantity: quantity 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_maxQuantity_decimal" CHECK ("maxQuantity">-(10::numeric^20) AND "maxQuantity"<(10::numeric^20) AND scale("maxQuantity")<=18 AND "maxQuantity">0);

-- InstrumentRuleVersion.minNotional: amount 38,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_minNotional_decimal" CHECK ("minNotional">-(10::numeric^20) AND "minNotional"<(10::numeric^20) AND scale("minNotional")<=18 AND "minNotional">=0);

-- InstrumentRuleVersion.contractSize: quantity 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_contractSize_decimal" CHECK ("contractSize">-(10::numeric^20) AND "contractSize"<(10::numeric^20) AND scale("contractSize")<=18 AND "contractSize">0);

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_sourceHash_length" CHECK (octet_length("sourceHash")=32);

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "capability_snapshot" ADD CONSTRAINT "capability_snapshot_evidenceHash_length" CHECK (octet_length("evidenceHash")=32);

ALTER TABLE "capability_snapshot" ADD CONSTRAINT "capability_snapshot_version_nonnegative" CHECK ("version">=0);

-- BalanceSnapshot.total: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_total_decimal" CHECK ("total">-(10::numeric^30) AND "total"<(10::numeric^30) AND scale("total")<=18);

-- BalanceSnapshot.available: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_available_decimal" CHECK ("available">-(10::numeric^30) AND "available"<(10::numeric^30) AND scale("available")<=18);

-- BalanceSnapshot.reserved: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_reserved_decimal" CHECK ("reserved">-(10::numeric^30) AND "reserved"<(10::numeric^30) AND scale("reserved")<=18 AND "reserved">=0);

-- BalanceSnapshot.borrowed: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_borrowed_decimal" CHECK ("borrowed">-(10::numeric^30) AND "borrowed"<(10::numeric^30) AND scale("borrowed")<=18 AND "borrowed">=0);

-- Position.quantity: quantity 38,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "position" ADD CONSTRAINT "position_quantity_decimal" CHECK ("quantity">-(10::numeric^20) AND "quantity"<(10::numeric^20) AND scale("quantity")<=18);

-- Position.averageEntryPrice: price 38,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "position" ADD CONSTRAINT "position_averageEntryPrice_decimal" CHECK ("averageEntryPrice">-(10::numeric^20) AND "averageEntryPrice"<(10::numeric^20) AND scale("averageEntryPrice")<=18 AND "averageEntryPrice">=0);

-- Position.realizedPnl: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "position" ADD CONSTRAINT "position_realizedPnl_decimal" CHECK ("realizedPnl">-(10::numeric^30) AND "realizedPnl"<(10::numeric^30) AND scale("realizedPnl")<=18);

-- Position.unrealizedPnl: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "position" ADD CONSTRAINT "position_unrealizedPnl_decimal" CHECK ("unrealizedPnl">-(10::numeric^30) AND "unrealizedPnl"<(10::numeric^30) AND scale("unrealizedPnl")<=18);

-- Position.feesPaid: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "position" ADD CONSTRAINT "position_feesPaid_decimal" CHECK ("feesPaid">-(10::numeric^30) AND "feesPaid"<(10::numeric^30) AND scale("feesPaid")<=18);

-- Position.fundingPaid: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "position" ADD CONSTRAINT "position_fundingPaid_decimal" CHECK ("fundingPaid">-(10::numeric^30) AND "fundingPaid"<(10::numeric^30) AND scale("fundingPaid")<=18);

ALTER TABLE "position" ADD CONSTRAINT "position_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "account_state_version" ADD CONSTRAINT "account_state_version_stateHash_length" CHECK (octet_length("stateHash")=32);

ALTER TABLE "account_state_version" ADD CONSTRAINT "account_state_version_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "account_state_version" ADD CONSTRAINT "account_state_version_reconciliationEpoch_nonnegative" CHECK ("reconciliationEpoch">=0);

-- LedgerEntry.amount: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_amount_decimal" CHECK ("amount">-(10::numeric^30) AND "amount"<(10::numeric^30) AND scale("amount")<=18);

ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_entryIndex_nonnegative" CHECK ("entryIndex">=0);

-- AssetValuation.price: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_price_decimal" CHECK ("price">-(10::numeric^20) AND "price"<(10::numeric^20) AND scale("price")<=18 AND "price">0);

-- AssetValuation.baseAmount: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_baseAmount_decimal" CHECK ("baseAmount">-(10::numeric^30) AND "baseAmount"<(10::numeric^30) AND scale("baseAmount")<=18);

-- AssetValuation.quoteAmount: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_quoteAmount_decimal" CHECK ("quoteAmount">-(10::numeric^30) AND "quoteAmount"<(10::numeric^30) AND scale("quoteAmount")<=18);

-- OrderIntent.quantity: quantity 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_quantity_decimal" CHECK ("quantity">-(10::numeric^20) AND "quantity"<(10::numeric^20) AND scale("quantity")<=18 AND "quantity">0);

-- OrderIntent.limitPrice: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_limitPrice_decimal" CHECK ("limitPrice">-(10::numeric^20) AND "limitPrice"<(10::numeric^20) AND scale("limitPrice")<=18 AND "limitPrice">0);

-- OrderIntent.triggerPrice: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_triggerPrice_decimal" CHECK ("triggerPrice">-(10::numeric^20) AND "triggerPrice"<(10::numeric^20) AND scale("triggerPrice")<=18 AND "triggerPrice">0);

ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_commandHash_length" CHECK (octet_length("commandHash")=32);

ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_requestHash_length" CHECK (octet_length("requestHash")=32);

ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_responseCode_nonnegative" CHECK ("responseCode">=0);

-- Order.quantity: quantity 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "order" ADD CONSTRAINT "order_quantity_decimal" CHECK ("quantity">-(10::numeric^20) AND "quantity"<(10::numeric^20) AND scale("quantity")<=18 AND "quantity">0);

-- Order.filledQuantity: quantity 38,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "order" ADD CONSTRAINT "order_filledQuantity_decimal" CHECK ("filledQuantity">-(10::numeric^20) AND "filledQuantity"<(10::numeric^20) AND scale("filledQuantity")<=18 AND "filledQuantity">=0);

-- Order.limitPrice: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "order" ADD CONSTRAINT "order_limitPrice_decimal" CHECK ("limitPrice">-(10::numeric^20) AND "limitPrice"<(10::numeric^20) AND scale("limitPrice")<=18 AND "limitPrice">0);

-- Order.averageFillPrice: price 38,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "order" ADD CONSTRAINT "order_averageFillPrice_decimal" CHECK ("averageFillPrice">-(10::numeric^20) AND "averageFillPrice"<(10::numeric^20) AND scale("averageFillPrice")<=18 AND "averageFillPrice">=0);

ALTER TABLE "order" ADD CONSTRAINT "order_version_nonnegative" CHECK ("version">=0);

-- AlgoOrder.triggerPrice: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "algo_order" ADD CONSTRAINT "algo_order_triggerPrice_decimal" CHECK ("triggerPrice">-(10::numeric^20) AND "triggerPrice"<(10::numeric^20) AND scale("triggerPrice")<=18 AND "triggerPrice">0);

-- AlgoOrder.trailingRate: rate 20,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "algo_order" ADD CONSTRAINT "algo_order_trailingRate_decimal" CHECK ("trailingRate">-(10::numeric^2) AND "trailingRate"<(10::numeric^2) AND scale("trailingRate")<=18 AND "trailingRate">=0);

ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_commandHash_length" CHECK (octet_length("commandHash")=32);

ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_evidenceHash_length" CHECK (octet_length("evidenceHash")=32);

ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_operationVersion_nonnegative" CHECK ("operationVersion">=0);

ALTER TABLE "submission_attempt" ADD CONSTRAINT "submission_attempt_permissionEpoch_nonnegative" CHECK ("permissionEpoch">=0);

ALTER TABLE "order_event" ADD CONSTRAINT "order_event_evidenceHash_length" CHECK (octet_length("evidenceHash")=32);

ALTER TABLE "order_event" ADD CONSTRAINT "order_event_version_nonnegative" CHECK ("version">=0);

-- Trade.grossPnl: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "trade" ADD CONSTRAINT "trade_grossPnl_decimal" CHECK ("grossPnl">-(10::numeric^30) AND "grossPnl"<(10::numeric^30) AND scale("grossPnl")<=18);

-- Trade.netPnl: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "trade" ADD CONSTRAINT "trade_netPnl_decimal" CHECK ("netPnl">-(10::numeric^30) AND "netPnl"<(10::numeric^30) AND scale("netPnl")<=18);

ALTER TABLE "trade" ADD CONSTRAINT "trade_version_nonnegative" CHECK ("version">=0);

-- Fill.quantity: quantity 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "fill" ADD CONSTRAINT "fill_quantity_decimal" CHECK ("quantity">-(10::numeric^20) AND "quantity"<(10::numeric^20) AND scale("quantity")<=18 AND "quantity">0);

-- Fill.price: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "fill" ADD CONSTRAINT "fill_price_decimal" CHECK ("price">-(10::numeric^20) AND "price"<(10::numeric^20) AND scale("price")<=18 AND "price">0);

-- Fill.quoteAmount: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "fill" ADD CONSTRAINT "fill_quoteAmount_decimal" CHECK ("quoteAmount">-(10::numeric^30) AND "quoteAmount"<(10::numeric^30) AND scale("quoteAmount")<=18 AND "quoteAmount">=0);

ALTER TABLE "fill" ADD CONSTRAINT "fill_evidenceHash_length" CHECK (octet_length("evidenceHash")=32);

-- Fee.amount: amount 38,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "fee" ADD CONSTRAINT "fee_amount_decimal" CHECK ("amount">-(10::numeric^20) AND "amount"<(10::numeric^20) AND scale("amount")<=18);

-- Fee.rate: rate 20,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "fee" ADD CONSTRAINT "fee_rate_decimal" CHECK ("rate">-(10::numeric^2) AND "rate"<(10::numeric^2) AND scale("rate")<=18);

-- FundingPayment.amount: amount 38,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "funding_payment" ADD CONSTRAINT "funding_payment_amount_decimal" CHECK ("amount">-(10::numeric^20) AND "amount"<(10::numeric^20) AND scale("amount")<=18);

-- FundingPayment.rate: rate 20,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "funding_payment" ADD CONSTRAINT "funding_payment_rate_decimal" CHECK ("rate">-(10::numeric^2) AND "rate"<(10::numeric^2) AND scale("rate")<=18);

ALTER TABLE "strategy_definition" ADD CONSTRAINT "strategy_definition_implementationHash_length" CHECK (octet_length("implementationHash")=32);

ALTER TABLE "strategy_definition" ADD CONSTRAINT "strategy_definition_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "strategy_definition" ADD CONSTRAINT "strategy_definition_parameterSchemaVersion_nonnegative" CHECK ("parameterSchemaVersion">=0);

ALTER TABLE "strategy_definition" ADD CONSTRAINT "strategy_definition_minimumWarmupBars_nonnegative" CHECK ("minimumWarmupBars">=0);

ALTER TABLE "strategy_instance" ADD CONSTRAINT "strategy_instance_selectionHash_length" CHECK (octet_length("selectionHash")=32);

ALTER TABLE "strategy_instance" ADD CONSTRAINT "strategy_instance_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "strategy_run" ADD CONSTRAINT "strategy_run_instanceVersion_nonnegative" CHECK ("instanceVersion">=0);

ALTER TABLE "strategy_run" ADD CONSTRAINT "strategy_run_inputVersion_nonnegative" CHECK ("inputVersion">=0);

ALTER TABLE "strategy_run" ADD CONSTRAINT "strategy_run_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "strategy_state" ADD CONSTRAINT "strategy_state_stateHash_length" CHECK (octet_length("stateHash")=32);

ALTER TABLE "strategy_state" ADD CONSTRAINT "strategy_state_schemaVersion_nonnegative" CHECK ("schemaVersion">=0);

ALTER TABLE "strategy_state" ADD CONSTRAINT "strategy_state_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "signal" ADD CONSTRAINT "signal_commandHash_length" CHECK (octet_length("commandHash")=32);

ALTER TABLE "signal" ADD CONSTRAINT "signal_ruleVersion_nonnegative" CHECK ("ruleVersion">=0);

ALTER TABLE "signal" ADD CONSTRAINT "signal_payloadSchemaVersion_nonnegative" CHECK ("payloadSchemaVersion">=0);

-- RiskProfile.maxNotional: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "risk_profile" ADD CONSTRAINT "risk_profile_maxNotional_decimal" CHECK ("maxNotional">-(10::numeric^30) AND "maxNotional"<(10::numeric^30) AND scale("maxNotional")<=18 AND "maxNotional">=0);

-- RiskProfile.maxDailyLoss: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "risk_profile" ADD CONSTRAINT "risk_profile_maxDailyLoss_decimal" CHECK ("maxDailyLoss">-(10::numeric^30) AND "maxDailyLoss"<(10::numeric^30) AND scale("maxDailyLoss")<=18 AND "maxDailyLoss">=0);

-- RiskProfile.maxDrawdownRate: rate 20,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "risk_profile" ADD CONSTRAINT "risk_profile_maxDrawdownRate_decimal" CHECK ("maxDrawdownRate">-(10::numeric^2) AND "maxDrawdownRate"<(10::numeric^2) AND scale("maxDrawdownRate")<=18 AND "maxDrawdownRate">=0);

ALTER TABLE "risk_profile" ADD CONSTRAINT "risk_profile_policyHash_length" CHECK (octet_length("policyHash")=32);

ALTER TABLE "risk_profile" ADD CONSTRAINT "risk_profile_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "risk_profile" ADD CONSTRAINT "risk_profile_maxOpenOrders_nonnegative" CHECK ("maxOpenOrders">=0);

ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_commandHash_length" CHECK (octet_length("commandHash")=32);

ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_policyVersion_nonnegative" CHECK ("policyVersion">=0);

ALTER TABLE "risk_decision" ADD CONSTRAINT "risk_decision_permissionEpoch_nonnegative" CHECK ("permissionEpoch">=0);

ALTER TABLE "risk_event" ADD CONSTRAINT "risk_event_schemaVersion_nonnegative" CHECK ("schemaVersion">=0);

-- RiskReservation.amount: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "risk_reservation" ADD CONSTRAINT "risk_reservation_amount_decimal" CHECK ("amount">-(10::numeric^30) AND "amount"<(10::numeric^30) AND scale("amount")<=18 AND "amount">=0);

-- RiskReservation.consumedAmount: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "risk_reservation" ADD CONSTRAINT "risk_reservation_consumedAmount_decimal" CHECK ("consumedAmount">-(10::numeric^30) AND "consumedAmount"<(10::numeric^30) AND scale("consumedAmount")<=18 AND "consumedAmount">=0);

ALTER TABLE "risk_reservation" ADD CONSTRAINT "risk_reservation_version_nonnegative" CHECK ("version">=0);

-- RiskBudget.limitAmount: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "risk_budget" ADD CONSTRAINT "risk_budget_limitAmount_decimal" CHECK ("limitAmount">-(10::numeric^30) AND "limitAmount"<(10::numeric^30) AND scale("limitAmount")<=18 AND "limitAmount">=0);

-- RiskBudget.reservedAmount: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "risk_budget" ADD CONSTRAINT "risk_budget_reservedAmount_decimal" CHECK ("reservedAmount">-(10::numeric^30) AND "reservedAmount"<(10::numeric^30) AND scale("reservedAmount")<=18 AND "reservedAmount">=0);

-- RiskBudget.consumedAmount: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "risk_budget" ADD CONSTRAINT "risk_budget_consumedAmount_decimal" CHECK ("consumedAmount">-(10::numeric^30) AND "consumedAmount"<(10::numeric^30) AND scale("consumedAmount")<=18);

ALTER TABLE "risk_budget" ADD CONSTRAINT "risk_budget_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "trading_pause" ADD CONSTRAINT "trading_pause_evidenceHash_length" CHECK (octet_length("evidenceHash")=32);

ALTER TABLE "trading_pause" ADD CONSTRAINT "trading_pause_epoch_nonnegative" CHECK ("epoch">=0);

ALTER TABLE "circuit_state" ADD CONSTRAINT "circuit_state_epoch_nonnegative" CHECK ("epoch">=0);

ALTER TABLE "circuit_state" ADD CONSTRAINT "circuit_state_failureCount_nonnegative" CHECK ("failureCount">=0);

ALTER TABLE "circuit_state" ADD CONSTRAINT "circuit_state_version_nonnegative" CHECK ("version">=0);

-- PaperAccount.initialCapital: aggregate 48,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "paper_account" ADD CONSTRAINT "paper_account_initialCapital_decimal" CHECK ("initialCapital">-(10::numeric^30) AND "initialCapital"<(10::numeric^30) AND scale("initialCapital")<=18 AND "initialCapital">0);

ALTER TABLE "paper_account" ADD CONSTRAINT "paper_account_resetEpoch_nonnegative" CHECK ("resetEpoch">=0);

-- PaperOrder.slippageRate: rate 20,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "paper_order" ADD CONSTRAINT "paper_order_slippageRate_decimal" CHECK ("slippageRate">-(10::numeric^2) AND "slippageRate"<(10::numeric^2) AND scale("slippageRate")<=18 AND "slippageRate">=0);

ALTER TABLE "paper_order" ADD CONSTRAINT "paper_order_simulationEvidenceHash_length" CHECK (octet_length("simulationEvidenceHash")=32);

ALTER TABLE "paper_position" ADD CONSTRAINT "paper_position_resetEpoch_nonnegative" CHECK ("resetEpoch">=0);

-- Backtest.initialCapital: aggregate 48,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "backtest" ADD CONSTRAINT "backtest_initialCapital_decimal" CHECK ("initialCapital">-(10::numeric^30) AND "initialCapital"<(10::numeric^30) AND scale("initialCapital")<=18 AND "initialCapital">0);

ALTER TABLE "backtest" ADD CONSTRAINT "backtest_parametersHash_length" CHECK (octet_length("parametersHash")=32);

ALTER TABLE "backtest" ADD CONSTRAINT "backtest_rulesManifestHash_length" CHECK (octet_length("rulesManifestHash")=32);

ALTER TABLE "backtest" ADD CONSTRAINT "backtest_artifactHash_length" CHECK (octet_length("artifactHash")=32);

ALTER TABLE "backtest" ADD CONSTRAINT "backtest_version_nonnegative" CHECK ("version">=0);

-- BacktestTrade.quantity: quantity 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_quantity_decimal" CHECK ("quantity">-(10::numeric^20) AND "quantity"<(10::numeric^20) AND scale("quantity")<=18 AND "quantity">0);

-- BacktestTrade.entryPrice: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_entryPrice_decimal" CHECK ("entryPrice">-(10::numeric^20) AND "entryPrice"<(10::numeric^20) AND scale("entryPrice")<=18 AND "entryPrice">0);

-- BacktestTrade.exitPrice: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_exitPrice_decimal" CHECK ("exitPrice">-(10::numeric^20) AND "exitPrice"<(10::numeric^20) AND scale("exitPrice")<=18 AND "exitPrice">0);

-- BacktestTrade.netPnl: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_netPnl_decimal" CHECK ("netPnl">-(10::numeric^30) AND "netPnl"<(10::numeric^30) AND scale("netPnl")<=18);

-- BacktestTrade.fees: amount 38,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_fees_decimal" CHECK ("fees">-(10::numeric^20) AND "fees"<(10::numeric^20) AND scale("fees")<=18);

ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_sequence_nonnegative" CHECK ("sequence">=0);

-- BacktestMetric.value: aggregate 48,18 signed; NUMERIC has no rounding typmod.

ALTER TABLE "backtest_metric" ADD CONSTRAINT "backtest_metric_value_decimal" CHECK ("value">-(10::numeric^30) AND "value"<(10::numeric^30) AND scale("value")<=18);

ALTER TABLE "backtest_metric" ADD CONSTRAINT "backtest_metric_sampleCount_nonnegative" CHECK ("sampleCount">=0);

ALTER TABLE "dataset_manifest" ADD CONSTRAINT "dataset_manifest_artifactHash_length" CHECK (octet_length("artifactHash")=32);

ALTER TABLE "dataset_manifest" ADD CONSTRAINT "dataset_manifest_rulesManifestHash_length" CHECK (octet_length("rulesManifestHash")=32);

ALTER TABLE "dataset_manifest" ADD CONSTRAINT "dataset_manifest_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "dataset_manifest" ADD CONSTRAINT "dataset_manifest_schemaVersion_nonnegative" CHECK ("schemaVersion">=0);

ALTER TABLE "dataset_manifest" ADD CONSTRAINT "dataset_manifest_rowCount_nonnegative" CHECK ("rowCount">=0);

-- Candle.open: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "candle" ADD CONSTRAINT "candle_open_decimal" CHECK ("open">-(10::numeric^20) AND "open"<(10::numeric^20) AND scale("open")<=18 AND "open">0);

-- Candle.high: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "candle" ADD CONSTRAINT "candle_high_decimal" CHECK ("high">-(10::numeric^20) AND "high"<(10::numeric^20) AND scale("high")<=18 AND "high">0);

-- Candle.low: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "candle" ADD CONSTRAINT "candle_low_decimal" CHECK ("low">-(10::numeric^20) AND "low"<(10::numeric^20) AND scale("low")<=18 AND "low">0);

-- Candle.close: price 38,18 positive; NUMERIC has no rounding typmod.

ALTER TABLE "candle" ADD CONSTRAINT "candle_close_decimal" CHECK ("close">-(10::numeric^20) AND "close"<(10::numeric^20) AND scale("close")<=18 AND "close">0);

-- Candle.baseVolume: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "candle" ADD CONSTRAINT "candle_baseVolume_decimal" CHECK ("baseVolume">-(10::numeric^30) AND "baseVolume"<(10::numeric^30) AND scale("baseVolume")<=18 AND "baseVolume">=0);

-- Candle.quoteVolume: aggregate 48,18 nonnegative; NUMERIC has no rounding typmod.

ALTER TABLE "candle" ADD CONSTRAINT "candle_quoteVolume_decimal" CHECK ("quoteVolume">-(10::numeric^30) AND "quoteVolume"<(10::numeric^30) AND scale("quoteVolume")<=18 AND "quoteVolume">=0);

ALTER TABLE "candle" ADD CONSTRAINT "candle_sourceHash_length" CHECK (octet_length("sourceHash")=32);

ALTER TABLE "candle" ADD CONSTRAINT "candle_timeframeSeconds_nonnegative" CHECK ("timeframeSeconds">=0);

ALTER TABLE "candle" ADD CONSTRAINT "candle_tradeCount_nonnegative" CHECK ("tradeCount">=0);

ALTER TABLE "candle" ADD CONSTRAINT "candle_revision_nonnegative" CHECK ("revision">=0);

ALTER TABLE "market_gap" ADD CONSTRAINT "market_gap_repairEvidenceHash_length" CHECK (octet_length("repairEvidenceHash")=32);

ALTER TABLE "market_checkpoint" ADD CONSTRAINT "market_checkpoint_sourceRevision_nonnegative" CHECK ("sourceRevision">=0);

ALTER TABLE "market_checkpoint" ADD CONSTRAINT "market_checkpoint_ownerEpoch_nonnegative" CHECK ("ownerEpoch">=0);

ALTER TABLE "market_checkpoint" ADD CONSTRAINT "market_checkpoint_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "subscription_assignment" ADD CONSTRAINT "subscription_assignment_ownerEpoch_nonnegative" CHECK ("ownerEpoch">=0);

ALTER TABLE "subscription_assignment" ADD CONSTRAINT "subscription_assignment_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_schemaVersion_nonnegative" CHECK ("schemaVersion">=0);

ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_aggregateVersion_nonnegative" CHECK ("aggregateVersion">=0);

ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_attempts_nonnegative" CHECK ("attempts">=0);

ALTER TABLE "consumer_inbox" ADD CONSTRAINT "consumer_inbox_payloadHash_length" CHECK (octet_length("payloadHash")=32);

ALTER TABLE "consumer_inbox" ADD CONSTRAINT "consumer_inbox_schemaVersion_nonnegative" CHECK ("schemaVersion">=0);

ALTER TABLE "notification" ADD CONSTRAINT "notification_templateVersion_nonnegative" CHECK ("templateVersion">=0);

ALTER TABLE "notification" ADD CONSTRAINT "notification_attempts_nonnegative" CHECK ("attempts">=0);

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_previousHash_length" CHECK (octet_length("previousHash")=32);

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_entryHash_length" CHECK (octet_length("entryHash")=32);

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_schemaVersion_nonnegative" CHECK ("schemaVersion">=0);

ALTER TABLE "system_event" ADD CONSTRAINT "system_event_evidenceHash_length" CHECK (octet_length("evidenceHash")=32);

ALTER TABLE "system_event" ADD CONSTRAINT "system_event_schemaVersion_nonnegative" CHECK ("schemaVersion">=0);

ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_evidenceHash_length" CHECK (octet_length("evidenceHash")=32);

ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_epoch_nonnegative" CHECK ("epoch">=0);

ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_unresolvedCount_nonnegative" CHECK ("unresolvedCount">=0);

ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_version_nonnegative" CHECK ("version">=0);

ALTER TABLE "user" ADD CONSTRAINT "user_normalized_email" CHECK ("emailNormalized"=lower(btrim("emailNormalized")) AND length("emailNormalized")>3);

ALTER TABLE "user" ADD CONSTRAINT "user_password_is_hash" CHECK ("passwordHash" IS NULL OR "passwordHash" LIKE '$argon2id$%');

ALTER TABLE "exchange_connection" ADD CONSTRAINT "exchange_connection_external_mode" CHECK (mode<>'PAPER');

ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_live_mode" CHECK (mode='LIVE');

ALTER TABLE "paper_account" ADD CONSTRAINT "paper_account_paper_mode" CHECK (mode='PAPER');

ALTER TABLE "paper_order" ADD CONSTRAINT "paper_order_paper_mode" CHECK (mode='PAPER');

ALTER TABLE "paper_position" ADD CONSTRAINT "paper_position_paper_mode" CHECK (mode='PAPER');

ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_connection_mode" CHECK ((mode='PAPER' AND "connectionId" IS NULL) OR (mode<>'PAPER' AND "connectionId" IS NOT NULL));

ALTER TABLE "order" ADD CONSTRAINT "order_connection_mode" CHECK ((mode='PAPER' AND "connectionId" IS NULL) OR (mode<>'PAPER' AND "connectionId" IS NOT NULL));

ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_connection_mode" CHECK ((mode='PAPER' AND "connectionId" IS NULL) OR (mode<>'PAPER' AND "connectionId" IS NOT NULL));

ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_destination_mode" CHECK ((mode='PAPER' AND destination='PAPER_ENGINE') OR (mode<>'PAPER' AND destination='EXCHANGE'));

ALTER TABLE "order" ADD CONSTRAINT "order_fill_bound" CHECK ("filledQuantity"<=quantity);

ALTER TABLE "instrument_rule_version" ADD CONSTRAINT "instrument_rule_version_quantity_range" CHECK ("maxQuantity" IS NULL OR "maxQuantity">="minQuantity");

ALTER TABLE "candle" ADD CONSTRAINT "candle_timeframe" CHECK ("timeframeSeconds" IN (30,60,180,300,900,1800,3600));

ALTER TABLE "candle" ADD CONSTRAINT "candle_time_bounds" CHECK ("closeTime"="openTime"+"timeframeSeconds"*interval '1 second' AND mod(extract(epoch FROM "openTime"),"timeframeSeconds")=0);

ALTER TABLE "candle" ADD CONSTRAINT "candle_ohlc" CHECK (high>=low AND high>=open AND high>=close AND low<=open AND low<=close);

ALTER TABLE "user_session" ADD CONSTRAINT "user_session_expiresAt_order" CHECK ("expiresAt">="createdAt");

ALTER TABLE "user_session" ADD CONSTRAINT "user_session_revokedAt_order" CHECK ("revokedAt">="createdAt");

ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_expiresAt_order" CHECK ("expiresAt">="createdAt");

ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_consumedAt_order" CHECK ("consumedAt">="createdAt");

ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_expiresAt_order" CHECK ("expiresAt">="createdAt");

ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_consumedAt_order" CHECK ("consumedAt">="createdAt");

ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_expiresAt_order" CHECK ("expiresAt">="createdAt");

ALTER TABLE "live_grant" ADD CONSTRAINT "live_grant_revokedAt_order" CHECK ("revokedAt">="createdAt");


-- A single active immutable version per parent; regular nullable unique keys keep NULL distinct.
CREATE UNIQUE INDEX credential_one_active ON encrypted_credential ("tenantId","connectionId") WHERE status='ACTIVE';
CREATE UNIQUE INDEX instrument_rule_one_current ON instrument_rule_version ("instrumentId") WHERE "isCurrent";
-- Stored booleans give the RLS planner a built-in Boolean predicate. PostgreSQL
-- enum_eq is not LEAKPROOF; enum predicates cannot reliably use these indexes under RLS.
ALTER TABLE "order" ADD COLUMN "isActive" boolean GENERATED ALWAYS AS
 (status IN ('CREATED','RISK_APPROVED','SUBMITTING','SUBMITTED','PARTIALLY_FILLED','CANCEL_PENDING','UNKNOWN','RECONCILIATION_REQUIRED')) STORED NOT NULL;
ALTER TABLE strategy_instance ADD COLUMN "isRunning" boolean GENERATED ALWAYS AS (status='RUNNING') STORED NOT NULL;
CREATE INDEX order_active_account ON "order" ("tenantId","accountId","instrumentId",id) WHERE "isActive";
CREATE INDEX strategy_running_tenant ON strategy_instance ("tenantId",id) WHERE "isRunning";
CREATE INDEX outbox_ready ON outbox_event ("availableAt",id) WHERE "deliveredAt" IS NULL;
CREATE INDEX attempt_unresolved ON submission_attempt ("tenantId","orderId","createdAt") WHERE status IN ('DISPATCHING','UNKNOWN');

-- Ledger and other durable evidence are append-only, including for the table owner.
CREATE FUNCTION ctp_immutable_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Immutable evidence cannot be changed' USING ERRCODE='23514';
END $$;


CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "order_intent" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "fill" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "fee" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "funding_payment" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "order_event" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "ledger_transaction" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "ledger_entry" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "signal" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "asset_valuation" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "risk_profile" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "risk_decision" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();

CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON "risk_event" FOR EACH ROW EXECUTE FUNCTION ctp_immutable_row();


CREATE FUNCTION ctp_immutable_rule() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'isCurrent') IS DISTINCT FROM (to_jsonb(OLD)-'isCurrent') THEN
    RAISE EXCEPTION 'Historical rules are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_rule BEFORE UPDATE OR DELETE ON instrument_rule_version FOR EACH ROW EXECUTE FUNCTION ctp_immutable_rule();

-- A deduplication key always identifies the original request. Completion fields
-- remain mutable, while deletion is reserved for a future controlled retention job.
CREATE FUNCTION ctp_immutable_idempotency() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR
    ROW(NEW.id,NEW."tenantId",NEW.operation,NEW."idempotencyKey",NEW."requestHash",NEW."createdAt")
    IS DISTINCT FROM
    ROW(OLD.id,OLD."tenantId",OLD.operation,OLD."idempotencyKey",OLD."requestHash",OLD."createdAt") THEN
    RAISE EXCEPTION 'Idempotency request identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_idempotency BEFORE UPDATE OR DELETE ON idempotency_record
 FOR EACH ROW EXECUTE FUNCTION ctp_immutable_idempotency();

-- Internal enforcement metadata is deliberately outside the 59 public domain
-- models. An immutable posting is sealed when its deferred constraints run.
-- No application role can access this schema or execute its trigger functions.
CREATE SCHEMA ctp_internal;
REVOKE ALL ON SCHEMA ctp_internal FROM PUBLIC;
CREATE TABLE ctp_internal.ledger_seal (
  "transactionId" uuid PRIMARY KEY REFERENCES public.ledger_transaction(id) ON DELETE RESTRICT,
  "tenantId" uuid NOT NULL,
  "sealedAt" timestamptz(3) NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE ctp_internal.ledger_seal FROM PUBLIC;

-- Upgrade fail-closed: old postings must already be complete and conserved.
-- Migration 002 installs RLS below, after validating and sealing legacy rows.
LOCK TABLE public.ledger_transaction, public.ledger_entry IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ledger_transaction t
    LEFT JOIN public.ledger_entry e ON e."transactionId"=t.id
    GROUP BY t.id HAVING count(e.id)<2
  ) OR EXISTS (
    SELECT 1 FROM public.ledger_entry GROUP BY "transactionId",asset HAVING count(*)<2 OR sum(amount)<>0
  ) THEN
    RAISE EXCEPTION 'Existing ledger postings violate conservation' USING ERRCODE='23514';
  END IF;
  INSERT INTO ctp_internal.ledger_seal ("transactionId","tenantId")
    SELECT id,"tenantId" FROM public.ledger_transaction;
END $$;

CREATE FUNCTION ctp_internal.ledger_entry_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Ledger tenant context is required' USING ERRCODE='42501';
  END IF;
  -- Every entry takes the same parent lock before checking the seal. A parent
  -- cannot become visible to another transaction until its seal also commits.
  PERFORM 1 FROM public.ledger_transaction
    WHERE id=NEW."transactionId" AND "tenantId"=NEW."tenantId"
      AND "accountId"=NEW."accountId" AND mode=NEW.mode FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger parent scope does not match' USING ERRCODE='23503';
  END IF;
  IF EXISTS (SELECT 1 FROM ctp_internal.ledger_seal WHERE "transactionId"=NEW."transactionId") THEN
    RAISE EXCEPTION 'A closed ledger posting cannot accept entries' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION ctp_internal.ledger_validate_and_seal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE transaction_id uuid;
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Ledger tenant context is required' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='ledger_transaction' THEN transaction_id=NEW.id;
  ELSE transaction_id=NEW."transactionId"; END IF;
  PERFORM 1 FROM public.ledger_transaction
    WHERE id=transaction_id AND "tenantId"=NEW."tenantId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger parent scope does not match' USING ERRCODE='23503';
  END IF;
  IF EXISTS (SELECT 1 FROM ctp_internal.ledger_seal WHERE "transactionId"=transaction_id) THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM public.ledger_entry WHERE "transactionId"=transaction_id AND "tenantId"=NEW."tenantId")<2
    OR EXISTS (
      SELECT 1 FROM public.ledger_entry WHERE "transactionId"=transaction_id AND "tenantId"=NEW."tenantId"
      GROUP BY asset HAVING count(*)<2 OR sum(amount)<>0
    ) THEN
    RAISE EXCEPTION 'A ledger posting requires at least two entries and zero sum per asset' USING ERRCODE='23514';
  END IF;
  INSERT INTO ctp_internal.ledger_seal ("transactionId","tenantId") VALUES (transaction_id,NEW."tenantId");
  RETURN NULL;
END $$;

CREATE TRIGGER ledger_entry_guard BEFORE INSERT ON public.ledger_entry
 FOR EACH ROW EXECUTE FUNCTION ctp_internal.ledger_entry_guard();
CREATE CONSTRAINT TRIGGER ledger_header_conservation AFTER INSERT ON public.ledger_transaction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_internal.ledger_validate_and_seal();
CREATE CONSTRAINT TRIGGER ledger_entry_conservation AFTER INSERT ON public.ledger_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_internal.ledger_validate_and_seal();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ctp_internal FROM PUBLIC;

-- Roles have no login credentials. Deployment creates independent LOGIN roles and grants membership.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['ctp_api','ctp_signer','ctp_ingest'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin OR rolreplication)) THEN
      RAISE EXCEPTION 'Existing application role has unsafe privileges';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ctp_api,ctp_signer,ctp_ingest;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_immutable_row(),ctp_immutable_rule(),ctp_immutable_idempotency() FROM PUBLIC;


ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user" USING ("id"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("id"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT (id,"emailNormalized",status,"emailVerifiedAt","updatedAt","createdAt") ON "user" TO ctp_api;

ALTER TABLE "user_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_session" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_session" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE "email_verification_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_verification_token" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_verification_token" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE "password_reset_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_token" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "password_reset_token" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE "two_factor_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "two_factor_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "two_factor_config" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE "recovery_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_code" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "recovery_code" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE "exchange_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exchange_account" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "exchange_account" TO ctp_api;

ALTER TABLE "exchange_connection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_connection" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exchange_connection" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "exchange_connection" TO ctp_api;

ALTER TABLE "encrypted_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "encrypted_credential" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "encrypted_credential" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT ON "encrypted_credential" TO ctp_signer;

ALTER TABLE "live_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_grant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "live_grant" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "live_grant" TO ctp_api;

GRANT SELECT ON "instrument" TO ctp_api;

GRANT SELECT ON "instrument_rule_version" TO ctp_api;

GRANT SELECT ON "capability_snapshot" TO ctp_api;

ALTER TABLE "balance_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "balance_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "balance_snapshot" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "balance_snapshot" TO ctp_api;

ALTER TABLE "position" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "position" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "position" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "position" TO ctp_api;

ALTER TABLE "account_state_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_state_version" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_state_version" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "account_state_version" TO ctp_api;

ALTER TABLE "ledger_transaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_transaction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ledger_transaction" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "ledger_transaction" TO ctp_api;

ALTER TABLE "ledger_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ledger_entry" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "ledger_entry" TO ctp_api;

ALTER TABLE "asset_valuation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_valuation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "asset_valuation" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "asset_valuation" TO ctp_api;

ALTER TABLE "order_intent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_intent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_intent" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "order_intent" TO ctp_api;

ALTER TABLE "idempotency_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_record" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "idempotency_record" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_record" TO ctp_api;

ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "order" TO ctp_api;

ALTER TABLE "algo_order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "algo_order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "algo_order" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "algo_order" TO ctp_api;

ALTER TABLE "submission_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_attempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "submission_attempt" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "submission_attempt" TO ctp_api;

ALTER TABLE "order_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_event" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "order_event" TO ctp_api;

ALTER TABLE "trade" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trade" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "trade" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "trade" TO ctp_api;

ALTER TABLE "fill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fill" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fill" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "fill" TO ctp_api;

ALTER TABLE "fee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fee" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fee" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "fee" TO ctp_api;

ALTER TABLE "funding_payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "funding_payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "funding_payment" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "funding_payment" TO ctp_api;

GRANT SELECT ON "strategy_definition" TO ctp_api;

GRANT SELECT ON "strategy_parameter" TO ctp_api;

ALTER TABLE "strategy_instance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "strategy_instance" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "strategy_instance" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "strategy_instance" TO ctp_api;

ALTER TABLE "strategy_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "strategy_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "strategy_run" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "strategy_run" TO ctp_api;

ALTER TABLE "strategy_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "strategy_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "strategy_state" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "strategy_state" TO ctp_api;

ALTER TABLE "signal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "signal" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "signal" TO ctp_api;

ALTER TABLE "risk_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "risk_profile" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "risk_profile" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "risk_profile" TO ctp_api;

ALTER TABLE "risk_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "risk_decision" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "risk_decision" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "risk_decision" TO ctp_api;

ALTER TABLE "risk_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "risk_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "risk_event" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "risk_event" TO ctp_api;

ALTER TABLE "risk_reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "risk_reservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "risk_reservation" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "risk_reservation" TO ctp_api;

ALTER TABLE "risk_budget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "risk_budget" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "risk_budget" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "risk_budget" TO ctp_api;

ALTER TABLE "trading_pause" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trading_pause" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "trading_pause" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "trading_pause" TO ctp_api;

ALTER TABLE "circuit_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "circuit_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "circuit_state" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "circuit_state" TO ctp_api;

ALTER TABLE "paper_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "paper_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "paper_account" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "paper_account" TO ctp_api;

ALTER TABLE "paper_order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "paper_order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "paper_order" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "paper_order" TO ctp_api;

ALTER TABLE "paper_position" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "paper_position" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "paper_position" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "paper_position" TO ctp_api;

ALTER TABLE "backtest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "backtest" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "backtest" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "backtest" TO ctp_api;

ALTER TABLE "backtest_trade" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "backtest_trade" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "backtest_trade" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "backtest_trade" TO ctp_api;

ALTER TABLE "backtest_metric" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "backtest_metric" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "backtest_metric" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "backtest_metric" TO ctp_api;

GRANT SELECT ON "dataset_manifest" TO ctp_api;

GRANT SELECT ON "candle" TO ctp_api;

GRANT SELECT ON "market_gap" TO ctp_api;

GRANT SELECT ON "market_checkpoint" TO ctp_api;

GRANT SELECT ON "subscription_assignment" TO ctp_api;

ALTER TABLE "outbox_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outbox_event" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_event" TO ctp_api;

ALTER TABLE "consumer_inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consumer_inbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "consumer_inbox" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "consumer_inbox" TO ctp_api;

ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "notification" TO ctp_api;

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT ON "audit_log" TO ctp_api;

ALTER TABLE "reconciliation_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reconciliation_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reconciliation_run" USING ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "reconciliation_run" TO ctp_api;

GRANT SELECT,INSERT,UPDATE,DELETE ON "instrument" TO ctp_ingest;

GRANT SELECT,INSERT,UPDATE,DELETE ON "instrument_rule_version" TO ctp_ingest;

GRANT SELECT,INSERT,UPDATE,DELETE ON "capability_snapshot" TO ctp_ingest;

GRANT SELECT,INSERT,UPDATE,DELETE ON "candle" TO ctp_ingest;

GRANT SELECT,INSERT,UPDATE,DELETE ON "market_gap" TO ctp_ingest;

GRANT SELECT,INSERT,UPDATE,DELETE ON "market_checkpoint" TO ctp_ingest;

GRANT SELECT,INSERT,UPDATE,DELETE ON "subscription_assignment" TO ctp_ingest;

-- No LOGIN, passwords, seed or real financial operations are created by migrations.
COMMIT;
