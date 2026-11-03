BEGIN;
-- Pristine virtual-submission journal only. No monetary/Portfolio/allocation
-- write or financial permit; published1-61 and their function bodies immutable.
CREATE TABLE ctp_paper.attempt_start (
 tenant_id uuid NOT NULL, start_key text NOT NULL CHECK(start_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 attempt_id uuid NOT NULL, intent_id uuid NOT NULL, reservation_id uuid NOT NULL, event_id uuid NOT NULL,
 started_ms bigint NOT NULL CHECK(started_ms BETWEEN 0 AND 8640000000000000),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=16384), authorization_epochs jsonb NOT NULL,
 state jsonb NOT NULL, state_hash bytea NOT NULL CHECK(state_hash=sha256(convert_to(state::text,'UTF8'))),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=65536),
 response_hash bytea NOT NULL CHECK(response_hash=sha256(convert_to(response::text,'UTF8'))),
 PRIMARY KEY(tenant_id,start_key), UNIQUE(tenant_id,attempt_id), UNIQUE(tenant_id,intent_id),
 UNIQUE(tenant_id,reservation_id), UNIQUE(tenant_id,event_id)
);
ALTER TABLE ctp_paper.attempt_start ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.attempt_start FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_start_tenant ON ctp_paper.attempt_start
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON ctp_paper.attempt_start FROM PUBLIC,ctp_paper_risk_admission;
CREATE TRIGGER execution_start_immutable BEFORE UPDATE OR DELETE ON ctp_paper.attempt_start
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER execution_start_no_truncate BEFORE TRUNCATE ON ctp_paper.attempt_start
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.execution_start_auth(p jsonb) RETURNS uuid
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; auth jsonb:=p->'authorization'; v jsonb;
BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','preparationKey','startKey','admission','authorization']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_EXECUTION_START' OR octet_length(p::text)>16384
  OR NOT coalesce(ctp_market.snapshot_keys(auth,ARRAY['permissionEpoch','userSessionEpoch']),false)
  OR jsonb_typeof(p->'startKey') IS DISTINCT FROM 'string' OR p->>'startKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR jsonb_typeof(p->'preparationKey') IS DISTINCT FROM 'string' OR p->>'preparationKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOR v IN SELECT value FROM jsonb_each(auth) LOOP
  IF jsonb_typeof(v)<>'string' OR v#>>'{}' !~ '^(0|[1-9][0-9]{0,18})$' OR (v#>>'{}')::numeric>9223372036854775807
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 IF (auth->>'userSessionEpoch')::numeric>2147483647 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 t:=ctp_paper.admission_lock(p->'admission');
 IF NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t AND "sessionEpoch"=(auth->>'userSessionEpoch')::integer)
  OR NOT EXISTS(SELECT 1 FROM public.exchange_account WHERE "tenantId"=t AND id=(p->'admission'->'binding'->>'accountId')::uuid
   AND "permissionEpoch"=(auth->>'permissionEpoch')::bigint)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 RETURN t;
END $$;

