BEGIN;
-- Construction only. Risk prepare/final dispatch still reject AMEND until its
-- certified control/delta and causal outcome contracts are accepted together.
-- Existing immutable commands and published migrations remain unchanged.
ALTER TABLE ctp_execution.command DROP CONSTRAINT command_operation_check;
ALTER TABLE ctp_execution.command ADD CONSTRAINT command_operation_check
 CHECK(operation IN('PLACE','CANCEL','AMEND'));
ALTER TABLE ctp_execution.command ADD CONSTRAINT command_native_amend_shape CHECK(
 CASE WHEN operation='AMEND' THEN COALESCE(
  command::jsonb->>'semantics'='IN_PLACE'
  AND command::jsonb->'identity'=jsonb_build_object('exchangeOrderId','PRESERVED','clientOrderId','REPLACED')
  AND command::jsonb->'target'->>'internalOrderId'="orderId"::text
  AND command::jsonb->'locator'->'locator'->>'kind'='EXCHANGE_ID'
  AND command::jsonb->'target'->'current'->>'instrumentId'=command::jsonb->'replacement'->>'instrumentId'
  AND command::jsonb->'target'->'current'->>'side'=command::jsonb->'replacement'->>'side'
  AND command::jsonb->'target'->'current'->>'type'='LIMIT'
  AND command::jsonb->'replacement'->>'type'='LIMIT'
  AND command::jsonb->'target'->'current'->>'timeInForce'='GTC'
  AND command::jsonb->'replacement'->>'timeInForce'='GTC'
  AND command::jsonb->'target'->'current'->>'limitPrice'=command::jsonb->'replacement'->>'limitPrice'
  AND command::jsonb->'target'->'current'->'size'->>'kind'='BASE_QUANTITY'
  AND command::jsonb->'replacement'->'size'->>'kind'='BASE_QUANTITY'
  AND command::jsonb->'target'->'current'->'size'->>'asset'=command::jsonb->'replacement'->'size'->>'asset'
  AND command::jsonb->'target'->'current'->>'clientOrderId'<>command::jsonb->'replacement'->>'clientOrderId'
  AND (command::jsonb->'replacement'->'size'->>'value')::numeric>0
  AND (command::jsonb->'replacement'->'size'->>'value')::numeric<(command::jsonb->'target'->'current'->'size'->>'value')::numeric
  AND (command::jsonb->'target'->>'filledQuantity')::numeric<(command::jsonb->'replacement'->'size'->>'value')::numeric
  AND command::jsonb->'replacement'->>'reduceOnly'='false'
  AND command::jsonb->'target'->'current'->>'reduceOnly'='false'
  AND command::jsonb->'target'->'current'->'trigger'='null'::jsonb
  AND command::jsonb->'replacement'->'trigger'='null'::jsonb
  AND (command::jsonb->'target'->>'nativeUpdatedAt')::bigint<=(command::jsonb->'target'->>'observedAt')::bigint
 ,false) ELSE true END);
CREATE UNIQUE INDEX execution_amend_once ON public.submission_attempt("tenantId","intentId")
 WHERE operation='AMEND' AND "workerId"='order-engine';
COMMIT;
