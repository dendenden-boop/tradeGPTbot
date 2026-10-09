BEGIN;
-- Certified CANCEL is a separate frozen native control, never synthetic AMEND or PLACE.
ALTER TABLE ctp_admission.issuance DROP CONSTRAINT issuance_control_shape;
ALTER TABLE ctp_admission.issuance ADD CONSTRAINT issuance_control_shape CHECK(
 CASE WHEN request->>'operation'='PLACE' THEN "primaryReservationId" IS NULL AND control IS NULL
 ELSE request->>'operation' IN('AMEND','CANCEL') AND "primaryReservationId" IS NOT NULL
  AND "primaryReservationId"<>"reservationId" AND control IS NOT NULL
  AND notional=0 AND "reductionQuantity"=0 END);
CREATE OR REPLACE FUNCTION ctp_admission.cancel_target(p jsonb,own_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid:=(p->'binding'->>'tenantId')::uuid; cmd ctp_execution.command;
 o public."order"; primary_i ctp_admission.issuance; rr public.risk_reservation;
 original ctp_execution.command; progress ctp_execution.progress; body jsonb; c jsonb; pending public.submission_attempt;
BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_CANCEL_SCOPE'; END IF;
 SELECT * INTO cmd FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF NOT FOUND OR cmd.operation IS DISTINCT FROM 'CANCEL' OR cmd.binding::jsonb IS DISTINCT FROM p->'binding'
  OR p->'binding'->>'mode' IS DISTINCT FROM 'TESTNET' OR p->'binding'->'profile'->>'exchange' IS DISTINCT FROM 'BINANCE'
  OR p->'binding'->'profile'->>'market' IS DISTINCT FROM 'SPOT'
  OR p->'binding'->'profile'->>'endpointProfileId' IS DISTINCT FROM 'binance-spot-testnet-v1'
 THEN RAISE EXCEPTION 'RISK_CANCEL_UNSUPPORTED'; END IF;
 c:=cmd.command::jsonb;
 IF NOT ctp_market.snapshot_keys(c,ARRAY['instrumentId','locator','target'])
  OR NOT ctp_market.snapshot_keys(c->'locator',ARRAY['kind','id']) OR c->'locator'->>'kind' IS DISTINCT FROM 'EXCHANGE_ID'
  OR NOT ctp_market.snapshot_keys(c->'target',ARRAY['internalOrderId','placeIntentId','revision','observedAt','nativeUpdatedAt','current','filledQuantity'])
  OR jsonb_typeof(c->'target'->'revision') IS DISTINCT FROM 'string' OR c->'target'->>'revision' !~ '^[1-9][0-9]{0,18}$'
  OR jsonb_typeof(c->'target'->'nativeUpdatedAt') IS DISTINCT FROM 'number'
  OR c->'instrumentId' IS DISTINCT FROM c->'target'->'current'->'instrumentId'
 THEN RAISE EXCEPTION 'RISK_CANCEL_TARGET'; END IF;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=cmd."orderId" FOR UPDATE;
 IF NOT FOUND OR o."accountId"<>(p->'binding'->>'accountId')::uuid OR o.mode<>'TESTNET'
  OR o."connectionId"<>(p->'binding'->>'connectionId')::uuid
  OR (o.status NOT IN('SUBMITTED','PARTIALLY_FILLED') AND NOT (own_attempt IS NOT NULL AND o.status='CANCEL_PENDING'))
  OR (own_attempt IS NULL AND (o."reconciliationState"<>'CONSISTENT'
   OR EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."orderId"=o.id AND a.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED'))))
 THEN RAISE EXCEPTION 'RISK_CANCEL_TARGET'; END IF;
 IF own_attempt IS NOT NULL THEN
  SELECT * INTO pending FROM public.submission_attempt WHERE "tenantId"=t AND id=own_attempt AND "orderId"=o.id AND "intentId"=cmd."intentId";
  IF NOT FOUND OR pending.operation IS DISTINCT FROM 'CANCEL'::public."SubmissionOperation" OR pending.status IS DISTINCT FROM 'DISPATCHING'::public."SubmissionStatus"
   OR pending."transportStartedAt" IS NOT NULL OR pending."permitConsumedAt" IS NOT NULL OR pending."operationVersion" IS DISTINCT FROM o.version
   OR o."reconciliationState" IS DISTINCT FROM 'REQUIRED'::public."ReconciliationState"
   OR EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."orderId"=o.id AND a.id<>own_attempt AND a.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED'))
   OR NOT EXISTS(SELECT 1 FROM ctp_execution.authoritative_event e WHERE e."tenantId"=t AND e."orderId"=o.id AND e.identity='dispatch:'||own_attempt::text
    AND e.payload::jsonb=jsonb_build_object('type','DISPATCH','operation','CANCEL','attemptId',own_attempt::text))
  THEN RAISE EXCEPTION 'RISK_CANCEL_TARGET'; END IF;
 END IF;
 IF own_attempt IS NULL THEN PERFORM ctp_admission.sync_reservation(t,o.id); END IF;
 SELECT * INTO primary_i FROM ctp_admission.issuance WHERE "tenantId"=t AND "intentId"=o."intentId" AND "orderId"=o.id AND "primaryReservationId" IS NULL;
 IF NOT FOUND OR primary_i.request->'binding' IS DISTINCT FROM p->'binding'
  OR primary_i.certificate_hash<>sha256(convert_to(primary_i.certificate,'UTF8')) THEN RAISE EXCEPTION 'RISK_CANCEL_RESERVATION'; END IF;
 SELECT * INTO rr FROM public.risk_reservation WHERE "tenantId"=t AND id=primary_i."reservationId" FOR UPDATE;
 IF NOT FOUND OR rr.status<>'ACTIVE' OR rr.amount<=0 OR rr."accountId"<>o."accountId" OR rr.mode<>o.mode THEN RAISE EXCEPTION 'RISK_CANCEL_RESERVATION'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_admission.issuance i JOIN public.risk_reservation r ON r."tenantId"=i."tenantId" AND r.id=i."reservationId"
  WHERE i."tenantId"=t AND i."primaryReservationId"=rr.id AND i."intentId"<>cmd."intentId" AND r.status<>'RELEASED') THEN RAISE EXCEPTION 'RISK_CANCEL_PENDING'; END IF;
 SELECT * INTO original FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=o."intentId" AND "orderId"=o.id AND operation='PLACE';
 IF NOT FOUND OR c->'target'->'current' IS DISTINCT FROM ctp_execution.effective_command(t,o.id)
  OR c->'target'->>'internalOrderId' IS DISTINCT FROM o.id::text OR c->'target'->>'placeIntentId' IS DISTINCT FROM o."intentId"::text
  OR (c->'target'->>'revision')::bigint IS DISTINCT FROM o.version::bigint-(CASE WHEN own_attempt IS NULL THEN 0 ELSE 1 END) OR (c->'target'->>'filledQuantity')::numeric IS DISTINCT FROM o."filledQuantity"
  OR c->'locator'->>'id' IS DISTINCT FROM o."exchangeOrderId"
  OR jsonb_typeof(c->'target'->'observedAt') IS DISTINCT FROM 'number'
  OR (c->'target'->>'observedAt')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)
  OR floor(extract(epoch FROM clock_timestamp())*1000)-(c->'target'->>'observedAt')::bigint>5000
 THEN RAISE EXCEPTION 'RISK_CANCEL_TARGET'; END IF;
 SELECT * INTO progress FROM ctp_execution.progress WHERE "tenantId"=t AND "orderId"=o.id;
 SELECT e.payload::jsonb->'order' INTO body FROM ctp_execution.authoritative_event e WHERE e."tenantId"=t AND e."orderId"=o.id AND e.payload::jsonb->>'type'='NATIVE'
  AND sha256(convert_to(ctp_admission.canonical(e.payload::jsonb->'order'),'UTF8'))=progress."nativeHash" LIMIT 1;
 IF body IS NULL OR body->>'internalOrderId' IS DISTINCT FROM o.id::text OR body->>'intentId' IS DISTINCT FROM o."intentId"::text
  OR body->>'clientOrderId' IS DISTINCT FROM ctp_execution.effective_command(t,o.id)->>'clientOrderId' OR body->>'exchangeOrderId' IS DISTINCT FROM o."exchangeOrderId"
  OR body->>'instrumentId' IS DISTINCT FROM primary_i.instrument OR body->>'side' IS DISTINCT FROM o.side::text OR body->>'type' IS DISTINCT FROM 'LIMIT'
  OR body->'price'->>'state' IS DISTINCT FROM 'AVAILABLE' OR (body->'price'->>'value')::numeric IS DISTINCT FROM o."limitPrice"
  OR (body->>'quantity')::numeric IS DISTINCT FROM (ctp_execution.effective_command(t,o.id)->'size'->>'value')::numeric OR (body->>'filledQuantity')::numeric IS DISTINCT FROM o."filledQuantity"
  OR (body->>'updatedAt')::bigint IS DISTINCT FROM progress."nativeAt" OR progress."nativeAt" IS DISTINCT FROM (c->'target'->>'nativeUpdatedAt')::bigint
  OR body->'account' IS DISTINCT FROM jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',p->'binding'->>'externalAccountId')
  OR body->'scope' IS DISTINCT FROM (p->'binding'->'profile')-'accountMode'-'profileVersion'-'endpointProfileId'-'credentialRef'

  OR body->>'quantityUnit' IS DISTINCT FROM 'BASE' OR progress."nativeStatus" NOT IN('SUBMITTED','PARTIALLY_FILLED') OR (own_attempt IS NULL AND progress."nativeStatus" IS DISTINCT FROM o.status)
  OR body->>'status' IS DISTINCT FROM (CASE progress."nativeStatus" WHEN 'SUBMITTED' THEN 'OPEN' ELSE progress."nativeStatus"::text END)
  OR progress."nativeAt" IS NULL OR progress."nativeAt">floor(extract(epoch FROM clock_timestamp())*1000) THEN RAISE EXCEPTION 'RISK_CANCEL_NATIVE'; END IF;
 RETURN jsonb_build_object('orderId',o.id::text,'placeIntentId',o."intentId"::text,'reservationId',rr.id::text,
  'accountId',o."accountId"::text,'mode',o.mode::text,'asset',rr.asset,'amount',trim_scale(rr.amount)::text,'status',rr.status::text,
  'orderRevision',CASE WHEN own_attempt IS NULL THEN o.version::text ELSE c->'target'->>'revision' END,'command',ctp_execution.effective_command(t,o.id),'filledQuantity',trim_scale(o."filledQuantity")::text,
  'exchangeOrderId',o."exchangeOrderId",'nativeUpdatedAt',progress."nativeAt",'nativeHash',encode(progress."nativeHash",'hex'));
END $$;
REVOKE ALL ON FUNCTION ctp_admission.cancel_target(jsonb,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ctp_admission.control_target(p jsonb,own_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid:=(p->'binding'->>'tenantId')::uuid; cmd ctp_execution.command;
 o public."order"; primary_i ctp_admission.issuance; rr public.risk_reservation;
 original ctp_execution.command; progress ctp_execution.progress; body jsonb; c jsonb; pending public.submission_attempt;
BEGIN
 IF EXISTS(SELECT 1 FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid AND operation='CANCEL') THEN
  RETURN ctp_admission.cancel_target(p,own_attempt);
 END IF;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_AMEND_SCOPE'; END IF;
 SELECT * INTO cmd FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF NOT FOUND OR cmd.operation IS DISTINCT FROM 'AMEND' OR cmd.binding::jsonb IS DISTINCT FROM p->'binding'
  OR p->'binding'->>'mode' IS DISTINCT FROM 'TESTNET' OR p->'binding'->'profile'->>'exchange' IS DISTINCT FROM 'BINANCE'
  OR p->'binding'->'profile'->>'market' IS DISTINCT FROM 'SPOT'
  OR p->'binding'->'profile'->>'endpointProfileId' IS DISTINCT FROM 'binance-spot-testnet-v1'
 THEN RAISE EXCEPTION 'RISK_AMEND_UNSUPPORTED'; END IF;
 c:=cmd.command::jsonb;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=cmd."orderId" FOR UPDATE;
 IF NOT FOUND OR o."accountId"<>(p->'binding'->>'accountId')::uuid OR o.mode<>'TESTNET'
  OR o."connectionId"<>(p->'binding'->>'connectionId')::uuid
  OR o.status NOT IN('SUBMITTED','PARTIALLY_FILLED')
  OR (own_attempt IS NULL AND (o."reconciliationState"<>'CONSISTENT'
   OR EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."orderId"=o.id AND a.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED'))))
 THEN RAISE EXCEPTION 'RISK_AMEND_TARGET'; END IF;
 IF own_attempt IS NOT NULL THEN
  SELECT * INTO pending FROM public.submission_attempt WHERE "tenantId"=t AND id=own_attempt AND "orderId"=o.id AND "intentId"=cmd."intentId";
  IF NOT FOUND OR pending.operation IS DISTINCT FROM 'AMEND'::public."SubmissionOperation" OR pending.status IS DISTINCT FROM 'DISPATCHING'::public."SubmissionStatus"
   OR pending."transportStartedAt" IS NOT NULL OR pending."permitConsumedAt" IS NOT NULL OR pending."operationVersion" IS DISTINCT FROM o.version
   OR o."reconciliationState" IS DISTINCT FROM 'REQUIRED'::public."ReconciliationState"
   OR EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."orderId"=o.id AND a.id<>own_attempt AND a.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED'))
   OR NOT EXISTS(SELECT 1 FROM ctp_execution.authoritative_event e WHERE e."tenantId"=t AND e."orderId"=o.id AND e.identity='dispatch:'||own_attempt::text
    AND e.payload::jsonb=jsonb_build_object('type','DISPATCH','operation','AMEND','attemptId',own_attempt::text))
  THEN RAISE EXCEPTION 'RISK_AMEND_TARGET'; END IF;
 END IF;
 IF own_attempt IS NULL THEN PERFORM ctp_admission.sync_reservation(t,o.id); END IF;
 SELECT * INTO primary_i FROM ctp_admission.issuance WHERE "tenantId"=t AND "intentId"=o."intentId" AND "orderId"=o.id AND "primaryReservationId" IS NULL;
 IF NOT FOUND OR primary_i.request->'binding' IS DISTINCT FROM p->'binding'
  OR primary_i.certificate_hash<>sha256(convert_to(primary_i.certificate,'UTF8')) THEN RAISE EXCEPTION 'RISK_AMEND_RESERVATION'; END IF;
 SELECT * INTO rr FROM public.risk_reservation WHERE "tenantId"=t AND id=primary_i."reservationId" FOR UPDATE;
 IF NOT FOUND OR rr.status<>'ACTIVE' OR rr.amount<=0 OR rr."accountId"<>o."accountId" OR rr.mode<>o.mode THEN RAISE EXCEPTION 'RISK_AMEND_RESERVATION'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_admission.issuance i JOIN public.risk_reservation r ON r."tenantId"=i."tenantId" AND r.id=i."reservationId"
  WHERE i."tenantId"=t AND i."primaryReservationId"=rr.id AND i."intentId"<>cmd."intentId" AND r.status<>'RELEASED') THEN RAISE EXCEPTION 'RISK_AMEND_PENDING'; END IF;
 SELECT * INTO original FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=o."intentId" AND "orderId"=o.id AND operation='PLACE';
 IF NOT FOUND OR c->'target'->'current' IS DISTINCT FROM ctp_execution.effective_command(t,o.id)
  OR c->'target'->>'internalOrderId' IS DISTINCT FROM o.id::text OR c->'target'->>'placeIntentId' IS DISTINCT FROM o."intentId"::text
  OR (c->'target'->>'revision')::bigint IS DISTINCT FROM o.version::bigint-(CASE WHEN own_attempt IS NULL THEN 0 ELSE 1 END) OR (c->'target'->>'filledQuantity')::numeric IS DISTINCT FROM o."filledQuantity"
  OR c->'locator'->'locator'->>'id' IS DISTINCT FROM o."exchangeOrderId"
  OR jsonb_typeof(c->'target'->'observedAt') IS DISTINCT FROM 'number'
  OR (c->'target'->>'observedAt')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)
  OR floor(extract(epoch FROM clock_timestamp())*1000)-(c->'target'->>'observedAt')::bigint>5000
 THEN RAISE EXCEPTION 'RISK_AMEND_TARGET'; END IF;
 SELECT * INTO progress FROM ctp_execution.progress WHERE "tenantId"=t AND "orderId"=o.id;
 SELECT e.payload::jsonb->'order' INTO body FROM ctp_execution.authoritative_event e WHERE e."tenantId"=t AND e."orderId"=o.id AND e.payload::jsonb->>'type'='NATIVE'
  AND sha256(convert_to(ctp_admission.canonical(e.payload::jsonb->'order'),'UTF8'))=progress."nativeHash" LIMIT 1;
 IF body IS NULL OR body->>'internalOrderId' IS DISTINCT FROM o.id::text OR body->>'intentId' IS DISTINCT FROM o."intentId"::text
  OR body->>'clientOrderId' IS DISTINCT FROM ctp_execution.effective_command(t,o.id)->>'clientOrderId' OR body->>'exchangeOrderId' IS DISTINCT FROM o."exchangeOrderId"
  OR body->>'instrumentId' IS DISTINCT FROM primary_i.instrument OR body->>'side' IS DISTINCT FROM o.side::text OR body->>'type' IS DISTINCT FROM 'LIMIT'
  OR body->'price'->>'state' IS DISTINCT FROM 'AVAILABLE' OR (body->'price'->>'value')::numeric IS DISTINCT FROM o."limitPrice"
  OR (body->>'quantity')::numeric IS DISTINCT FROM (ctp_execution.effective_command(t,o.id)->'size'->>'value')::numeric OR (body->>'filledQuantity')::numeric IS DISTINCT FROM o."filledQuantity"
  OR (body->>'updatedAt')::bigint IS DISTINCT FROM progress."nativeAt" OR progress."nativeAt" IS DISTINCT FROM (c->'target'->>'nativeUpdatedAt')::bigint
  OR body->'account' IS DISTINCT FROM jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',p->'binding'->>'externalAccountId')
  OR body->'scope' IS DISTINCT FROM (p->'binding'->'profile')-'accountMode'-'profileVersion'-'endpointProfileId'-'credentialRef'

  OR body->>'quantityUnit' IS DISTINCT FROM 'BASE' OR progress."nativeStatus" IS DISTINCT FROM o.status
  OR body->>'status' IS DISTINCT FROM (CASE o.status WHEN 'SUBMITTED' THEN 'OPEN' ELSE o.status::text END)
  OR progress."nativeAt" IS NULL OR progress."nativeAt">floor(extract(epoch FROM clock_timestamp())*1000) THEN RAISE EXCEPTION 'RISK_AMEND_NATIVE'; END IF;
 RETURN jsonb_build_object('orderId',o.id::text,'placeIntentId',o."intentId"::text,'reservationId',rr.id::text,
  'accountId',o."accountId"::text,'mode',o.mode::text,'asset',rr.asset,'amount',trim_scale(rr.amount)::text,'status',rr.status::text,
  'orderRevision',CASE WHEN own_attempt IS NULL THEN o.version::text ELSE c->'target'->>'revision' END,'command',ctp_execution.effective_command(t,o.id),'filledQuantity',trim_scale(o."filledQuantity")::text,
  'exchangeOrderId',o."exchangeOrderId",'nativeUpdatedAt',progress."nativeAt",'nativeHash',encode(progress."nativeHash",'hex'));
END $$;

CREATE OR REPLACE FUNCTION ctp_certification.capture_sources(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; b jsonb; profile jsonb; s jsonb; pf jsonb; policy_platform ctp_risk.policy_revision; policy_user ctp_risk.policy_revision;
 a public.exchange_account; c public.exchange_connection; u public."user"; command ctp_execution.command; cap public.capability_snapshot; evaluation_order jsonb; retention jsonb;
 reg ctp_registry.current_record; obs ctp_certification.observation; observation jsonb; market_ids uuid[]; native ctp_market.snapshot_event;
 markets jsonb:='[]'; issued_exposure jsonb; loss ctp_risk.loss_batch; controls jsonb; controls_raw jsonb; result jsonb; age integer; now_ms bigint; market_id uuid; count_orders bigint; BEGIN
 IF NOT (ctp_risk.valid_policy_publisher('ctp_risk_certifier') OR ctp_risk.valid_policy_publisher('ctp_risk_admission') OR ctp_risk.valid_policy_publisher('ctp_execution')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
 t:=ctp_certification.lock_key(p,true);b:=p->'binding';profile:=b->'profile';m:=(b->>'mode')::public."TradingMode";
 pf:=ctp_certification.capture_inventory(jsonb_build_object('tenantId',t::text,'mode',m::text,'targetAccountId',b->>'accountId','maxEvidenceAgeMs',5000));
 SELECT * INTO u FROM public."user" WHERE id=t; IF NOT FOUND OR u.status::text<>'ACTIVE' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_SCOPE'; END IF;
 SELECT * INTO a FROM public.exchange_account WHERE "tenantId"=t AND id=(b->>'accountId')::uuid AND mode=m;
 IF NOT FOUND OR a.status::text<>'ACTIVE' OR a.exchange::text<>profile->>'exchange' OR a.region<>profile->>'region' OR a."accountMode"<>profile->>'accountMode' OR a."externalAccountId"<>b->>'externalAccountId' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_SCOPE'; END IF;
 SELECT * INTO c FROM public.exchange_connection WHERE "tenantId"=t AND "accountId"=a.id AND id=(b->>'connectionId')::uuid AND mode=m;
 IF NOT FOUND OR c.status::text<>'ACTIVE' OR c."disabledAt" IS NOT NULL OR c."withdrawalPermissionDetected" OR c.permissions->'read' IS DISTINCT FROM 'true'::jsonb OR c.permissions->'trade' IS DISTINCT FROM 'true'::jsonb OR c.permissions->'withdrawal' IS DISTINCT FROM 'false'::jsonb OR c."permissionsVerifiedAt" IS NULL THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PERMISSION'; END IF;
 SELECT * INTO command FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF NOT FOUND OR command.binding::jsonb IS DISTINCT FROM b OR command.operation NOT IN('PLACE','AMEND','CANCEL') OR NOT EXISTS(SELECT 1 FROM public.order_intent i WHERE i."tenantId"=t AND i.id=command."intentId" AND i."accountId"=a.id AND i.mode=m AND i."connectionId"=c.id AND i."instrumentId"=(p->>'dbInstrumentId')::uuid AND i."ruleVersionId"=(p->>'dbRuleId')::uuid AND i."commandHash"=command."commandHash") THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INTENT'; END IF;
 evaluation_order:=CASE command.operation WHEN 'PLACE' THEN command.command::jsonb WHEN 'AMEND' THEN command.command::jsonb->'replacement' WHEN 'CANCEL' THEN jsonb_set(command.command::jsonb->'target'->'current','{ruleVersion}',command.draft::jsonb->'order'->'ruleVersion') END;
 IF command.operation IN('AMEND','CANCEL') THEN
  retention:=ctp_admission.control_retention(p);
  -- A trusted unused zero control may have been reaped in this transaction.
  -- Reread the already-locked inventory; no native clock or expiry is renewed.
  pf:=ctp_certification.capture_inventory(jsonb_build_object('tenantId',t::text,'mode',m::text,'targetAccountId',b->>'accountId','maxEvidenceAgeMs',5000));
 END IF;
 SELECT r.* INTO policy_platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id) WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode=m;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_POLICY_MISSING'; END IF;
 SELECT r.* INTO policy_user FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id) WHERE h.scope='USER' AND h.target=t AND h.mode=m;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_POLICY_MISSING'; END IF;
 IF policy_platform."limitsText"::jsonb->>'valuationAsset'<>policy_user."limitsText"::jsonb->>'valuationAsset' THEN RAISE EXCEPTION 'RISK_POLICY_CURRENCY'; END IF;
 age:=least((policy_platform."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(policy_user."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer);
 LOCK TABLE public.instrument,public.instrument_rule_version,public.capability_snapshot IN SHARE MODE;
 SELECT * INTO cap FROM public.capability_snapshot WHERE exchange=a.exchange AND mode=m AND region=a.region AND "accountMode"=a."accountMode" AND market::text=CASE profile->>'market' WHEN 'SPOT' THEN 'SPOT' WHEN 'LINEAR_PERPETUAL' THEN 'PERPETUAL' WHEN 'INVERSE_PERPETUAL' THEN 'PERPETUAL' ELSE 'FUTURES' END ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR cap.id<>(p->>'dbCapabilityId')::uuid OR cap."verifiedAt">clock_timestamp() OR cap."expiresAt"<=clock_timestamp() OR cap."profileVersion"<>profile->>'profileVersion' OR NOT ctp_market.snapshot_keys(cap.capabilities,ARRAY['adapterVersion','features']) OR jsonb_typeof(cap.capabilities->'features')<>'array' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
 s:=jsonb_build_object('exchange',profile->'exchange','region',profile->'region','market',profile->'market','environment',profile->'environment');
 SELECT * INTO reg FROM ctp_registry.current_record WHERE scope=s AND id=p->>'instrumentId' FOR SHARE;
 IF NOT FOUND OR reg.record->'rules'->>'version'<>evaluation_order->>'ruleVersion' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
 SELECT v.* INTO obs FROM ctp_certification.observation_head h JOIN ctp_certification.observation v USING("tenantId",key,id,revision) WHERE h."tenantId"=t AND h.key=p-'intentId';
 IF NOT FOUND OR obs.hash<>sha256(convert_to(obs.payload,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_OBSERVATION'; END IF;
 observation:=obs.payload::jsonb->'observation';
 SELECT array_agg(mid ORDER BY mid) INTO market_ids FROM (SELECT DISTINCT (value->>'marketId')::uuid AS mid FROM jsonb_array_elements(observation->'valuations') UNION SELECT (observation->'execution'->>'marketId')::uuid)q;
 IF COALESCE(cardinality(market_ids),0) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 -- Sorted keys freeze current GAP/head replacements while native data is verified.
 FOR market_id IN SELECT e.id FROM ctp_market.snapshot_event e WHERE e.id=ANY(market_ids) ORDER BY ((e.payload::jsonb->'key')-'dbRuleId')::text LOOP
  SELECT * INTO native FROM ctp_market.snapshot_event WHERE snapshot_event.id=market_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('ctp:market:snapshot:'||((native.payload::jsonb->'key')-'dbRuleId')::text,0));
 END LOOP;
 FOREACH market_id IN ARRAY market_ids LOOP
  SELECT e.* INTO native FROM ctp_market.snapshot_head h JOIN ctp_market.snapshot_event e ON e.id=h.native WHERE e.id=market_id AND NOT h.gap AND h.key=e.key-'dbRuleId';
  IF NOT FOUND OR native.hash<>sha256(convert_to(native.payload,'UTF8')) OR ctp_market.snapshot_valid(native.payload::jsonb) IS NOT TRUE OR ctp_market.snapshot_metadata(native.payload::jsonb) IS NOT TRUE OR ctp_market.snapshot_fresh(native.payload::jsonb,age) IS NOT TRUE THEN RAISE EXCEPTION 'RISK_SNAPSHOT_MARKET'; END IF;
  IF market_id=(observation->'execution'->>'marketId')::uuid AND native.payload::jsonb->'record'<>reg.record THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
  markets:=markets||jsonb_build_array(jsonb_build_object('id',native.id::text,'revision',native.revision::text,'text',native.payload,'hash',encode(native.hash,'hex')));
 END LOOP;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 SELECT v.* INTO loss FROM ctp_risk.loss_head h JOIN ctp_risk.loss_batch v ON v."tenantId"=h."tenantId" AND v.id=h.id WHERE h."tenantId"=t AND h.mode=m AND h.asset=policy_platform."limitsText"::jsonb->>'valuationAsset' AND h.day=now_ms/86400000*86400000;
 IF NOT FOUND OR loss.hash<>sha256(convert_to(loss.checkpoint,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_LOSS'; END IF;
 issued_exposure:=ctp_admission.capture_exposure(t,m,pf,observation,markets,policy_platform."limitsText"::jsonb->>'valuationAsset');
 IF (SELECT count(*) FROM ctp_risk.global_head)>10000 OR (SELECT count(*) FROM ctp_risk.tenant_head WHERE "tenantId"=t)>10000 OR (SELECT count(*) FROM public.trading_pause WHERE "tenantId"=t)>10000 OR (SELECT count(*) FROM public.circuit_state WHERE "tenantId"=t)>10000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 controls_raw:=jsonb_build_object('global',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY kind,key) FROM ctp_risk.global_head h),'[]'), 'tenant',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY scope,target,kind,key) FROM ctp_risk.tenant_head h WHERE "tenantId"=t),'[]'),'pauses',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM public.trading_pause h WHERE "tenantId"=t),'[]'),'circuits',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM public.circuit_state h WHERE "tenantId"=t),'[]'));
 controls:=jsonb_build_object('pauses',jsonb_build_object('global',NOT EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill' AND state='RUNNING'), 'user',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='USER' AND kind='KILL_SWITCH' AND state<>'RUNNING') OR EXISTS(SELECT 1 FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL), 'connection',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='CONNECTION' AND target=c.id AND kind='KILL_SWITCH' AND state<>'RUNNING'), 'strategy',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='STRATEGY' AND kind='KILL_SWITCH' AND state<>'RUNNING')), 'circuit',CASE WHEN EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='CIRCUIT' AND state='OPEN') OR EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND kind='CIRCUIT' AND state='OPEN') OR EXISTS(SELECT 1 FROM public.circuit_state WHERE "tenantId"=t AND status::text='OPEN') THEN 'OPEN' WHEN EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='CIRCUIT' AND state='HALF_OPEN') OR EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND kind='CIRCUIT' AND state='HALF_OPEN') OR EXISTS(SELECT 1 FROM public.circuit_state WHERE "tenantId"=t AND status::text='HALF_OPEN') THEN 'HALF_OPEN' ELSE 'CLOSED' END);
 SELECT count(*) INTO count_orders FROM public.order_intent WHERE "tenantId"=t AND mode=m AND "createdAt">=clock_timestamp()-interval '1 minute';
 IF count_orders>1000000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 result:=jsonb_build_object('key',p,'capturedAt',now_ms,'user',jsonb_build_object('id',u.id::text,'status',u.status::text,'sessionEpoch',u."sessionEpoch"::text), 'portfolio',pf, 'policies',jsonb_build_array(ctp_risk.policy_json(policy_platform),ctp_risk.policy_json(policy_user)), 'metadata',jsonb_build_object('value',jsonb_build_object('record',reg.record,'capabilities',cap.capabilities->'features','adapterVersion',cap.capabilities->'adapterVersion'),'revision',reg.revision::text), 'intent',jsonb_build_object('id',command."intentId"::text,'operation',command.operation,'command',command.command::jsonb),'connection',jsonb_build_object('id',c.id::text,'accountId',c."accountId"::text,'mode',c.mode::text,'status',c.status::text,'permissionEpoch',a."permissionEpoch"::text,'version',c.version,'permissionsVersion',c."permissionsVersion",'verifiedAt',floor(extract(epoch FROM c."permissionsVerifiedAt")*1000)::bigint,'disabledAt',NULL,'withdrawalPermissionDetected',false,'permissions',jsonb_build_object('read',true,'trade',true,'withdrawal',false)), 'observation',jsonb_build_object('id',obs.id::text,'revision',obs.revision::text,'text',observation::text,'hash',encode(sha256(convert_to(observation::text,'UTF8')),'hex')), 'markets',markets,'loss',jsonb_build_object('checkpointText',loss.checkpoint,'hash',encode(loss.hash,'hex')), 'controls',jsonb_build_object('value',controls,'fingerprint',encode(sha256(convert_to(controls_raw::text,'UTF8')),'hex')), 'exposure',issued_exposure,'ordersInLastMinute',count_orders);
 IF retention IS NOT NULL THEN result:=result||jsonb_build_object('retention',retention); END IF;
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION ctp_certification.capture_dispatch_sources(p jsonb,own_attempt uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; b jsonb; profile jsonb; s jsonb; pf jsonb; policy_platform ctp_risk.policy_revision; policy_user ctp_risk.policy_revision;
 a public.exchange_account; c public.exchange_connection; u public."user"; command ctp_execution.command; cap public.capability_snapshot; evaluation_order jsonb; retention jsonb;
 reg ctp_registry.current_record; obs ctp_certification.observation; observation jsonb; market_ids uuid[]; native ctp_market.snapshot_event;
 markets jsonb:='[]'; issued_exposure jsonb; loss ctp_risk.loss_batch; controls jsonb; controls_raw jsonb; result jsonb; age integer; now_ms bigint; market_id uuid; count_orders bigint; BEGIN
 IF NOT (ctp_risk.valid_policy_publisher('ctp_risk_certifier') OR ctp_risk.valid_policy_publisher('ctp_risk_admission') OR ctp_risk.valid_policy_publisher('ctp_execution')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
 t:=ctp_certification.lock_key(p,true);b:=p->'binding';profile:=b->'profile';m:=(b->>'mode')::public."TradingMode";
 pf:=ctp_certification.capture_inventory(jsonb_build_object('tenantId',t::text,'mode',m::text,'targetAccountId',b->>'accountId','maxEvidenceAgeMs',5000));
 SELECT * INTO u FROM public."user" WHERE id=t; IF NOT FOUND OR u.status::text<>'ACTIVE' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_SCOPE'; END IF;
 SELECT * INTO a FROM public.exchange_account WHERE "tenantId"=t AND id=(b->>'accountId')::uuid AND mode=m;
 IF NOT FOUND OR a.status::text<>'ACTIVE' OR a.exchange::text<>profile->>'exchange' OR a.region<>profile->>'region' OR a."accountMode"<>profile->>'accountMode' OR a."externalAccountId"<>b->>'externalAccountId' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_SCOPE'; END IF;
 SELECT * INTO c FROM public.exchange_connection WHERE "tenantId"=t AND "accountId"=a.id AND id=(b->>'connectionId')::uuid AND mode=m;
 IF NOT FOUND OR c.status::text<>'ACTIVE' OR c."disabledAt" IS NOT NULL OR c."withdrawalPermissionDetected" OR c.permissions->'read' IS DISTINCT FROM 'true'::jsonb OR c.permissions->'trade' IS DISTINCT FROM 'true'::jsonb OR c.permissions->'withdrawal' IS DISTINCT FROM 'false'::jsonb OR c."permissionsVerifiedAt" IS NULL THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PERMISSION'; END IF;
 SELECT * INTO command FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF NOT FOUND OR command.binding::jsonb IS DISTINCT FROM b OR command.operation NOT IN('PLACE','AMEND','CANCEL') OR NOT EXISTS(SELECT 1 FROM public.order_intent i WHERE i."tenantId"=t AND i.id=command."intentId" AND i."accountId"=a.id AND i.mode=m AND i."connectionId"=c.id AND i."instrumentId"=(p->>'dbInstrumentId')::uuid AND i."ruleVersionId"=(p->>'dbRuleId')::uuid AND i."commandHash"=command."commandHash") THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INTENT'; END IF;
 evaluation_order:=CASE command.operation WHEN 'PLACE' THEN command.command::jsonb WHEN 'AMEND' THEN command.command::jsonb->'replacement' WHEN 'CANCEL' THEN jsonb_set(command.command::jsonb->'target'->'current','{ruleVersion}',command.draft::jsonb->'order'->'ruleVersion') END;
 IF command.operation IN('AMEND','CANCEL') THEN
  retention:=ctp_admission.control_target(p,own_attempt);
  -- A trusted unused zero control may have been reaped in this transaction.
  -- Reread the already-locked inventory; no native clock or expiry is renewed.
  pf:=ctp_certification.capture_inventory(jsonb_build_object('tenantId',t::text,'mode',m::text,'targetAccountId',b->>'accountId','maxEvidenceAgeMs',5000));
 END IF;
 SELECT r.* INTO policy_platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id) WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode=m;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_POLICY_MISSING'; END IF;
 SELECT r.* INTO policy_user FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id) WHERE h.scope='USER' AND h.target=t AND h.mode=m;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_POLICY_MISSING'; END IF;
 IF policy_platform."limitsText"::jsonb->>'valuationAsset'<>policy_user."limitsText"::jsonb->>'valuationAsset' THEN RAISE EXCEPTION 'RISK_POLICY_CURRENCY'; END IF;
 age:=least((policy_platform."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(policy_user."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer);
 LOCK TABLE public.instrument,public.instrument_rule_version,public.capability_snapshot IN SHARE MODE;
 SELECT * INTO cap FROM public.capability_snapshot WHERE exchange=a.exchange AND mode=m AND region=a.region AND "accountMode"=a."accountMode" AND market::text=CASE profile->>'market' WHEN 'SPOT' THEN 'SPOT' WHEN 'LINEAR_PERPETUAL' THEN 'PERPETUAL' WHEN 'INVERSE_PERPETUAL' THEN 'PERPETUAL' ELSE 'FUTURES' END ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR cap.id<>(p->>'dbCapabilityId')::uuid OR cap."verifiedAt">clock_timestamp() OR cap."expiresAt"<=clock_timestamp() OR cap."profileVersion"<>profile->>'profileVersion' OR NOT ctp_market.snapshot_keys(cap.capabilities,ARRAY['adapterVersion','features']) OR jsonb_typeof(cap.capabilities->'features')<>'array' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
 s:=jsonb_build_object('exchange',profile->'exchange','region',profile->'region','market',profile->'market','environment',profile->'environment');
 SELECT * INTO reg FROM ctp_registry.current_record WHERE scope=s AND id=p->>'instrumentId' FOR SHARE;
 IF NOT FOUND OR reg.record->'rules'->>'version'<>evaluation_order->>'ruleVersion' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
 SELECT v.* INTO obs FROM ctp_certification.observation_head h JOIN ctp_certification.observation v USING("tenantId",key,id,revision) WHERE h."tenantId"=t AND h.key=p-'intentId';
 IF NOT FOUND OR obs.hash<>sha256(convert_to(obs.payload,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_OBSERVATION'; END IF;
 observation:=obs.payload::jsonb->'observation';
 SELECT array_agg(mid ORDER BY mid) INTO market_ids FROM (SELECT DISTINCT (value->>'marketId')::uuid AS mid FROM jsonb_array_elements(observation->'valuations') UNION SELECT (observation->'execution'->>'marketId')::uuid)q;
 IF COALESCE(cardinality(market_ids),0) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 -- Sorted keys freeze current GAP/head replacements while native data is verified.
 FOR market_id IN SELECT e.id FROM ctp_market.snapshot_event e WHERE e.id=ANY(market_ids) ORDER BY ((e.payload::jsonb->'key')-'dbRuleId')::text LOOP
  SELECT * INTO native FROM ctp_market.snapshot_event WHERE snapshot_event.id=market_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('ctp:market:snapshot:'||((native.payload::jsonb->'key')-'dbRuleId')::text,0));
 END LOOP;
 FOREACH market_id IN ARRAY market_ids LOOP
  SELECT e.* INTO native FROM ctp_market.snapshot_head h JOIN ctp_market.snapshot_event e ON e.id=h.native WHERE e.id=market_id AND NOT h.gap AND h.key=e.key-'dbRuleId';
  IF NOT FOUND OR native.hash<>sha256(convert_to(native.payload,'UTF8')) OR ctp_market.snapshot_valid(native.payload::jsonb) IS NOT TRUE OR ctp_market.snapshot_metadata(native.payload::jsonb) IS NOT TRUE OR ctp_market.snapshot_fresh(native.payload::jsonb,age) IS NOT TRUE THEN RAISE EXCEPTION 'RISK_SNAPSHOT_MARKET'; END IF;
  IF market_id=(observation->'execution'->>'marketId')::uuid AND native.payload::jsonb->'record'<>reg.record THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
  markets:=markets||jsonb_build_array(jsonb_build_object('id',native.id::text,'revision',native.revision::text,'text',native.payload,'hash',encode(native.hash,'hex')));
 END LOOP;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 SELECT v.* INTO loss FROM ctp_risk.loss_head h JOIN ctp_risk.loss_batch v ON v."tenantId"=h."tenantId" AND v.id=h.id WHERE h."tenantId"=t AND h.mode=m AND h.asset=policy_platform."limitsText"::jsonb->>'valuationAsset' AND h.day=now_ms/86400000*86400000;
 IF NOT FOUND OR loss.hash<>sha256(convert_to(loss.checkpoint,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_LOSS'; END IF;
 issued_exposure:=ctp_admission.capture_exposure(t,m,pf,observation,markets,policy_platform."limitsText"::jsonb->>'valuationAsset');
 IF (SELECT count(*) FROM ctp_risk.global_head)>10000 OR (SELECT count(*) FROM ctp_risk.tenant_head WHERE "tenantId"=t)>10000 OR (SELECT count(*) FROM public.trading_pause WHERE "tenantId"=t)>10000 OR (SELECT count(*) FROM public.circuit_state WHERE "tenantId"=t)>10000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 controls_raw:=jsonb_build_object('global',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY kind,key) FROM ctp_risk.global_head h),'[]'), 'tenant',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY scope,target,kind,key) FROM ctp_risk.tenant_head h WHERE "tenantId"=t),'[]'),'pauses',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM public.trading_pause h WHERE "tenantId"=t),'[]'),'circuits',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM public.circuit_state h WHERE "tenantId"=t),'[]'));
 controls:=jsonb_build_object('pauses',jsonb_build_object('global',NOT EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill' AND state='RUNNING'), 'user',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='USER' AND kind='KILL_SWITCH' AND state<>'RUNNING') OR EXISTS(SELECT 1 FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL), 'connection',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='CONNECTION' AND target=c.id AND kind='KILL_SWITCH' AND state<>'RUNNING'), 'strategy',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='STRATEGY' AND kind='KILL_SWITCH' AND state<>'RUNNING')), 'circuit',CASE WHEN EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='CIRCUIT' AND state='OPEN') OR EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND kind='CIRCUIT' AND state='OPEN') OR EXISTS(SELECT 1 FROM public.circuit_state WHERE "tenantId"=t AND status::text='OPEN') THEN 'OPEN' WHEN EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='CIRCUIT' AND state='HALF_OPEN') OR EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND kind='CIRCUIT' AND state='HALF_OPEN') OR EXISTS(SELECT 1 FROM public.circuit_state WHERE "tenantId"=t AND status::text='HALF_OPEN') THEN 'HALF_OPEN' ELSE 'CLOSED' END);
 SELECT count(*) INTO count_orders FROM public.order_intent WHERE "tenantId"=t AND mode=m AND "createdAt">=clock_timestamp()-interval '1 minute';
 IF count_orders>1000000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 result:=jsonb_build_object('key',p,'capturedAt',now_ms,'user',jsonb_build_object('id',u.id::text,'status',u.status::text,'sessionEpoch',u."sessionEpoch"::text), 'portfolio',pf, 'policies',jsonb_build_array(ctp_risk.policy_json(policy_platform),ctp_risk.policy_json(policy_user)), 'metadata',jsonb_build_object('value',jsonb_build_object('record',reg.record,'capabilities',cap.capabilities->'features','adapterVersion',cap.capabilities->'adapterVersion'),'revision',reg.revision::text), 'intent',jsonb_build_object('id',command."intentId"::text,'operation',command.operation,'command',command.command::jsonb),'connection',jsonb_build_object('id',c.id::text,'accountId',c."accountId"::text,'mode',c.mode::text,'status',c.status::text,'permissionEpoch',a."permissionEpoch"::text,'version',c.version,'permissionsVersion',c."permissionsVersion",'verifiedAt',floor(extract(epoch FROM c."permissionsVerifiedAt")*1000)::bigint,'disabledAt',NULL,'withdrawalPermissionDetected',false,'permissions',jsonb_build_object('read',true,'trade',true,'withdrawal',false)), 'observation',jsonb_build_object('id',obs.id::text,'revision',obs.revision::text,'text',observation::text,'hash',encode(sha256(convert_to(observation::text,'UTF8')),'hex')), 'markets',markets,'loss',jsonb_build_object('checkpointText',loss.checkpoint,'hash',encode(loss.hash,'hex')), 'controls',jsonb_build_object('value',controls,'fingerprint',encode(sha256(convert_to(controls_raw::text,'UTF8')),'hex')), 'exposure',issued_exposure,'ordersInLastMinute',count_orders);
 IF retention IS NOT NULL THEN result:=result||jsonb_build_object('retention',retention); END IF;
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION ctp_admission.prepare(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; old ctp_admission.issuance; prep ctp_admission.preparation; cmd ctp_execution.command; k jsonb; src jsonb; ident jsonb; alloc jsonb; cap_id uuid; BEGIN
 t:=ctp_admission.lock_request(p);
 SELECT * INTO old FROM ctp_admission.issuance WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF FOUND THEN
  IF old.request IS DISTINCT FROM p OR old.certificate_hash<>sha256(convert_to(old.certificate,'UTF8')) THEN RAISE EXCEPTION 'RISK_ADMISSION_CONFLICT'; END IF;
  RETURN jsonb_build_object('replay',old.receipt);
 END IF;
 SELECT * INTO cmd FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid AND "orderId"=(p->>'orderId')::uuid FOR SHARE;
 IF NOT FOUND OR cmd.binding::jsonb IS DISTINCT FROM p->'binding' OR cmd.operation::text<>p->>'operation' OR encode(cmd."commandHash",'hex')<>p->>'commandHash' THEN RAISE EXCEPTION 'RISK_ADMISSION_CONFLICT'; END IF;
 IF cmd.operation NOT IN('PLACE','AMEND','CANCEL') THEN RAISE EXCEPTION 'RISK_ADMISSION_OPERATION_UNSUPPORTED'; END IF;
 LOCK TABLE public.instrument,public.instrument_rule_version,public.capability_snapshot IN SHARE MODE;
 SELECT id INTO cap_id FROM public.capability_snapshot WHERE exchange=(p->'binding'->'profile'->>'exchange')::public."Exchange" AND mode=(p->'binding'->>'mode')::public."TradingMode" AND region=p->'binding'->'profile'->>'region' AND "accountMode"=p->'binding'->'profile'->>'accountMode' AND market::text=CASE p->'binding'->'profile'->>'market' WHEN 'SPOT' THEN 'SPOT' ELSE 'PERPETUAL' END ORDER BY version DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
 k:=jsonb_build_object('binding',p->'binding','instrumentId',CASE cmd.operation WHEN 'AMEND' THEN cmd.command::jsonb->'replacement'->'instrumentId' ELSE cmd.command::jsonb->'instrumentId' END,'dbInstrumentId',cmd.draft::jsonb->'dbInstrumentId','dbRuleId',cmd.draft::jsonb->'dbRuleId','dbCapabilityId',cap_id::text,'intentId',cmd."intentId"::text);
 src:=ctp_certification.capture_sources(k);
 SELECT * INTO prep FROM ctp_admission.preparation WHERE "tenantId"=t AND "intentId"=cmd."intentId";
 IF FOUND THEN
  IF prep.request IS DISTINCT FROM p OR prep.transaction_id<>pg_current_xact_id() OR prep.source_hash<>sha256(convert_to(prep.source,'UTF8')) THEN RAISE EXCEPTION 'RISK_ADMISSION_CONFLICT'; END IF;
  k:=prep.key;src:=prep.source::jsonb;alloc:=prep.allocation;
 ELSE
  ident:=ctp_certification.next_identity(k);
  alloc:=jsonb_build_object('certificateId',ident->'id','revision',ident->'revision','decisionId',gen_random_uuid()::text,'reservationId',gen_random_uuid()::text);
  INSERT INTO ctp_admission.preparation("tenantId","intentId",request,key,allocation,source,source_hash,transaction_id) VALUES(t,cmd."intentId",p,k,alloc,src::text,sha256(convert_to(src::text,'UTF8')),pg_current_xact_id());
 END IF;
 RETURN jsonb_build_object('replay',NULL,'key',k,'capture',src,'allocation',alloc,'commandHash',p->'commandHash','orderId',p->'orderId');
END $$;

CREATE OR REPLACE FUNCTION ctp_admission.evaluation_command(src jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT CASE src->'intent'->>'operation' WHEN 'PLACE' THEN src->'intent'->'command'
 WHEN 'AMEND' THEN src->'intent'->'command'->'replacement' WHEN 'CANCEL' THEN jsonb_set(src->'intent'->'command'->'target'->'current','{ruleVersion}',src->'metadata'->'value'->'record'->'rules'->'version') ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION ctp_admission.persist(p jsonb,raw text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
<<admission>> DECLARE t uuid; prep ctp_admission.preparation; v jsonb; cert jsonb; proj jsonb; evaluation jsonb; pf jsonb; src jsonb; current_src jsonb; cmd jsonb; policy jsonb; lim jsonb;
 b jsonb; actual_totals jsonb; total_key text; total_value jsonb; target_book ctp_portfolio.book; next_state jsonb; ev jsonb; hold jsonb; w jsonb; native_balance jsonb; profile_row public.risk_profile; budget_row public.risk_budget;
 decision_id uuid; reserve_id uuid; state_id uuid:=gen_random_uuid(); state_version bigint; asset text; valuation text; policy_name text; policy_hash bytea;
 qty numeric; price numeric; fx numeric; notional numeric; amount numeric; fee numeric; available numeric; minimum_balance numeric; book_state jsonb; expected_holds jsonb; receipt jsonb;
 now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; deadline_ms bigint; mode_value public."TradingMode"; retained boolean; parent_id uuid; required_amount numeric; BEGIN
 t:=ctp_admission.lock_request(p);
 IF raw IS NULL OR octet_length(raw)>4194304 THEN RAISE EXCEPTION 'RISK_ADMISSION_INPUT'; END IF;
 v:=raw::jsonb; cert:=v->'certificate';proj:=cert->'projection';evaluation:=v->'evaluation';pf:=v->'portfolio';
 IF NOT ctp_market.snapshot_keys(v,ARRAY['certificate','evaluation','allocation','portfolio']) OR NOT ctp_market.snapshot_keys(pf,ARRAY['bookId','expectedRevision','event','watermark','stateText','hash']) THEN RAISE EXCEPTION 'RISK_ADMISSION_INPUT'; END IF;
 IF ctp_market.snapshot_keys(evaluation,ARRAY['kind','effect','notional','proposal']) IS NOT TRUE
 OR ctp_market.snapshot_keys(evaluation->'proposal',ARRAY['asset','amount']) IS NOT TRUE
 OR ctp_admission.money(evaluation->'notional') IS NOT TRUE OR ctp_admission.money(evaluation->'proposal'->'amount') IS NOT TRUE
 OR jsonb_typeof(evaluation->'proposal'->'asset') IS DISTINCT FROM 'string'
 OR jsonb_typeof(cert->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(cert->'revision') IS DISTINCT FROM 'string'
 OR jsonb_typeof(cert->'expiresAt') IS DISTINCT FROM 'number' OR jsonb_typeof(cert->'createdAt') IS DISTINCT FROM 'number'
 OR cert->>'hash' IS DISTINCT FROM encode(sha256(convert_to(ctp_admission.canonical(proj),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'RISK_ADMISSION_INPUT'; END IF;
 SELECT * INTO prep FROM ctp_admission.preparation WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF NOT FOUND OR prep.transaction_id<>pg_current_xact_id() OR prep.request IS DISTINCT FROM p OR prep.allocation IS DISTINCT FROM v->'allocation' OR prep.source_hash<>sha256(convert_to(prep.source,'UTF8')) THEN RAISE EXCEPTION 'RISK_ADMISSION_TRANSACTION'; END IF;
 src:=prep.source::jsonb;current_src:=ctp_certification.capture_sources(prep.key);
 IF (src-'capturedAt') IS DISTINCT FROM (current_src-'capturedAt') THEN RAISE EXCEPTION 'RISK_ADMISSION_REPLACED'; END IF;
 actual_totals:=ctp_admission.exposure_totals(src);
 FOR total_key,total_value IN SELECT key,value FROM jsonb_each(actual_totals) LOOP
  IF proj->'snapshot'->total_key IS DISTINCT FROM total_value THEN RAISE EXCEPTION 'RISK_ADMISSION_EXPOSURE'; END IF;
 END LOOP;
 b:=p->'binding';mode_value:=(b->>'mode')::public."TradingMode";cmd:=ctp_admission.evaluation_command(src);retained:=src->'intent'->>'operation' IN('AMEND','CANCEL');
 IF proj->'key' IS DISTINCT FROM prep.key OR cert->>'id'<>prep.allocation->>'certificateId' OR cert->>'revision'<>prep.allocation->>'revision'
 OR proj->'metadata' IS DISTINCT FROM src->'metadata'->'value' OR proj->'platform' IS DISTINCT FROM src->'policies'->0 OR proj->'user' IS DISTINCT FROM src->'policies'->1
 OR proj->>'permissionEpoch'<>src->'connection'->>'permissionEpoch' OR proj->'snapshot'->'binding' IS DISTINCT FROM b-'connectionId'-'externalAccountId'
 OR evaluation->>'kind' IS DISTINCT FROM 'EVALUATED' OR COALESCE(evaluation->>'effect' NOT IN('INCREASE','REDUCE','RETAIN'),true) THEN RAISE EXCEPTION 'RISK_ADMISSION_CONFLICT'; END IF;
 deadline_ms:=(cert->>'expiresAt')::bigint;
 IF deadline_ms<=now_ms OR deadline_ms>(proj->'snapshot'->>'sourceAt')::bigint+least((src->'policies'->0->'limits'->>'maxEvidenceAgeMs')::integer,(src->'policies'->1->'limits'->>'maxEvidenceAgeMs')::integer)
 OR deadline_ms>(src->'metadata'->'value'->'record'->'rules'->>'expiresAt')::bigint
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(src->'metadata'->'value'->'capabilities') c WHERE deadline_ms>(c->>'expiresAt')::bigint)
 OR (cert->>'createdAt')::bigint>now_ms THEN RAISE EXCEPTION 'RISK_ADMISSION_EXPIRED'; END IF;
 -- Actual immutable native command determines units and price; caller proposals
 -- cannot lower the durable reserve or change the collateral currency.
 IF cmd->'size'->>'kind'<>'BASE_QUANTITY' OR cmd->>'type' NOT IN('LIMIT','MARKET') THEN RAISE EXCEPTION 'RISK_ADMISSION_OPERATION_UNSUPPORTED'; END IF;
 qty:=(cmd->'size'->>'value')::numeric;
 price:=COALESCE((cmd->>'limitPrice')::numeric,((src->'observation'->>'text')::jsonb->'execution'->>'upperPrice')::numeric);
 valuation:=src->'policies'->0->'limits'->>'valuationAsset';
 SELECT (e->>'rate')::numeric INTO fx FROM jsonb_array_elements((src->'observation'->>'text')::jsonb->'fx') e WHERE e->>'from'=src->'metadata'->'value'->'record'->'instrument'->>'quoteAsset' AND e->>'to'=valuation;
 IF fx IS NULL OR fx<=0 OR qty<=0 OR price<=0 THEN RAISE EXCEPTION 'RISK_ADMISSION_CURRENCY'; END IF;
 notional:=qty*price*fx;
 PERFORM ctp_admission.validate_current(src,proj,qty,price,notional,now_ms);
 asset:=CASE WHEN b->'profile'->>'market'='SPOT' AND cmd->>'side'='SELL' THEN src->'metadata'->'value'->'record'->'instrument'->>'baseAsset' ELSE src->'metadata'->'value'->'record'->'instrument'->>'quoteAsset' END;
 fee:=((src->'observation'->>'text')::jsonb->'fee'->>'maxRate')::numeric;
 amount:=(CASE WHEN b->'profile'->>'market'='SPOT' AND cmd->>'side'='SELL' THEN qty WHEN cmd->>'reduceOnly'='true' THEN 0 ELSE qty*price END)+(CASE WHEN b->'profile'->>'market'='SPOT' AND cmd->>'side'='SELL' THEN qty ELSE qty*price END)*fee;
 IF retained THEN
  parent_id:=(src->'retention'->>'reservationId')::uuid;
  required_amount:=(CASE WHEN cmd->>'side'='SELL' THEN qty-(src->'retention'->>'filledQuantity')::numeric ELSE (qty-(src->'retention'->>'filledQuantity')::numeric)*price END)*(1+fee);
  IF src->'retention'->>'status' IS DISTINCT FROM 'ACTIVE' OR src->'retention'->>'asset' IS DISTINCT FROM asset OR (src->'retention'->>'amount')::numeric<required_amount
   OR cmd->>'type' IS DISTINCT FROM 'LIMIT' OR cmd->>'timeInForce' IS DISTINCT FROM 'GTC' OR cmd->'reduceOnly' IS DISTINCT FROM 'false'::jsonb
   OR (src->'intent'->>'operation'='AMEND' AND qty>=(src->'retention'->'command'->'size'->>'value')::numeric)
   OR (src->'intent'->>'operation'='CANCEL' AND qty IS DISTINCT FROM (src->'retention'->'command'->'size'->>'value')::numeric) OR qty<=(src->'retention'->>'filledQuantity')::numeric
   OR cmd->'limitPrice' IS DISTINCT FROM src->'retention'->'command'->'limitPrice' THEN RAISE EXCEPTION 'RISK_AMEND_RESERVE_UNPROVED'; END IF;
  amount:=0;
 END IF;
 IF (evaluation->>'effect'='RETAIN') IS DISTINCT FROM retained THEN RAISE EXCEPTION 'RISK_ADMISSION_AMOUNT'; END IF;
 IF evaluation->'proposal'->>'asset'<>asset OR (evaluation->'proposal'->>'amount')::numeric<>amount OR (evaluation->>'notional')::numeric<>(CASE WHEN retained THEN 0 ELSE notional END) OR ((evaluation->>'effect'='REDUCE') IS DISTINCT FROM (cmd->>'reduceOnly'='true')) THEN RAISE EXCEPTION 'RISK_ADMISSION_AMOUNT'; END IF;
 IF (src->'observation'->>'text')::jsonb->'fee'->>'asset'<>asset THEN RAISE EXCEPTION 'RISK_ADMISSION_CURRENCY'; END IF;
 -- Pure evaluation is necessary, while SQL independently enforces both current
 -- platform/user limits on the exact proposed effect under shared tenant locks.
 FOR policy IN SELECT value FROM jsonb_array_elements(src->'policies') LOOP
  lim:=policy->'limits';
  IF evaluation->>'effect' IN('INCREASE','RETAIN') AND (
   notional>(lim->>'maxOrderNotional')::numeric OR (proj->'snapshot'->>'instrumentExposure')::numeric+(CASE WHEN retained THEN 0 ELSE notional END)>(lim->>'maxInstrumentExposure')::numeric
   OR (proj->'snapshot'->>'assetExposure')::numeric+(CASE WHEN retained THEN 0 ELSE notional END)>(lim->>'maxAssetExposure')::numeric OR (proj->'snapshot'->>'accountExposure')::numeric+(CASE WHEN retained THEN 0 ELSE notional END)>(lim->>'maxAccountExposure')::numeric
   OR (proj->'snapshot'->>'userExposure')::numeric+(CASE WHEN retained THEN 0 ELSE notional END)>(lim->>'maxUserExposure')::numeric OR (proj->'snapshot'->>'openOrders')::integer+(CASE WHEN retained THEN 0 ELSE 1 END)>(lim->>'maxOpenOrders')::integer
   OR (src->>'ordersInLastMinute')::integer+1>(lim->>'maxOrdersPerMinute')::integer
   OR (proj->'snapshot'->>'concurrentPositions')::integer+(CASE WHEN NOT retained AND proj->'snapshot'->>'positionQuantity'='0' AND proj->'snapshot'->>'instrumentHasPendingEntry'='false' THEN 1 ELSE 0 END)>(lim->>'maxConcurrentPositions')::integer
  ) THEN RAISE EXCEPTION 'RISK_ADMISSION_LIMIT'; END IF;
 END LOOP;
 IF evaluation->>'effect' IN('INCREASE','RETAIN') AND (src->'controls'->'value'->>'circuit'<>'CLOSED' OR EXISTS(SELECT 1 FROM jsonb_each(src->'controls'->'value'->'pauses') WHERE value<>'false'::jsonb)) THEN RAISE EXCEPTION 'RISK_PAUSED'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each((src->'observation'->>'text')::jsonb->'health') WHERE value->>'status'<>'HEALTHY') THEN RAISE EXCEPTION 'RISK_HEALTH'; END IF;
 SELECT * INTO target_book FROM ctp_portfolio.book WHERE "tenantId"=t AND id=(pf->>'bookId')::uuid AND "accountId"=(b->>'accountId')::uuid AND mode=mode_value FOR UPDATE;
 IF NOT FOUND OR target_book.revision::text<>pf->>'expectedRevision' OR target_book.state_hash<>sha256(convert_to(target_book.state,'UTF8')) OR target_book.revision>=9007199254740991 THEN RAISE EXCEPTION 'RISK_ADMISSION_PORTFOLIO'; END IF;
 book_state:=target_book.state::jsonb;ev:=pf->'event';hold:=ev->'hold';w:=pf->'watermark';next_state:=(pf->>'stateText')::jsonb;
 IF ctp_admission.money(hold->'amount') IS NOT TRUE
 OR ctp_market.snapshot_keys(w,ARRAY['timestamp','fingerprint','released','unknown']) IS NOT TRUE
 OR jsonb_typeof(w->'timestamp') IS DISTINCT FROM 'number' OR jsonb_typeof(ev->'timestamp') IS DISTINCT FROM 'number'
 OR w->>'fingerprint' IS DISTINCT FROM encode(sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8')),'hex')
 OR pf->>'stateText' IS DISTINCT FROM ctp_admission.canonical(next_state)
 THEN RAISE EXCEPTION 'RISK_ADMISSION_PORTFOLIO'; END IF;
 decision_id:=(prep.allocation->>'decisionId')::uuid;reserve_id:=(prep.allocation->>'reservationId')::uuid;
 IF NOT ctp_market.snapshot_keys(ev,ARRAY['id','timestamp','type','hold']) OR ev->>'type'<>'COMMITMENT' OR ev->>'id'<>'risk-reserve-'||reserve_id::text OR (ev->>'timestamp')::bigint>now_ms
 OR NOT ctp_market.snapshot_keys(hold,ARRAY['id','asset','amount','status','reflected']) OR hold->>'id' IS DISTINCT FROM reserve_id::text OR hold->>'asset' IS DISTINCT FROM asset OR (hold->>'amount')::numeric<>amount OR hold->>'status' IS DISTINCT FROM 'RESERVED' OR hold->'reflected' IS DISTINCT FROM 'false'::jsonb
 OR EXISTS(SELECT 1 FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=target_book.id AND "holdId"=reserve_id::text) THEN RAISE EXCEPTION 'RISK_ADMISSION_PORTFOLIO'; END IF;
 expected_holds:=COALESCE(book_state->'holds','[]'::jsonb)||jsonb_build_array(hold);
 IF jsonb_array_length(expected_holds)>1000 OR next_state IS DISTINCT FROM jsonb_set(book_state,'{holds}',expected_holds)
 OR decode(pf->>'hash','hex')<>sha256(convert_to(pf->>'stateText','UTF8')) OR w->>'timestamp' IS DISTINCT FROM ev->>'timestamp' OR w->'released' IS DISTINCT FROM 'false'::jsonb OR w->'unknown' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'RISK_ADMISSION_PORTFOLIO'; END IF;
 SELECT value INTO native_balance FROM jsonb_array_elements(book_state->'balances') WHERE value->>'asset'=asset;
 available:=COALESCE((native_balance->>'available')::numeric,(native_balance->>'free')::numeric);
 IF available IS NULL THEN RAISE EXCEPTION 'RISK_ADMISSION_COLLATERAL'; END IF;
 available:=(actual_totals->>'availableAmount')::numeric;
 minimum_balance:=greatest((src->'policies'->0->'limits'->>'minAvailableBalance')::numeric,(src->'policies'->1->'limits'->>'minAvailableBalance')::numeric);
 IF available<amount OR (available-amount)*(CASE WHEN b->'profile'->>'market'='SPOT' AND cmd->>'side'='SELL' THEN ((src->'observation'->>'text')::jsonb->'execution'->>'lowerPrice')::numeric*fx ELSE fx END)<minimum_balance THEN RAISE EXCEPTION 'RISK_ADMISSION_COLLATERAL'; END IF;
 IF (SELECT count(*) FROM ctp_portfolio.outbox WHERE "tenantId"=t AND book=target_book.id)>=10000 THEN RAISE EXCEPTION 'RISK_ADMISSION_CAPACITY'; END IF;
 policy:=jsonb_build_object('platform',src->'policies'->0,'user',src->'policies'->1);policy_hash:=sha256(convert_to(policy::text,'UTF8'));policy_name:='risk-certified-'||encode(policy_hash,'hex');
 SELECT * INTO profile_row FROM public.risk_profile WHERE "tenantId"=t AND name=policy_name AND version=1;
 IF NOT FOUND THEN
  INSERT INTO public.risk_profile("tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt") VALUES(t,policy_name,1,policy_hash,valuation,least((src->'policies'->0->'limits'->>'maxUserExposure')::numeric,(src->'policies'->1->'limits'->>'maxUserExposure')::numeric),least((src->'policies'->0->'limits'->>'maxDailyTotalLoss')::numeric,(src->'policies'->1->'limits'->>'maxDailyTotalLoss')::numeric),least((src->'policies'->0->'limits'->>'maxDrawdownRate')::numeric,(src->'policies'->1->'limits'->>'maxDrawdownRate')::numeric),least((src->'policies'->0->'limits'->>'maxOpenOrders')::integer,(src->'policies'->1->'limits'->>'maxOpenOrders')::integer),policy,clock_timestamp()) RETURNING * INTO profile_row;
 ELSE IF profile_row."policyHash"<>policy_hash OR profile_row.policy<>policy THEN RAISE EXCEPTION 'RISK_ADMISSION_CONFLICT'; END IF; END IF;
 SELECT COALESCE(max(version),0)+1 INTO state_version FROM public.account_state_version WHERE "tenantId"=t AND "accountId"=(b->>'accountId')::uuid AND mode=mode_value;
 INSERT INTO public.account_state_version(id,"tenantId","accountId",mode,version,"sourceCursor","sourceAt","receivedAt","reconciledAt","reconciliationEpoch","stateHash") SELECT state_id,t,a.id,mode_value,state_version,'risk-certificate-'||(cert->>'id'),to_timestamp((proj->'snapshot'->>'sourceAt')::double precision/1000),clock_timestamp(),to_timestamp((proj->'snapshot'->>'reconciledAt')::double precision/1000),a."reconciliationEpoch",decode(cert->>'hash','hex') FROM public.exchange_account a WHERE a."tenantId"=t AND a.id=(b->>'accountId')::uuid;
 PERFORM ctp_certification.insert_certificate(prep.key,cert::text);
 INSERT INTO public.risk_decision(id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","reasonCodes","permissionEpoch","expiresAt") VALUES(decision_id,t,(p->>'intentId')::uuid,(b->>'accountId')::uuid,mode_value,profile_row.id,state_id,(prep.key->>'dbRuleId')::uuid,(prep.key->>'dbCapabilityId')::uuid,CASE evaluation->>'effect' WHEN 'REDUCE' THEN 'REDUCE_ONLY'::public."RiskVerdict" ELSE 'APPROVE'::public."RiskVerdict" END,1,decode(p->>'commandHash','hex'),ARRAY['CERTIFIED_ATOMIC_ADMISSION'],(proj->>'permissionEpoch')::bigint,to_timestamp(deadline_ms::double precision/1000));
 SELECT rb.* INTO budget_row FROM public.risk_budget rb WHERE rb."tenantId"=t AND rb.mode=mode_value AND rb.scope='ACCOUNT' AND rb."scopeKey"='risk-account-'||(b->>'accountId') AND rb.asset=admission.asset AND rb."windowStart"=to_timestamp((now_ms/86400000*86400000)::double precision/1000) FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO public.risk_budget("tenantId","accountId","profileId",mode,scope,"scopeKey",asset,"windowStart","windowEnd","limitAmount","reservedAmount","updatedAt") VALUES(t,(b->>'accountId')::uuid,profile_row.id,mode_value,'ACCOUNT','risk-account-'||(b->>'accountId'),asset,to_timestamp((now_ms/86400000*86400000)::double precision/1000),to_timestamp((now_ms/86400000*86400000+86400000)::double precision/1000),available,amount,clock_timestamp()) RETURNING * INTO budget_row;
 ELSE
  UPDATE public.risk_budget SET "reservedAmount"="reservedAmount"+amount,version=version+1,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=budget_row.id AND version<2147483647 RETURNING * INTO budget_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'RISK_ADMISSION_CAPACITY'; END IF;
 END IF;
 INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"budgetId",status,asset,amount,"expiresAt","updatedAt") VALUES(reserve_id,t,decision_id,(p->>'intentId')::uuid,(b->>'accountId')::uuid,mode_value,budget_row.id,'ACTIVE',asset,amount,to_timestamp(deadline_ms::double precision/1000),clock_timestamp());
 INSERT INTO ctp_portfolio.hold_watermark("tenantId",book,"accountId",mode,"holdId",timestamp,fingerprint,released,unknown) VALUES(t,target_book.id,(b->>'accountId')::uuid,mode_value,reserve_id::text,(ev->>'timestamp')::bigint,decode(w->>'fingerprint','hex'),false,false);
 INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger) VALUES(t,target_book.id,(b->>'accountId')::uuid,mode_value,ev->>'id',sha256(convert_to(ctp_admission.canonical(ev),'UTF8')),ctp_admission.canonical(ev),NULL);
 UPDATE ctp_portfolio.book SET state=pf->>'stateText',state_hash=decode(pf->>'hash','hex'),revision=revision+1 WHERE id=target_book.id AND "tenantId"=t;
 INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId") VALUES(t,target_book.id,(b->>'accountId')::uuid,mode_value,target_book.revision+1,'COMMITMENT',ev->>'id');
 receipt:=jsonb_build_object('decisionId',decision_id::text,'reservationId',reserve_id::text,'permissionEpoch',proj->'permissionEpoch','expiresAt',deadline_ms);
 INSERT INTO ctp_admission.issuance("tenantId","intentId","orderId","accountId",mode,"decisionId","reservationId","certificateId","bookId",request,receipt,certificate,certificate_hash,notional,"reductionQuantity",instrument,base,"primaryReservationId",control) VALUES(t,(p->>'intentId')::uuid,(p->>'orderId')::uuid,(b->>'accountId')::uuid,mode_value,decision_id,reserve_id,(cert->>'id')::uuid,target_book.id,p,receipt,cert::text,sha256(convert_to(cert::text,'UTF8')),CASE evaluation->>'effect' WHEN 'REDUCE' THEN 0 WHEN 'RETAIN' THEN 0 ELSE notional END,CASE evaluation->>'effect' WHEN 'REDUCE' THEN qty ELSE 0 END,prep.key->>'instrumentId',src->'metadata'->'value'->'record'->'instrument'->>'baseAsset',parent_id,CASE WHEN retained THEN jsonb_build_object('retention',src->'retention','command',src->'intent'->'command') ELSE NULL END);
 RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION ctp_admission.validate_current(src jsonb,projection jsonb,qty numeric,price numeric,notional numeric,now_ms bigint) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE cmd jsonb:=ctp_admission.evaluation_command(src); obs jsonb:=(src->'observation'->>'text')::jsonb; rules jsonb:=src->'metadata'->'value'->'record'->'rules'; instrument jsonb:=src->'metadata'->'value'->'record'->'instrument';
 loss jsonb:=(src->'loss'->>'checkpointText')::jsonb; native jsonb; fact jsonb; policy jsonb; lim jsonb; capability jsonb; feature text;
 lower_price numeric; upper_price numeric; reference_price numeric; bid numeric; ask numeric; liquidity numeric; fx numeric; leverage numeric;
 age integer:=least((src->'policies'->0->'limits'->>'maxEvidenceAgeMs')::integer,(src->'policies'->1->'limits'->>'maxEvidenceAgeMs')::integer);
 totals jsonb; min_at bigint:=src->>'capturedAt'; baseline jsonb; expected_value jsonb; field text;
 BEGIN
 FOR fact IN SELECT value FROM jsonb_each(obs->'health') UNION ALL SELECT obs->'fee' UNION ALL SELECT obs->'execution' UNION ALL SELECT value FROM jsonb_array_elements(obs->'fx') UNION ALL SELECT value FROM jsonb_array_elements(obs->'marks') LOOP
  IF (fact->>'asOf')::bigint>now_ms OR now_ms-(fact->>'asOf')::bigint>age THEN RAISE EXCEPTION 'RISK_SNAPSHOT_STALE'; END IF;
  min_at:=least(min_at,(fact->>'asOf')::bigint);
 END LOOP;
 min_at:=least(min_at,(loss->>'coveredThrough')::bigint);
 IF (loss->>'dayStart')::bigint<>now_ms/86400000*86400000 OR (loss->>'coveredThrough')::bigint>now_ms OR now_ms-(loss->>'coveredThrough')::bigint>age THEN RAISE EXCEPTION 'RISK_ADMISSION_LOSS'; END IF;
 baseline:=jsonb_build_object('utcDayStart',loss->'dayStart','adjustedOpeningEquity',loss->'openingEquity','adjustedCurrentEquity',loss->'adjustedCurrentEquity','adjustedPeakEquity',loss->'adjustedPeakEquity','dailyNetRealizedPnl',loss->'netRealized','lossBaselineComplete',true);
 FOR field,expected_value IN SELECT key,value FROM jsonb_each(baseline) LOOP
  IF projection->'snapshot'->field IS DISTINCT FROM expected_value THEN RAISE EXCEPTION 'RISK_ADMISSION_LOSS'; END IF;
 END LOOP;
 IF (loss->>'openingEquity')::numeric<=0 OR (loss->>'adjustedCurrentEquity')::numeric<=0
 OR (loss->>'adjustedPeakEquity')::numeric<greatest((loss->>'openingEquity')::numeric,(loss->>'adjustedCurrentEquity')::numeric) THEN RAISE EXCEPTION 'RISK_ADMISSION_LOSS'; END IF;
 FOR fact IN SELECT value FROM jsonb_array_elements(src->'portfolio'->'books') LOOP
  IF ((fact->>'stateText')::jsonb->>'snapshotAt')::bigint>now_ms OR now_ms-((fact->>'stateText')::jsonb->>'snapshotAt')::bigint>age THEN RAISE EXCEPTION 'RISK_PORTFOLIO_INCOMPLETE'; END IF;
  min_at:=least(min_at,((fact->>'stateText')::jsonb->>'snapshotAt')::bigint);
 END LOOP;
 FOR fact IN SELECT value FROM jsonb_each(obs->'health') LOOP min_at:=least(min_at,(fact->>'asOf')::bigint); END LOOP;
 IF now_ms-(src->'connection'->>'verifiedAt')::bigint>age OR (src->'connection'->>'verifiedAt')::bigint>now_ms THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PERMISSION'; END IF;
 IF (rules->>'effectiveAt')::bigint>now_ms OR (rules->>'expiresAt')::bigint<=now_ms OR instrument->>'status'<>'TRADING'
 OR (instrument->>'expiryAt' IS NOT NULL AND (instrument->>'expiryAt')::bigint<=now_ms)
 OR rules->>'quantityUnit'<>'BASE' OR cmd->'size'->>'asset'<>instrument->>'baseAsset' OR NOT (rules->'orderTypes' ? (cmd->>'type'))
 OR (cmd->>'timeInForce' IS NOT NULL AND NOT (rules->'timeInForce' ? (cmd->>'timeInForce')))
 OR qty<=0 OR mod(qty,(rules->>'stepSize')::numeric)<>0
 OR qty<(CASE WHEN cmd->>'type'='MARKET' THEN rules->>'marketMinQuantity' ELSE rules->>'minQuantity' END)::numeric
 OR qty>(CASE WHEN cmd->>'type'='MARKET' THEN rules->>'marketMaxQuantity' ELSE rules->>'maxQuantity' END)::numeric
 OR (cmd->>'limitPrice' IS NOT NULL AND (mod(price,(rules->>'tickSize')::numeric)<>0 OR (rules->>'minPrice' IS NOT NULL AND price<(rules->>'minPrice')::numeric) OR (rules->>'maxPrice' IS NOT NULL AND price>(rules->>'maxPrice')::numeric)))
 THEN RAISE EXCEPTION 'RISK_ORDER_RULES'; END IF;
 FOREACH feature IN ARRAY (CASE WHEN cmd->>'reduceOnly'='true' THEN ARRAY[CASE WHEN cmd->>'type'='LIMIT' THEN 'LIMIT_ORDER' ELSE 'MARKET_ORDER' END,'REDUCE_ONLY'] ELSE ARRAY[CASE WHEN cmd->>'type'='LIMIT' THEN 'LIMIT_ORDER' ELSE 'MARKET_ORDER' END] END) LOOP
  IF (SELECT count(*) FROM jsonb_array_elements(src->'metadata'->'value'->'capabilities') c WHERE c->>'feature'=feature)<>1 THEN RAISE EXCEPTION 'RISK_CAPABILITY'; END IF;
  SELECT c INTO capability FROM jsonb_array_elements(src->'metadata'->'value'->'capabilities') c WHERE c->>'feature'=feature;
  IF capability->'profile' IS DISTINCT FROM src->'key'->'binding'->'profile' OR capability->>'support'<>'SUPPORTED' OR capability->>'implementation' NOT IN('NATIVE','EMULATED')
  OR capability->>'adapterVersion'<>src->'metadata'->'value'->>'adapterVersion' OR (capability->>'checkedAt')::bigint>now_ms OR (capability->>'expiresAt')::bigint<=now_ms
  OR capability->'constraints' ? 'timeframes' OR (capability->'constraints' ? 'instrumentIds' AND NOT (capability->'constraints'->'instrumentIds' ? (src->'key'->>'instrumentId'))) THEN RAISE EXCEPTION 'RISK_CAPABILITY'; END IF;
 END LOOP;
 IF src->'intent'->>'operation' IN('AMEND','CANCEL') THEN
  IF (SELECT count(*) FROM jsonb_array_elements(src->'metadata'->'value'->'capabilities') c WHERE c->>'feature'=CASE src->'intent'->>'operation' WHEN 'AMEND' THEN 'AMEND_ORDER' ELSE 'CANCEL_ORDER' END)<>1 THEN RAISE EXCEPTION 'RISK_CAPABILITY'; END IF;
  SELECT c INTO capability FROM jsonb_array_elements(src->'metadata'->'value'->'capabilities') c WHERE c->>'feature'=CASE src->'intent'->>'operation' WHEN 'AMEND' THEN 'AMEND_ORDER' ELSE 'CANCEL_ORDER' END;
  IF capability->'profile' IS DISTINCT FROM src->'key'->'binding'->'profile' OR capability->>'support' IS DISTINCT FROM 'SUPPORTED' OR capability->>'implementation' IS DISTINCT FROM 'NATIVE'
   OR capability->>'adapterVersion' IS DISTINCT FROM src->'metadata'->'value'->>'adapterVersion' OR (capability->>'checkedAt')::bigint>now_ms OR (capability->>'expiresAt')::bigint<=now_ms
   OR capability->'constraints' ? 'timeframes' OR (capability->'constraints' ? 'instrumentIds' AND NOT (capability->'constraints'->'instrumentIds' ? (src->'key'->>'instrumentId')))
   OR (src->'intent'->'command'->'target'->>'observedAt')::bigint>now_ms OR now_ms-(src->'intent'->'command'->'target'->>'observedAt')::bigint>age THEN RAISE EXCEPTION 'RISK_CAPABILITY'; END IF;
 END IF;
 SELECT (v->>'text')::jsonb INTO native FROM jsonb_array_elements(src->'markets') v WHERE v->>'id'=obs->'execution'->>'marketId';
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_MARKET'; END IF;
 lower_price:=(obs->'execution'->>'lowerPrice')::numeric;upper_price:=(obs->'execution'->>'upperPrice')::numeric;
 bid:=(native->'book'->'bids'->0->>'price')::numeric;ask:=(native->'book'->'asks'->0->>'price')::numeric;
 min_at:=least(min_at,(native->>'timestamp')::bigint,(native->'ticker'->>'exchangeTime')::bigint,(native->'ticker'->>'receivedAt')::bigint,
 COALESCE((native->'book'->>'exchangeTime')::bigint,(native->'book'->>'receivedAt')::bigint),(native->'book'->>'receivedAt')::bigint,(obs->'execution'->>'asOf')::bigint,(obs->'fee'->>'asOf')::bigint);
 IF lower_price>bid OR upper_price<ask OR bid>ask OR lower_price>upper_price OR (cmd->>'type'='MARKET' AND obs->'execution'->'boundEnforced'<>'true'::jsonb) THEN RAISE EXCEPTION 'RISK_MARKET_UNPROVED'; END IF;
 IF src->'key'->'binding'->'profile'->>'market'='SPOT' THEN
  IF obs->>'positionMode'<>'SPOT' OR obs->>'leverage'<>'1' OR cmd->>'reduceOnly'<>'false' THEN RAISE EXCEPTION 'RISK_POSITION_MODE_UNPROVED'; END IF;
  reference_price:=(native->'ticker'->'last'->>'value')::numeric;
 ELSE
  IF obs->>'positionMode'<>'ONE_WAY' OR src->'key'->'binding'->'profile'->>'accountMode' IS DISTINCT FROM (CASE src->'key'->'binding'->'profile'->>'exchange' WHEN 'BINANCE' THEN 'ONE_WAY' WHEN 'BYBIT' THEN 'UTA2_ONE_WAY' WHEN 'OKX' THEN 'FUTURES_MODE_NET' ELSE NULL END)
  OR instrument->>'settlementAsset' IS DISTINCT FROM instrument->>'quoteAsset' THEN RAISE EXCEPTION 'RISK_POSITION_MODE_UNPROVED'; END IF;
  SELECT (v->>'price')::numeric INTO reference_price FROM jsonb_array_elements(obs->'marks') v WHERE v->>'marketId'=native->>'id' AND v->>'priceAsset'=instrument->>'quoteAsset';
  IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_MARKET'; END IF;
 END IF;
 SELECT (v->>'rate')::numeric INTO fx FROM jsonb_array_elements(obs->'fx') v WHERE v->>'from'=instrument->>'quoteAsset' AND v->>'to'=src->'policies'->0->'limits'->>'valuationAsset';
 IF NOT FOUND OR fx<=0 OR reference_price<=0 THEN RAISE EXCEPTION 'RISK_CURRENCY_UNPROVED'; END IF;
 SELECT least((SELECT sum((v->>'price')::numeric*(v->>'quantity')::numeric) FROM jsonb_array_elements(native->'book'->'bids') v),
 (SELECT sum((v->>'price')::numeric*(v->>'quantity')::numeric) FROM jsonb_array_elements(native->'book'->'asks') v))*fx INTO liquidity;
 IF liquidity IS NULL OR liquidity<notional OR (cmd->>'limitPrice' IS NULL AND qty*lower_price<(rules->>'minNotional')::numeric)
 OR qty*price<(rules->>'minNotional')::numeric OR (rules->>'maxNotional' IS NOT NULL AND qty*price>(rules->>'maxNotional')::numeric) THEN RAISE EXCEPTION 'RISK_ORDER_NOTIONAL'; END IF;
 IF (projection->'snapshot'->>'sourceAt')::bigint IS DISTINCT FROM min_at OR projection->'snapshot'->'complete' IS DISTINCT FROM 'true'::jsonb OR projection->'snapshot'->'unknownExposure' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'RISK_ADMISSION_SOURCE'; END IF;
 totals:=ctp_admission.exposure_totals(src);leverage:=(obs->>'leverage')::numeric;
 IF cmd->>'reduceOnly'='true' AND ((totals->>'positionQuantity')::numeric=0
  OR ((totals->>'positionQuantity')::numeric>0 AND cmd->>'side'<>'SELL') OR ((totals->>'positionQuantity')::numeric<0 AND cmd->>'side'<>'BUY')
  OR qty>abs((totals->>'positionQuantity')::numeric)-(totals->>'committedReductionQuantity')::numeric) THEN RAISE EXCEPTION 'RISK_REDUCTION_UNPROVED'; END IF;
 FOR policy IN SELECT value FROM jsonb_array_elements(src->'policies') LOOP
  lim:=policy->'limits';
  IF leverage>(lim->>'maxLeverage')::numeric OR abs(price-reference_price)>reference_price*(lim->>'maxPriceDeviationRate')::numeric
  OR abs(COALESCE((cmd->>'limitPrice')::numeric,lower_price)-reference_price)>reference_price*(lim->>'maxPriceDeviationRate')::numeric
  OR ask-bid>reference_price*(lim->>'maxSpreadRate')::numeric OR liquidity<(lim->>'minLiquidityNotional')::numeric THEN RAISE EXCEPTION 'RISK_ADMISSION_MARKET_LIMIT'; END IF;
  IF cmd->>'reduceOnly'='false' AND (
   ((loss->>'netRealized')::numeric<0 AND -(loss->>'netRealized')::numeric>=(lim->>'maxDailyRealizedLoss')::numeric)
   OR ((loss->>'openingEquity')::numeric>(loss->>'adjustedCurrentEquity')::numeric AND (loss->>'openingEquity')::numeric-(loss->>'adjustedCurrentEquity')::numeric>=(lim->>'maxDailyTotalLoss')::numeric)
   OR ((loss->>'adjustedPeakEquity')::numeric>(loss->>'adjustedCurrentEquity')::numeric AND (loss->>'adjustedPeakEquity')::numeric-(loss->>'adjustedCurrentEquity')::numeric>=(loss->>'adjustedPeakEquity')::numeric*(lim->>'maxDrawdownRate')::numeric))
  THEN RAISE EXCEPTION 'RISK_ADMISSION_LOSS'; END IF;
 END LOOP;
 IF src->'key'->'binding'->'profile'->>'market'='LINEAR_PERPETUAL' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rules->'leverageTiers') tier
  WHERE (totals->>'instrumentExposure')::numeric+(CASE WHEN cmd->>'reduceOnly'='true' THEN 0 ELSE notional END)<=(tier->>'notionalCap')::numeric*fx AND leverage<=(tier->>'maxLeverage')::numeric) THEN RAISE EXCEPTION 'RISK_LEVERAGE_UNPROVED'; END IF;
END $$;

CREATE OR REPLACE FUNCTION ctp_admission.validate_dispatch(t uuid,attempt_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.submission_attempt%ROWTYPE; i ctp_admission.issuance%ROWTYPE; prep ctp_admission.preparation%ROWTYPE;
 rr public.risk_reservation%ROWTYPE; d public.risk_decision%ROWTYPE; old_src jsonb; src jsonb; validation_src jsonb; projection jsonb;
 field text; book jsonb; previous_book jsonb; state jsonb; previous_state jsonb; totals jsonb; lim jsonb; cmd jsonb; now_ms bigint; qty numeric; price numeric;
BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_DISPATCH_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 SELECT * INTO a FROM public.submission_attempt WHERE "tenantId"=t AND id=attempt_id;
 SELECT * INTO i FROM ctp_admission.issuance WHERE "tenantId"=t AND "intentId"=a."intentId" AND "orderId"=a."orderId" AND "reservationId"=a."reservationId";
 IF NOT FOUND OR a.operation NOT IN('PLACE','AMEND','CANCEL') OR a.mode NOT IN('TESTNET','DEMO') OR a.status<>'DISPATCHING' OR a."transportStartedAt" IS NOT NULL OR a."permitConsumedAt" IS NOT NULL OR a."deadlineAt"<=clock_timestamp() THEN RAISE EXCEPTION 'RISK_DISPATCH_ISSUANCE'; END IF;
 SELECT * INTO rr FROM public.risk_reservation WHERE "tenantId"=t AND id=i."reservationId" FOR UPDATE;
 SELECT * INTO d FROM public.risk_decision WHERE "tenantId"=t AND id=i."decisionId";
 SELECT * INTO prep FROM ctp_admission.preparation WHERE "tenantId"=t AND "intentId"=i."intentId";
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF rr.status IS DISTINCT FROM 'ACTIVE'::public."ReservationStatus" OR rr."expiresAt"<=clock_timestamp() OR d."expiresAt"<=clock_timestamp()
 OR d.verdict NOT IN('APPROVE','REDUCE_ONLY') OR d."commandHash" IS DISTINCT FROM a."commandHash" OR d."permissionEpoch" IS DISTINCT FROM a."permissionEpoch"
 OR prep.source_hash IS DISTINCT FROM sha256(convert_to(prep.source,'UTF8')) OR i.certificate_hash IS DISTINCT FROM sha256(convert_to(i.certificate,'UTF8'))
 OR (i.certificate::jsonb->>'expiresAt')::bigint<=now_ms THEN RAISE EXCEPTION 'RISK_DISPATCH_RESERVATION'; END IF;
 old_src:=prep.source::jsonb;projection:=i.certificate::jsonb->'projection';
 IF a.operation IN('AMEND','CANCEL') THEN
  IF i."primaryReservationId" IS NULL OR rr.amount<>0 OR i.notional<>0 OR i.control->'command' IS DISTINCT FROM old_src->'intent'->'command' THEN RAISE EXCEPTION 'RISK_DISPATCH_ISSUANCE'; END IF;
  src:=ctp_certification.capture_dispatch_sources(prep.key,a.id);
  IF src->'retention' IS DISTINCT FROM old_src->'retention' THEN RAISE EXCEPTION 'RISK_DISPATCH_REPLACED'; END IF;
 ELSE src:=ctp_certification.capture_sources(prep.key); END IF;
 -- Any authoritative revision replacement requires a new evaluation. Receipt
 -- reuse cannot prolong the original evidence lifetime or silently authorize it.
 FOREACH field IN ARRAY ARRAY['user','connection','policies','metadata','observation','markets','loss','controls','intent'] LOOP
  IF src->field IS DISTINCT FROM old_src->field THEN RAISE EXCEPTION 'RISK_DISPATCH_REPLACED'; END IF;
 END LOOP;
 IF ctp_risk.dispatch_gate(t,(prep.key->'binding'->>'connectionId')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'RISK_DISPATCH_CONTROL'; END IF;
 IF jsonb_array_length(src->'portfolio'->'books')<>jsonb_array_length(old_src->'portfolio'->'books') THEN RAISE EXCEPTION 'RISK_DISPATCH_PORTFOLIO'; END IF;
 FOR book IN SELECT value FROM jsonb_array_elements(src->'portfolio'->'books') LOOP
  SELECT value INTO previous_book FROM jsonb_array_elements(old_src->'portfolio'->'books') WHERE value->>'id'=book->>'id';
  state:=(book->>'stateText')::jsonb;previous_state:=(previous_book->>'stateText')::jsonb;
  IF previous_book IS NULL OR (book-'stateText'-'hash'-'revision'-'holdWatermarks') IS DISTINCT FROM (previous_book-'stateText'-'hash'-'revision'-'holdWatermarks')
   OR (state-'holds') IS DISTINCT FROM (previous_state-'holds') THEN RAISE EXCEPTION 'RISK_DISPATCH_PORTFOLIO'; END IF;
 END LOOP;
 -- Current totals include this logical effect once. The rules/market evaluator
 -- receives exposure without that effect so reduction/tier checks do not add it twice.
 totals:=ctp_admission.exposure_totals(src);
 validation_src:=jsonb_set(src,'{exposure,orders}',COALESCE((SELECT jsonb_agg(v) FROM jsonb_array_elements(src->'exposure'->'orders') v WHERE v->>'id'<>i."orderId"::text),'[]'::jsonb));
 validation_src:=jsonb_set(validation_src,'{exposure,reservations}',COALESCE((SELECT jsonb_agg(v) FROM jsonb_array_elements(src->'exposure'->'reservations') v WHERE v->>'orderId'<>i."orderId"::text),'[]'::jsonb));
 cmd:=ctp_admission.evaluation_command(src);qty:=(cmd->'size'->>'value')::numeric;
 price:=COALESCE((cmd->>'limitPrice')::numeric,((src->'observation'->>'text')::jsonb->'execution'->>'upperPrice')::numeric);
 PERFORM ctp_admission.validate_current(validation_src,projection,qty,price,
  CASE WHEN a.operation IN('AMEND','CANCEL') THEN qty*price*(projection->'snapshot'->'market'->>'quoteToValuation')::numeric ELSE i.notional END,now_ms);
 FOR lim IN SELECT value->'limits' FROM jsonb_array_elements(src->'policies') LOOP
  IF (totals->>'instrumentExposure')::numeric>(lim->>'maxInstrumentExposure')::numeric OR (totals->>'assetExposure')::numeric>(lim->>'maxAssetExposure')::numeric
   OR (totals->>'accountExposure')::numeric>(lim->>'maxAccountExposure')::numeric OR (totals->>'userExposure')::numeric>(lim->>'maxUserExposure')::numeric
   OR (totals->>'openOrders')::integer>(lim->>'maxOpenOrders')::integer OR (src->>'ordersInLastMinute')::integer>(lim->>'maxOrdersPerMinute')::integer
   OR (totals->>'availableAmount')::numeric<0 THEN RAISE EXCEPTION 'RISK_DISPATCH_LIMIT'; END IF;
 END LOOP;
 IF clock_timestamp()>=least(a."deadlineAt",rr."expiresAt",d."expiresAt",to_timestamp((i.certificate::jsonb->>'expiresAt')::double precision/1000)) THEN RAISE EXCEPTION 'RISK_DISPATCH_EXPIRED'; END IF;
END $$;

CREATE OR REPLACE FUNCTION ctp_admission.capture_exposure(t uuid,m public."TradingMode",pf jsonb,observation jsonb,markets jsonb,valuation text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record; b jsonb; h jsonb; cmd jsonb; native jsonb; mark jsonb; fx jsonb;
 price numeric; remaining numeric; effect numeric; reduction numeric; unknown boolean;
 orders jsonb:='[]'; reservations jsonb:='[]'; control_rows jsonb:='[]'; parent ctp_admission.issuance; parent_rr public.risk_reservation; BEGIN
 IF (SELECT count(*) FROM public.risk_reservation WHERE "tenantId"=t AND mode=m AND status<>'RELEASED')>10000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 IF EXISTS(SELECT 1 FROM public.risk_reservation rr LEFT JOIN ctp_admission.issuance i ON i."tenantId"=rr."tenantId" AND i."reservationId"=rr.id
  WHERE rr."tenantId"=t AND rr.mode=m AND rr.status<>'RELEASED' AND i."reservationId" IS NULL)
 OR EXISTS(SELECT 1 FROM public."order" o WHERE o."tenantId"=t AND o.mode=m
  AND (o.status IN('RISK_APPROVED','SUBMITTING','SUBMITTED','PARTIALLY_FILLED','CANCEL_PENDING','UNKNOWN','RECONCILIATION_REQUIRED')
   OR EXISTS(SELECT 1 FROM public.submission_attempt sa WHERE sa."tenantId"=t AND sa."orderId"=o.id AND sa.status IN('DISPATCHING','ACKNOWLEDGED','UNKNOWN')))
  AND NOT EXISTS(SELECT 1 FROM ctp_admission.issuance i JOIN public.risk_reservation rr ON rr."tenantId"=i."tenantId" AND rr.id=i."reservationId" AND rr.status<>'RELEASED' WHERE i."tenantId"=t AND i."orderId"=o.id))
 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_UNISSUED_EXPOSURE'; END IF;
 FOR r IN SELECT rr.id,rr.asset,rr.amount,rr.status AS reservation_status,i.*,o.status AS order_status,o.quantity,o."filledQuantity",
  c.command::jsonb AS command,c.binding::jsonb AS binding
  FROM public.risk_reservation rr JOIN ctp_admission.issuance i ON i."tenantId"=rr."tenantId" AND i."reservationId"=rr.id
  JOIN public."order" o ON o."tenantId"=i."tenantId" AND o.id=i."orderId" AND o."accountId"=i."accountId" AND o.mode=i.mode
  JOIN ctp_execution.command c ON c."tenantId"=i."tenantId" AND c."intentId"=i."intentId" AND c."orderId"=o.id
  WHERE rr."tenantId"=t AND rr.mode=m AND rr.status<>'RELEASED' ORDER BY i."accountId",i."orderId" LOOP
  IF r.request->'binding' IS DISTINCT FROM r.binding OR r.request->>'operation' NOT IN('PLACE','AMEND','CANCEL')
  OR r.certificate_hash<>sha256(convert_to(r.certificate,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ISSUANCE_CORRUPT'; END IF;
  SELECT value INTO b FROM jsonb_array_elements(pf->'books') WHERE value->>'id'=r."bookId"::text AND value->>'accountId'=r."accountId"::text;
  IF NOT FOUND OR (b->>'stateText')::jsonb->'binding'->>'connectionId'<>r.binding->>'connectionId' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_HOLD'; END IF;
  SELECT value INTO h FROM jsonb_array_elements((b->>'stateText')::jsonb->'holds') WHERE value->>'id'=r."reservationId"::text;
  IF NOT FOUND OR h->>'asset'<>r.asset OR (h->>'amount')::numeric<>r.amount THEN RAISE EXCEPTION 'RISK_SNAPSHOT_HOLD'; END IF;
  IF r."primaryReservationId" IS NOT NULL THEN
   SELECT * INTO parent FROM ctp_admission.issuance WHERE "tenantId"=t AND "reservationId"=r."primaryReservationId" AND "primaryReservationId" IS NULL;
   IF NOT FOUND OR parent."orderId"<>r."orderId" OR parent."accountId"<>r."accountId" OR parent.mode<>r.mode OR parent."bookId"<>r."bookId" THEN RAISE EXCEPTION 'RISK_CONTROL_EVIDENCE'; END IF;
   SELECT * INTO parent_rr FROM public.risk_reservation WHERE "tenantId"=t AND id=parent."reservationId";
   IF NOT FOUND OR parent_rr.status='RELEASED' OR r.request->>'operation' NOT IN('AMEND','CANCEL') OR r.amount<>0 OR r.notional<>0 OR r.asset<>parent_rr.asset OR h->'reflected' IS DISTINCT FROM 'false'::jsonb
    OR r.control->'command' IS DISTINCT FROM r.command OR r.control->'retention'->>'reservationId' IS DISTINCT FROM parent."reservationId"::text THEN RAISE EXCEPTION 'RISK_CONTROL_EVIDENCE'; END IF;
   unknown:=r.reservation_status='UNRESOLVED';
   IF unknown AND (h->>'status'<>'UNKNOWN' OR parent_rr.status<>'UNRESOLVED') THEN RAISE EXCEPTION 'RISK_CONTROL_EVIDENCE'; END IF;
   control_rows:=control_rows||jsonb_build_array(jsonb_build_object('id',r."reservationId"::text,'intentId',r."intentId"::text,'orderId',r."orderId"::text,'primaryReservationId',parent."reservationId"::text,'accountId',r."accountId"::text,'asset',r.asset,'amount','0','holdId',r."reservationId"::text,'unknown',unknown));
   CONTINUE;
  END IF;
  IF r.request->>'operation'<>'PLACE' THEN RAISE EXCEPTION 'RISK_CONTROL_EVIDENCE'; END IF;
  unknown:=r.order_status IN('UNKNOWN','RECONCILIATION_REQUIRED') OR r.reservation_status='UNRESOLVED'
   OR EXISTS(SELECT 1 FROM public.submission_attempt sa WHERE sa."tenantId"=t AND sa."orderId"=r."orderId" AND sa.status='UNKNOWN');
  IF unknown AND h->>'status'<>'UNKNOWN' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_HOLD'; END IF;
  IF r."filledQuantity"<>(SELECT COALESCE(sum(quantity),0) FROM public.fill WHERE "tenantId"=t AND "orderId"=r."orderId")
  OR EXISTS(SELECT 1 FROM public.fill f LEFT JOIN ctp_execution.fill_adoption ad ON ad."tenantId"=f."tenantId" AND ad."fillId"=f.id
   LEFT JOIN ctp_portfolio.evidence e ON e."tenantId"=ad."tenantId" AND e.book=ad.book AND e.id=ad."eventId"
   WHERE f."tenantId"=t AND f."orderId"=r."orderId" AND (ad.book IS DISTINCT FROM r."bookId" OR e.ledger IS NULL
    OR e.fingerprint<>sha256(convert_to(e.payload,'UTF8')) OR floor(extract(epoch FROM f.timestamp)*1000)::bigint>((b->>'stateText')::jsonb->>'snapshotAt')::bigint))
  THEN RAISE EXCEPTION 'RISK_SNAPSHOT_FILL_COVERAGE'; END IF;
  cmd:=ctp_execution.effective_command(t,r."orderId");remaining:=(cmd->'size'->>'value')::numeric-r."filledQuantity";
  IF remaining<=0 OR cmd->'size'->>'kind'<>'BASE_QUANTITY' OR cmd->>'type' NOT IN('LIMIT','MARKET') THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PENDING_EFFECT'; END IF;
  SELECT (value->>'text')::jsonb INTO native FROM jsonb_array_elements(markets) WHERE (value->>'text')::jsonb->'key'->>'instrumentId'=r.instrument
   AND (value->>'text')::jsonb->'key'->'scope'=(r.binding->'profile')-'accountMode'-'profileVersion'-'endpointProfileId'-'credentialRef';
  IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PENDING_VALUATION'; END IF;
  IF native->'key'->>'instrumentId'<>observation->'key'->>'instrumentId' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(observation->'valuations') v
   WHERE v->>'accountId'=r."accountId"::text AND v->>'bookId'=r."bookId"::text AND v->>'snapshotId'=(b->>'stateText')::jsonb->>'snapshotId' AND v->>'instrumentId'=r.instrument AND v->>'marketId'=native->>'id')
  THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PENDING_VALUATION'; END IF;
  IF r.binding->'profile'->>'market'='SPOT' THEN
   IF native->'ticker'->'last'->>'state'<>'AVAILABLE' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PENDING_VALUATION'; END IF;
   price:=(native->'ticker'->'last'->>'value')::numeric;
  ELSE
   SELECT value INTO mark FROM jsonb_array_elements(observation->'marks') WHERE value->>'marketId'=native->>'id' AND value->>'priceAsset'=native->'record'->'instrument'->>'quoteAsset';
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PENDING_VALUATION'; END IF;
   price:=(mark->>'price')::numeric;
  END IF;
  price:=greatest(price,COALESCE((cmd->>'limitPrice')::numeric,((r.certificate::jsonb)->'projection'->'snapshot'->'market'->>'upperExecutionPrice')::numeric));
  SELECT value INTO fx FROM jsonb_array_elements(observation->'fx') WHERE value->>'from'=native->'record'->'instrument'->>'quoteAsset' AND value->>'to'=valuation;
  IF NOT FOUND OR (fx->>'rate')::numeric<=0 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PENDING_VALUATION'; END IF;
  effect:=CASE WHEN cmd->>'reduceOnly'='true' THEN 0 ELSE remaining*price*(fx->>'rate')::numeric END;
  reduction:=CASE WHEN cmd->>'reduceOnly'='true' THEN remaining ELSE 0 END;
  orders:=orders||jsonb_build_array(jsonb_build_object('id',r."orderId"::text,'accountId',r."accountId"::text,'instrumentId',r.instrument,'base',r.base,'notional',trim_scale(effect)::text,'reductionQuantity',trim_scale(reduction)::text,'status',CASE WHEN unknown THEN 'UNKNOWN' WHEN r.order_status IN('CREATED','RISK_APPROVED','SUBMITTING') THEN 'PENDING' ELSE 'OPEN' END));
  reservations:=reservations||jsonb_build_array(jsonb_build_object('id',r."reservationId"::text,'orderId',r."orderId"::text,'accountId',r."accountId"::text,'instrumentId',r.instrument,'base',r.base,'notional',trim_scale(effect)::text,'reductionQuantity',trim_scale(reduction)::text,'asset',r.asset,'amount',trim_scale(r.amount)::text,'holdId',r."reservationId"::text,'unknown',unknown));
 END LOOP;
 RETURN jsonb_build_object('orders',orders,'reservations',reservations,'controls',control_rows);
END $$;

CREATE OR REPLACE FUNCTION ctp_admission.sync_reservation(t uuid,order_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i ctp_admission.issuance%ROWTYPE; o public."order"%ROWTYPE; rr public.risk_reservation%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; wm ctp_portfolio.hold_watermark%ROWTYPE;
 previous ctp_admission.lifecycle_revision%ROWTYPE; pg ctp_execution.progress%ROWTYPE;
 proof jsonb; fp bytea; state jsonb; hold jsonb; event jsonb; text_state text;
 native jsonb; control_applied boolean; effective jsonb; control_reject boolean; expired_unused boolean; terminal_proof boolean; not_sent boolean; definitive_reject boolean;
 unresolved boolean; native_confirmed boolean; next_amount numeric; original_amount numeric; desired public."ReservationStatus"; seq bigint; event_id text; at_ms bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ctp_admission.issuance WHERE "tenantId"=t AND "orderId"=order_id) THEN RETURN; END IF;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_LIFECYCLE_SCOPE'; END IF;
 -- Every caller already owns GLOBAL -> tenant. Acquire the same locks also for direct owner writes.
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 PERFORM 1 FROM public.exchange_account a WHERE a."tenantId"=t AND a.id IN(SELECT "accountId" FROM ctp_admission.issuance WHERE "tenantId"=t AND "orderId"=order_id) ORDER BY a.id FOR UPDATE;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=order_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 FOR i IN SELECT * FROM ctp_admission.issuance WHERE "tenantId"=t AND "orderId"=order_id ORDER BY "accountId","reservationId" LOOP
  SELECT * INTO rr FROM public.risk_reservation WHERE "tenantId"=t AND id=i."reservationId" FOR UPDATE;
  SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=i."bookId" FOR UPDATE;
  SELECT * INTO wm FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=b.id AND "holdId"=rr.id::text FOR UPDATE;
  IF NOT FOUND OR b."accountId" IS DISTINCT FROM i."accountId" OR b.mode IS DISTINCT FROM i.mode THEN RAISE EXCEPTION 'RISK_LIFECYCLE_HOLD'; END IF;
  SELECT r.* INTO previous FROM ctp_admission.lifecycle_head h JOIN ctp_admission.lifecycle_revision r USING("tenantId","reservationId",sequence) WHERE h."tenantId"=t AND h."reservationId"=rr.id FOR UPDATE OF h;
  SELECT * INTO pg FROM ctp_execution.progress WHERE "tenantId"=t AND "orderId"=order_id;
  proof:=jsonb_build_object('orderVersion',o.version,'status',o.status,'reconciliation',o."reconciliationState",'filledQuantity',trim_scale(o."filledQuantity")::text,
   'portfolioSnapshotId',b.state::jsonb->'snapshotId','portfolioSnapshotAt',b.state::jsonb->'snapshotAt','portfolioStatus',b.state::jsonb->'status','nativeAt',pg."nativeAt",'nativeHash',encode(pg."nativeHash",'hex'),'nativeStatus',pg."nativeStatus",
   'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'status',s.status,'response',s."responseCode",'evidence',encode(s."evidenceHash",'hex'),'started',s."transportStartedAt",'consumed',s."permitConsumedAt") ORDER BY s.id) FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id),'[]'::jsonb));
  expired_unused:=i."primaryReservationId" IS NOT NULL AND rr.status='ACTIVE' AND rr.amount=0 AND i.notional=0 AND i."reductionQuantity"=0
   AND rr."expiresAt"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."intentId"=i."intentId");
  proof:=proof||jsonb_build_object('expiredUnusedControl',expired_unused);
  fp:=sha256(convert_to(ctp_admission.canonical(proof),'UTF8'));
  IF previous.sequence IS NOT NULL AND previous."orderVersion">o.version THEN RAISE EXCEPTION 'RISK_LIFECYCLE_VERSION'; END IF;
  IF previous.sequence IS NOT NULL AND previous.fingerprint=fp THEN CONTINUE; END IF;
  -- A durable released tombstone is irreversible even when late outcome evidence arrives.
  IF rr.status='RELEASED' OR wm.released THEN
   IF rr.status IS DISTINCT FROM 'RELEASED'::public."ReservationStatus" OR NOT wm.released OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.state::jsonb->'holds')h WHERE h->>'id'=rr.id::text) THEN RAISE EXCEPTION 'RISK_LIFECYCLE_DIVERGENCE'; END IF;
   CONTINUE;
  END IF;
  state:=b.state::jsonb;
  SELECT value INTO hold FROM jsonb_array_elements(state->'holds') WHERE value->>'id'=rr.id::text;
  IF NOT FOUND OR hold->>'asset' IS DISTINCT FROM rr.asset OR (hold->>'amount')::numeric IS DISTINCT FROM rr.amount THEN RAISE EXCEPTION 'RISK_LIFECYCLE_DIVERGENCE'; END IF;
  SELECT e.payload::jsonb->'order' INTO native FROM ctp_execution.authoritative_event e
   WHERE e."tenantId"=t AND e."orderId"=order_id AND e.payload::jsonb->>'type'='NATIVE'
   AND sha256(convert_to(ctp_admission.canonical(e.payload::jsonb->'order'),'UTF8'))=pg."nativeHash"
   AND (e.payload::jsonb->'order'->>'updatedAt')::bigint=pg."nativeAt" LIMIT 1;
  effective:=ctp_execution.effective_command(t,order_id);
  terminal_proof:=COALESCE(o.status IN('FILLED','CANCELED','REJECTED','EXPIRED') AND o."reconciliationState"='CONSISTENT'
   AND pg."nativeStatus"=o.status AND pg."nativeAt"<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND native->>'status'=pg."nativeStatus"::text AND native->>'clientOrderId'=effective->>'clientOrderId'
   AND native->>'internalOrderId'=o.id::text AND native->>'intentId'=o."intentId"::text
   AND native->>'exchangeOrderId'=o."exchangeOrderId" AND (native->>'filledQuantity')::numeric=o."filledQuantity"
   AND native->'account'=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',i.request->'binding'->>'externalAccountId')
   AND native->>'instrumentId'=i.instrument AND (native->>'quantity')::numeric=(effective->'size'->>'value')::numeric
   AND o."filledQuantity"=(SELECT COALESCE(sum(quantity),0) FROM public.fill WHERE "tenantId"=t AND "orderId"=order_id)
   AND NOT EXISTS(SELECT 1 FROM public.fill f LEFT JOIN ctp_execution.fill_adoption a ON a."tenantId"=f."tenantId" AND a."fillId"=f.id LEFT JOIN ctp_portfolio.evidence e ON e."tenantId"=a."tenantId" AND e.book=a.book AND e.id=a."eventId"
    WHERE f."tenantId"=t AND f."orderId"=order_id AND (a.book IS DISTINCT FROM b.id OR e.ledger IS NULL OR floor(extract(epoch FROM f.timestamp)*1000)::bigint>(state->>'snapshotAt')::bigint))
   AND NOT EXISTS(SELECT 1 FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id AND s.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED')),false);
  native_confirmed:=COALESCE(o.status IN('SUBMITTED','PARTIALLY_FILLED') AND o."reconciliationState"='CONSISTENT'
   AND pg."nativeStatus"=o.status AND pg."nativeAt"<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND native->>'status'=CASE pg."nativeStatus" WHEN 'SUBMITTED' THEN 'OPEN' ELSE pg."nativeStatus"::text END AND native->>'clientOrderId'=effective->>'clientOrderId'
   AND native->>'internalOrderId'=o.id::text AND native->>'intentId'=o."intentId"::text
   AND native->>'exchangeOrderId'=o."exchangeOrderId" AND (native->>'filledQuantity')::numeric=o."filledQuantity"
   AND native->'account'=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',i.request->'binding'->>'externalAccountId')
   AND state->>'status'='RECONCILED' AND state->'pending'='[]'::jsonb AND state->'differences'='[]'::jsonb AND (state->>'snapshotAt')::bigint>=pg."nativeAt"
   AND (NOT EXISTS(SELECT 1 FROM ctp_execution.amendment_head h WHERE h."tenantId"=t AND h."orderId"=order_id)
    OR EXISTS(SELECT 1 FROM ctp_execution.amendment_head h JOIN ctp_execution.amendment_application j USING("tenantId","orderId",sequence)
     WHERE h."tenantId"=t AND h."orderId"=order_id AND (state->>'snapshotAt')::bigint>=(j.proof->>'nativeReceivedAt')::bigint)) AND native->>'side'=o.side::text AND native->>'instrumentId'=i.instrument AND (native->>'quantity')::numeric=(effective->'size'->>'value')::numeric
   AND (o."orderType"<>'LIMIT' OR (native->'price'->>'state'='AVAILABLE' AND (native->'price'->>'value')::numeric=o."limitPrice"))
   AND o."filledQuantity"=(SELECT COALESCE(sum(quantity),0) FROM public.fill WHERE "tenantId"=t AND "orderId"=order_id)
   AND NOT EXISTS(SELECT 1 FROM public.fill f LEFT JOIN ctp_execution.fill_adoption a ON a."tenantId"=f."tenantId" AND a."fillId"=f.id LEFT JOIN ctp_portfolio.evidence e ON e."tenantId"=a."tenantId" AND e.book=a.book AND e.id=a."eventId"
    WHERE f."tenantId"=t AND f."orderId"=order_id AND (a.book IS DISTINCT FROM b.id OR e.ledger IS NULL OR floor(extract(epoch FROM f.timestamp)*1000)::bigint>(state->>'snapshotAt')::bigint))
   AND NOT EXISTS(SELECT 1 FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id AND s.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED')),false);
  not_sent:=o.status='REJECTED' AND o."reconciliationState"='CONSISTENT' AND EXISTS(
   SELECT 1 FROM public.submission_attempt s JOIN ctp_execution.authoritative_event e ON e."tenantId"=s."tenantId" AND e."orderId"=s."orderId" AND e.identity='result:'||s.id::text
   WHERE s."tenantId"=t AND s."intentId"=i."intentId" AND s.status='REJECTED' AND s."responseCode"='NOT_SENT' AND s."transportStartedAt" IS NULL AND s."permitConsumedAt" IS NULL
    AND e.payload::jsonb->'outcome'->>'kind'='DEFINITIVELY_REJECTED');
  definitive_reject:=o.status='REJECTED' AND o."reconciliationState"='CONSISTENT' AND EXISTS(
   SELECT 1 FROM public.submission_attempt s JOIN ctp_execution.authoritative_event e ON e."tenantId"=s."tenantId" AND e."orderId"=s."orderId" AND e.identity='result:'||s.id::text
   WHERE s."tenantId"=t AND s."intentId"=i."intentId" AND s.status='REJECTED' AND s."responseCode"='DEFINITIVELY_REJECTED' AND s."transportStartedAt" IS NOT NULL
    AND e.payload::jsonb->'outcome'->>'kind'='DEFINITIVELY_REJECTED');
  unresolved:=o.status IN('UNKNOWN','RECONCILIATION_REQUIRED') OR EXISTS(SELECT 1 FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id AND s.status='UNKNOWN');
  control_reject:=i."primaryReservationId" IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.submission_attempt a JOIN ctp_execution.authoritative_event e ON e."tenantId"=a."tenantId" AND e."orderId"=a."orderId" AND e.identity='result:'||a.id::text
    WHERE a."tenantId"=t AND a."intentId"=i."intentId" AND a.operation IN('AMEND','CANCEL') AND a.status='REJECTED'
    AND a."reservationId"=rr.id AND a."commandHash"=decode(i.request->>'commandHash','hex')
    AND e.payload::jsonb->>'operation'=a.operation::text AND e.payload::jsonb->>'attemptId'=a.id::text
    AND e.payload::jsonb->'outcome'->>'kind'='DEFINITIVELY_REJECTED'
    AND ((a."responseCode"='NOT_SENT' AND a."transportStartedAt" IS NULL AND a."permitConsumedAt" IS NULL)
     OR (a."responseCode"='DEFINITIVELY_REJECTED' AND a."transportStartedAt" IS NOT NULL AND a."permitConsumedAt" IS NOT NULL)));
  control_applied:=i."primaryReservationId" IS NOT NULL AND rr.amount=0 AND EXISTS(
   SELECT 1 FROM ctp_execution.amendment_application app JOIN public.submission_attempt a ON a."tenantId"=app."tenantId" AND a.id=app."attemptId"
    WHERE app."tenantId"=t AND app."intentId"=i."intentId" AND app."orderId"=order_id AND a.status='RECONCILED'
    AND a."reservationId"=rr.id AND a."transportStartedAt" IS NOT NULL AND a."permitConsumedAt" IS NOT NULL
    AND app.fingerprint=sha256(convert_to(ctp_admission.canonical(app.cause),'UTF8')) AND app.replacement=i.control->'command'->'replacement');
  desired:=CASE WHEN control_applied OR expired_unused OR control_reject OR terminal_proof OR not_sent OR definitive_reject THEN 'RELEASED'::public."ReservationStatus" WHEN unresolved OR (rr.status='UNRESOLVED' AND NOT native_confirmed) THEN 'UNRESOLVED'::public."ReservationStatus" ELSE 'ACTIVE'::public."ReservationStatus" END;
  next_amount:=rr.amount;
  IF native_confirmed AND i."primaryReservationId" IS NULL AND o.quantity>0 AND (effective->'size'->>'value')::numeric>o."filledQuantity" AND ((effective->'size'->>'value')::numeric<o.quantity OR o."filledQuantity">0) THEN
   SELECT (e.payload::jsonb->'hold'->>'amount')::numeric INTO original_amount FROM ctp_portfolio.evidence e WHERE e."tenantId"=t AND e.book=b.id AND e.id='risk-reserve-'||rr.id::text;
   IF original_amount IS NULL THEN RAISE EXCEPTION 'RISK_LIFECYCLE_ORIGINAL_AMOUNT'; END IF;
   next_amount:=least(rr.amount,ceil(original_amount*((effective->'size'->>'value')::numeric-o."filledQuantity")/o.quantity*10::numeric^18)/10::numeric^18);
  END IF;
  proof:=proof||jsonb_build_object('nativeConfirmed',native_confirmed,'nativeBodyHash',CASE WHEN native IS NULL THEN NULL ELSE encode(sha256(convert_to(ctp_admission.canonical(native),'UTF8')),'hex') END,'nextAmount',trim_scale(next_amount)::text);
  expired_unused:=i."primaryReservationId" IS NOT NULL AND rr.status='ACTIVE' AND rr.amount=0 AND i.notional=0 AND i."reductionQuantity"=0
   AND rr."expiresAt"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."intentId"=i."intentId");
  proof:=proof||jsonb_build_object('expiredUnusedControl',expired_unused);
  fp:=sha256(convert_to(ctp_admission.canonical(proof),'UTF8'));
  IF previous.sequence IS NOT NULL AND previous.fingerprint=fp THEN CONTINUE; END IF;
  seq:=COALESCE(previous.sequence,0)+1; event_id:=NULL;
  IF next_amount IS DISTINCT FROM rr.amount OR desired IS DISTINCT FROM rr.status OR (desired='UNRESOLVED' AND hold->>'status'<>'UNKNOWN') THEN
   at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
   IF at_ms<=wm.timestamp THEN PERFORM pg_sleep(0.002); at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; END IF;
   IF at_ms<=wm.timestamp THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CLOCK'; END IF;
   event_id:='risk-lifecycle-'||rr.id::text||'-'||seq::text;
   IF desired='RELEASED' THEN
    event:=jsonb_build_object('id',event_id,'timestamp',at_ms,'type','RELEASE','holdId',rr.id::text,'resolved',true);
    state:=jsonb_set(state,'{holds}',COALESCE((SELECT jsonb_agg(h ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY z(h,n) WHERE h->>'id'<>rr.id::text),'[]'::jsonb));
    UPDATE public.risk_budget SET "reservedAmount"="reservedAmount"-rr.amount,version=version+1,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=rr."budgetId" AND "reservedAmount">=rr.amount AND version<2147483647;
    IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_BUDGET'; END IF;
   ELSIF native_confirmed AND desired='ACTIVE' THEN
    hold:=jsonb_set(jsonb_set(hold,'{amount}',to_jsonb(trim_scale(next_amount)::text)),'{status}','"RESERVED"'::jsonb);
    event:=jsonb_build_object('id',event_id,'timestamp',at_ms,'type','RESOLVE_COMMITMENT','hold',hold,'proofId',rr.id::text||':'||seq::text,'proofHash',encode(fp,'hex'));
    state:=jsonb_set(state,'{holds}',(SELECT jsonb_agg(CASE WHEN h->>'id'=rr.id::text THEN hold ELSE h END ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY z(h,n)));
    UPDATE public.risk_budget SET "reservedAmount"="reservedAmount"-(rr.amount-next_amount),version=version+1,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=rr."budgetId" AND "reservedAmount">=rr.amount-next_amount AND version<2147483647;
    IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_BUDGET'; END IF;
   ELSE
    hold:=jsonb_set(hold,'{status}','"UNKNOWN"'::jsonb);
    event:=jsonb_build_object('id',event_id,'timestamp',at_ms,'type','COMMITMENT','hold',hold);
    state:=jsonb_set(state,'{holds}',(SELECT jsonb_agg(CASE WHEN h->>'id'=rr.id::text THEN hold ELSE h END ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY z(h,n)));
   END IF;
   INSERT INTO ctp_admission.lifecycle_revision("tenantId","reservationId",sequence,"orderVersion",proof,fingerprint,status,amount,"eventId",event) VALUES(t,rr.id,seq,o.version,proof,fp,desired,next_amount,event_id,event);
   INSERT INTO ctp_admission.lifecycle_head("tenantId","reservationId",sequence) VALUES(t,rr.id,seq) ON CONFLICT("tenantId","reservationId") DO UPDATE SET sequence=EXCLUDED.sequence;
   text_state:=ctp_admission.canonical(state);
   UPDATE public.risk_reservation SET status=desired,amount=next_amount,version=version+1,"releasedAt"=CASE WHEN desired='RELEASED' THEN clock_timestamp() ELSE "releasedAt" END,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=rr.id AND version<2147483647;
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CAPACITY'; END IF;
   UPDATE ctp_portfolio.hold_watermark SET timestamp=at_ms,fingerprint=sha256(convert_to(ctp_admission.canonical(event-'id'-'timestamp'),'UTF8')),released=desired='RELEASED',unknown=desired='UNRESOLVED' WHERE "tenantId"=t AND book=b.id AND "holdId"=rr.id::text;
   INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger) VALUES(t,b.id,b."accountId",b.mode,event_id,sha256(convert_to(ctp_admission.canonical(event),'UTF8')),ctp_admission.canonical(event),NULL);
   UPDATE ctp_portfolio.book SET state=text_state,state_hash=sha256(convert_to(text_state,'UTF8')),revision=revision+1 WHERE "tenantId"=t AND id=b.id AND revision<2147483647;
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CAPACITY'; END IF;
   INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId") VALUES(t,b.id,b."accountId",b.mode,b.revision+1,event->>'type',event_id);
  ELSE
   INSERT INTO ctp_admission.lifecycle_revision("tenantId","reservationId",sequence,"orderVersion",proof,fingerprint,status,amount,"eventId") VALUES(t,rr.id,seq,o.version,proof,fp,desired,rr.amount,NULL);
   INSERT INTO ctp_admission.lifecycle_head("tenantId","reservationId",sequence) VALUES(t,rr.id,seq) ON CONFLICT("tenantId","reservationId") DO UPDATE SET sequence=EXCLUDED.sequence;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION ctp_certification.capture_sources(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.prepare(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.persist(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.validate_current(jsonb,jsonb,numeric,numeric,numeric,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.capture_exposure(uuid,public."TradingMode",jsonb,jsonb,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.sync_reservation(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.validate_dispatch(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.evaluation_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.control_target(jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_certification.capture_dispatch_sources(jsonb,uuid) FROM PUBLIC;
COMMIT;