CREATE FUNCTION ctp_paper.validate_execution_start(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; a uuid; w jsonb; inventory jsonb; source jsonb; prep jsonb; cfg jsonb; model jsonb; market jsonb;
 i ctp_paper.admission_issuance%ROWTYPE; cap public.capability_snapshot%ROWTYPE;
 controls jsonb; obs jsonb; fact jsonb; now_ms bigint; until_ms bigint; age integer; at_ms bigint; row jsonb; lim jsonb;
 qty numeric; step numeric; lower_price numeric; upper_price numeric; reference_price numeric; bid numeric; ask numeric; liquid numeric;
 instrument_total numeric:=0; asset_total numeric:=0; account_total numeric:=0; user_total numeric:=0; available numeric;
 open_count integer; positions_count integer; rate_count integer; quote text; heads jsonb:='[]'; validation jsonb;
BEGIN
 t:=ctp_paper.execution_start_auth(p);a:=(p->'admission'->'binding'->>'accountId')::uuid;
 -- Both fixed private captures retain the accepted GLOBAL -> tenant -> sorted
 -- account/order/book/catalog boundary. They cannot adopt an uninitialized book.
 w:=ctp_paper.capture_execution_risk(jsonb_build_object('kind','PAPER_EXECUTION_RISK_CAPTURE',
  'preparationKey',p->'preparationKey','admission',p->'admission','authorization',p->'authorization'));
 inventory:=ctp_paper.capture_preparation_inventory(jsonb_build_object('kind','PAPER_PREPARATION_INVENTORY_CAPTURE',
  'admission',p->'admission','authorization',p->'authorization'));
 source:=w->'capture';prep:=w->'journal'->'preparation';
 IF source-'asOf' IS DISTINCT FROM (inventory->'capture')-'asOf'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(inventory->'entries') e WHERE e->>'kind'<>'PREPARED')
  OR source->'candidates'->0->>'intentId' IS DISTINCT FROM p->'admission'->>'intentId'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=(p->'admission'->>'intentId')::uuid;
 IF NOT FOUND OR i.request IS DISTINCT FROM p->'admission' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 market:=w->'market';cfg:=(w->'runtime'->'configuration'->>'receiptText')::jsonb->'configuration';model:=source->'model';
 -- The supported pristine path retains exact original immutable metadata/model
 -- and worst-case debit. Refresh/replacement cannot silently widen the envelope.
 IF market->'record' IS DISTINCT FROM i.response->'policy'->'record'
  OR market->'order' IS DISTINCT FROM prep->'request'->'admission'->'command'
  OR market->>'dbRuleId' IS DISTINCT FROM i.rule_id::text
  OR jsonb_array_length(w->'evidence'->'positions')<>0
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO cap FROM public.capability_snapshot WHERE id=i.capability_id;
 IF NOT FOUND OR cap.mode<>'PAPER' OR cap."accountMode"<>'SIMULATED' OR cap.market<>'SPOT'
  OR cap."profileVersion"<>'spot-l2-taker-v1'
  OR cap.exchange::text IS DISTINCT FROM p->'admission'->'binding'->'profile'->>'exchange'
  OR cap.region IS DISTINCT FROM p->'admission'->'binding'->'profile'->>'region'
  OR cap.capabilities IS DISTINCT FROM jsonb_build_object('adapterVersion','paper-spot-l2-taker-v1','features',i.response->'policy'->'capabilities')
  OR cap."evidenceHash"<>sha256(convert_to((i.response->'policy'->'capabilities')::text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 until_ms:=least((i.response->'receipt'->>'expiresAt')::bigint,(source->>'validUntil')::bigint,
  floor(extract(epoch FROM cap."expiresAt")*1000)::bigint,now_ms/86400000*86400000+86400000);
 IF until_ms<=now_ms OR floor(extract(epoch FROM cap."verifiedAt")*1000)::bigint>now_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 age:=least((w->'policies'->0->'limits'->>'maxEvidenceAgeMs')::integer,(w->'policies'->1->'limits'->>'maxEvidenceAgeMs')::integer,
  (model->>'maxEvidenceAgeMs')::integer);
 obs:=(w->'runtime'->'publication'->>'text')::jsonb->'observation';
 IF (SELECT count(*) FROM jsonb_each(obs->'health'))<>9 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 FOR fact IN SELECT value FROM jsonb_each(obs->'health') LOOP
  IF fact->>'status' IS DISTINCT FROM 'HEALTHY' THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  at_ms:=(fact->>'asOf')::bigint;
  IF at_ms>now_ms OR now_ms-at_ms>age THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
  until_ms:=least(until_ms,at_ms+age+1);
 END LOOP;
 controls:=(w->'controls'->>'text')::jsonb;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'global') e WHERE e->>'kind'='KILL_SWITCH' AND e->>'key'='kill' AND e->>'state'='RUNNING')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'tenant') e WHERE e->>'kind'='KILL_SWITCH' AND e->>'state'<>'RUNNING')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements((controls->'global')||(controls->'tenant')) e WHERE e->>'kind'='CIRCUIT' AND e->>'state'<>'CLOSED')
  OR jsonb_array_length(controls->'activePauses')<>0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(controls->'circuits') e WHERE e->>'state'<>'CLOSED')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 quote:=market->'record'->'instrument'->>'quoteAsset';
 IF w->'policies'->0->'limits'->>'valuationAsset' IS DISTINCT FROM quote
  OR w->'policies'->1->'limits'->>'valuationAsset' IS DISTINCT FROM quote
  OR w->'loss'->>'asset' IS DISTINCT FROM quote
  OR (w->'loss'->>'utcDayStart')::bigint<>now_ms/86400000*86400000
  OR coalesce((w->'loss'->>'openingEquity')::numeric,(w->'loss'->>'initialCapital')::numeric,0)<=0
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 qty:=(market->'order'->'size'->>'value')::numeric;step:=(market->'record'->'rules'->>'stepSize')::numeric;
 lower_price:=(i.response->'policy'->'snapshot'->'market'->>'lowerExecutionPrice')::numeric;
 upper_price:=(i.response->'policy'->'snapshot'->'market'->>'upperExecutionPrice')::numeric;
 bid:=(market->'book'->'bids'->0->>'price')::numeric;ask:=(market->'book'->'asks'->0->>'price')::numeric;
 reference_price:=(market->'ticker'->'last'->>'value')::numeric;
 liquid:=floor(least((market->'book'->'bids'->0->>'quantity')::numeric,(market->'book'->'asks'->0->>'quantity')::numeric,
  (market->'trade'->>'quantity')::numeric)*(model->>'participationRate')::numeric/step)*step*least(bid,ask);
 IF qty<=0 OR upper_price<=0 OR lower_price<=0 OR upper_price<lower_price OR bid>ask OR reference_price<=0
  OR lower_price>bid OR upper_price<ask OR liquid<i.notional
  OR i.notional<>ceil(qty*upper_price*10::numeric^18)/10::numeric^18
  OR (i.response->'debits'->0->>'amount')::numeric<i.notional+(qty/step)*ceil(step*upper_price*(model->>'takerFeeRate')::numeric*10::numeric^18)/10::numeric^18
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(w->'evidence'->'reservations') LOOP
  IF row->'unknown' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  user_total:=user_total+(row->>'notional')::numeric;
  IF row->>'accountId'=a::text THEN
   account_total:=account_total+(row->>'notional')::numeric;
   IF row->>'base'=market->'record'->'instrument'->>'baseAsset' THEN asset_total:=asset_total+(row->>'notional')::numeric; END IF;
   IF row->>'instrumentId'=i.instrument THEN instrument_total:=instrument_total+(row->>'notional')::numeric; END IF;
  END IF;
 END LOOP;
 SELECT count(*),count(DISTINCT e->>'instrumentId') INTO open_count,positions_count
  FROM jsonb_array_elements(w->'evidence'->'reservations') e WHERE e->>'accountId'=a::text;
 SELECT (e->>'available')::numeric INTO available FROM jsonb_array_elements(w->'evidence'->'balances') e WHERE e->>'accountId'=a::text AND e->>'asset'=quote;
 SELECT available-coalesce(sum((e->>'amount')::numeric),0) INTO available FROM jsonb_array_elements(w->'evidence'->'holds') e WHERE e->>'accountId'=a::text AND e->>'asset'=quote;
 rate_count:=(w->>'ordersInLastMinuteExcludingTarget')::integer+1;
 IF available IS NULL OR available<0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(w->'policies') LOOP
  lim:=row->'limits';
  IF ctp_risk.valid_limits(lim) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF i.notional>(lim->>'maxOrderNotional')::numeric OR instrument_total>(lim->>'maxInstrumentExposure')::numeric
   OR asset_total>(lim->>'maxAssetExposure')::numeric OR account_total>(lim->>'maxAccountExposure')::numeric
   OR user_total>(lim->>'maxUserExposure')::numeric OR open_count>(lim->>'maxOpenOrders')::integer
   OR positions_count>(lim->>'maxConcurrentPositions')::integer OR rate_count>(lim->>'maxOrdersPerMinute')::integer
   OR (lim->>'maxLeverage')::numeric<1 OR available<(lim->>'minAvailableBalance')::numeric
   OR abs(upper_price-reference_price)>reference_price*(lim->>'maxPriceDeviationRate')::numeric
   OR (market->'order'->>'type'='MARKET' AND abs(lower_price-reference_price)>reference_price*(lim->>'maxPriceDeviationRate')::numeric)
   OR ask-bid>reference_price*(lim->>'maxSpreadRate')::numeric OR liquid<(lim->>'minLiquidityNotional')::numeric
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  heads:=heads||jsonb_build_array(jsonb_build_object('scope',row->'scope'->>'kind','tenantId',row->'scope'->'tenantId',
   'version',row->'version','eventId',row->'eventId','limitsHash',row->'limitsHash'));
 END LOOP;
 FOR at_ms IN SELECT value::bigint FROM unnest(ARRAY[(w->'evidence'->>'asOf')::bigint,(market->>'snapshotAt')::bigint,
  (market->>'tradeAt')::bigint,(market->'book'->>'receivedAt')::bigint,(market->'book'->>'exchangeTime')::bigint,
  (market->'trade'->>'receivedAt')::bigint,(market->'trade'->>'exchangeTime')::bigint,
  (market->'ticker'->>'receivedAt')::bigint,(market->'ticker'->>'exchangeTime')::bigint]) value LOOP
  IF at_ms IS NULL OR at_ms>now_ms OR now_ms-at_ms>age THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
  until_ms:=least(until_ms,at_ms+age+1);
 END LOOP;
 validation:=jsonb_build_object('validUntil',until_ms,'sourceHash',encode(sha256(convert_to(w::text||inventory::text,'UTF8')),'hex'),
  'policyHeads',heads,'book',jsonb_build_object('id',source->'portfolio'->'bookId','revision',source->'portfolio'->'revision','hash',source->'portfolio'->'hash'),
  'metadata',jsonb_build_object('instrumentId',market->'dbInstrumentId','ruleId',market->'dbRuleId'),
  'capability',jsonb_build_object('id',cap.id::text,'hash',encode(cap."evidenceHash",'hex')),'authorization',p->'authorization');
 IF until_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 RETURN jsonb_build_object('preparation',prep,'validation',validation);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;

