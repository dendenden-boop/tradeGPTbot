BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_risk_admission') THEN
  CREATE ROLE ctp_risk_admission NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
CREATE SCHEMA ctp_admission;
REVOKE ALL ON SCHEMA ctp_admission FROM PUBLIC;
GRANT USAGE ON SCHEMA ctp_admission TO ctp_risk_admission;
CREATE TABLE ctp_admission.preparation (
 "tenantId" uuid NOT NULL REFERENCES public."user"(id), "intentId" uuid NOT NULL,
 request jsonb NOT NULL, key jsonb NOT NULL, allocation jsonb NOT NULL,
 source text NOT NULL CHECK(octet_length(source)<=2097152),
 source_hash bytea NOT NULL CHECK(source_hash=sha256(convert_to(source,'UTF8'))),
 transaction_id xid8 NOT NULL, PRIMARY KEY("tenantId","intentId")
);
CREATE TABLE ctp_admission.issuance (
 "tenantId" uuid NOT NULL, "intentId" uuid NOT NULL, "orderId" uuid NOT NULL,
 "accountId" uuid NOT NULL, mode public."TradingMode" NOT NULL,
 "decisionId" uuid NOT NULL, "reservationId" uuid NOT NULL, "certificateId" uuid NOT NULL,
 "bookId" uuid NOT NULL, request jsonb NOT NULL, receipt jsonb NOT NULL,
 certificate text NOT NULL CHECK(octet_length(certificate)<=2097152),
 certificate_hash bytea NOT NULL CHECK(certificate_hash=sha256(convert_to(certificate,'UTF8'))),
 notional numeric NOT NULL CHECK(notional>=0 AND notional<10::numeric^30 AND scale(notional)<=18),
 "reductionQuantity" numeric NOT NULL CHECK("reductionQuantity">=0 AND "reductionQuantity"<10::numeric^30 AND scale("reductionQuantity")<=18),
 instrument text NOT NULL, base text NOT NULL,
 PRIMARY KEY("tenantId","intentId"), UNIQUE("tenantId","decisionId"), UNIQUE("tenantId","reservationId"),
 FOREIGN KEY("tenantId","intentId") REFERENCES ctp_admission.preparation("tenantId","intentId"),
 FOREIGN KEY("tenantId","decisionId","intentId","accountId",mode) REFERENCES public.risk_decision("tenantId",id,"intentId","accountId",mode),
 FOREIGN KEY("tenantId","reservationId","intentId","accountId",mode) REFERENCES public.risk_reservation("tenantId",id,"intentId","accountId",mode),
 FOREIGN KEY("tenantId","orderId") REFERENCES public."order"("tenantId",id),
 FOREIGN KEY("tenantId","certificateId") REFERENCES ctp_certification.certificate("tenantId",id),
 FOREIGN KEY("tenantId","bookId","accountId",mode) REFERENCES ctp_portfolio.book("tenantId",id,"accountId",mode)
);
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['preparation','issuance'] LOOP
 EXECUTE format('ALTER TABLE ctp_admission.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE ctp_admission.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY admission_tenant ON ctp_admission.%I USING ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',n);
 EXECUTE format('CREATE TRIGGER admission_immutable BEFORE UPDATE OR DELETE ON ctp_admission.%I FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row()',n);
 EXECUTE format('CREATE TRIGGER admission_no_truncate BEFORE TRUNCATE ON ctp_admission.%I FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row()',n);
END LOOP; END $$;
CREATE FUNCTION ctp_admission.lock_request(p jsonb) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; field text; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_admission') THEN RAISE EXCEPTION 'RISK_ADMISSION_ROLE_UNSAFE'; END IF;
 IF octet_length(p::text)>8192 OR NOT ctp_market.snapshot_keys(p,ARRAY['binding','orderId','intentId','operation','commandHash'])
 OR p->>'operation' NOT IN('PLACE','CANCEL','AMEND') OR p->>'commandHash' !~ '^[a-f0-9]{64}$'
 OR p->'binding'->>'mode' NOT IN('TESTNET','DEMO') THEN RAISE EXCEPTION 'RISK_ADMISSION_INPUT'; END IF;
 FOREACH field IN ARRAY ARRAY['orderId','intentId'] LOOP
  IF jsonb_typeof(p->field)<>'string' OR p->>field !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'RISK_ADMISSION_INPUT'; END IF;
 END LOOP;
 t:=(p->'binding'->>'tenantId')::uuid;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_ADMISSION_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 RETURN t;
