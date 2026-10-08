BEGIN;
CREATE OR REPLACE FUNCTION ctp_certification.capture_inventory(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; inventory_ids uuid[]; ids uuid[]; connection_ids uuid[]; b_ids uuid[]; result jsonb; BEGIN
 IF NOT (ctp_risk.valid_policy_publisher('ctp_risk_certifier') OR ctp_risk.valid_policy_publisher('ctp_risk_admission') OR ctp_risk.valid_policy_publisher('ctp_execution')) THEN RAISE EXCEPTION 'RISK_PORTFOLIO_ROLE_UNSAFE'; END IF;
 IF NOT ctp_market.snapshot_keys(p,ARRAY['tenantId','mode','targetAccountId','maxEvidenceAgeMs'])
 OR jsonb_typeof(p->'tenantId') IS DISTINCT FROM 'string' OR p->>'tenantId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p->'targetAccountId') IS DISTINCT FROM 'string' OR p->>'targetAccountId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p->'mode') IS DISTINCT FROM 'string' OR p->>'mode' NOT IN('PAPER','TESTNET','DEMO','LIVE')
 OR jsonb_typeof(p->'maxEvidenceAgeMs') IS DISTINCT FROM 'number' OR p->>'maxEvidenceAgeMs' !~ '^[1-9][0-9]{0,3}$' OR (p->>'maxEvidenceAgeMs')::integer>5000
 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_INPUT'; END IF;
 t:=(p->>'tenantId')::uuid; m:=(p->>'mode')::public."TradingMode";
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_PORTFOLIO_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 -- The tenant advisory lock serializes trusted financial writers. Row/FK locks
 -- also freeze account/connection/book inventory for ordinary API writers that
 -- do not participate in that advisory protocol. Lock all owned modes before
 -- selecting this mode, so an existing account cannot move into the selection.
 PERFORM id FROM public."user" WHERE id=t FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_PORTFOLIO_SCOPE'; END IF;
 SELECT array_agg(id ORDER BY id) INTO inventory_ids FROM
  (SELECT id FROM public.exchange_account WHERE "tenantId"=t ORDER BY id LIMIT 401)a;
 IF COALESCE(cardinality(inventory_ids),0)>400 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 PERFORM id FROM public.exchange_account WHERE "tenantId"=t AND id=ANY(inventory_ids) ORDER BY id FOR UPDATE;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode=m ORDER BY id LIMIT 101)a;
 IF cardinality(ids) IS NULL OR NOT((p->>'targetAccountId')::uuid=ANY(ids)) THEN RAISE EXCEPTION 'RISK_PORTFOLIO_SCOPE'; END IF;
 IF cardinality(ids)>100 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 SELECT array_agg(id ORDER BY "accountId",id) INTO connection_ids FROM
  (SELECT id,"accountId" FROM public.exchange_connection WHERE "tenantId"=t AND "accountId"=ANY(ids) AND mode=m ORDER BY "accountId",id LIMIT 301)c;
 IF COALESCE(cardinality(connection_ids),0)>300 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 PERFORM id FROM public.exchange_connection WHERE "tenantId"=t AND id=ANY(connection_ids) ORDER BY "accountId",id FOR SHARE;
 SELECT array_agg(id ORDER BY "accountId",wallet,id) INTO b_ids FROM (SELECT id,"accountId",wallet FROM ctp_portfolio.book WHERE "tenantId"=t AND "accountId"=ANY(ids) AND mode=m ORDER BY "accountId",wallet,id LIMIT 301)b;
 IF COALESCE(cardinality(b_ids),0)>300 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 PERFORM id FROM ctp_portfolio.book WHERE "tenantId"=t AND id=ANY(b_ids) ORDER BY "accountId",wallet,id FOR SHARE;
 IF COALESCE((SELECT sum(octet_length(state)) FROM ctp_portfolio.book WHERE "tenantId"=t AND id=ANY(b_ids)),0)>1048576 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_portfolio.book b WHERE b."tenantId"=t AND b.id=ANY(b_ids) AND
  (b.state_hash<>sha256(convert_to(b.state,'UTF8')) OR b.state::jsonb->'binding'->>'tenantId'<>t::text
   OR b.state::jsonb->'binding'->>'accountId'<>b."accountId"::text OR b.state::jsonb->'binding'->>'mode'<>m::text
   OR b.state::jsonb->'binding'->>'walletId'<>b.wallet
   OR NOT EXISTS(SELECT 1 FROM public.exchange_account a JOIN public.exchange_connection c ON c."tenantId"=a."tenantId" AND c."accountId"=a.id AND c.mode=a.mode
    WHERE a."tenantId"=t AND a.id=b."accountId" AND a.mode=m AND c.id=(b.state::jsonb->'binding'->>'connectionId')::uuid
    AND a."externalAccountId"=b.state::jsonb->'binding'->>'externalAccountId'
    AND a.exchange::text=b.state::jsonb->'binding'->'scope'->>'exchange' AND a.region=b.state::jsonb->'binding'->'scope'->>'region')))
 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CORRUPT'; END IF;
 SELECT jsonb_build_object('scope',jsonb_build_object('tenantId',t::text,'mode',m::text),
  'accounts',(SELECT jsonb_agg(jsonb_build_object('id',id::text,'exchange',exchange::text,'region',region,'externalAccountId',"externalAccountId",'accountMode',"accountMode",'status',status::text,'permissionEpoch',"permissionEpoch"::text,'reconciliationEpoch',"reconciliationEpoch"::text,'version',version) ORDER BY id) FROM public.exchange_account WHERE "tenantId"=t AND id=ANY(ids) AND mode=m),
  'books',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',b.id::text,'accountId',b."accountId"::text,'wallet',b.wallet,'revision',b.revision::text,'stateText',b.state,'hash',encode(b.state_hash,'hex'),
    'holdWatermarks',COALESCE((SELECT jsonb_agg(jsonb_build_object('holdId',w."holdId",'timestamp',w.timestamp::text,'fingerprint',encode(w.fingerprint,'hex'),'released',w.released,'unknown',w.unknown) ORDER BY w."holdId") FROM ctp_portfolio.hold_watermark w WHERE w."tenantId"=t AND w.book=b.id AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.state::jsonb->'holds')h WHERE h->>'id'=w."holdId")),'[]'::jsonb)) ORDER BY b."accountId",b.wallet,b.id) FROM ctp_portfolio.book b WHERE b."tenantId"=t AND b.id=ANY(b_ids)),'[]'::jsonb)) INTO result;
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION ctp_certification.capture_sources(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; b jsonb; profile jsonb; s jsonb; pf jsonb; policy_platform ctp_risk.policy_revision; policy_user ctp_risk.policy_revision;
 a public.exchange_account; c public.exchange_connection; u public."user"; command ctp_execution.command; cap public.capability_snapshot;
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
 IF NOT FOUND OR command.binding::jsonb IS DISTINCT FROM b OR command.operation<>'PLACE' OR NOT EXISTS(SELECT 1 FROM public.order_intent i WHERE i."tenantId"=t AND i.id=command."intentId" AND i."accountId"=a.id AND i.mode=m AND i."connectionId"=c.id AND i."instrumentId"=(p->>'dbInstrumentId')::uuid AND i."ruleVersionId"=(p->>'dbRuleId')::uuid AND i."commandHash"=command."commandHash") THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INTENT'; END IF;
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
 IF NOT FOUND OR reg.record->'rules'->>'version'<>command.command::jsonb->>'ruleVersion' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
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
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION ctp_admission.validate_dispatch(t uuid,attempt_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a public.submission_attempt%ROWTYPE; i ctp_admission.issuance%ROWTYPE; prep ctp_admission.preparation%ROWTYPE;
 rr public.risk_reservation%ROWTYPE; d public.risk_decision%ROWTYPE; old_src jsonb; src jsonb; validation_src jsonb; projection jsonb;
 field text; book jsonb; previous_book jsonb; state jsonb; previous_state jsonb; totals jsonb; lim jsonb; cmd jsonb; now_ms bigint; qty numeric; price numeric;
BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_DISPATCH_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 SELECT * INTO a FROM public.submission_attempt WHERE "tenantId"=t AND id=attempt_id;
 SELECT * INTO i FROM ctp_admission.issuance WHERE "tenantId"=t AND "intentId"=a."intentId" AND "orderId"=a."orderId" AND "reservationId"=a."reservationId";
 IF NOT FOUND OR a.operation<>'PLACE' OR a.mode NOT IN('TESTNET','DEMO') OR a.status<>'DISPATCHING' OR a."transportStartedAt" IS NOT NULL OR a."permitConsumedAt" IS NOT NULL OR a."deadlineAt"<=clock_timestamp() THEN RAISE EXCEPTION 'RISK_DISPATCH_ISSUANCE'; END IF;
 SELECT * INTO rr FROM public.risk_reservation WHERE "tenantId"=t AND id=i."reservationId" FOR UPDATE;
 SELECT * INTO d FROM public.risk_decision WHERE "tenantId"=t AND id=i."decisionId";
 SELECT * INTO prep FROM ctp_admission.preparation WHERE "tenantId"=t AND "intentId"=i."intentId";
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF rr.status IS DISTINCT FROM 'ACTIVE'::public."ReservationStatus" OR rr."expiresAt"<=clock_timestamp() OR d."expiresAt"<=clock_timestamp()
 OR d.verdict NOT IN('APPROVE','REDUCE_ONLY') OR d."commandHash" IS DISTINCT FROM a."commandHash" OR d."permissionEpoch" IS DISTINCT FROM a."permissionEpoch"
 OR prep.source_hash IS DISTINCT FROM sha256(convert_to(prep.source,'UTF8')) OR i.certificate_hash IS DISTINCT FROM sha256(convert_to(i.certificate,'UTF8'))
 OR (i.certificate::jsonb->>'expiresAt')::bigint<=now_ms THEN RAISE EXCEPTION 'RISK_DISPATCH_RESERVATION'; END IF;
 old_src:=prep.source::jsonb;projection:=i.certificate::jsonb->'projection';
 src:=ctp_certification.capture_sources(prep.key);
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
 cmd:=src->'intent'->'command';qty:=(cmd->'size'->>'value')::numeric;
 price:=COALESCE((cmd->>'limitPrice')::numeric,((src->'observation'->>'text')::jsonb->'execution'->>'upperPrice')::numeric);
 PERFORM ctp_admission.validate_current(validation_src,projection,qty,price,i.notional,now_ms);
 FOR lim IN SELECT value->'limits' FROM jsonb_array_elements(src->'policies') LOOP
  IF (totals->>'instrumentExposure')::numeric>(lim->>'maxInstrumentExposure')::numeric OR (totals->>'assetExposure')::numeric>(lim->>'maxAssetExposure')::numeric
   OR (totals->>'accountExposure')::numeric>(lim->>'maxAccountExposure')::numeric OR (totals->>'userExposure')::numeric>(lim->>'maxUserExposure')::numeric
   OR (totals->>'openOrders')::integer>(lim->>'maxOpenOrders')::integer OR (src->>'ordersInLastMinute')::integer>(lim->>'maxOrdersPerMinute')::integer
   OR (totals->>'availableAmount')::numeric<0 THEN RAISE EXCEPTION 'RISK_DISPATCH_LIMIT'; END IF;
 END LOOP;
 IF clock_timestamp()>=least(a."deadlineAt",rr."expiresAt",d."expiresAt",to_timestamp((i.certificate::jsonb->>'expiresAt')::double precision/1000)) THEN RAISE EXCEPTION 'RISK_DISPATCH_EXPIRED'; END IF;
END $$;
CREATE FUNCTION ctp_admission.current_dispatch_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF OLD."transportStartedAt" IS NULL AND NEW."transportStartedAt" IS NOT NULL
  AND EXISTS(SELECT 1 FROM ctp_admission.issuance WHERE "tenantId"=NEW."tenantId" AND "intentId"=NEW."intentId") THEN
  PERFORM ctp_admission.validate_dispatch(NEW."tenantId",NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER issued_current_dispatch BEFORE UPDATE ON public.submission_attempt FOR EACH ROW EXECUTE FUNCTION ctp_admission.current_dispatch_trigger();
REVOKE ALL ON FUNCTION ctp_admission.validate_dispatch(uuid,uuid),ctp_admission.current_dispatch_trigger() FROM PUBLIC;
-- No execution grant on either capture function or the private validator.
COMMIT;