CREATE FUNCTION ctp_paper.derive_execution_start() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE p jsonb; v jsonb; prepared jsonb; witness jsonb; receipt jsonb;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid
  OR NEW.attempt_id IS NOT NULL OR NEW.event_id IS NOT NULL OR NEW.started_ms IS NOT NULL
  OR NEW.intent_id IS NOT NULL OR NEW.reservation_id IS NOT NULL OR NEW.state IS NOT NULL OR NEW.state_hash IS NOT NULL
  OR NEW.response IS NOT NULL OR NEW.response_hash IS NOT NULL
  OR NOT coalesce(ctp_market.snapshot_keys(NEW.request,ARRAY['startKey','preparationKey','admission']),false)
  OR NEW.request->>'startKey' IS DISTINCT FROM NEW.start_key
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 p:=NEW.request||jsonb_build_object('kind','PAPER_EXECUTION_START','authorization',NEW.authorization_epochs);
 v:=ctp_paper.validate_execution_start(p);prepared:=v->'preparation';witness:=v->'validation';
 NEW.attempt_id:=(prepared->'request'->>'attemptId')::uuid;NEW.intent_id:=(prepared->'request'->'admission'->>'intentId')::uuid;
 NEW.reservation_id:=(prepared->'request'->'admission'->>'reservationId')::uuid;
 NEW.event_id:=gen_random_uuid();NEW.started_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF NEW.started_ms>=(witness->>'validUntil')::bigint OR NEW.started_ms<(prepared->'request'->>'preparedAt')::bigint
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 witness:=witness||jsonb_build_object('validatedAt',NEW.started_ms);
 NEW.state:=prepared||jsonb_build_object('revision','2','phase','STARTED','startedAt',NEW.started_ms,
  'lastEvent',jsonb_build_object('id',NEW.event_id::text,'kind','START','expectedRevision','1','at',NEW.started_ms));
 NEW.state_hash:=sha256(convert_to(NEW.state::text,'UTF8'));
 receipt:=jsonb_build_object('kind','PAPER_EXECUTION_START_RECEIPT','version','paper-pristine-start-v1',
  'startKey',NEW.start_key,'preparationKey',NEW.request->'preparationKey','attemptId',NEW.attempt_id::text,'eventId',NEW.event_id::text,'startedAt',NEW.started_ms,
  'requestHash',encode(sha256(convert_to(ctp_admission.canonical(NEW.request),'UTF8')),'hex'),
  'preparationHash',encode(sha256(convert_to(ctp_admission.canonical(prepared),'UTF8')),'hex'),
  'validation',witness,'validationHash',encode(sha256(convert_to(ctp_admission.canonical(witness),'UTF8')),'hex'));
 NEW.response:=jsonb_build_object('preparation',prepared,'receipt',receipt,'state',NEW.state,'unknown',NULL);
 NEW.response_hash:=sha256(convert_to(NEW.response::text,'UTF8'));
 RETURN NEW;