END $$;
-- Exact existing capture/identity implementation with an additional isolated
-- admission authority; historical migration 18 stays byte-identical.
CREATE OR REPLACE FUNCTION ctp_certification.capture_inventory(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; inventory_ids uuid[]; ids uuid[]; connection_ids uuid[]; b_ids uuid[]; result jsonb; BEGIN
 IF NOT (ctp_risk.valid_policy_publisher('ctp_risk_certifier') OR ctp_risk.valid_policy_publisher('ctp_risk_admission')) THEN RAISE EXCEPTION 'RISK_PORTFOLIO_ROLE_UNSAFE'; END IF;
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

-- Only certified permanent issuance can attest pending exposure. Its immutable
-- command identifies the effect; valuation comes from current captured Market/FX,
-- not the old certificate's notional. No TTL expiry releases an unresolved hold.
CREATE FUNCTION ctp_admission.capture_exposure(t uuid,m public."TradingMode",pf jsonb,observation jsonb,markets jsonb,valuation text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record; b jsonb; h jsonb; cmd jsonb; native jsonb; mark jsonb; fx jsonb;
 price numeric; remaining numeric; effect numeric; reduction numeric; unknown boolean;
 orders jsonb:='[]'; reservations jsonb:='[]'; BEGIN
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
  IF r.request->'binding' IS DISTINCT FROM r.binding OR r.request->>'operation'<>'PLACE'
  OR r.certificate_hash<>sha256(convert_to(r.certificate,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ISSUANCE_CORRUPT'; END IF;
  SELECT value INTO b FROM jsonb_array_elements(pf->'books') WHERE value->>'id'=r."bookId"::text AND value->>'accountId'=r."accountId"::text;
  IF NOT FOUND OR (b->>'stateText')::jsonb->'binding'->>'connectionId'<>r.binding->>'connectionId' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_HOLD'; END IF;
  SELECT value INTO h FROM jsonb_array_elements((b->>'stateText')::jsonb->'holds') WHERE value->>'id'=r."reservationId"::text;
  IF NOT FOUND OR h->>'asset'<>r.asset OR (h->>'amount')::numeric<>r.amount THEN RAISE EXCEPTION 'RISK_SNAPSHOT_HOLD'; END IF;
  unknown:=r.order_status IN('UNKNOWN','RECONCILIATION_REQUIRED') OR r.reservation_status='UNRESOLVED'
   OR EXISTS(SELECT 1 FROM public.submission_attempt sa WHERE sa."tenantId"=t AND sa."orderId"=r."orderId" AND sa.status='UNKNOWN');
  IF unknown AND h->>'status'<>'UNKNOWN' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_HOLD'; END IF;
  IF r."filledQuantity"<>(SELECT COALESCE(sum(quantity),0) FROM public.fill WHERE "tenantId"=t AND "orderId"=r."orderId")
  OR EXISTS(SELECT 1 FROM public.fill f LEFT JOIN ctp_execution.fill_adoption ad ON ad."tenantId"=f."tenantId" AND ad."fillId"=f.id
   LEFT JOIN ctp_portfolio.evidence e ON e."tenantId"=ad."tenantId" AND e.book=ad.book AND e.id=ad."eventId"
   WHERE f."tenantId"=t AND f."orderId"=r."orderId" AND (ad.book IS DISTINCT FROM r."bookId" OR e.ledger IS NULL
    OR e.fingerprint<>sha256(convert_to(e.payload,'UTF8')) OR floor(extract(epoch FROM f.timestamp)*1000)::bigint>((b->>'stateText')::jsonb->>'snapshotAt')::bigint))
  THEN RAISE EXCEPTION 'RISK_SNAPSHOT_FILL_COVERAGE'; END IF;
  cmd:=r.command;remaining:=r.quantity-r."filledQuantity";
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
 RETURN jsonb_build_object('orders',orders,'reservations',reservations);
END $$;
CREATE OR REPLACE FUNCTION ctp_certification.capture_sources(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; b jsonb; profile jsonb; s jsonb; pf jsonb; policy_platform ctp_risk.policy_revision; policy_user ctp_risk.policy_revision;
 a public.exchange_account; c public.exchange_connection; u public."user"; command ctp_execution.command; cap public.capability_snapshot;
 reg ctp_registry.current_record; obs ctp_certification.observation; observation jsonb; market_ids uuid[]; native ctp_market.snapshot_event;
 markets jsonb:='[]'; issued_exposure jsonb; loss ctp_risk.loss_batch; controls jsonb; controls_raw jsonb; result jsonb; age integer; now_ms bigint; market_id uuid; count_orders bigint; BEGIN
 IF NOT (ctp_risk.valid_policy_publisher('ctp_risk_certifier') OR ctp_risk.valid_policy_publisher('ctp_risk_admission')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
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

CREATE OR REPLACE FUNCTION ctp_certification.next_identity(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; v bigint; identity_id uuid:=gen_random_uuid(); BEGIN
 IF NOT (ctp_risk.valid_policy_publisher('ctp_risk_certifier') OR ctp_risk.valid_policy_publisher('ctp_risk_admission')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
 t:=ctp_certification.lock_key(p,true);
 SELECT revision INTO v FROM ctp_certification.identity_head WHERE "tenantId"=t AND key=p;
 IF COALESCE(v,0)>=9223372036854775807 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_REVISION'; END IF; v:=COALESCE(v,0)+1;
 INSERT INTO ctp_certification.identity("tenantId",key,id,revision) VALUES(t,p,identity_id,v);
 INSERT INTO ctp_certification.identity_head("tenantId",key,id,revision) VALUES(t,p,identity_id,v) ON CONFLICT("tenantId",key) DO UPDATE SET id=EXCLUDED.id,revision=EXCLUDED.revision;
 RETURN jsonb_build_object('id',identity_id::text,'revision',v::text);
END $$;

CREATE OR REPLACE FUNCTION ctp_certification.insert_certificate(p jsonb,raw text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; c jsonb; h ctp_certification.identity_head; old ctp_certification.certificate; BEGIN
 IF NOT (ctp_risk.valid_policy_publisher('ctp_risk_certifier') OR ctp_risk.valid_policy_publisher('ctp_risk_admission')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
 t:=ctp_certification.lock_key(p,true);
 IF raw IS NULL OR octet_length(raw)>2097152 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INPUT'; END IF; c:=raw::jsonb;
 IF NOT ctp_market.snapshot_keys(c,ARRAY['id','revision','hash','createdAt','expiresAt','projection'])
 OR c->'projection'->'key' IS DISTINCT FROM p OR c->>'hash' !~ '^[a-f0-9]{64}$'
 OR c->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR c->>'revision' !~ '^[1-9][0-9]{0,18}$' OR (c->>'revision')::numeric>9223372036854775807
 OR NOT ctp_risk.loss_number(c->'createdAt') OR NOT ctp_risk.loss_number(c->'expiresAt')
 OR (c->>'createdAt')::numeric>floor(extract(epoch FROM clock_timestamp())*1000)
 OR (c->>'expiresAt')::numeric<floor(extract(epoch FROM clock_timestamp())*1000)
 OR (c->>'expiresAt')::numeric>(c->>'createdAt')::numeric+5000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INPUT'; END IF;
 SELECT * INTO old FROM ctp_certification.certificate WHERE "tenantId"=t AND id=(c->>'id')::uuid;
 IF FOUND THEN IF old.key<>p OR old.payload<>raw THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INSERT_CONFLICT'; END IF; RETURN; END IF;
 SELECT * INTO h FROM ctp_certification.identity_head WHERE "tenantId"=t AND key=p;
 IF h.id IS DISTINCT FROM (c->>'id')::uuid OR h.revision IS DISTINCT FROM (c->>'revision')::bigint THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INSERT_CONFLICT'; END IF;
 INSERT INTO ctp_certification.certificate("tenantId",key,id,revision,payload,hash) VALUES(t,p,h.id,h.revision,raw,sha256(convert_to(raw,'UTF8')));
 INSERT INTO ctp_certification.certificate_head("tenantId",key,id,revision) VALUES(t,p,h.id,h.revision) ON CONFLICT("tenantId",key) DO UPDATE SET id=EXCLUDED.id,revision=EXCLUDED.revision;
END $$;

CREATE FUNCTION ctp_admission.prepare(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; old ctp_admission.issuance; prep ctp_admission.preparation; cmd ctp_execution.command; k jsonb; src jsonb; ident jsonb; alloc jsonb; cap_id uuid; BEGIN
 t:=ctp_admission.lock_request(p);
 SELECT * INTO old FROM ctp_admission.issuance WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF FOUND THEN
  IF old.request IS DISTINCT FROM p OR old.certificate_hash<>sha256(convert_to(old.certificate,'UTF8')) THEN RAISE EXCEPTION 'RISK_ADMISSION_CONFLICT'; END IF;
  RETURN jsonb_build_object('replay',old.receipt);
 END IF;
 SELECT * INTO cmd FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid AND "orderId"=(p->>'orderId')::uuid FOR SHARE;
 IF NOT FOUND OR cmd.binding::jsonb IS DISTINCT FROM p->'binding' OR cmd.operation::text<>p->>'operation' OR encode(cmd."commandHash",'hex')<>p->>'commandHash' THEN RAISE EXCEPTION 'RISK_ADMISSION_CONFLICT'; END IF;
 IF cmd.operation<>'PLACE' THEN RAISE EXCEPTION 'RISK_ADMISSION_OPERATION_UNSUPPORTED'; END IF;
 LOCK TABLE public.instrument,public.instrument_rule_version,public.capability_snapshot IN SHARE MODE;
 SELECT id INTO cap_id FROM public.capability_snapshot WHERE exchange=(p->'binding'->'profile'->>'exchange')::public."Exchange" AND mode=(p->'binding'->>'mode')::public."TradingMode" AND region=p->'binding'->'profile'->>'region' AND "accountMode"=p->'binding'->'profile'->>'accountMode' AND market::text=CASE p->'binding'->'profile'->>'market' WHEN 'SPOT' THEN 'SPOT' ELSE 'PERPETUAL' END ORDER BY version DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
 k:=jsonb_build_object('binding',p->'binding','instrumentId',cmd.command::jsonb->'instrumentId','dbInstrumentId',cmd.draft::jsonb->'dbInstrumentId','dbRuleId',cmd.draft::jsonb->'dbRuleId','dbCapabilityId',cap_id::text,'intentId',cmd."intentId"::text);
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
-- Private canonical codec matches the Portfolio contract for the strict ASCII
-- field names admitted below. Money remains canonical decimal strings.
CREATE FUNCTION ctp_admission.canonical(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE result text; BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN
  SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||ctp_admission.canonical(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(v);
 WHEN 'array' THEN
  SELECT '['||COALESCE(string_agg(ctp_admission.canonical(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY a(value,ordinal);
 WHEN 'number' THEN result:=trim_scale((v::text)::numeric)::text;
 ELSE result:=v::text;
 END CASE;
 RETURN result;
END $$;
CREATE FUNCTION ctp_admission.money(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(v)='string' AND length(v#>>'{}')<=49
 AND (regexp_match(v#>>'{}','^(0|[1-9][0-9]{0,29})([.][0-9]{0,17}[1-9])?$'))[1] IS NOT NULL
 AND (v#>>'{}')=trim_scale((v#>>'{}')::numeric)::text,false)
$$;
-- Reconstruct shared exposure from actual captured books and issuance. The
-- projection supplied by a function caller cannot lower any of these totals.
CREATE FUNCTION ctp_admission.exposure_totals(src jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE book jsonb; state jsonb; position jsonb; reservation jsonb; native jsonb; observation jsonb; fx jsonb; market_id text; key jsonb:=src->'key';
 base text:=src->'metadata'->'value'->'record'->'instrument'->>'baseAsset'; account text:=src->'key'->'binding'->>'accountId'; valuation text:=src->'policies'->0->'limits'->>'valuationAsset';
 position_ids text[]:='{}'; target_positions integer:=0; open_orders integer:=0; pending boolean:=false;
 instrument_total numeric:=0; asset_total numeric:=0; account_total numeric:=0; user_total numeric:=0;
 quantity numeric:=0; reduction numeric:=0; effect numeric; price numeric; target_balance numeric; holds numeric:=0; asset text; BEGIN
 observation:=(src->'observation'->>'text')::jsonb;
 asset:=CASE WHEN key->'binding'->'profile'->>'market'='SPOT' AND src->'intent'->'command'->>'side'='SELL' THEN base ELSE COALESCE(src->'metadata'->'value'->'record'->'instrument'->>'settlementAsset',src->'metadata'->'value'->'record'->'instrument'->>'quoteAsset') END;
 FOR book IN SELECT value FROM jsonb_array_elements(src->'portfolio'->'books') LOOP
  state:=(book->>'stateText')::jsonb;
  IF state->>'status'<>'RECONCILED' OR jsonb_array_length(state->'pending')<>0 OR jsonb_array_length(state->'differences')<>0 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_INCOMPLETE'; END IF;
  IF book->>'accountId'=account THEN
   holds:=holds+COALESCE((SELECT sum((h->>'amount')::numeric) FROM jsonb_array_elements(state->'holds') h WHERE h->>'asset'=asset AND h->'reflected'='false'::jsonb),0);
   IF state->'binding'->>'connectionId'=key->'binding'->>'connectionId' AND state->'binding'->'scope'=(key->'binding'->'profile')-'accountMode'-'profileVersion'-'endpointProfileId'-'credentialRef' THEN
    IF target_balance IS NOT NULL THEN RAISE EXCEPTION 'RISK_SNAPSHOT_WALLET'; END IF;
    SELECT COALESCE((b->>'available')::numeric,(b->>'free')::numeric) INTO target_balance FROM jsonb_array_elements(state->'balances') b WHERE b->>'asset'=asset;
   END IF;
  END IF;
  FOR position IN SELECT value FROM jsonb_array_elements(state->'positions') LOOP
   IF position->>'positionSide'<>'NET' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_POSITION_MODE'; END IF;
   IF book->>'accountId'=account AND position->>'instrumentId'=key->>'instrumentId' THEN
    target_positions:=target_positions+1;quantity:=quantity+(position->>'quantity')::numeric;
    IF target_positions>1 THEN RAISE EXCEPTION 'RISK_CERTIFICATE_POSITION'; END IF;
   END IF;
   IF (position->>'quantity')::numeric=0 THEN CONTINUE; END IF;
   SELECT v->>'marketId' INTO market_id FROM jsonb_array_elements(observation->'valuations') v WHERE v->>'bookId'=book->>'id' AND v->>'accountId'=book->>'accountId' AND v->>'snapshotId'=state->>'snapshotId' AND v->>'instrumentId'=position->>'instrumentId';
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_POSITION_VALUATION'; END IF;
   SELECT (v->>'text')::jsonb INTO native FROM jsonb_array_elements(src->'markets') v WHERE v->>'id'=market_id;
   IF NOT FOUND OR native->'key'->>'instrumentId'<>position->>'instrumentId' OR native->'record'->'instrument'->>'baseAsset'<>position->>'base' OR native->'record'->'instrument'->>'quoteAsset'<>position->>'quote'
   OR native->'key'->'scope' IS DISTINCT FROM state->'binding'->'scope' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_POSITION_VALUATION'; END IF;
   IF native->'key'->'scope'->>'market'='SPOT' THEN
    IF native->'ticker'->'last'->>'state'<>'AVAILABLE' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_POSITION_VALUATION'; END IF;
    price:=(native->'ticker'->'last'->>'value')::numeric;
   ELSE
    SELECT (v->>'price')::numeric INTO price FROM jsonb_array_elements(observation->'marks') v WHERE v->>'marketId'=market_id AND v->>'priceAsset'=position->>'quote';
    IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_POSITION_VALUATION'; END IF;
   END IF;
   SELECT v INTO fx FROM jsonb_array_elements(observation->'fx') v WHERE v->>'from'=position->>'quote' AND v->>'to'=valuation;
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_SNAPSHOT_FX'; END IF;
   effect:=abs((position->>'quantity')::numeric)*price*(fx->>'rate')::numeric;
   user_total:=user_total+effect;
   IF book->>'accountId'=account THEN
    account_total:=account_total+effect;
    IF position->>'base'=base THEN asset_total:=asset_total+effect; END IF;
    IF position->>'instrumentId'=key->>'instrumentId' THEN instrument_total:=instrument_total+effect; END IF;
    IF NOT (position->>'instrumentId'=ANY(position_ids)) THEN position_ids:=array_append(position_ids,position->>'instrumentId'); END IF;
   END IF;
  END LOOP;
 END LOOP;
 FOR reservation IN SELECT value FROM jsonb_array_elements(src->'exposure'->'reservations') LOOP
  effect:=(reservation->>'notional')::numeric;user_total:=user_total+effect;
  IF reservation->>'accountId'=account THEN
   account_total:=account_total+effect;open_orders:=open_orders+1;
   IF reservation->>'base'=base THEN asset_total:=asset_total+effect; END IF;
   IF reservation->>'instrumentId'=key->>'instrumentId' THEN
    instrument_total:=instrument_total+effect;reduction:=reduction+(reservation->>'reductionQuantity')::numeric;
    IF reservation->>'reductionQuantity'='0' THEN pending:=true; END IF;
   END IF;
  END IF;
 END LOOP;
 IF target_balance IS NULL OR target_balance-holds<0 THEN RAISE EXCEPTION 'RISK_CERTIFICATE_COLLATERAL'; END IF;
 RETURN jsonb_build_object('instrumentExposure',trim_scale(instrument_total)::text,'assetExposure',trim_scale(asset_total)::text,'accountExposure',trim_scale(account_total)::text,'userExposure',trim_scale(user_total)::text,
 'positionQuantity',trim_scale(quantity)::text,'committedReductionQuantity',trim_scale(reduction)::text,'concurrentPositions',cardinality(position_ids),'openOrders',open_orders,'instrumentHasPendingEntry',pending,'availableAsset',asset,'availableAmount',trim_scale(target_balance-holds)::text);
END $$;
CREATE FUNCTION ctp_admission.validate_current(src jsonb,projection jsonb,qty numeric,price numeric,notional numeric,now_ms bigint) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE cmd jsonb:=src->'intent'->'command'; obs jsonb:=(src->'observation'->>'text')::jsonb; rules jsonb:=src->'metadata'->'value'->'record'->'rules'; instrument jsonb:=src->'metadata'->'value'->'record'->'instrument';
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
CREATE FUNCTION ctp_admission.persist(p jsonb,raw text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
<<admission>> DECLARE t uuid; prep ctp_admission.preparation; v jsonb; cert jsonb; proj jsonb; evaluation jsonb; pf jsonb; src jsonb; current_src jsonb; cmd jsonb; policy jsonb; lim jsonb;
 b jsonb; actual_totals jsonb; total_key text; total_value jsonb; target_book ctp_portfolio.book; next_state jsonb; ev jsonb; hold jsonb; w jsonb; native_balance jsonb; profile_row public.risk_profile; budget_row public.risk_budget;
 decision_id uuid; reserve_id uuid; state_id uuid:=gen_random_uuid(); state_version bigint; asset text; valuation text; policy_name text; policy_hash bytea;
 qty numeric; price numeric; fx numeric; notional numeric; amount numeric; fee numeric; available numeric; minimum_balance numeric; book_state jsonb; expected_holds jsonb; receipt jsonb;
 now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; deadline_ms bigint; mode_value public."TradingMode"; BEGIN
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
 b:=p->'binding';mode_value:=(b->>'mode')::public."TradingMode";cmd:=src->'intent'->'command';
 IF proj->'key' IS DISTINCT FROM prep.key OR cert->>'id'<>prep.allocation->>'certificateId' OR cert->>'revision'<>prep.allocation->>'revision'
 OR proj->'metadata' IS DISTINCT FROM src->'metadata'->'value' OR proj->'platform' IS DISTINCT FROM src->'policies'->0 OR proj->'user' IS DISTINCT FROM src->'policies'->1
 OR proj->>'permissionEpoch'<>src->'connection'->>'permissionEpoch' OR proj->'snapshot'->'binding' IS DISTINCT FROM b-'connectionId'-'externalAccountId'
 OR evaluation->>'kind' IS DISTINCT FROM 'EVALUATED' OR COALESCE(evaluation->>'effect' NOT IN('INCREASE','REDUCE'),true) THEN RAISE EXCEPTION 'RISK_ADMISSION_CONFLICT'; END IF;
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
 IF evaluation->'proposal'->>'asset'<>asset OR (evaluation->'proposal'->>'amount')::numeric<>amount OR (evaluation->>'notional')::numeric<>notional OR ((evaluation->>'effect'='REDUCE') IS DISTINCT FROM (cmd->>'reduceOnly'='true')) THEN RAISE EXCEPTION 'RISK_ADMISSION_AMOUNT'; END IF;
 IF (src->'observation'->>'text')::jsonb->'fee'->>'asset'<>asset THEN RAISE EXCEPTION 'RISK_ADMISSION_CURRENCY'; END IF;
 -- Pure evaluation is necessary, while SQL independently enforces both current
 -- platform/user limits on the exact proposed effect under shared tenant locks.
 FOR policy IN SELECT value FROM jsonb_array_elements(src->'policies') LOOP
  lim:=policy->'limits';
  IF evaluation->>'effect'='INCREASE' AND (
   notional>(lim->>'maxOrderNotional')::numeric OR (proj->'snapshot'->>'instrumentExposure')::numeric+notional>(lim->>'maxInstrumentExposure')::numeric
   OR (proj->'snapshot'->>'assetExposure')::numeric+notional>(lim->>'maxAssetExposure')::numeric OR (proj->'snapshot'->>'accountExposure')::numeric+notional>(lim->>'maxAccountExposure')::numeric
   OR (proj->'snapshot'->>'userExposure')::numeric+notional>(lim->>'maxUserExposure')::numeric OR (proj->'snapshot'->>'openOrders')::integer+1>(lim->>'maxOpenOrders')::integer
   OR (src->>'ordersInLastMinute')::integer+1>(lim->>'maxOrdersPerMinute')::integer
   OR (proj->'snapshot'->>'concurrentPositions')::integer+(CASE WHEN proj->'snapshot'->>'positionQuantity'='0' AND proj->'snapshot'->>'instrumentHasPendingEntry'='false' THEN 1 ELSE 0 END)>(lim->>'maxConcurrentPositions')::integer
  ) THEN RAISE EXCEPTION 'RISK_ADMISSION_LIMIT'; END IF;
 END LOOP;
 IF evaluation->>'effect'='INCREASE' AND (src->'controls'->'value'->>'circuit'<>'CLOSED' OR EXISTS(SELECT 1 FROM jsonb_each(src->'controls'->'value'->'pauses') WHERE value<>'false'::jsonb)) THEN RAISE EXCEPTION 'RISK_PAUSED'; END IF;
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
 INSERT INTO ctp_admission.issuance("tenantId","intentId","orderId","accountId",mode,"decisionId","reservationId","certificateId","bookId",request,receipt,certificate,certificate_hash,notional,"reductionQuantity",instrument,base) VALUES(t,(p->>'intentId')::uuid,(p->>'orderId')::uuid,(b->>'accountId')::uuid,mode_value,decision_id,reserve_id,(cert->>'id')::uuid,target_book.id,p,receipt,cert::text,sha256(convert_to(cert::text,'UTF8')),CASE evaluation->>'effect' WHEN 'REDUCE' THEN 0 ELSE notional END,CASE evaluation->>'effect' WHEN 'REDUCE' THEN qty ELSE 0 END,prep.key->>'instrumentId',src->'metadata'->'value'->'record'->'instrument'->>'baseAsset');
 RETURN receipt;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA ctp_admission FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ctp_admission FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_admission.prepare(jsonb),ctp_admission.persist(jsonb,text) TO ctp_risk_admission;
COMMIT;
