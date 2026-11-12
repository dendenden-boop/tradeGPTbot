BEGIN;
-- First pristine Spot BUY execution only. Public PAPER/LIVE dispatch stays off.
-- Published1-64 are unchanged. No caller-supplied amount/projection is accepted.
CREATE FUNCTION ctp_paper.validate_execution_commit(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; a uuid; w jsonb; inventory jsonb; source jsonb; prep jsonb; cfg jsonb; model jsonb; market jsonb;
 i ctp_paper.admission_issuance%ROWTYPE; cap public.capability_snapshot%ROWTYPE;
 controls jsonb; obs jsonb; fact jsonb; now_ms bigint; until_ms bigint; age integer; at_ms bigint; row jsonb; lim jsonb;
 qty numeric; step numeric; lower_price numeric; upper_price numeric; reference_price numeric; bid numeric; ask numeric; liquid numeric;
 instrument_total numeric:=0; asset_total numeric:=0; account_total numeric:=0; user_total numeric:=0; available numeric;
 open_count integer; positions_count integer; rate_count integer; quote text; heads jsonb:='[]'; validation jsonb;
BEGIN
 t:=ctp_paper.execution_start_auth(p);a:=(p->'admission'->'binding'->>'accountId')::uuid;
 -- Current actual START, complete inventory and current Risk under the same
 -- retained GLOBAL -> tenant -> sorted account/order/book/catalog boundary.
 inventory:=ctp_paper.capture_started_risk(p||jsonb_build_object('kind','PAPER_STARTED_RISK_CAPTURE'));
 w:=inventory->'risk';source:=w->'capture';prep:=w->'journal'->'preparation';
 IF jsonb_array_length(source->'candidates')<>1
  OR source->'candidates'->0->>'intentId' IS DISTINCT FROM p->'admission'->>'intentId'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
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
 RETURN jsonb_build_object('source',inventory,'validation',validation);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;

CREATE TABLE ctp_paper.execution_commit (
 tenant_id uuid NOT NULL, execution_key text NOT NULL CHECK(execution_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=16384), authorization_epochs jsonb NOT NULL,
 execution_id uuid NOT NULL, attempt_id uuid NOT NULL, reservation_id uuid NOT NULL,
 intent_id uuid NOT NULL, order_id uuid NOT NULL, account_id uuid NOT NULL, book_id uuid NOT NULL,
 previous_revision bigint NOT NULL, previous_hash bytea NOT NULL,
 revision bigint NOT NULL CHECK(revision=previous_revision+1 AND revision<=9007199254740991),
 state_hash bytea NOT NULL, evaluated_ms bigint NOT NULL CHECK(evaluated_ms BETWEEN 0 AND 8640000000000000),
 valid_until_ms bigint NOT NULL CHECK(valid_until_ms>evaluated_ms AND valid_until_ms<=8640000000000000),
 source jsonb NOT NULL CHECK(octet_length(source::text)<=16777216),
 input jsonb NOT NULL CHECK(octet_length(input::text)<=8388608),
 effects jsonb NOT NULL CHECK(octet_length(effects::text)<=8388608),
 receipt jsonb NOT NULL CHECK(octet_length(receipt::text)<=262144),
 fill_ids uuid[] NOT NULL CHECK(cardinality(fill_ids)<=1000),
 ledger_ids uuid[] NOT NULL CHECK(cardinality(ledger_ids)=cardinality(fill_ids)),
 seal bytea NOT NULL,
 PRIMARY KEY(tenant_id,execution_key), UNIQUE(tenant_id,execution_id), UNIQUE(tenant_id,attempt_id),
 UNIQUE(tenant_id,order_id), UNIQUE(tenant_id,reservation_id), UNIQUE(tenant_id,book_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES ctp_paper.admission_issuance(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,book_id,previous_revision,previous_hash) REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash),
 FOREIGN KEY(tenant_id,book_id,revision,state_hash) REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash) DEFERRABLE INITIALLY DEFERRED
);
-- A native trade identity never acquires a fresh allowance because its book or
-- publication revision changed. The first-transition writer owns it once.
CREATE TABLE ctp_paper.execution_liquidity (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, configuration_id uuid NOT NULL,
 native_identity bytea NOT NULL CHECK(octet_length(native_identity)=32),
 execution_id uuid NOT NULL, frame_before jsonb NOT NULL, frame_after jsonb NOT NULL,
 PRIMARY KEY(tenant_id,account_id,configuration_id,native_identity), UNIQUE(tenant_id,execution_id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES ctp_paper.execution_commit(tenant_id,execution_id)
);
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['execution_commit','execution_liquidity'] LOOP
 EXECUTE format('ALTER TABLE ctp_paper.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE ctp_paper.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY execution_tenant ON ctp_paper.%I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 EXECUTE format('REVOKE ALL ON ctp_paper.%I FROM PUBLIC,ctp_paper_risk_admission',tab);
 EXECUTE format('CREATE TRIGGER execution_immutable BEFORE UPDATE OR DELETE ON ctp_paper.%I FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row()',tab);
 EXECUTE format('CREATE TRIGGER execution_no_truncate BEFORE TRUNCATE ON ctp_paper.%I FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row()',tab);
END LOOP; END $$;

ALTER TABLE ctp_paper.admission_book_event DROP CONSTRAINT admission_book_event_kind_check;
ALTER TABLE ctp_paper.admission_book_event DROP CONSTRAINT admission_book_event_check1;
ALTER TABLE ctp_paper.admission_book_event ADD CONSTRAINT admission_book_event_kind_check CHECK(kind IN('BOOTSTRAP','RESERVE','UNKNOWN','RELEASE','EXECUTE'));
ALTER TABLE ctp_paper.admission_book_event ADD CONSTRAINT admission_book_event_check1 CHECK(
 (kind='BOOTSTRAP' AND revision=1 AND previous_revision=0 AND previous_hash IS NULL AND cause_id=book_id)
 OR (kind IN('RESERVE','UNKNOWN','RELEASE','EXECUTE') AND revision=previous_revision+1 AND octet_length(previous_hash)=32));
ALTER TABLE ctp_portfolio.outbox DROP CONSTRAINT outbox_type_check;
ALTER TABLE ctp_portfolio.outbox ADD CONSTRAINT outbox_type_check CHECK(type IN('FILL','FUNDING','SNAPSHOT','COMMITMENT','RELEASE','GAP','RESOLVE_COMMITMENT','PAPER_EXECUTION'));
ALTER TABLE ctp_portfolio.outbox ADD CONSTRAINT paper_execution_mode CHECK(type<>'PAPER_EXECUTION' OR mode='PAPER');
ALTER TABLE ctp_paper.reservation_state_event DROP CONSTRAINT reservation_state_event_check;
ALTER TABLE ctp_paper.reservation_state_event ADD CONSTRAINT reservation_state_event_check
 CHECK((revision=1 AND status='ACTIVE') OR (revision=2 AND status IN('UNKNOWN','ACTIVE','RELEASED')));

CREATE FUNCTION ctp_paper.execution_commit_seal(x ctp_paper.execution_commit) RETURNS bytea
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT sha256(convert_to((to_jsonb(x)-'seal')::text,'UTF8')) $$;

CREATE FUNCTION ctp_paper.derive_execution_commit() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE p jsonb; validated jsonb; captured jsonb; candidate jsonb; market jsonb; frame jsonb; wm jsonb;
 i ctp_paper.admission_issuance%ROWTYPE; n integer; until_ms bigint;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid
  OR NOT coalesce(ctp_market.snapshot_keys(NEW.request,ARRAY['executionKey','preparationKey','startKey','admission']),false)
  OR NEW.request->>'executionKey' IS DISTINCT FROM NEW.execution_key
  OR (to_jsonb(NEW)-ARRAY['tenant_id','execution_key','request','authorization_epochs']) IS DISTINCT FROM
    jsonb_build_object('execution_id',NULL,'attempt_id',NULL,'reservation_id',NULL,'intent_id',NULL,'order_id',NULL,
     'account_id',NULL,'book_id',NULL,'previous_revision',NULL,'previous_hash',NULL,'revision',NULL,'state_hash',NULL,
     'evaluated_ms',NULL,'valid_until_ms',NULL,'source',NULL,'input',NULL,'effects',NULL,'receipt',NULL,'fill_ids',NULL,'ledger_ids',NULL,'seal',NULL)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 p:=(NEW.request-'executionKey')||jsonb_build_object('kind','PAPER_EXECUTION_START','authorization',NEW.authorization_epochs);
 validated:=ctp_paper.validate_execution_commit(p);NEW.source:=validated->'source';
 captured:=NEW.source->'started'->'capture';candidate:=captured->'candidates'->0;market:=captured->'market';
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=NEW.tenant_id AND intent_id=(candidate->>'intentId')::uuid;
 -- Deliberately narrow first financial transition. Historical/continued books
 -- and multiple contenders must use a future independently certified writer.
 IF NOT FOUND OR (SELECT count(*) FROM ctp_paper.admission_issuance WHERE tenant_id=NEW.tenant_id AND book_id=i.book_id)<>1
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
 SELECT jsonb_build_object('holdId',"holdId",'timestamp',timestamp,'fingerprint',encode(fingerprint,'hex'),'released',released,'unknown',unknown)
 INTO wm FROM ctp_portfolio.hold_watermark WHERE "tenantId"=NEW.tenant_id AND book=i.book_id AND "holdId"=i.response->'debits'->0->>'holdId';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 NEW.evaluated_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 until_ms:=(validated->'validation'->>'validUntil')::bigint;
 NEW.valid_until_ms:=until_ms;
 IF NEW.evaluated_ms>=until_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 frame:=jsonb_build_object('model',captured->'model','record',market->'record','book',market->'book','trade',market->'trade',
  'volumeUsed','0','asksUsed',(SELECT jsonb_agg('0'::text ORDER BY ordinality) FROM jsonb_array_elements(market->'book'->'asks') WITH ORDINALITY),
  'bidsUsed',(SELECT jsonb_agg('0'::text ORDER BY ordinality) FROM jsonb_array_elements(market->'book'->'bids') WITH ORDINALITY));
 NEW.input:=jsonb_build_object('now',NEW.evaluated_ms,'attempt',NEW.source->'started'->'journal'->'state','frame',frame,
  'portfolio',(captured->'portfolio'->>'stateText')::jsonb,
  'original',jsonb_build_object('now',i.created_ms,'model',i.response->'budget'->'model','record',i.response->'budget'->'record',
   'book',i.response->'budget'->'book','trade',i.response->'budget'->'trade'),
  'reservation',jsonb_build_object('id',i.reservation_id::text,'decisionId',i.decision_id::text,'orderId',i.order_id::text,
   'intentId',i.intent_id::text,'revision','1','status','ACTIVE','debits',i.response->'debits','watermarks',jsonb_build_array(wm)));
 NEW.effects:=ctp_paper.derive_pristine_effects(NEW.input);
 IF NEW.effects->'execution'->>'status'='WAITING' THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 NEW.execution_id:=gen_random_uuid();NEW.attempt_id:=(NEW.input->'attempt'->'request'->>'attemptId')::uuid;
 NEW.intent_id:=i.intent_id;NEW.order_id:=i.order_id;NEW.reservation_id:=i.reservation_id;NEW.account_id:=i.account_id;NEW.book_id:=i.book_id;
 NEW.previous_revision:=(captured->'portfolio'->>'revision')::bigint;NEW.previous_hash:=decode(captured->'portfolio'->>'hash','hex');
 NEW.revision:=NEW.previous_revision+1;NEW.state_hash:=sha256(convert_to(ctp_admission.canonical(NEW.effects->'state'),'UTF8'));
 n:=jsonb_array_length(NEW.effects->'fills');
 SELECT coalesce(array_agg(gen_random_uuid() ORDER BY v),'{}'::uuid[]) INTO NEW.fill_ids FROM generate_series(1,n) v;
 SELECT coalesce(array_agg(gen_random_uuid() ORDER BY v),'{}'::uuid[]) INTO NEW.ledger_ids FROM generate_series(1,n) v;
 NEW.receipt:=jsonb_build_object('kind','PAPER_EXECUTION_COMMIT_RECEIPT','version','paper-pristine-execution-v1',
  'executionKey',NEW.execution_key,'executionId',NEW.execution_id::text,'attemptId',NEW.attempt_id::text,'orderId',NEW.order_id::text,
  'intentId',NEW.intent_id::text,'reservationId',NEW.reservation_id::text,'order',(NEW.effects->'order')-'orderId'-'intentId',
  'reservation',(NEW.effects->'reservation')-'id'-'decisionId'-'debits','fillIds',to_jsonb(NEW.fill_ids),'ledgerTransactionIds',to_jsonb(NEW.ledger_ids));
 NEW.seal:=ctp_paper.execution_commit_seal(NEW);
 RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;
CREATE TRIGGER derive_execution_commit BEFORE INSERT ON ctp_paper.execution_commit FOR EACH ROW EXECUTE FUNCTION ctp_paper.derive_execution_commit();

-- Exact 18-place HALF_EVEN projection; no monetary posting uses an average.
CREATE FUNCTION ctp_paper.execution_average(n numeric,q numeric) RETURNS numeric
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE scaled numeric; v numeric; remainder numeric; BEGIN
 IF q=0 THEN RETURN 0; END IF;
 scaled:=n*10::numeric^18;v:=div(scaled,q);remainder:=mod(scaled,q);
 IF remainder*2>q OR (remainder*2=q AND mod(v,2)=1) THEN v:=v+1; END IF;
 RETURN v*0.000000000000000001;
END $$;

CREATE FUNCTION ctp_paper.apply_execution_commit() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE x ctp_paper.execution_commit:=NEW; i ctp_paper.admission_issuance%ROWTYPE;
 fill jsonb; event jsonb; posting jsonb; change jsonb; market jsonb:=x.input->'frame'; native bytea;
 index integer:=0; entry_index integer; fill_id uuid; ledger_id uuid; event_text text; after_text text;
 at_time timestamptz:=to_timestamp(x.evaluated_ms::double precision/1000); notional numeric:=0; summary jsonb;
BEGIN
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=x.tenant_id AND intent_id=x.intent_id;
 native:=sha256(convert_to(ctp_admission.canonical(jsonb_build_object('scope',market->'trade'->'scope',
  'instrumentId',market->'trade'->'instrumentId','identityScope',market->'trade'->'identityScope','tradeId',market->'trade'->'tradeId')),'UTF8'));
 INSERT INTO ctp_paper.execution_liquidity VALUES(x.tenant_id,x.account_id,(x.source->'started'->'capture'->>'configurationId')::uuid,
  native,x.execution_id,market,x.effects->'execution'->'frame');
 FOR fill IN SELECT value FROM jsonb_array_elements(x.effects->'fills') WITH ORDINALITY ORDER BY ordinality LOOP
  index:=index+1;fill_id:=x.fill_ids[index];ledger_id:=x.ledger_ids[index];event:=fill->'event';
  notional:=notional+(event->>'quantity')::numeric*(event->>'price')::numeric;
  INSERT INTO public.fill(id,"tenantId","orderId","accountId",mode,"instrumentId","ruleVersionId",market,"executionIdentity",side,"liquidityRole",
   "baseAsset","quoteAsset",quantity,price,"quoteAmount",timestamp,"receivedAt","evidenceHash")
  VALUES(fill_id,x.tenant_id,x.order_id,x.account_id,'PAPER',(x.input->'attempt'->'request'->'admission'->>'dbInstrumentId')::uuid,i.rule_id,
   'SPOT','paper-fill:'||(fill->>'fillId'),'BUY','TAKER',i.base,i.quote,(event->>'quantity')::numeric,(event->>'price')::numeric,
   trim_scale((event->>'quantity')::numeric*(event->>'price')::numeric),at_time,at_time,sha256(convert_to(ctp_admission.canonical(event),'UTF8')));
  INSERT INTO public.ledger_transaction(id,"tenantId","accountId",mode,cause,"causeIdentity","fillId","effectiveAt","descriptionCode")
   VALUES(ledger_id,x.tenant_id,x.account_id,'PAPER','FILL','paper-fill:'||(fill->>'fillId'),fill_id,at_time,'PAPER_SPOT_BUY_EXECUTION');
  entry_index:=0;
  FOR posting IN SELECT value FROM jsonb_array_elements(fill->'postings') WITH ORDINALITY ORDER BY ordinality LOOP
   INSERT INTO public.ledger_entry("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount)
    VALUES(x.tenant_id,ledger_id,x.account_id,'PAPER',entry_index,posting->>'asset',(posting->>'bucket')::public."LedgerBucket",(posting->>'amount')::numeric);
   entry_index:=entry_index+1;
  END LOOP;
  IF jsonb_array_length(event->'fees')>0 THEN
   INSERT INTO public.fee("tenantId","fillId","accountId",mode,"ledgerTransactionId","feeIdentity",asset,kind,amount,rate,timestamp)
    VALUES(x.tenant_id,fill_id,x.account_id,'PAPER',ledger_id,'paper-fee:'||(fill->>'fillId'),i.quote,'CHARGE',
     (event->'fees'->0->>'amount')::numeric,(market->'model'->>'takerFeeRate')::numeric,at_time);
  END IF;
  event_text:=ctp_admission.canonical(event);
  INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
   VALUES(x.tenant_id,x.book_id,x.account_id,'PAPER',event->>'id',sha256(convert_to(event_text,'UTF8')),event_text,ledger_id);
 END LOOP;
 FOR change IN SELECT value FROM jsonb_array_elements(x.effects->'holdChanges') LOOP
  event:=change->'event';event_text:=ctp_admission.canonical(event);
  INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
   VALUES(x.tenant_id,x.book_id,x.account_id,'PAPER',event->>'id',sha256(convert_to(event_text,'UTF8')),event_text,NULL);
  UPDATE ctp_portfolio.hold_watermark SET timestamp=(change->'watermark'->>'timestamp')::bigint,
   fingerprint=decode(change->'watermark'->>'fingerprint','hex'),released=(change->'watermark'->>'released')::boolean,unknown=false
   WHERE "tenantId"=x.tenant_id AND book=x.book_id AND "holdId"=i.response->'debits'->0->>'holdId';
  IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 END LOOP;
 INSERT INTO ctp_paper.reservation_state_event(tenant_id,reservation_id,intent_id,account_id,mode,event_id,revision,status,observed_ms)
 VALUES(x.tenant_id,x.reservation_id,x.intent_id,x.account_id,'PAPER',x.execution_id,2,x.effects->'reservation'->>'status',x.evaluated_ms);
 after_text:=ctp_admission.canonical(x.effects->'state');
 UPDATE ctp_portfolio.book SET revision=x.revision,state=after_text,state_hash=x.state_hash
  WHERE "tenantId"=x.tenant_id AND id=x.book_id AND revision=x.previous_revision AND state_hash=x.previous_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 INSERT INTO ctp_paper.admission_book_event(tenant_id,account_id,book_id,revision,cause_id,kind,previous_revision,previous_hash,state_text,state_hash)
  VALUES(x.tenant_id,x.account_id,x.book_id,x.revision,x.execution_id,'EXECUTE',x.previous_revision,x.previous_hash,after_text,x.state_hash);
 UPDATE ctp_paper.admission_book_head SET revision=x.revision,state_hash=x.state_hash WHERE tenant_id=x.tenant_id AND book_id=x.book_id;
 summary:=jsonb_build_object('id','paper-execution:'||x.execution_id::text,'type','PAPER_EXECUTION','timestamp',x.evaluated_ms,
  'executionId',x.execution_id::text,'stateHash',encode(x.state_hash,'hex'),'fillIds',x.receipt->'fillIds');
 event_text:=ctp_admission.canonical(summary);
 INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
  VALUES(x.tenant_id,x.book_id,x.account_id,'PAPER',summary->>'id',sha256(convert_to(event_text,'UTF8')),event_text,NULL);
 INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId")
  VALUES(x.tenant_id,x.book_id,x.account_id,'PAPER',x.revision,'PAPER_EXECUTION',summary->>'id');
 UPDATE public."order" SET status=(x.effects->'order'->>'status')::public."OrderStatus","reconciliationState"='CONSISTENT',version=1,
  "filledQuantity"=(x.effects->'order'->>'executedQuantity')::numeric,
  "averageFillPrice"=trim_scale(ctp_paper.execution_average(notional,(x.effects->'order'->>'executedQuantity')::numeric)),
  "terminalAt"=CASE WHEN x.effects->'order'->>'status' IN('FILLED','EXPIRED') THEN at_time ELSE NULL END,"updatedAt"=at_time
  WHERE "tenantId"=x.tenant_id AND id=x.order_id AND status='CREATED' AND version=0 AND "filledQuantity"=0;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 INSERT INTO public.order_event("tenantId","orderId",version,"previousStatus",status,source,"sourceIdentity","evidenceHash","occurredAt")
  VALUES(x.tenant_id,x.order_id,1,'CREATED',(x.effects->'order'->>'status')::public."OrderStatus",'PAPER_EXECUTION',x.execution_id::text,x.seal,at_time);
 INSERT INTO public.outbox_event("tenantId","eventType","schemaVersion","aggregateType","aggregateId","aggregateVersion",payload,"occurredAt")
  VALUES(x.tenant_id,'PaperOrderExecuted',1,'Order',x.order_id,1,x.receipt,at_time);
 IF floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=x.valid_until_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 SET CONSTRAINTS public.ledger_header_conservation,public.ledger_entry_conservation IMMEDIATE;
 RETURN NULL;
END $$;
CREATE TRIGGER apply_execution_commit AFTER INSERT ON ctp_paper.execution_commit FOR EACH ROW EXECUTE FUNCTION ctp_paper.apply_execution_commit();

CREATE FUNCTION ctp_paper.validate_committed_execution(t uuid,k text) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE x ctp_paper.execution_commit%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE; s ctp_paper.attempt_start%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; previous ctp_paper.admission_book_event%ROWTYPE; e ctp_paper.admission_book_event%ROWTYPE;
 o public."order"%ROWTYPE; r public.risk_reservation%ROWTYPE; j ctp_paper.reservation_state_event%ROWTYPE;
 wm ctp_portfolio.hold_watermark%ROWTYPE; f public.fill%ROWTYPE; l public.ledger_transaction%ROWTYPE; fee public.fee%ROWTYPE;
 item jsonb; event jsonb; change jsonb; event_payload text; expected jsonb; n integer:=0; notional numeric:=0; native bytea;
BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_key=k;
 IF NOT FOUND OR x.seal IS DISTINCT FROM ctp_paper.execution_commit_seal(x)
  OR x.effects IS DISTINCT FROM ctp_paper.derive_pristine_effects(x.input)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND reservation_id=x.reservation_id;
 IF NOT FOUND OR ROW(i.order_id,i.intent_id,i.account_id,i.book_id) IS DISTINCT FROM ROW(x.order_id,x.intent_id,x.account_id,x.book_id)
  OR i.request IS DISTINCT FROM x.request->'admission' OR i.response_hash<>sha256(convert_to(i.response::text,'UTF8'))
  OR i.source_hash<>sha256(convert_to(i.source::text,'UTF8'))
  OR (SELECT count(*) FROM ctp_paper.admission_issuance WHERE tenant_id=t AND book_id=x.book_id)<>1
  OR EXISTS(SELECT 1 FROM ctp_paper.admission_unknown_event WHERE tenant_id=t AND reservation_id=x.reservation_id)
  OR EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND reservation_id=x.reservation_id)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO s FROM ctp_paper.attempt_start WHERE tenant_id=t AND attempt_id=x.attempt_id;
 IF NOT FOUND OR s.request IS DISTINCT FROM x.request-'executionKey' OR s.state IS DISTINCT FROM x.input->'attempt'
  OR s.state_hash<>sha256(convert_to(s.state::text,'UTF8')) OR s.response_hash<>sha256(convert_to(s.response::text,'UTF8'))
  OR s.reservation_id<>x.reservation_id OR s.intent_id<>x.intent_id OR s.started_ms>x.evaluated_ms
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO previous FROM ctp_paper.admission_book_event WHERE tenant_id=t AND book_id=x.book_id AND revision=x.previous_revision;
 IF NOT FOUND OR previous.state_hash<>x.previous_hash OR previous.state_text IS DISTINCT FROM i.response->'portfolio'->>'afterText'
  OR previous.state_text::jsonb IS DISTINCT FROM x.input->'portfolio'
  OR x.input->'original' IS DISTINCT FROM jsonb_build_object('now',i.created_ms,'model',i.response->'budget'->'model',
   'record',i.response->'budget'->'record','book',i.response->'budget'->'book','trade',i.response->'budget'->'trade')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO e FROM ctp_paper.admission_book_event WHERE tenant_id=t AND book_id=x.book_id AND revision=x.revision;
 IF NOT FOUND OR ROW(e.account_id,e.cause_id,e.kind,e.previous_revision,e.previous_hash,e.state_hash,e.state_text)
  IS DISTINCT FROM ROW(x.account_id,x.execution_id,'EXECUTE'::text,x.previous_revision,x.previous_hash,x.state_hash,ctp_admission.canonical(x.effects->'state'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=x.book_id;
 IF NOT FOUND OR ROW(b."accountId",b.mode,b.revision,b.state_hash,b.state) IS DISTINCT FROM ROW(x.account_id,'PAPER'::public."TradingMode",x.revision,x.state_hash,e.state_text)
  OR NOT EXISTS(SELECT 1 FROM ctp_paper.admission_book_head WHERE tenant_id=t AND book_id=x.book_id AND revision=x.revision AND state_hash=x.state_hash)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO r FROM public.risk_reservation WHERE "tenantId"=t AND id=x.reservation_id;
 IF NOT FOUND OR ROW(r."intentId",r."accountId",r."decisionId",r.mode,r.status,r.version,r."consumedAmount",r."vectorSize",r."paperLegacy")
  IS DISTINCT FROM ROW(x.intent_id,x.account_id,i.decision_id,'PAPER'::public."TradingMode",'ACTIVE'::public."ReservationStatus",0,0::numeric,1,false)
  OR r.asset IS NOT NULL OR r.amount IS NOT NULL OR r."budgetId" IS NOT NULL OR r."releasedAt" IS NOT NULL
  OR (SELECT count(*) FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=x.reservation_id)<>2
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO j FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=x.reservation_id AND revision=2;
 IF NOT FOUND OR ROW(j.intent_id,j.account_id,j.event_id,j.status,j.observed_ms)
  IS DISTINCT FROM ROW(x.intent_id,x.account_id,x.execution_id,x.effects->'reservation'->>'status',x.evaluated_ms)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 change:=x.effects->'holdChanges'->0;
 SELECT * INTO wm FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=x.book_id AND "holdId"=i.response->'debits'->0->>'holdId';
 IF NOT FOUND OR jsonb_build_object('timestamp',wm.timestamp,'fingerprint',encode(wm.fingerprint,'hex'),'released',wm.released,'unknown',wm.unknown)
  IS DISTINCT FROM change->'watermark' OR (SELECT count(*) FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=x.book_id)<>1
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 event:=change->'event';event_payload:=ctp_admission.canonical(event);
 IF NOT EXISTS(SELECT 1 FROM ctp_portfolio.evidence v WHERE v."tenantId"=t AND v.book=x.book_id AND v.id=event->>'id'
  AND v.payload=event_payload AND v.fingerprint=sha256(convert_to(v.payload,'UTF8')) AND v.ledger IS NULL)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(x.effects->'fills') WITH ORDINALITY ORDER BY ordinality LOOP
  n:=n+1;event:=item->'event';notional:=notional+(event->>'quantity')::numeric*(event->>'price')::numeric;
  SELECT * INTO f FROM public.fill WHERE "tenantId"=t AND id=x.fill_ids[n];
  IF NOT FOUND OR ROW(f."orderId",f."accountId",f.mode,f."instrumentId",f."ruleVersionId",f."tradeId",f.market,f."executionIdentity",f."exchangeTradeId",f.side,f."liquidityRole",f."baseAsset",f."quoteAsset",f.quantity,f.price,f."quoteAmount",f.timestamp,f."receivedAt",f."evidenceHash")
   IS DISTINCT FROM ROW(x.order_id,x.account_id,'PAPER'::public."TradingMode",(x.input->'attempt'->'request'->'admission'->>'dbInstrumentId')::uuid,
    i.rule_id,NULL::uuid,'SPOT'::public."MarketType",'paper-fill:'||(item->>'fillId'),NULL::varchar,'BUY'::public."OrderSide",'TAKER'::public."LiquidityRole",
    i.base::varchar,i.quote::varchar,(event->>'quantity')::numeric,(event->>'price')::numeric,(event->>'quantity')::numeric*(event->>'price')::numeric,
    to_timestamp(x.evaluated_ms::double precision/1000),to_timestamp(x.evaluated_ms::double precision/1000),sha256(convert_to(ctp_admission.canonical(event),'UTF8')))
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  SELECT * INTO l FROM public.ledger_transaction WHERE "tenantId"=t AND id=x.ledger_ids[n];
  IF NOT FOUND OR ROW(l."accountId",l.mode,l.cause,l."causeIdentity",l."fillId",l."fundingPaymentId",l."correctionOfId",l."effectiveAt",l."descriptionCode")
   IS DISTINCT FROM ROW(x.account_id,'PAPER'::public."TradingMode",'FILL'::public."LedgerCause",'paper-fill:'||(item->>'fillId'),f.id,NULL::uuid,NULL::uuid,
    to_timestamp(x.evaluated_ms::double precision/1000),'PAPER_SPOT_BUY_EXECUTION'::varchar)
   OR NOT EXISTS(SELECT 1 FROM ctp_internal.ledger_seal WHERE "tenantId"=t AND "transactionId"=l.id)
   OR (SELECT jsonb_agg(jsonb_build_object('asset',asset,'bucket',bucket::text,'amount',trim_scale(amount)::text) ORDER BY "entryIndex")
       FROM public.ledger_entry WHERE "tenantId"=t AND "transactionId"=l.id) IS DISTINCT FROM item->'postings'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF jsonb_array_length(event->'fees')=0 THEN
   IF EXISTS(SELECT 1 FROM public.fee WHERE "tenantId"=t AND "fillId"=f.id) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  ELSE
   SELECT * INTO fee FROM public.fee WHERE "tenantId"=t AND "fillId"=f.id;
   IF NOT FOUND OR (SELECT count(*) FROM public.fee WHERE "tenantId"=t AND "fillId"=f.id)<>1
    OR ROW(fee."accountId",fee.mode,fee."ledgerTransactionId",fee."feeIdentity",fee.asset,fee.kind,fee.amount,fee.rate,fee.timestamp)
    IS DISTINCT FROM ROW(x.account_id,'PAPER'::public."TradingMode",l.id,'paper-fee:'||(item->>'fillId'),i.quote::varchar,'CHARGE'::public."FeeKind",
     (event->'fees'->0->>'amount')::numeric,(x.input->'frame'->'model'->>'takerFeeRate')::numeric,to_timestamp(x.evaluated_ms::double precision/1000))
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  END IF;
  event_payload:=ctp_admission.canonical(event);
  IF NOT EXISTS(SELECT 1 FROM ctp_portfolio.evidence v WHERE v."tenantId"=t AND v.book=x.book_id AND v.id=event->>'id'
   AND v.payload=event_payload AND v.fingerprint=sha256(convert_to(v.payload,'UTF8')) AND v.ledger=l.id)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.fill WHERE "tenantId"=t AND "accountId"=x.account_id AND mode='PAPER')<>n
  OR (SELECT count(*) FROM public.ledger_transaction WHERE "tenantId"=t AND "fillId"=ANY(x.fill_ids))<>n
  OR EXISTS(SELECT 1 FROM public.ledger_transaction v WHERE v."tenantId"=t AND v."accountId"=x.account_id AND v.mode='PAPER'
   AND NOT(v.id=ANY(x.ledger_ids)) AND NOT EXISTS(SELECT 1 FROM ctp_paper.initial_funding seed_funding WHERE seed_funding.tenant_id=t AND seed_funding.account_id=x.account_id AND seed_funding.ledger_id=v.id))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=x.order_id;
 IF NOT FOUND OR ROW(o."accountId",o.mode,o."intentId",o.status,o."reconciliationState",o.version,o."filledQuantity",o."averageFillPrice",o."exchangeOrderId",o."lastExchangeAt",o."terminalAt")
  IS DISTINCT FROM ROW(x.account_id,'PAPER'::public."TradingMode",x.intent_id,(x.effects->'order'->>'status')::public."OrderStatus",'CONSISTENT'::public."ReconciliationState",1,
   (x.effects->'order'->>'executedQuantity')::numeric,ctp_paper.execution_average(notional,(x.effects->'order'->>'executedQuantity')::numeric),NULL::varchar,NULL::timestamptz,
   CASE WHEN x.effects->'order'->>'status' IN('FILLED','EXPIRED') THEN to_timestamp(x.evaluated_ms::double precision/1000) ELSE NULL END)
  OR NOT EXISTS(SELECT 1 FROM public.order_event WHERE "tenantId"=t AND "orderId"=x.order_id AND version=1 AND "previousStatus"='CREATED'
   AND status=o.status AND source='PAPER_EXECUTION' AND "sourceIdentity"=x.execution_id::text AND "evidenceHash"=x.seal AND "attemptId" IS NULL
   AND "occurredAt"=to_timestamp(x.evaluated_ms::double precision/1000))
  OR (SELECT count(*) FROM public.order_event WHERE "tenantId"=t AND "orderId"=x.order_id)<>2
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 native:=sha256(convert_to(ctp_admission.canonical(jsonb_build_object('scope',x.input->'frame'->'trade'->'scope',
  'instrumentId',x.input->'frame'->'trade'->'instrumentId','identityScope',x.input->'frame'->'trade'->'identityScope','tradeId',x.input->'frame'->'trade'->'tradeId')),'UTF8'));
 IF NOT EXISTS(SELECT 1 FROM ctp_paper.execution_liquidity WHERE tenant_id=t AND account_id=x.account_id AND execution_id=x.execution_id
  AND configuration_id=(x.source->'started'->'capture'->>'configurationId')::uuid AND native_identity=native
  AND frame_before=x.input->'frame' AND frame_after=x.effects->'execution'->'frame')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 expected:=jsonb_build_object('kind','PAPER_EXECUTION_COMMIT_RECEIPT','version','paper-pristine-execution-v1',
  'executionKey',x.execution_key,'executionId',x.execution_id::text,'attemptId',x.attempt_id::text,'orderId',x.order_id::text,
  'intentId',x.intent_id::text,'reservationId',x.reservation_id::text,'order',(x.effects->'order')-'orderId'-'intentId',
  'reservation',(x.effects->'reservation')-'id'-'decisionId'-'debits','fillIds',to_jsonb(x.fill_ids),'ledgerTransactionIds',to_jsonb(x.ledger_ids));
 IF x.receipt IS DISTINCT FROM expected THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
END $$;

CREATE FUNCTION ctp_paper.execution_commit(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; sem jsonb; x ctp_paper.execution_commit%ROWTYPE;
BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','executionKey','preparationKey','startKey','admission','authorization']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_EXECUTION_COMMIT' OR octet_length(p::text)>16384
  OR jsonb_typeof(p->'executionKey') IS DISTINCT FROM 'string' OR p->>'executionKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 t:=ctp_paper.execution_start_auth((p-'executionKey')||jsonb_build_object('kind','PAPER_EXECUTION_START'));
 sem:=p-'kind'-'authorization';
 SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_key=p->>'executionKey';
 IF FOUND THEN
  IF x.request IS DISTINCT FROM sem THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM ctp_paper.execution_commit WHERE tenant_id=t AND intent_id=(p->'admission'->>'intentId')::uuid)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF read_only THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
  INSERT INTO ctp_paper.execution_commit(tenant_id,execution_key,request,authorization_epochs)
   VALUES(t,p->>'executionKey',sem,p->'authorization') RETURNING * INTO x;
 END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 PERFORM ctp_paper.validate_committed_execution(t,x.execution_key);
 RETURN jsonb_build_object('kind','COMMITTED','request',p,'authorization',x.authorization_epochs,'evaluatedAt',x.evaluated_ms,
  'source',x.source,'input',x.input,'effects',x.effects,'receipt',x.receipt);
END $$;


-- Retained pre-execution guard bodies, with one authenticated execution branch.
CREATE OR REPLACE FUNCTION ctp_paper.check_reservation_state() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.risk_reservation%ROWTYPE;
 previous ctp_paper.reservation_state_event%ROWTYPE;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_SCOPE' USING ERRCODE='23514';
 END IF;
 -- This is storage serialization, not the GLOBAL/tenant/account Risk lock set.
 -- A future certified writer must acquire the full shared lock order first.
 SELECT * INTO r FROM public.risk_reservation
  WHERE "tenantId"=NEW.tenant_id AND id=NEW.reservation_id FOR UPDATE;
 IF NOT FOUND OR r.mode<>'PAPER' OR r."paperLegacy" OR r."vectorSize" IS NULL
  OR ROW(NEW.intent_id,NEW.account_id,NEW.mode) IS DISTINCT FROM ROW(r."intentId",r."accountId",r.mode)
  OR (SELECT count(*) FROM ctp_paper.reservation_debit WHERE tenant_id=r."tenantId" AND reservation_id=r.id)<>r."vectorSize" THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_SCOPE' USING ERRCODE='23514';
 END IF;
 IF NEW.observed_ms IS NULL OR NEW.observed_ms<0 OR NEW.observed_ms>8640000000000000
  OR NEW.observed_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_INPUT' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM ctp_paper.reservation_state_event
  WHERE tenant_id=NEW.tenant_id AND reservation_id=NEW.reservation_id ORDER BY revision DESC LIMIT 1;
 IF FOUND THEN
  IF previous.revision<>1 OR NEW.revision IS DISTINCT FROM 2::smallint
   OR (NEW.status IS DISTINCT FROM 'UNKNOWN' AND NOT EXISTS(
    SELECT 1 FROM ctp_paper.execution_commit x WHERE x.tenant_id=NEW.tenant_id AND x.reservation_id=NEW.reservation_id
     AND x.execution_id=NEW.event_id AND x.evaluated_ms=NEW.observed_ms AND x.effects->'reservation'->>'status'=NEW.status)) OR NEW.observed_ms<=previous.observed_ms THEN
   RAISE EXCEPTION 'PAPER_RESERVATION_STATE_ORDERING' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.revision IS DISTINCT FROM 1::smallint OR NEW.status IS DISTINCT FROM 'ACTIVE'
   OR NEW.observed_ms<floor(extract(epoch FROM r."createdAt")*1000)::bigint THEN
   RAISE EXCEPTION 'PAPER_RESERVATION_STATE_ORDERING' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ctp_paper.check_admission_book() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE raw jsonb; t uuid; target_book uuid; h ctp_paper.admission_book_head%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 w ctp_portfolio.hold_watermark%ROWTYPE; r public.risk_reservation%ROWTYPE;
 d ctp_paper.reservation_debit%ROWTYPE; hold jsonb; actual_hold jsonb; n integer:=0;
 u ctp_paper.admission_unknown_event%ROWTYPE; j ctp_paper.reservation_state_event%ROWTYPE;
 expected_status text; expected_time bigint; live_n integer:=0;
BEGIN
 raw:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 t:=coalesce(raw->>'tenant_id',raw->>'tenantId')::uuid;
 IF TG_TABLE_NAME='risk_reservation' OR TG_TABLE_NAME='reservation_state_event' THEN
  SELECT book_id INTO target_book FROM ctp_paper.admission_issuance WHERE tenant_id=t
   AND reservation_id=coalesce(raw->>'reservation_id',raw->>'id')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
 ELSE
  target_book:=coalesce(raw->>'book_id',raw->>'book',raw->>'id')::uuid;
 END IF;
 SELECT * INTO h FROM ctp_paper.admission_book_head WHERE tenant_id=t AND book_id=target_book;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=target_book;
 IF NOT FOUND OR b.revision<>h.revision OR b.state_hash<>h.state_hash
  OR b.state_hash<>sha256(convert_to(b.state,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_paper.execution_commit WHERE tenant_id=t AND book_id=target_book) THEN
  PERFORM ctp_paper.validate_committed_execution(t,execution_key) FROM ctp_paper.execution_commit WHERE tenant_id=t AND book_id=target_book;
  RETURN NULL;
 END IF;
 FOR i IN SELECT * FROM ctp_paper.admission_issuance WHERE tenant_id=t AND book_id=target_book LOOP
  n:=n+1;
  SELECT * INTO r FROM public.risk_reservation WHERE "tenantId"=t AND id=i.reservation_id;
  IF NOT FOUND OR r.status<>'ACTIVE' OR r.version<>0 OR r."consumedAmount"<>0 OR r."releasedAt" IS NOT NULL
   OR r."vectorSize" IS DISTINCT FROM 1 OR r."paperLegacy" OR r.asset IS NOT NULL OR r.amount IS NOT NULL
   OR r."budgetId" IS NOT NULL OR r."decisionId"<>i.decision_id OR r."intentId"<>i.intent_id OR r."accountId"<>i.account_id
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
  SELECT * INTO d FROM ctp_paper.reservation_debit WHERE tenant_id=t AND reservation_id=r.id AND ordinal=1;
  IF NOT FOUND OR i.response->'debits'->0 IS DISTINCT FROM jsonb_build_object('asset',d.asset,'amount',trim_scale(d.amount)::text,'holdId',d.hold_id::text)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM ctp_paper.withdrawal_release x WHERE x.tenant_id=t AND x.reservation_id=r.id) THEN
   PERFORM ctp_paper.validate_withdrawal_release(t,r.id); CONTINUE;
  END IF;
  live_n:=live_n+1;
  SELECT * INTO u FROM ctp_paper.admission_unknown_event WHERE tenant_id=t AND reservation_id=r.id;
  IF FOUND THEN
   expected_status:='UNKNOWN'; expected_time:=u.observed_ms;
   IF ROW(u.intent_id,u.account_id,u.book_id) IS DISTINCT FROM ROW(i.intent_id,i.account_id,i.book_id)
    OR u.request->'admission' IS DISTINCT FROM i.request OR u.request->>'reservationId' IS DISTINCT FROM r.id::text
    OR u.request->>'eventId' IS DISTINCT FROM u.event_id::text
    OR u.response_hash<>sha256(convert_to(u.response::text,'UTF8'))
    OR NOT EXISTS(SELECT 1 FROM ctp_paper.admission_book_event e WHERE e.tenant_id=t AND e.book_id=target_book
     AND e.revision=u.book_revision AND e.state_hash=u.book_hash AND e.kind='UNKNOWN' AND e.cause_id=u.event_id
     AND e.state_text=u.response->'portfolio'->>'afterText')
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
  ELSE expected_status:='RESERVED'; expected_time:=i.created_ms; END IF;
  SELECT * INTO j FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=r.id ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND OR j.observed_ms<>expected_time
   OR (expected_status='RESERVED' AND (j.status<>'ACTIVE' OR j.revision<>1))
   OR (expected_status='UNKNOWN' AND (j.status<>'UNKNOWN' OR j.revision<>2 OR j.event_id<>u.event_id))
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
  hold:=jsonb_build_object('id',d.hold_id::text,'asset',d.asset,'amount',trim_scale(d.amount)::text,'status',expected_status,'reflected',false);
  SELECT value INTO actual_hold FROM jsonb_array_elements(b.state::jsonb->'holds') WHERE value->>'id'=d.hold_id::text;
  IF NOT FOUND OR actual_hold IS DISTINCT FROM hold THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
  SELECT * INTO w FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=target_book AND "holdId"=d.hold_id::text;
  IF NOT FOUND OR w.timestamp<>expected_time OR w.released OR w.unknown IS DISTINCT FROM (expected_status='UNKNOWN')
   OR w.fingerprint<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8'))
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF jsonb_array_length(b.state::jsonb->'holds')<>live_n
  OR (SELECT count(*) FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=target_book)<>n
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION ctp_paper.check_execution_cause() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE raw jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 t uuid; a uuid; x ctp_paper.execution_commit%ROWTYPE; b uuid;
BEGIN
 t:=coalesce(raw->>'tenant_id',raw->>'tenantId')::uuid;
 IF TG_TABLE_SCHEMA='ctp_paper' AND TG_TABLE_NAME='execution_commit' THEN
  PERFORM ctp_paper.validate_committed_execution(t,raw->>'execution_key');RETURN NULL;
 END IF;
 IF TG_TABLE_SCHEMA='ctp_paper' AND TG_TABLE_NAME='execution_liquidity' THEN
  SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_id=(raw->>'execution_id')::uuid;
 ELSE
  IF raw->>'mode' IS DISTINCT FROM 'PAPER' THEN RETURN NULL; END IF;
  a:=(raw->>'accountId')::uuid;
  SELECT book INTO b FROM ctp_paper.book_origin WHERE tenant_id=t AND account_id=a;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM ctp_paper.admission_book_head WHERE tenant_id=t AND book_id=b) THEN RETURN NULL; END IF;
  SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND account_id=a;
  IF NOT FOUND THEN
   IF TG_TABLE_NAME IN('fill','fee') OR (TG_TABLE_NAME='ledger_transaction' AND raw->>'cause'='FILL')
    OR (TG_TABLE_NAME='ledger_entry' AND EXISTS(SELECT 1 FROM public.ledger_transaction WHERE "tenantId"=t AND id=(raw->>'transactionId')::uuid AND cause='FILL'))
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
   RETURN NULL;
  END IF;
 END IF;
 IF x.execution_id IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 PERFORM ctp_paper.validate_committed_execution(t,x.execution_key);RETURN NULL;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['execution_commit','execution_liquidity'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER paper_execution_cause AFTER INSERT ON ctp_paper.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_execution_cause()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['fill','fee','ledger_transaction','ledger_entry','order'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER paper_execution_cause AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_execution_cause()',tab);
 END LOOP;
END $$;
ALTER FUNCTION ctp_paper.evaluate_and_reserve(jsonb) RENAME TO evaluate_and_reserve_v65;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v65;
CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_EXECUTION_COMMIT' THEN
  IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
  RETURN ctp_paper.execution_commit(p,false);
 END IF;
 RETURN ctp_paper.evaluate_and_reserve_v65(p);
END $$;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_EXECUTION_COMMIT' THEN
  IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
  RETURN ctp_paper.execution_commit(p,true);
 END IF;
 RETURN ctp_paper.reconcile_admission_v65(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.validate_execution_commit(jsonb),ctp_paper.execution_commit_seal(ctp_paper.execution_commit),
 ctp_paper.derive_execution_commit(),ctp_paper.execution_average(numeric,numeric),ctp_paper.apply_execution_commit(),
 ctp_paper.validate_committed_execution(uuid,text),ctp_paper.execution_commit(jsonb,boolean),ctp_paper.check_execution_cause(),
 ctp_paper.check_admission_book(),ctp_paper.check_reservation_state(),ctp_paper.evaluate_and_reserve_v65(jsonb),
 ctp_paper.reconcile_admission_v65(jsonb),ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb)
 FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