END $$;
CREATE TRIGGER derive_execution_start BEFORE INSERT ON ctp_paper.attempt_start FOR EACH ROW EXECUTE FUNCTION ctp_paper.derive_execution_start();

CREATE FUNCTION ctp_paper.execution_start(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; sem jsonb; s ctp_paper.attempt_start%ROWTYPE; u ctp_paper.admission_unknown_event%ROWTYPE;
 j ctp_paper.reservation_state_event%ROWTYPE; result jsonb; replay boolean:=false;
BEGIN
 t:=ctp_paper.execution_start_auth(p);sem:=p-'kind'-'authorization';
 SELECT * INTO s FROM ctp_paper.attempt_start WHERE tenant_id=t AND start_key=p->>'startKey';
 IF FOUND THEN
  IF s.request IS DISTINCT FROM sem THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;replay:=true;
 ELSE
  IF EXISTS(SELECT 1 FROM ctp_paper.attempt_start WHERE tenant_id=t AND intent_id=(p->'admission'->>'intentId')::uuid)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF read_only THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
  INSERT INTO ctp_paper.attempt_start(tenant_id,start_key,request,authorization_epochs) VALUES(t,p->>'startKey',sem,p->'authorization') RETURNING * INTO s;
 END IF;
 IF s.response_hash<>sha256(convert_to(s.response::text,'UTF8')) OR s.state_hash<>sha256(convert_to(s.state::text,'UTF8'))
  OR s.response->'state' IS DISTINCT FROM s.state THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 result:=s.response;
 SELECT * INTO j FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=s.reservation_id ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND OR (j.revision,j.status) NOT IN((1,'ACTIVE'),(2,'UNKNOWN')) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO u FROM ctp_paper.admission_unknown_event WHERE tenant_id=t AND reservation_id=s.reservation_id;
 IF FOUND THEN
  IF j.status<>'UNKNOWN' OR j.revision<>2 OR j.event_id<>u.event_id OR j.observed_ms<>u.observed_ms
   OR u.observed_ms<s.started_ms OR u.request->'admission' IS DISTINCT FROM sem->'admission'
   OR u.response_hash<>sha256(convert_to(u.response::text,'UTF8')) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  result:=result||jsonb_build_object('unknown',u.response->'receipt','state',s.state||jsonb_build_object('revision','3','phase','UNKNOWN',
   'lastEvent',jsonb_build_object('id',u.event_id::text,'kind','UNKNOWN','expectedRevision','2','at',u.observed_ms,'reason','AFTER_START')));
 ELSIF j.status<>'ACTIVE' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
 END IF;
 RETURN result||jsonb_build_object('kind',CASE WHEN read_only THEN 'COMMITTED' WHEN replay THEN 'REPLAY' ELSE 'STARTED' END,'request',p);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT';
END $$;

-- Old pristine readers may not silently return PREPARED for started history.
ALTER FUNCTION ctp_paper.capture_execution_candidates(jsonb) RENAME TO capture_execution_candidates_v61;
CREATE FUNCTION ctp_paper.capture_execution_candidates(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE result jsonb; BEGIN
 result:=ctp_paper.capture_execution_candidates_v61(p);
 IF EXISTS(SELECT 1 FROM ctp_paper.attempt_start WHERE tenant_id=(p->'admission'->'binding'->>'tenantId')::uuid
  AND request->'admission'->'binding'->>'accountId'=p->'admission'->'binding'->>'accountId')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;RETURN result;
END $$;
ALTER FUNCTION ctp_paper.attempt_journal(jsonb,boolean) RENAME TO attempt_journal_v61;
CREATE FUNCTION ctp_paper.attempt_journal(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE result jsonb; BEGIN
 result:=ctp_paper.attempt_journal_v61(p,read_only);
 IF EXISTS(SELECT 1 FROM ctp_paper.attempt_start WHERE tenant_id=(p->'admission'->'binding'->>'tenantId')::uuid
  AND intent_id=(p->'admission'->>'intentId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;RETURN result;
END $$;
CREATE FUNCTION ctp_paper.start_prevents_not_sent() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM ctp_paper.attempt_start WHERE tenant_id=NEW.tenant_id AND reservation_id=NEW.reservation_id)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER start_prevents_not_sent BEFORE INSERT ON ctp_paper.withdrawal_barrier FOR EACH ROW EXECUTE FUNCTION ctp_paper.start_prevents_not_sent();
ALTER FUNCTION ctp_paper.evaluate_and_reserve(jsonb) RENAME TO evaluate_and_reserve_v61;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v61;
CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_EXECUTION_START' THEN
  IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
  RETURN ctp_paper.execution_start(p,false);
 END IF;RETURN ctp_paper.evaluate_and_reserve_v61(p);
END $$;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_EXECUTION_START' THEN
  IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
  RETURN ctp_paper.execution_start(p,true);
 END IF;RETURN ctp_paper.reconcile_admission_v61(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.execution_start_auth(jsonb),ctp_paper.validate_execution_start(jsonb),ctp_paper.derive_execution_start(),
 ctp_paper.execution_start(jsonb,boolean),ctp_paper.capture_execution_candidates_v61(jsonb),ctp_paper.capture_execution_candidates(jsonb),
 ctp_paper.attempt_journal_v61(jsonb,boolean),ctp_paper.attempt_journal(jsonb,boolean),
 ctp_paper.start_prevents_not_sent(),ctp_paper.evaluate_and_reserve_v61(jsonb),ctp_paper.reconcile_admission_v61(jsonb),
 ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
