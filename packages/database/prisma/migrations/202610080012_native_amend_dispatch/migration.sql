BEGIN;
-- Native AMEND final admission only; production factory dispatch stays disabled.
CREATE OR REPLACE FUNCTION ctp_admission.control_target(p jsonb,own_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid:=(p->'binding'->>'tenantId')::uuid; cmd ctp_execution.command;
 o public."order"; primary_i ctp_admission.issuance; rr public.risk_reservation;
 original ctp_execution.command; progress ctp_execution.progress; body jsonb; c jsonb; pending public.submission_attempt;
BEGIN
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
 IF NOT FOUND OR c->'target'->'current' IS DISTINCT FROM original.command::jsonb
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
  OR body->>'clientOrderId' IS DISTINCT FROM o."clientId" OR body->>'exchangeOrderId' IS DISTINCT FROM o."exchangeOrderId"
  OR body->>'instrumentId' IS DISTINCT FROM primary_i.instrument OR body->>'side' IS DISTINCT FROM o.side::text OR body->>'type' IS DISTINCT FROM 'LIMIT'
  OR body->'price'->>'state' IS DISTINCT FROM 'AVAILABLE' OR (body->'price'->>'value')::numeric IS DISTINCT FROM o."limitPrice"
  OR (body->>'quantity')::numeric IS DISTINCT FROM o.quantity OR (body->>'filledQuantity')::numeric IS DISTINCT FROM o."filledQuantity"
  OR (body->>'updatedAt')::bigint IS DISTINCT FROM progress."nativeAt" OR progress."nativeAt" IS DISTINCT FROM (c->'target'->>'nativeUpdatedAt')::bigint
  OR body->'account' IS DISTINCT FROM jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',p->'binding'->>'externalAccountId')
  OR body->'scope' IS DISTINCT FROM (p->'binding'->'profile')-'accountMode'-'profileVersion'-'endpointProfileId'-'credentialRef'

  OR body->>'quantityUnit' IS DISTINCT FROM 'BASE' OR progress."nativeStatus" IS DISTINCT FROM o.status
  OR body->>'status' IS DISTINCT FROM (CASE o.status WHEN 'SUBMITTED' THEN 'OPEN' ELSE o.status::text END)
  OR progress."nativeAt" IS NULL OR progress."nativeAt">floor(extract(epoch FROM clock_timestamp())*1000) THEN RAISE EXCEPTION 'RISK_AMEND_NATIVE'; END IF;
 RETURN jsonb_build_object('orderId',o.id::text,'placeIntentId',o."intentId"::text,'reservationId',rr.id::text,
  'accountId',o."accountId"::text,'mode',o.mode::text,'asset',rr.asset,'amount',trim_scale(rr.amount)::text,'status',rr.status::text,
  'orderRevision',CASE WHEN own_attempt IS NULL THEN o.version::text ELSE c->'target'->>'revision' END,'command',original.command::jsonb,'filledQuantity',trim_scale(o."filledQuantity")::text,
  'exchangeOrderId',o."exchangeOrderId",'nativeUpdatedAt',progress."nativeAt",'nativeHash',encode(progress."nativeHash",'hex'));
END $$;
REVOKE ALL ON FUNCTION ctp_admission.control_target(jsonb,uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION ctp_admission.control_retention(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT ctp_admission.control_target(p,NULL::uuid) $$;
REVOKE ALL ON FUNCTION ctp_admission.control_retention(jsonb) FROM PUBLIC;
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
 IF NOT FOUND OR command.binding::jsonb IS DISTINCT FROM b OR command.operation NOT IN('PLACE','AMEND') OR NOT EXISTS(SELECT 1 FROM public.order_intent i WHERE i."tenantId"=t AND i.id=command."intentId" AND i."accountId"=a.id AND i.mode=m AND i."connectionId"=c.id AND i."instrumentId"=(p->>'dbInstrumentId')::uuid AND i."ruleVersionId"=(p->>'dbRuleId')::uuid AND i."commandHash"=command."commandHash") THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INTENT'; END IF;
 evaluation_order:=CASE command.operation WHEN 'PLACE' THEN command.command::jsonb WHEN 'AMEND' THEN command.command::jsonb->'replacement' END;
 IF command.operation='AMEND' THEN
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
 IF NOT FOUND OR command.binding::jsonb IS DISTINCT FROM b OR command.operation NOT IN('PLACE','AMEND') OR NOT EXISTS(SELECT 1 FROM public.order_intent i WHERE i."tenantId"=t AND i.id=command."intentId" AND i."accountId"=a.id AND i.mode=m AND i."connectionId"=c.id AND i."instrumentId"=(p->>'dbInstrumentId')::uuid AND i."ruleVersionId"=(p->>'dbRuleId')::uuid AND i."commandHash"=command."commandHash") THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INTENT'; END IF;
 evaluation_order:=CASE command.operation WHEN 'PLACE' THEN command.command::jsonb WHEN 'AMEND' THEN command.command::jsonb->'replacement' END;
 IF command.operation='AMEND' THEN
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
REVOKE ALL ON FUNCTION ctp_certification.capture_dispatch_sources(jsonb,uuid) FROM PUBLIC;
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
 IF NOT FOUND OR a.operation NOT IN('PLACE','AMEND') OR a.mode NOT IN('TESTNET','DEMO') OR a.status<>'DISPATCHING' OR a."transportStartedAt" IS NOT NULL OR a."permitConsumedAt" IS NOT NULL OR a."deadlineAt"<=clock_timestamp() THEN RAISE EXCEPTION 'RISK_DISPATCH_ISSUANCE'; END IF;
 SELECT * INTO rr FROM public.risk_reservation WHERE "tenantId"=t AND id=i."reservationId" FOR UPDATE;
 SELECT * INTO d FROM public.risk_decision WHERE "tenantId"=t AND id=i."decisionId";
 SELECT * INTO prep FROM ctp_admission.preparation WHERE "tenantId"=t AND "intentId"=i."intentId";
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF rr.status IS DISTINCT FROM 'ACTIVE'::public."ReservationStatus" OR rr."expiresAt"<=clock_timestamp() OR d."expiresAt"<=clock_timestamp()
 OR d.verdict NOT IN('APPROVE','REDUCE_ONLY') OR d."commandHash" IS DISTINCT FROM a."commandHash" OR d."permissionEpoch" IS DISTINCT FROM a."permissionEpoch"
 OR prep.source_hash IS DISTINCT FROM sha256(convert_to(prep.source,'UTF8')) OR i.certificate_hash IS DISTINCT FROM sha256(convert_to(i.certificate,'UTF8'))
 OR (i.certificate::jsonb->>'expiresAt')::bigint<=now_ms THEN RAISE EXCEPTION 'RISK_DISPATCH_RESERVATION'; END IF;
 old_src:=prep.source::jsonb;projection:=i.certificate::jsonb->'projection';
 IF a.operation='AMEND' THEN
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
  CASE WHEN a.operation='AMEND' THEN qty*price*(projection->'snapshot'->'market'->>'quoteToValuation')::numeric ELSE i.notional END,now_ms);
 FOR lim IN SELECT value->'limits' FROM jsonb_array_elements(src->'policies') LOOP
  IF (totals->>'instrumentExposure')::numeric>(lim->>'maxInstrumentExposure')::numeric OR (totals->>'assetExposure')::numeric>(lim->>'maxAssetExposure')::numeric
   OR (totals->>'accountExposure')::numeric>(lim->>'maxAccountExposure')::numeric OR (totals->>'userExposure')::numeric>(lim->>'maxUserExposure')::numeric
   OR (totals->>'openOrders')::integer>(lim->>'maxOpenOrders')::integer OR (src->>'ordersInLastMinute')::integer>(lim->>'maxOrdersPerMinute')::integer
   OR (totals->>'availableAmount')::numeric<0 THEN RAISE EXCEPTION 'RISK_DISPATCH_LIMIT'; END IF;
 END LOOP;
 IF clock_timestamp()>=least(a."deadlineAt",rr."expiresAt",d."expiresAt",to_timestamp((i.certificate::jsonb->>'expiresAt')::double precision/1000)) THEN RAISE EXCEPTION 'RISK_DISPATCH_EXPIRED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION ctp_admission.sync_reservation(t uuid,order_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i ctp_admission.issuance%ROWTYPE; o public."order"%ROWTYPE; rr public.risk_reservation%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; wm ctp_portfolio.hold_watermark%ROWTYPE;
 previous ctp_admission.lifecycle_revision%ROWTYPE; pg ctp_execution.progress%ROWTYPE;
 proof jsonb; fp bytea; state jsonb; hold jsonb; event jsonb; text_state text;
 native jsonb; control_reject boolean; expired_unused boolean; terminal_proof boolean; not_sent boolean; definitive_reject boolean;
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
  terminal_proof:=COALESCE(o.status IN('FILLED','CANCELED','REJECTED','EXPIRED') AND o."reconciliationState"='CONSISTENT'
   AND pg."nativeStatus"=o.status AND pg."nativeAt"<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND native->>'status'=pg."nativeStatus"::text AND native->>'clientOrderId'=o."clientId"
   AND native->>'internalOrderId'=o.id::text AND native->>'intentId'=o."intentId"::text
   AND native->>'exchangeOrderId'=o."exchangeOrderId" AND (native->>'filledQuantity')::numeric=o."filledQuantity"
   AND native->'account'=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',i.request->'binding'->>'externalAccountId')
   AND native->>'instrumentId'=i.instrument AND (native->>'quantity')::numeric=o.quantity
   AND o."filledQuantity"=(SELECT COALESCE(sum(quantity),0) FROM public.fill WHERE "tenantId"=t AND "orderId"=order_id)
   AND NOT EXISTS(SELECT 1 FROM public.fill f LEFT JOIN ctp_execution.fill_adoption a ON a."tenantId"=f."tenantId" AND a."fillId"=f.id LEFT JOIN ctp_portfolio.evidence e ON e."tenantId"=a."tenantId" AND e.book=a.book AND e.id=a."eventId"
    WHERE f."tenantId"=t AND f."orderId"=order_id AND (a.book IS DISTINCT FROM b.id OR e.ledger IS NULL OR floor(extract(epoch FROM f.timestamp)*1000)::bigint>(state->>'snapshotAt')::bigint))
   AND NOT EXISTS(SELECT 1 FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id AND s.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED')),false);
  native_confirmed:=COALESCE(o.status IN('SUBMITTED','PARTIALLY_FILLED') AND o."reconciliationState"='CONSISTENT'
   AND pg."nativeStatus"=o.status AND pg."nativeAt"<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND native->>'status'=CASE pg."nativeStatus" WHEN 'SUBMITTED' THEN 'OPEN' ELSE pg."nativeStatus"::text END AND native->>'clientOrderId'=o."clientId"
   AND native->>'internalOrderId'=o.id::text AND native->>'intentId'=o."intentId"::text
   AND native->>'exchangeOrderId'=o."exchangeOrderId" AND (native->>'filledQuantity')::numeric=o."filledQuantity"
   AND native->'account'=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',i.request->'binding'->>'externalAccountId')
   AND state->>'status'='RECONCILED' AND state->'pending'='[]'::jsonb AND state->'differences'='[]'::jsonb AND (state->>'snapshotAt')::bigint>=pg."nativeAt" AND native->>'side'=o.side::text AND native->>'instrumentId'=i.instrument AND (native->>'quantity')::numeric=o.quantity
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
    WHERE a."tenantId"=t AND a."intentId"=i."intentId" AND a.operation='AMEND' AND a.status='REJECTED'
    AND a."reservationId"=rr.id AND a."commandHash"=decode(i.request->>'commandHash','hex')
    AND e.payload::jsonb->>'operation'='AMEND' AND e.payload::jsonb->>'attemptId'=a.id::text
    AND e.payload::jsonb->'outcome'->>'kind'='DEFINITIVELY_REJECTED'
    AND ((a."responseCode"='NOT_SENT' AND a."transportStartedAt" IS NULL AND a."permitConsumedAt" IS NULL)
     OR (a."responseCode"='DEFINITIVELY_REJECTED' AND a."transportStartedAt" IS NOT NULL AND a."permitConsumedAt" IS NOT NULL)));
  desired:=CASE WHEN expired_unused OR control_reject OR terminal_proof OR not_sent OR definitive_reject THEN 'RELEASED'::public."ReservationStatus" WHEN unresolved OR (rr.status='UNRESOLVED' AND NOT native_confirmed) THEN 'UNRESOLVED'::public."ReservationStatus" ELSE 'ACTIVE'::public."ReservationStatus" END;
  next_amount:=rr.amount;
  IF native_confirmed AND o.quantity>0 AND o."filledQuantity">0 AND o."filledQuantity"<o.quantity THEN
   SELECT (e.payload::jsonb->'hold'->>'amount')::numeric INTO original_amount FROM ctp_portfolio.evidence e WHERE e."tenantId"=t AND e.book=b.id AND e.id='risk-reserve-'||rr.id::text;
   IF original_amount IS NULL THEN RAISE EXCEPTION 'RISK_LIFECYCLE_ORIGINAL_AMOUNT'; END IF;
   next_amount:=least(rr.amount,ceil(original_amount*(o.quantity-o."filledQuantity")/o.quantity*10::numeric^18)/10::numeric^18);
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
COMMIT;
