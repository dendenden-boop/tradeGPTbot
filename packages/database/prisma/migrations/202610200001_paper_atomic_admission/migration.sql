BEGIN;
-- Candidate PHASE13 authority. Published1-52 and native financial functions stay
-- unchanged. No runtime login, application composition or dispatch is enabled.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_risk_admission') THEN
 CREATE ROLE ctp_paper_risk_admission NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_risk_admission;
CREATE SEQUENCE ctp_paper.admission_revision AS bigint MINVALUE 1 NO CYCLE;
CREATE SEQUENCE ctp_paper.admission_capability_version AS bigint MINVALUE 1 MAXVALUE 2147483647 NO CYCLE;
LOCK TABLE public.capability_snapshot IN SHARE ROW EXCLUSIVE MODE;
SELECT setval('ctp_paper.admission_capability_version',greatest(1,coalesce(max(version),0)::bigint+1),false)
 FROM public.capability_snapshot WHERE mode='PAPER';
REVOKE ALL ON SEQUENCE ctp_paper.admission_revision,ctp_paper.admission_capability_version FROM PUBLIC;

CREATE TABLE ctp_paper.admission_issuance (
 tenant_id uuid NOT NULL, intent_id uuid NOT NULL, order_id uuid NOT NULL, account_id uuid NOT NULL,
 mode public."TradingMode" NOT NULL DEFAULT 'PAPER' CHECK(mode='PAPER'),
 decision_id uuid NOT NULL, reservation_id uuid NOT NULL, certificate_id uuid NOT NULL,
 state_id uuid NOT NULL, capability_id uuid NOT NULL, rule_id uuid NOT NULL, book_id uuid NOT NULL,
 instrument text NOT NULL, base text NOT NULL, quote text NOT NULL,
 notional numeric NOT NULL CHECK(notional>0 AND notional<10::numeric^20 AND scale(notional)<=18),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=8192),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=4194304),
 response_hash bytea NOT NULL CHECK(response_hash=sha256(convert_to(response::text,'UTF8'))),
 source jsonb NOT NULL CHECK(octet_length(source::text)<=4194304),
 source_hash bytea NOT NULL CHECK(source_hash=sha256(convert_to(source::text,'UTF8'))),
 created_ms bigint NOT NULL CHECK(created_ms BETWEEN 0 AND 8640000000000000),
 PRIMARY KEY(tenant_id,intent_id), UNIQUE(tenant_id,reservation_id), UNIQUE(tenant_id,certificate_id),
 FOREIGN KEY(tenant_id,decision_id,intent_id,account_id,mode)
  REFERENCES public.risk_decision("tenantId",id,"intentId","accountId",mode),
 FOREIGN KEY(tenant_id,reservation_id,intent_id,account_id,mode)
  REFERENCES public.risk_reservation("tenantId",id,"intentId","accountId",mode),
 FOREIGN KEY(tenant_id,order_id,account_id,mode)
  REFERENCES public."order"("tenantId",id,"accountId",mode),
 FOREIGN KEY(tenant_id,book_id,account_id,mode)
  REFERENCES ctp_portfolio.book("tenantId",id,"accountId",mode)
);
CREATE INDEX admission_current_account ON ctp_paper.admission_issuance(tenant_id,account_id,reservation_id);

CREATE TABLE ctp_paper.admission_book_event (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, book_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 cause_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN('BOOTSTRAP','RESERVE')),
 previous_revision bigint NOT NULL, previous_hash bytea,
 state_text text NOT NULL CHECK(octet_length(state_text)<=1048576),
 state_hash bytea NOT NULL CHECK(state_hash=sha256(convert_to(state_text,'UTF8'))),
 mode public."TradingMode" NOT NULL DEFAULT 'PAPER' CHECK(mode='PAPER'),
 CHECK((kind='BOOTSTRAP' AND revision=1 AND previous_revision=0 AND previous_hash IS NULL AND cause_id=book_id)
  OR (kind='RESERVE' AND revision=previous_revision+1 AND octet_length(previous_hash)=32)),
 PRIMARY KEY(tenant_id,book_id,revision), UNIQUE(tenant_id,cause_id),
 UNIQUE(tenant_id,book_id,revision,state_hash),
 FOREIGN KEY(tenant_id,book_id,previous_revision,previous_hash)
  REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash),
 FOREIGN KEY(tenant_id,book_id,account_id,mode) REFERENCES ctp_portfolio.book("tenantId",id,"accountId",mode)
);
CREATE TABLE ctp_paper.admission_book_head (
 tenant_id uuid NOT NULL, book_id uuid NOT NULL, revision bigint NOT NULL, state_hash bytea NOT NULL,
 PRIMARY KEY(tenant_id,book_id),
 FOREIGN KEY(tenant_id,book_id,revision,state_hash)
  REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash)
);
CREATE TABLE ctp_paper.admission_genesis (
 tenant_id uuid PRIMARY KEY REFERENCES public."user"(id), id uuid NOT NULL UNIQUE,
 funding_id uuid NOT NULL REFERENCES ctp_paper.initial_funding(id),
 asset text NOT NULL, initial_capital numeric NOT NULL CHECK(initial_capital>0 AND initial_capital<10::numeric^20),
 started_ms bigint NOT NULL CHECK(started_ms BETWEEN 0 AND 8640000000000000)
);
CREATE FUNCTION ctp_paper.admission_monotonic_head() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.tenant_id,NEW.book_id) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.book_id)
  OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION ctp_paper.admission_inventory(p jsonb,ts bigint) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid:=(p->'binding'->>'tenantId')::uuid; target uuid:=(p->'binding'->>'accountId')::uuid;
 ids uuid[]; a uuid; b jsonb; cfg jsonb; funding jsonb; state jsonb; target_book jsonb;
 books jsonb:='[]'; balances jsonb:='[]'; holds jsonb:='[]'; reservations jsonb:='[]'; orders jsonb:='[]';
 quote text; common_quote text; i ctp_paper.admission_issuance%ROWTYPE; d ctp_paper.reservation_debit%ROWTYPE;
 r public.risk_reservation%ROWTYPE; j ctp_paper.reservation_state_event%ROWTYPE; w ctp_portfolio.hold_watermark%ROWTYPE;
 hold jsonb; event jsonb; actual_hold jsonb; total integer:=0; account_holds integer; n integer;
BEGIN
 -- The caller already holds GLOBAL -> tenant -> user. Lock the complete exact
 -- PAPER account catalog in sorted order, closing FK insertion phantoms.
 SELECT array_agg(id ORDER BY id) INTO ids FROM(SELECT id FROM public.exchange_account
  WHERE "tenantId"=t AND mode='PAPER' ORDER BY id LIMIT 101) q;
 IF ids IS NULL OR NOT(target=ANY(ids)) OR cardinality(ids)>100 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."order" WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' AND status<>'ACTIVE')
 OR EXISTS(SELECT 1 FROM public.ledger_transaction x WHERE x."tenantId"=t AND x.mode='PAPER' AND NOT EXISTS(
  SELECT 1 FROM ctp_paper.initial_funding f WHERE f.tenant_id=t AND f.account_id=x."accountId" AND f.ledger_id=x.id AND f.mode=x.mode))
 OR EXISTS(SELECT 1 FROM public.ledger_entry x WHERE x."tenantId"=t AND x.mode='PAPER' AND NOT EXISTS(
  SELECT 1 FROM ctp_paper.initial_funding f WHERE f.tenant_id=t AND f.account_id=x."accountId" AND f.ledger_id=x."transactionId" AND f.mode=x.mode))
 OR EXISTS(SELECT 1 FROM public.fill WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.position WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.trade WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.funding_payment WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.asset_valuation WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.balance_snapshot WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.algo_order WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.paper_account WHERE "tenantId"=t)
 OR EXISTS(SELECT 1 FROM public.paper_order WHERE "tenantId"=t)
 OR EXISTS(SELECT 1 FROM public.paper_position WHERE "tenantId"=t)
 OR EXISTS(SELECT 1 FROM public.account_state_version s WHERE s."tenantId"=t AND s.mode='PAPER'
  AND NOT EXISTS(SELECT 1 FROM ctp_paper.admission_issuance x WHERE x.tenant_id=t AND x.state_id=s.id AND x.account_id=s."accountId"))
 OR EXISTS(SELECT 1 FROM public.risk_decision s WHERE s."tenantId"=t AND s.mode='PAPER'
  AND NOT EXISTS(SELECT 1 FROM ctp_paper.admission_issuance x WHERE x.tenant_id=t AND x.decision_id=s.id AND x.account_id=s."accountId"))
 OR EXISTS(SELECT 1 FROM public.risk_reservation s WHERE s."tenantId"=t AND s.mode='PAPER'
  AND (s."paperLegacy" OR s.status<>'ACTIVE' OR s."vectorSize" IS DISTINCT FROM 1 OR NOT EXISTS(
   SELECT 1 FROM ctp_paper.admission_issuance x WHERE x.tenant_id=t AND x.reservation_id=s.id AND x.intent_id=s."intentId" AND x.account_id=s."accountId")))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF EXISTS(SELECT 1 FROM public.order_intent x LEFT JOIN public."order" q ON q."tenantId"=x."tenantId" AND q."intentId"=x.id
  LEFT JOIN ctp_execution.command c ON c."tenantId"=x."tenantId" AND c."intentId"=x.id
  WHERE x."tenantId"=t AND x.mode='PAPER' AND (q.id IS NULL OR c."intentId" IS NULL OR x.operation<>'PLACE'
   OR x.destination<>'PAPER_ENGINE' OR x."connectionId" IS NOT NULL OR x."targetOrderId" IS NOT NULL
   OR q.mode<>'PAPER' OR q."connectionId" IS NOT NULL OR q.status<>'CREATED' OR q.version<>0
   OR q."reconciliationState"<>'REQUIRED' OR q."filledQuantity"<>0 OR q."exchangeOrderId" IS NOT NULL
   OR c.operation<>'PLACE' OR c."orderId"<>q.id OR c."commandHash"<>x."commandHash"
   OR x."instrumentId"<>q."instrumentId" OR x."ruleVersionId"<>q."ruleVersionId"))
 OR EXISTS(SELECT 1 FROM public.submission_attempt s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
 OR EXISTS(SELECT 1 FROM ctp_execution.evidence s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
 OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.order_event e JOIN public."order" q ON q."tenantId"=e."tenantId" AND q.id=e."orderId"
  LEFT JOIN ctp_execution.command c ON c."tenantId"=q."tenantId" AND c."intentId"=q."intentId"
  WHERE q."tenantId"=t AND q.mode='PAPER' AND (e.version<>0 OR e."previousStatus" IS NOT NULL OR e.status<>'CREATED'
   OR e.source<>'CREATE' OR e."sourceIdentity" IS DISTINCT FROM q."intentId"::text OR e."evidenceHash" IS DISTINCT FROM c."commandHash"
   OR e."attemptId" IS NOT NULL OR e."occurredAt"<q."createdAt" OR e."occurredAt">clock_timestamp()))
 OR EXISTS(SELECT 1 FROM public."order" q WHERE q."tenantId"=t AND q.mode='PAPER' AND NOT EXISTS(
  SELECT 1 FROM public.order_event e WHERE e."tenantId"=t AND e."orderId"=q.id AND e.version=0))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Bound CURRENT positive reservations/holds, never an evicted list of seen
 -- IDs. No release/consumption is supported by this initial authority slice.
 SELECT count(*) INTO n FROM(SELECT id FROM public.risk_reservation WHERE "tenantId"=t AND mode='PAPER' AND status='ACTIVE' LIMIT 1001) q;
 IF n>1000 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 FOREACH a IN ARRAY ids LOOP
  b:=ctp_paper.admission_book(jsonb_build_object('tenantId',t::text,'accountId',a::text,'mode','PAPER'));
  cfg:=b->'configuration'->'configuration'; funding:=b->'funding'->'funding'; state:=b->'state';
  quote:=cfg->>'valuationAsset'; IF common_quote IS NULL THEN common_quote:=quote; END IF;
  IF quote IS DISTINCT FROM common_quote OR jsonb_array_length(funding->'balances')<>1
   OR funding->'balances'->0->>'asset' IS DISTINCT FROM quote
   OR state->>'status' IS DISTINCT FROM 'RECONCILED' OR state->'positions' IS DISTINCT FROM '[]'::jsonb
   OR state->'pending' IS DISTINCT FROM '[]'::jsonb OR state->'differences' IS DISTINCT FROM '[]'::jsonb
   OR state->'lastEconomicAt' IS DISTINCT FROM 'null'::jsonb
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF state->'balances' IS DISTINCT FROM (b->'origin'->>'stateText')::jsonb->'balances' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  balances:=balances||jsonb_build_array(jsonb_build_object('accountId',a::text,'asset',quote,'available',state->'balances'->0->'available'));
  account_holds:=0;
  FOR i IN SELECT * FROM ctp_paper.admission_issuance WHERE tenant_id=t AND account_id=a ORDER BY reservation_id LOOP
   total:=total+1; account_holds:=account_holds+1;
   IF total>1000 OR i.quote<>quote OR i.response_hash<>sha256(convert_to(i.response::text,'UTF8'))
    OR i.response->'request' IS DISTINCT FROM i.request OR i.response->>'kind' IS DISTINCT FROM 'RESERVED'
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   SELECT * INTO r FROM public.risk_reservation WHERE "tenantId"=t AND id=i.reservation_id;
   IF NOT FOUND OR ROW(r."intentId",r."accountId",r."decisionId",r.mode,r.status,r.version,r."consumedAmount",r."vectorSize",r."paperLegacy")
    IS DISTINCT FROM ROW(i.intent_id,a,i.decision_id,'PAPER'::public."TradingMode",'ACTIVE'::public."ReservationStatus",0,0::numeric,1,false)
    OR r.asset IS NOT NULL OR r.amount IS NOT NULL OR r."budgetId" IS NOT NULL OR r."releasedAt" IS NOT NULL
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   SELECT * INTO j FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=r.id ORDER BY revision DESC LIMIT 1;
   IF NOT FOUND OR j.revision<>1 OR j.status<>'ACTIVE' OR j.observed_ms<>i.created_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   SELECT * INTO d FROM ctp_paper.reservation_debit WHERE tenant_id=t AND reservation_id=r.id AND ordinal=1;
   IF NOT FOUND OR d.asset<>quote OR jsonb_array_length(i.response->'debits')<>1
    OR i.response->'debits'->0 IS DISTINCT FROM jsonb_build_object('asset',d.asset,'amount',trim_scale(d.amount)::text,'holdId',d.hold_id::text)
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   hold:=jsonb_build_object('id',d.hold_id::text,'asset',quote,'amount',trim_scale(d.amount)::text,'status','RESERVED','reflected',false);
   SELECT value INTO actual_hold FROM jsonb_array_elements(state->'holds') WHERE value->>'id'=d.hold_id::text;
   IF NOT FOUND OR actual_hold IS DISTINCT FROM hold THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   SELECT * INTO w FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=i.book_id AND "holdId"=d.hold_id::text;
   IF NOT FOUND OR w.timestamp<>i.created_ms OR w.released OR w.unknown
    OR w.fingerprint<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8'))
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   event:=i.response->'portfolio'->'events'->0;
   IF event->'hold' IS DISTINCT FROM hold OR (event->>'timestamp')::bigint<>i.created_ms
    OR NOT EXISTS(SELECT 1 FROM ctp_portfolio.evidence e WHERE e."tenantId"=t AND e.book=i.book_id AND e.id=event->>'id'
     AND e.payload::jsonb=event AND e.fingerprint=sha256(convert_to(e.payload,'UTF8')) AND e.ledger IS NULL)
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   holds:=holds||jsonb_build_array(jsonb_build_object('id',d.hold_id::text,'accountId',a::text,'asset',quote,'amount',trim_scale(d.amount)::text,'unknown',false,'reflected',false));
   reservations:=reservations||jsonb_build_array(jsonb_build_object('id',r.id::text,'orderId',i.order_id::text,'intentId',i.intent_id::text,
    'accountId',a::text,'instrumentId',i.instrument,'base',i.base,'quote',i.quote,'side','BUY','notional',trim_scale(i.notional)::text,
    'unknown',false,'debits',i.response->'debits'));
   orders:=orders||jsonb_build_array(jsonb_build_object('id',i.order_id::text,'intentId',i.intent_id::text,
    'accountId',a::text,'instrumentId',i.instrument,'base',i.base,'quote',i.quote,'side','BUY','notional',trim_scale(i.notional)::text,'status','PENDING'));
  END LOOP;
  IF jsonb_array_length(state->'holds')<>account_holds
   OR (SELECT count(*) FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=(b->>'bookId')::uuid)<>account_holds
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF a=target THEN target_book:=b; END IF;
  books:=books||jsonb_build_array(b);
 END LOOP;
 IF total<>(SELECT count(*) FROM public.risk_reservation WHERE "tenantId"=t AND mode='PAPER') THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN jsonb_build_object('accountIds',to_jsonb(ids),'books',books,'target',target_book,'valuationAsset',common_quote,
  'evidence',jsonb_build_object('scope',jsonb_build_object('tenantId',t::text,'mode','PAPER','valuationAsset',common_quote),
   'asOf',ts,'complete',true,'accountIds',to_jsonb(ids),'positions','[]'::jsonb,'orders',orders,'reservations',reservations,'holds',holds,'balances',balances));
END $$;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['admission_issuance','admission_book_event','admission_book_head','admission_genesis'] LOOP
  EXECUTE format('ALTER TABLE ctp_paper.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE ctp_paper.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY admission_tenant ON ctp_paper.%I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',n);
  EXECUTE format('REVOKE ALL ON ctp_paper.%I FROM PUBLIC',n);
  EXECUTE format('CREATE TRIGGER admission_no_truncate BEFORE TRUNCATE ON ctp_paper.%I FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row()',n);
  IF n='admission_book_head' THEN
   EXECUTE format('CREATE TRIGGER admission_monotonic BEFORE UPDATE OR DELETE ON ctp_paper.%I FOR EACH ROW EXECUTE FUNCTION ctp_paper.admission_monotonic_head()',n);
  ELSE
   EXECUTE format('CREATE TRIGGER admission_immutable BEFORE UPDATE OR DELETE ON ctp_paper.%I FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row()',n);
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION ctp_paper.valid_admission_runtime() RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_risk_admission'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_risk_admission','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_risk_admission' AND pg_has_role(session_user,r.oid,'MEMBER'))
 AND NOT has_database_privilege(session_user,current_database(),'CREATE,TEMP')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_')
  AND (has_schema_privilege(session_user,n.oid,'CREATE') OR pg_has_role(session_user,n.nspowner,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p','v','m','f')
  AND (pg_has_role(session_user,t.relowner,'MEMBER') OR has_table_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
   OR has_any_column_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
  WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(session_user,f.oid,'EXECUTE')
  AND (n.nspname||'.'||f.proname||'('||replace(oidvectortypes(f.proargtypes),' ','')||')')
   NOT IN('ctp_paper.evaluate_and_reserve(jsonb)','ctp_paper.reconcile_admission(jsonb)'))
$$;

CREATE FUNCTION ctp_paper.admission_lock(p jsonb) RETURNS uuid
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; b jsonb:=p->'binding'; k text; cmd ctp_execution.command%ROWTYPE; BEGIN
 IF p IS NULL OR octet_length(p::text)>8192 OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['binding','orderId','intentId','operation','commandHash']),false)
  OR p->>'operation' IS DISTINCT FROM 'PLACE' OR jsonb_typeof(p->'commandHash') IS DISTINCT FROM 'string'
  OR p->>'commandHash' !~ '^[a-f0-9]{64}$'
  OR NOT coalesce(ctp_market.snapshot_keys(b,ARRAY['tenantId','accountId','mode','connectionId','externalAccountId','profile']),false)
  OR b->>'mode' IS DISTINCT FROM 'PAPER' OR b->'connectionId' IS DISTINCT FROM 'null'::jsonb
  OR NOT coalesce(ctp_market.snapshot_keys(b->'profile',ARRAY['exchange','region','market','environment','accountMode','profileVersion','endpointProfileId']),false)
  OR b->'profile'->>'market' IS DISTINCT FROM 'SPOT' OR b->'profile'->>'accountMode' IS DISTINCT FROM 'SIMULATED'
  OR b->'profile'->>'profileVersion' IS DISTINCT FROM 'spot-l2-taker-v1'
  OR b->'profile'->>'endpointProfileId' IS DISTINCT FROM 'paper-spot-v1'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOREACH k IN ARRAY ARRAY['tenantId','accountId'] LOOP
  IF jsonb_typeof(b->k) IS DISTINCT FROM 'string' OR b->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['orderId','intentId'] LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 t:=(b->>'tenantId')::uuid;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 PERFORM 1 FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND id=(b->>'accountId')::uuid
  AND mode='PAPER' AND status='ACTIVE' AND "externalAccountId"=b->>'externalAccountId'
  AND exchange::text=b->'profile'->>'exchange' AND region=b->'profile'->>'region' AND "accountMode"='SIMULATED';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO cmd FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF NOT FOUND OR cmd."orderId"<>(p->>'orderId')::uuid OR cmd.operation<>'PLACE'
  OR cmd.binding::jsonb IS DISTINCT FROM b OR encode(cmd."commandHash",'hex')<>p->>'commandHash'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 RETURN t;
END $$;

-- Original provenance and current-state authentication are distinct. This new
-- helper retains the sealed original receipt checks and then requires a private
-- causal head. The published pristine-only book_origin_wire remains unchanged.
CREATE FUNCTION ctp_paper.admission_book(o jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; c jsonb; f jsonb; r ctp_paper.book_origin%ROWTYPE; p jsonb;
 seal ctp_paper.book_origin_seal%ROWTYPE; b ctp_portfolio.book%ROWTYPE;
 h ctp_paper.admission_book_head%ROWTYPE; e ctp_paper.admission_book_event%ROWTYPE; ts bigint; origin_state jsonb;
BEGIN
 ctx:=ctp_paper.book_context(o); c:=ctx->'configuration'; f:=ctx->'funding';
 SELECT * INTO r FROM ctp_paper.book_origin WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO seal FROM ctp_paper.book_origin_seal WHERE book=r.book;
 p:=r.receipt_text::jsonb;
 IF NOT FOUND OR ROW(seal.tenant_id,seal.account_id) IS DISTINCT FROM ROW(r.tenant_id,r.account_id)
  OR seal.receipt_hash<>sha256(convert_to(r.receipt_text,'UTF8'))
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','bookId','revision','createdAt','configuration','funding','stateText','stateHash']),false)
  OR p->>'kind' IS DISTINCT FROM 'INITIAL_BOOK' OR p->>'bookId' IS DISTINCT FROM r.book::text
  OR p->>'revision' IS DISTINCT FROM '1' OR p->'configuration' IS DISTINCT FROM c OR p->'funding' IS DISTINCT FROM f
  OR jsonb_typeof(p->'createdAt') IS DISTINCT FROM 'number' OR p->>'createdAt' !~ '^(0|[1-9][0-9]{0,15})$'
  OR (p->>'createdAt')::numeric>8640000000000000 OR jsonb_typeof(p->'stateText') IS DISTINCT FROM 'string'
  OR p->>'stateHash' IS DISTINCT FROM encode(sha256(convert_to(p->>'stateText','UTF8')),'hex')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 ts:=(p->>'createdAt')::bigint;
 IF ts<((f->>'receiptText')::jsonb->>'createdAt')::bigint OR ts>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
  OR r.funding_id<>((f->>'receiptText')::jsonb->'funding'->>'id')::uuid OR r.book<>r.funding_id
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 origin_state:=ctp_paper.initial_book_state((c->>'receiptText')::jsonb,(f->>'receiptText')::jsonb,ts);
 IF (p->>'stateText')::jsonb IS DISTINCT FROM origin_state THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=r.tenant_id AND id=r.book AND "accountId"=r.account_id AND mode='PAPER' FOR UPDATE;
 IF NOT FOUND OR b.wallet<>'paper-initial:'||r.funding_id::text OR b.state_hash<>sha256(convert_to(b.state,'UTF8'))
  OR (SELECT count(*) FROM ctp_portfolio.book WHERE "tenantId"=r.tenant_id AND "accountId"=r.account_id)<>1
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO h FROM ctp_paper.admission_book_head WHERE tenant_id=r.tenant_id AND book_id=r.book;
 IF NOT FOUND THEN
  -- Adoption is possible only through the original full pristine proof, never
  -- by trusting arbitrary public state and a matching self-hash.
  PERFORM ctp_paper.book_origin_wire(r,c,f);
  INSERT INTO ctp_paper.admission_book_event(tenant_id,account_id,book_id,revision,cause_id,kind,previous_revision,state_text,state_hash)
   VALUES(r.tenant_id,r.account_id,r.book,1,r.book,'BOOTSTRAP',0,b.state,b.state_hash);
  INSERT INTO ctp_paper.admission_book_head VALUES(r.tenant_id,r.book,1,b.state_hash);
  SELECT * INTO h FROM ctp_paper.admission_book_head WHERE tenant_id=r.tenant_id AND book_id=r.book;
 END IF;
 SELECT * INTO e FROM ctp_paper.admission_book_event WHERE tenant_id=h.tenant_id AND book_id=h.book_id AND revision=h.revision;
 IF NOT FOUND OR ROW(e.account_id,e.revision,e.state_hash,e.state_text) IS DISTINCT FROM ROW(b."accountId",b.revision,b.state_hash,b.state)
  OR e.state_hash<>h.state_hash THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF e.kind='RESERVE' AND NOT EXISTS(SELECT 1 FROM ctp_paper.admission_issuance i
  WHERE i.tenant_id=e.tenant_id AND i.reservation_id=e.cause_id AND i.book_id=e.book_id
   AND i.response_hash=sha256(convert_to(i.response::text,'UTF8'))
   AND i.response->'portfolio'->>'revision'=e.revision::text
   AND i.response->'portfolio'->>'afterText'=e.state_text)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN jsonb_build_object('bookId',r.book::text,'revision',b.revision::text,'state',b.state::jsonb,'hash',encode(b.state_hash,'hex'),'origin',p,'configuration',(c->>'receiptText')::jsonb,'funding',(f->>'receiptText')::jsonb);
END $$;

CREATE FUNCTION ctp_paper.admission_loss(inv jsonb,ts bigint) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE day bigint:=ts/86400000*86400000; first_ms bigint; first_book jsonb; opening numeric;
 t uuid:=(inv->'evidence'->'scope'->>'tenantId')::uuid; g ctp_paper.admission_genesis%ROWTYPE;
BEGIN
 SELECT min((value->'funding'->>'createdAt')::bigint),coalesce(sum((value->'funding'->'funding'->'balances'->0->>'amount')::numeric)
  FILTER(WHERE (value->'funding'->>'createdAt')::bigint<day),0)
 INTO first_ms,opening FROM jsonb_array_elements(inv->'books');
 IF first_ms IS NULL OR first_ms>ts THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF opening>0 THEN
  IF opening>=10::numeric^20 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  RETURN jsonb_build_object('kind','UTC_CASH','utcDayStart',day,'baselineAt',day,'openingEquity',trim_scale(opening)::text,'asset',inv->'valuationAsset');
 END IF;
 -- This is the genuine first capital interval, NOT a backdated UTC opening.
 -- If earliest receipts tie, no arbitrary UUID/ctid ordering establishes which
 -- seed was first: reject instead of inventing provenance.
 IF first_ms<day OR (SELECT count(*) FROM jsonb_array_elements(inv->'books') b WHERE (b->'funding'->>'createdAt')::bigint=first_ms)<>1
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT value INTO first_book FROM jsonb_array_elements(inv->'books') WHERE (value->'funding'->>'createdAt')::bigint=first_ms;
 SELECT * INTO g FROM ctp_paper.admission_genesis WHERE tenant_id=t;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM ctp_paper.admission_issuance WHERE tenant_id=t) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  INSERT INTO ctp_paper.admission_genesis VALUES(t,gen_random_uuid(),(first_book->'funding'->'funding'->>'id')::uuid,
   inv->>'valuationAsset',(first_book->'funding'->'funding'->'balances'->0->>'amount')::numeric,first_ms) RETURNING * INTO g;
 END IF;
 IF g.started_ms<>first_ms OR g.asset IS DISTINCT FROM inv->>'valuationAsset'
  OR g.funding_id<>(first_book->'funding'->'funding'->>'id')::uuid
  OR g.initial_capital<>(first_book->'funding'->'funding'->'balances'->0->>'amount')::numeric
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Inventory proves all economic/valuation history absent and all cash equals
 -- genuine sealed seeds. Later seeds are external flows; they cannot increase
 -- this fixed risk reference or mint a new genesis on restart/account creation.
 RETURN jsonb_build_object('kind','PAPER_INCEPTION','utcDayStart',day,'baselineAt',first_ms,
  'genesisId',g.id::text,'fundingId',g.funding_id::text,'initialCapital',trim_scale(g.initial_capital)::text,'asset',g.asset);
END $$;

CREATE FUNCTION ctp_paper.admission_market(p jsonb,cfg jsonb,age integer) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c ctp_execution.command%ROWTYPE; ord public."order"%ROWTYPE;
 sh ctp_market.snapshot_head%ROWTYPE; se ctp_market.snapshot_event%ROWTYPE; th ctp_market.trade_head%ROWTYPE;
 sp jsonb; tp jsonb; k jsonb; state jsonb;
BEGIN
 SELECT * INTO c FROM ctp_execution.command WHERE "tenantId"=(p->'binding'->>'tenantId')::uuid AND "intentId"=(p->>'intentId')::uuid;
 SELECT * INTO ord FROM public."order" WHERE "tenantId"=c."tenantId" AND id=c."orderId";
 IF NOT FOUND OR ord."intentId"<>c."intentId" OR ord."ruleVersionId"::text IS DISTINCT FROM c.draft::jsonb->>'dbRuleId'
  OR ord."instrumentId"::text IS DISTINCT FROM c.draft::jsonb->>'dbInstrumentId'
  OR c."commandHash"<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('operation','createOrder','binding',c.binding::jsonb,'command',c.command::jsonb)),'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 LOCK TABLE public.instrument,public.instrument_rule_version,ctp_market.snapshot_head,ctp_market.trade_head IN SHARE MODE;
 k:=jsonb_build_object('scope',cfg->'source','instrumentId',c.command::jsonb->'instrumentId','dbInstrumentId',ord."instrumentId"::text);
 SELECT * INTO sh FROM ctp_market.snapshot_head WHERE key=k;
 IF NOT FOUND OR sh.gap OR sh.native IS NULL OR sh.event IS DISTINCT FROM sh.native THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO se FROM ctp_market.snapshot_event WHERE id=sh.native;
 IF NOT FOUND OR se.key<>k OR se.status<>'APPLIED' OR se.revision<>sh.revision OR se.hash<>sha256(convert_to(se.payload,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 sp:=se.payload::jsonb;
 IF sp->>'kind'<>'SNAPSHOT' OR sp->>'id'<>se.id::text
  OR sp->'key'<>k||jsonb_build_object('dbRuleId',ord."ruleVersionId"::text)
  OR ctp_market.snapshot_valid(sp) IS NOT TRUE OR ctp_market.snapshot_metadata(sp) IS NOT TRUE
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 state:=ctp_market.trade_checked_head(k);
 IF state->>'revision'='0' OR state->'gap'='true'::jsonb THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO th FROM ctp_market.trade_head WHERE key=k;
 tp:=ctp_market.trade_proof(th.native);
 IF tp->>'kind'<>'TRADE' OR tp->'key'<>sp->'key' OR tp->'record'<>sp->'record'
  OR ctp_market.snapshot_metadata(tp) IS NOT TRUE OR ctp_market.snapshot_fresh(sp,age) IS NOT TRUE
  OR ctp_market.trade_fresh(tp,age) IS NOT TRUE OR sp->'ticker'->'last'->>'state' IS DISTINCT FROM 'AVAILABLE'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN jsonb_build_object('record',sp->'record','book',sp->'book','trade',tp->'trade','ticker',sp->'ticker',
  'snapshotAt',sp->'timestamp','tradeAt',tp->'timestamp','order',c.command::jsonb,
  'dbRuleId',ord."ruleVersionId"::text,'dbInstrumentId',ord."instrumentId"::text,
  'snapshotId',se.id::text,'snapshotRevision',sh.revision::text,'snapshotHash',encode(se.hash,'hex'),
  'tradeId',th.native::text,'tradeRevision',th.revision::text);
END $$;

CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
<<paper_issue>> DECLARE t uuid; a uuid; o jsonb; inv jsonb; cfg jsonb; model jsonb; market jsonb; cmd jsonb; rules jsonb; inst jsonb;
 runtime jsonb; observation jsonb; fact jsonb; losses jsonb; opening text; source jsonb; source_hash bytea;
 platform ctp_risk.policy_revision%ROWTYPE; usr ctp_risk.policy_revision%ROWTYPE;
 lim jsonb; limits jsonb; old ctp_paper.admission_issuance%ROWTYPE; profile_row public.risk_profile%ROWTYPE;
 account_row public.exchange_account%ROWTYPE; intent public.order_intent%ROWTYPE; ord public."order"%ROWTYPE;
 now_ms bigint; deadline_ms bigint; source_at bigint; age integer; policy jsonb; policy_hash bytea;
 qty numeric; tick numeric; step numeric; lower_price numeric; upper_price numeric; notional numeric; amount numeric; fee numeric;
 bid numeric; ask numeric; reference_price numeric; liquid numeric; available numeric;
 instrument_total numeric:=0; asset_total numeric:=0; account_total numeric:=0; user_total numeric:=0;
 row jsonb; pending boolean; positions_count integer; open_count integer; rate_count integer;
 certificate_id uuid:=gen_random_uuid(); decision_id uuid:=gen_random_uuid(); reservation_id uuid:=gen_random_uuid();
 state_id uuid:=gen_random_uuid(); capability_id uuid:=gen_random_uuid(); hold_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
 certificate_revision bigint; state_version bigint; capabilities jsonb; feature text; binding jsonb;
 fx jsonb; snapshot jsonb; budget jsonb; receipt jsonb; response jsonb;
 book_id uuid; previous_revision bigint; before_state jsonb; after_state jsonb; after_text text; after_hash bytea; hold jsonb; event jsonb;
 controls jsonb; global_pause boolean; tenant_pause boolean; circuit_open boolean;
BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 t:=ctp_paper.admission_lock(p); a:=(p->'binding'->>'accountId')::uuid;
 SELECT * INTO old FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=(p->>'intentId')::uuid;
 IF FOUND THEN
  IF old.request IS DISTINCT FROM p THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF old.response_hash<>sha256(convert_to(old.response::text,'UTF8')) OR old.source_hash<>sha256(convert_to(old.source::text,'UTF8'))
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  RETURN jsonb_build_object('kind','REPLAY','request',old.request,'receipt',old.response->'receipt');
 END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 inv:=ctp_paper.admission_inventory(p,now_ms);
 cfg:=inv->'target'->'configuration'->'configuration'; model:=cfg->'model';
 o:=jsonb_build_object('tenantId',t::text,'accountId',a::text,'mode','PAPER');
 IF cfg->'source'||jsonb_build_object('accountMode','SIMULATED','profileVersion',model->'version','endpointProfileId','paper-spot-v1')
  IS DISTINCT FROM p->'binding'->'profile' THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT r.* INTO platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id)
  WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode='PAPER';
 IF NOT FOUND OR ctp_risk.valid_limits(platform."limitsText"::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT r.* INTO usr FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id)
  WHERE h.scope='USER' AND h.target=t AND h.mode='PAPER';
 IF NOT FOUND OR ctp_risk.valid_limits(usr."limitsText"::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF platform."limitsText"::jsonb->'valuationAsset' IS DISTINCT FROM usr."limitsText"::jsonb->'valuationAsset'
  OR inv->'valuationAsset' IS DISTINCT FROM platform."limitsText"::jsonb->'valuationAsset'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
 age:=least((platform."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(usr."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(model->>'maxEvidenceAgeMs')::integer);
 market:=ctp_paper.admission_market(p,cfg,age);
 runtime:=ctp_paper.context_runtime_capture(o); observation:=(runtime->'publication'->>'text')::jsonb->'observation';
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 deadline_ms:=least(now_ms/86400000*86400000+86400000,(inv->'evidence'->>'asOf')::bigint+age+1);
 source_at:=now_ms;
 FOR fact IN SELECT value FROM jsonb_each(observation->'health') LOOP
  IF fact->>'status' IS DISTINCT FROM 'HEALTHY' OR (fact->>'asOf')::bigint>now_ms OR now_ms-(fact->>'asOf')::bigint>age
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  source_at:=least(source_at,(fact->>'asOf')::bigint); deadline_ms:=least(deadline_ms,(fact->>'asOf')::bigint+age+1);
 END LOOP;
 IF (SELECT count(*) FROM jsonb_each(observation->'health'))<>9 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF (SELECT count(*) FROM ctp_risk.global_head)>10000 OR (SELECT count(*) FROM ctp_risk.tenant_head WHERE "tenantId"=t)>10000
  OR (SELECT count(*) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL)>10000
  OR (SELECT count(*) FROM public.circuit_state WHERE "tenantId"=t)>10000
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 global_pause:=NOT EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill' AND state='RUNNING');
 tenant_pause:=EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND kind='KILL_SWITCH' AND state<>'RUNNING')
  OR EXISTS(SELECT 1 FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL);
 circuit_open:=EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='CIRCUIT' AND state<>'CLOSED')
  OR EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND kind='CIRCUIT' AND state<>'CLOSED')
  OR EXISTS(SELECT 1 FROM public.circuit_state WHERE "tenantId"=t AND status<>'CLOSED');
 IF global_pause OR tenant_pause OR circuit_open THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 SELECT jsonb_build_object('global',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY kind,key) FROM ctp_risk.global_head x),'[]'),
  'tenant',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY scope,target,kind,key) FROM ctp_risk.tenant_head x WHERE "tenantId"=t),'[]'),
  'pauses',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL),'[]'),
  'circuits',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.circuit_state x WHERE "tenantId"=t),'[]')) INTO controls;
 SELECT * INTO account_row FROM public.exchange_account WHERE "tenantId"=t AND id=a AND mode='PAPER' AND status='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO intent FROM public.order_intent WHERE "tenantId"=t AND id=(p->>'intentId')::uuid AND "accountId"=a AND mode='PAPER';
 SELECT * INTO ord FROM public."order" WHERE "tenantId"=t AND id=(p->>'orderId')::uuid AND "intentId"=intent.id;
 cmd:=market->'order'; rules:=market->'record'->'rules'; inst:=market->'record'->'instrument';
 IF NOT coalesce(ctp_market.snapshot_keys(cmd,ARRAY['instrumentId','ruleVersion','clientOrderId','side','type','size','limitPrice','trigger','timeInForce','reduceOnly']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(cmd->'size',ARRAY['kind','value','asset']),false)
  OR cmd->>'side' IS DISTINCT FROM 'BUY' OR cmd->>'type' NOT IN('LIMIT','MARKET')
  OR cmd->'trigger' IS DISTINCT FROM 'null'::jsonb OR cmd->'reduceOnly' IS DISTINCT FROM 'false'::jsonb
  OR cmd->'size'->>'kind' IS DISTINCT FROM 'BASE_QUANTITY' OR cmd->'size'->>'asset' IS DISTINCT FROM inst->>'baseAsset'
  OR cmd->>'instrumentId' IS DISTINCT FROM inst->>'id' OR cmd->>'ruleVersion' IS DISTINCT FROM rules->>'version'
  OR cmd->>'clientOrderId' IS DISTINCT FROM ord."clientId"
  OR intent.side<>'BUY' OR intent."orderType"::text IS DISTINCT FROM cmd->>'type'
  OR intent."quantityAsset" IS DISTINCT FROM inst->>'baseAsset' OR intent."priceAsset" IS DISTINCT FROM inst->>'quoteAsset'
  OR inst->>'quoteAsset' IS DISTINCT FROM inv->>'valuationAsset' OR inst->>'baseAsset'=inst->>'quoteAsset'
  OR inst->'scope' IS DISTINCT FROM cfg->'source' OR inst->'scope'->>'market'<>'SPOT'
  OR inst->>'status'<>'TRADING' OR (inst->>'expiryAt' IS NOT NULL AND (inst->>'expiryAt')::bigint<=now_ms)
  OR rules->>'quantityUnit'<>'BASE' OR jsonb_array_length(rules->'leverageTiers')<>0
  OR NOT(rules->'orderTypes' ? (cmd->>'type')) OR (cmd->>'timeInForce' IS NOT NULL AND NOT(rules->'timeInForce' ? (cmd->>'timeInForce')))
  OR cmd->>'timeInForce'='POST_ONLY' OR (cmd->>'type'='LIMIT' AND cmd->>'limitPrice' IS NULL)
  OR (cmd->>'type'='MARKET' AND (cmd->>'limitPrice' IS NOT NULL OR cmd->>'timeInForce' IS NOT NULL))
  OR ctp_admission.money(cmd->'size'->'value') IS NOT TRUE
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
 qty:=(cmd->'size'->>'value')::numeric; tick:=(rules->>'tickSize')::numeric; step:=(rules->>'stepSize')::numeric;
 IF qty<=0 OR qty>=10::numeric^20 OR scale(qty)>18 OR qty<>intent.quantity OR mod(qty,step)<>0
  OR qty<(CASE WHEN cmd->>'type'='MARKET' THEN rules->>'marketMinQuantity' ELSE rules->>'minQuantity' END)::numeric
  OR qty>(CASE WHEN cmd->>'type'='MARKET' THEN rules->>'marketMaxQuantity' ELSE rules->>'maxQuantity' END)::numeric
  OR (rules->>'effectiveAt')::bigint>now_ms OR (rules->>'expiresAt')::bigint<=now_ms
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF cmd->>'limitPrice' IS NOT NULL AND (ctp_admission.money(cmd->'limitPrice') IS NOT TRUE
  OR (cmd->>'limitPrice')::numeric IS DISTINCT FROM intent."limitPrice"
  OR mod((cmd->>'limitPrice')::numeric,tick)<>0 OR (cmd->>'limitPrice')::numeric<=0
  OR (rules->>'minPrice' IS NOT NULL AND (cmd->>'limitPrice')::numeric<(rules->>'minPrice')::numeric)
  OR (rules->>'maxPrice' IS NOT NULL AND (cmd->>'limitPrice')::numeric>(rules->>'maxPrice')::numeric))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 lower_price:=ceil(greatest(tick,coalesce((rules->>'minPrice')::numeric,tick))/tick)*tick;
 upper_price:=floor(coalesce((cmd->>'limitPrice')::numeric,(rules->>'maxPrice')::numeric)/tick)*tick;
 IF upper_price IS NULL OR lower_price>upper_price OR upper_price<=0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
 notional:=trim_scale(ceil(qty*upper_price*10::numeric^18)/10::numeric^18);
 fee:=trim_scale((qty/step)*ceil(step*upper_price*(model->>'takerFeeRate')::numeric*10::numeric^18)/10::numeric^18);
 amount:=trim_scale(notional+fee);
 IF amount>=10::numeric^20 OR notional>=10::numeric^20 OR scale(trim_scale(amount))>18
  OR qty*coalesce((cmd->>'limitPrice')::numeric,lower_price)<(rules->>'minNotional')::numeric
  OR (rules->>'maxNotional' IS NOT NULL AND qty*upper_price>(rules->>'maxNotional')::numeric)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 bid:=(market->'book'->'bids'->0->>'price')::numeric; ask:=(market->'book'->'asks'->0->>'price')::numeric;
 reference_price:=(market->'ticker'->'last'->>'value')::numeric;
 liquid:=floor(least((market->'book'->'bids'->0->>'quantity')::numeric,(market->'book'->'asks'->0->>'quantity')::numeric,
  (market->'trade'->>'quantity')::numeric)*(model->>'participationRate')::numeric/step)*step*least(bid,ask);
 IF bid>ask OR lower_price>bid OR upper_price<ask OR liquid<notional OR reference_price<=0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(inv->'evidence'->'reservations') LOOP
  user_total:=user_total+(row->>'notional')::numeric;
  IF row->>'accountId'=a::text THEN
   account_total:=account_total+(row->>'notional')::numeric;
   IF row->>'base'=inst->>'baseAsset' THEN asset_total:=asset_total+(row->>'notional')::numeric; END IF;
   IF row->>'instrumentId'=inst->>'id' THEN instrument_total:=instrument_total+(row->>'notional')::numeric; END IF;
  END IF;
 END LOOP;
 SELECT count(*),count(DISTINCT value->>'instrumentId'),coalesce(bool_or(value->>'instrumentId'=inst->>'id'),false)
 INTO open_count,positions_count,pending FROM jsonb_array_elements(inv->'evidence'->'reservations') WHERE value->>'accountId'=a::text;
 SELECT (value->>'available')::numeric INTO available FROM jsonb_array_elements(inv->'evidence'->'balances')
  WHERE value->>'accountId'=a::text AND value->>'asset'=inst->>'quoteAsset';
 SELECT available-coalesce(sum((value->>'amount')::numeric),0) INTO available FROM jsonb_array_elements(inv->'evidence'->'holds')
  WHERE value->>'accountId'=a::text AND value->>'asset'=inst->>'quoteAsset';
 SELECT count(*) INTO rate_count FROM public.order_intent WHERE "tenantId"=t AND mode='PAPER' AND id<>intent.id
  AND "createdAt">=to_timestamp((now_ms-60000)::double precision/1000);
 losses:=ctp_paper.admission_loss(inv,now_ms); opening:=coalesce(losses->>'openingEquity',losses->>'initialCapital');
 IF available IS NULL OR available<amount OR opening IS NULL OR opening::numeric<=0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 FOREACH limits IN ARRAY ARRAY[platform."limitsText"::jsonb,usr."limitsText"::jsonb] LOOP
  IF notional>(limits->>'maxOrderNotional')::numeric OR instrument_total+notional>(limits->>'maxInstrumentExposure')::numeric
   OR asset_total+notional>(limits->>'maxAssetExposure')::numeric OR account_total+notional>(limits->>'maxAccountExposure')::numeric
   OR user_total+notional>(limits->>'maxUserExposure')::numeric OR open_count+1>(limits->>'maxOpenOrders')::integer
   OR positions_count+(CASE WHEN pending THEN 0 ELSE 1 END)>(limits->>'maxConcurrentPositions')::integer
   OR rate_count+1>(limits->>'maxOrdersPerMinute')::integer OR (limits->>'maxLeverage')::numeric<1
   OR available-amount<(limits->>'minAvailableBalance')::numeric
   OR abs(upper_price-reference_price)>reference_price*(limits->>'maxPriceDeviationRate')::numeric
   OR (cmd->>'type'='MARKET' AND abs(lower_price-reference_price)>reference_price*(limits->>'maxPriceDeviationRate')::numeric)
   OR ask-bid>reference_price*(limits->>'maxSpreadRate')::numeric OR liquid<(limits->>'minLiquidityNotional')::numeric
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 END LOOP;
 FOR row IN SELECT to_jsonb(x) FROM unnest(ARRAY[(market->>'snapshotAt')::bigint,(market->>'tradeAt')::bigint,
  (market->'book'->>'receivedAt')::bigint,coalesce((market->'book'->>'exchangeTime')::bigint,(market->'book'->>'receivedAt')::bigint),
  (market->'ticker'->>'receivedAt')::bigint,(market->'ticker'->>'exchangeTime')::bigint,
  (market->'trade'->>'receivedAt')::bigint,(market->'trade'->>'exchangeTime')::bigint]) x LOOP
  IF (row#>>'{}')::bigint>now_ms OR now_ms-(row#>>'{}')::bigint>age THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
  source_at:=least(source_at,(row#>>'{}')::bigint);deadline_ms:=least(deadline_ms,(row#>>'{}')::bigint+age+1);
 END LOOP;
 deadline_ms:=least(deadline_ms,(rules->>'expiresAt')::bigint,coalesce((inst->>'expiryAt')::bigint,(rules->>'expiresAt')::bigint));
 IF deadline_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 book_id:=(inv->'target'->>'bookId')::uuid; previous_revision:=(inv->'target'->>'revision')::bigint;before_state:=inv->'target'->'state';
 IF previous_revision>=9007199254740991 OR jsonb_array_length(before_state->'holds')>=1000 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 certificate_revision:=nextval('ctp_paper.admission_revision');binding:=(p->'binding')-'connectionId'-'externalAccountId';
 capabilities:='[]'::jsonb;
 FOREACH feature IN ARRAY ARRAY['LIMIT_ORDER','MARKET_ORDER'] LOOP
  capabilities:=capabilities||jsonb_build_array(jsonb_build_object('profile',binding->'profile','feature',feature,'support','SUPPORTED','implementation','SYNTHETIC',
   'constraints',jsonb_build_object('instrumentIds',jsonb_build_array(inst->'id')),
   'evidenceUrl','https://github.com/dendenden-boop/tradeGPTbot/blob/8dd14f4b77c3bda8a5f0df3003be54adde55bd07/packages/paper-engine/src/model.ts',
   'checkedAt',now_ms,'expiresAt',deadline_ms,'adapterVersion','paper-spot-l2-taker-v1'));
 END LOOP;
 fx:=jsonb_build_object('from',inst->'quoteAsset','to',inv->'valuationAsset','rate','1','kind','IDENTITY','sourceId','paper-identity-fx','asOf',inv->'evidence'->'asOf');
 budget:=jsonb_build_object('now',now_ms,'model',model,'record',market->'record','book',market->'book','trade',market->'trade','order',cmd,'owner',o,
  'target',jsonb_build_object('orderId',p->'orderId','intentId',p->'intentId'),'platform',platform."limitsText"::jsonb,'user',usr."limitsText"::jsonb,'fx',fx,'evidence',inv->'evidence');
 snapshot:=jsonb_build_object('binding',binding,'instrumentId',inst->'id','revision',certificate_revision::text,'sourceId','paper-certified:'||certificate_id::text,
  'sourceAt',source_at,'reconciledAt',now_ms,'complete',true,'unknownExposure',false,'valuationAsset',inv->'valuationAsset',
  'instrumentExposure',trim_scale(instrument_total)::text,'assetExposure',trim_scale(asset_total)::text,'accountExposure',trim_scale(account_total)::text,'userExposure',trim_scale(user_total)::text,
  'positionQuantity','0','positionEvidence',jsonb_build_object('mode','SPOT','accountMode','SIMULATED','accountId',a::text,'instrumentId',inst->'id',
   'sourceId','paper-certified:'||certificate_id::text,'revision',certificate_revision::text,'asOf',now_ms,'side','NET','quantity','0'),
  'committedReductionQuantity','0','instrumentHasPendingEntry',pending,'concurrentPositions',positions_count,'openOrders',open_count,'ordersInLastMinute',rate_count,
  'leverage','1','availableAsset',inst->'quoteAsset','availableAmount',trim_scale(available)::text,'dailyNetRealizedPnl','0','adjustedOpeningEquity',opening,
  'adjustedCurrentEquity',opening,'adjustedPeakEquity',opening,'utcDayStart',losses->'utcDayStart','lossBaselineComplete',true,
  'pauses',jsonb_build_object('global',false,'user',false,'connection',false,'strategy',false),'circuit','CLOSED',
  'health',jsonb_build_object('database',observation->'health'->'database'->'status','limiter',observation->'health'->'limiter'->'status',
   'authentication',observation->'health'->'authentication'->'status','exchangeRest',observation->'health'->'publicMarket'->'status',
   'privateStream',observation->'health'->'executor'->'status','clock',observation->'health'->'clock'->'status','latency',observation->'health'->'latency'->'status',
   'rejectRate',observation->'health'->'rejectRate'->'status','maintenance',observation->'health'->'maintenance'->'status'))
  ||jsonb_build_object('market',jsonb_build_object('sourceId','paper-market:'||(market->>'snapshotId'),'asOf',source_at,'complete',true,
   'referencePrice',trim_scale(reference_price)::text,'lowerExecutionPrice',trim_scale(lower_price)::text,'upperExecutionPrice',trim_scale(upper_price)::text,
   'bid',trim_scale(bid)::text,'ask',trim_scale(ask)::text,'liquidityNotional',trim_scale(liquid)::text,'liquidityAsset',inv->'valuationAsset',
   'priceAsset',inst->'quoteAsset','quoteToValuation','1','fxFromAsset',inst->'quoteAsset','fxToAsset',inv->'valuationAsset','fxKind','IDENTITY',
   'fxSourceId',fx->'sourceId','fxAsOf',fx->'asOf','kind','LAST','executionBoundEnforced',true,'feeAsset',inst->'quoteAsset','maxFeeRate',model->'takerFeeRate'));
 source:=jsonb_build_object('request',p,'inventory',inv,'market',market,'runtime',runtime,'platform',ctp_risk.policy_json(platform),'user',ctp_risk.policy_json(usr),
  'controls',controls,'loss',losses,'capturedAt',now_ms,'permissionEpoch',account_row."permissionEpoch"::text);
 IF octet_length(source::text)>4194304 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 source_hash:=sha256(convert_to(source::text,'UTF8'));
 hold:=jsonb_build_object('id',hold_id::text,'asset',inst->'quoteAsset','amount',trim_scale(amount)::text,'status','RESERVED','reflected',false);
 event:=jsonb_build_object('id',event_id::text,'timestamp',now_ms,'type','COMMITMENT','hold',hold);
 after_state:=jsonb_set(before_state,'{holds}',(before_state->'holds')||jsonb_build_array(hold));
 after_text:=ctp_admission.canonical(after_state);after_hash:=sha256(convert_to(after_text,'UTF8'));
 receipt:=jsonb_build_object('decisionId',decision_id::text,'reservationId',reservation_id::text,'permissionEpoch',account_row."permissionEpoch"::text,'expiresAt',deadline_ms);
 response:=jsonb_build_object('kind','RESERVED','request',p,'receipt',receipt,
  'certificate',jsonb_build_object('id',certificate_id::text,'revision',certificate_revision::text,'sourceHash',encode(source_hash,'hex'),'createdAt',now_ms,'expiresAt',deadline_ms),
  'permissionEpoch',account_row."permissionEpoch"::text,'loss',losses,
  'policy',jsonb_build_object('now',now_ms,'binding',binding,'adapterVersion','paper-spot-l2-taker-v1','platform',platform."limitsText"::jsonb,'user',usr."limitsText"::jsonb,
   'order',cmd,'record',market->'record','capabilities',capabilities,'snapshot',snapshot),
  'budget',budget,'debits',jsonb_build_array(jsonb_build_object('asset',inst->'quoteAsset','amount',trim_scale(amount)::text,'holdId',hold_id::text)),
  'portfolio',jsonb_build_object('bookId',book_id::text,'previousRevision',previous_revision::text,'revision',(previous_revision+1)::text,
   'before',before_state,'events',jsonb_build_array(event),'afterText',after_text,'afterHash',encode(after_hash,'hex')));
 IF octet_length(response::text)>4194304 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 policy:=jsonb_build_object('platform',ctp_risk.policy_json(platform),'user',ctp_risk.policy_json(usr));policy_hash:=sha256(convert_to(policy::text,'UTF8'));
 SELECT * INTO profile_row FROM public.risk_profile WHERE "tenantId"=t AND name='paper-certified-'||encode(policy_hash,'hex') AND version=1;
 IF NOT FOUND THEN
  INSERT INTO public.risk_profile("tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt")
  VALUES(t,'paper-certified-'||encode(policy_hash,'hex'),1,policy_hash,inv->>'valuationAsset',least((platform."limitsText"::jsonb->>'maxUserExposure')::numeric,(usr."limitsText"::jsonb->>'maxUserExposure')::numeric),
   least((platform."limitsText"::jsonb->>'maxDailyTotalLoss')::numeric,(usr."limitsText"::jsonb->>'maxDailyTotalLoss')::numeric),
   least((platform."limitsText"::jsonb->>'maxDrawdownRate')::numeric,(usr."limitsText"::jsonb->>'maxDrawdownRate')::numeric),
   least((platform."limitsText"::jsonb->>'maxOpenOrders')::integer,(usr."limitsText"::jsonb->>'maxOpenOrders')::integer),policy,clock_timestamp()) RETURNING * INTO profile_row;
 ELSIF profile_row."policyHash"<>policy_hash OR profile_row.policy<>policy THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 INSERT INTO public.capability_snapshot(id,exchange,market,mode,region,"accountMode",version,"profileVersion","verifiedAt","expiresAt",capabilities,"evidenceHash")
 VALUES(capability_id,account_row.exchange,'SPOT','PAPER',account_row.region,'SIMULATED',nextval('ctp_paper.admission_capability_version')::integer,
  'spot-l2-taker-v1',to_timestamp(now_ms::double precision/1000),to_timestamp(deadline_ms::double precision/1000),
  jsonb_build_object('adapterVersion','paper-spot-l2-taker-v1','features',capabilities),sha256(convert_to(capabilities::text,'UTF8')));
 SELECT coalesce(max(version),0)+1 INTO state_version FROM public.account_state_version WHERE "tenantId"=t AND "accountId"=a AND mode='PAPER';
 INSERT INTO public.account_state_version(id,"tenantId","accountId",mode,version,"sourceCursor","sourceAt","receivedAt","reconciledAt","reconciliationEpoch","stateHash")
 VALUES(state_id,t,a,'PAPER',state_version,'paper-certificate-'||certificate_id::text,to_timestamp(source_at::double precision/1000),
  to_timestamp(now_ms::double precision/1000),to_timestamp(now_ms::double precision/1000),account_row."reconciliationEpoch",source_hash);
 INSERT INTO public.risk_decision(id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId","capabilitySnapshotId",verdict,"policyVersion","commandHash","reasonCodes","permissionEpoch","expiresAt")
 VALUES(decision_id,t,intent.id,a,'PAPER',profile_row.id,state_id,(market->>'dbRuleId')::uuid,capability_id,'APPROVE',1,decode(p->>'commandHash','hex'),
  ARRAY['CERTIFIED_PAPER_ATOMIC_ADMISSION'],account_row."permissionEpoch",to_timestamp(deadline_ms::double precision/1000));
 INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"vectorSize","expiresAt","updatedAt","createdAt")
 VALUES(reservation_id,t,decision_id,intent.id,a,'PAPER',1,to_timestamp(deadline_ms::double precision/1000),to_timestamp(now_ms::double precision/1000),to_timestamp(now_ms::double precision/1000));
 INSERT INTO ctp_paper.reservation_debit VALUES(t,reservation_id,intent.id,a,'PAPER',1,inst->>'quoteAsset',amount,hold_id);
 PERFORM ctp_paper.append_reservation_state(t,reservation_id,gen_random_uuid(),0,'ACTIVE',now_ms);
 INSERT INTO ctp_portfolio.hold_watermark VALUES(t,book_id,a,'PAPER',hold_id::text,now_ms,
  sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8')),false,false);
 INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
 VALUES(t,book_id,a,'PAPER',event_id::text,sha256(convert_to(ctp_admission.canonical(event),'UTF8')),ctp_admission.canonical(event),NULL);
 UPDATE ctp_portfolio.book SET state=after_text,state_hash=after_hash,revision=previous_revision+1 WHERE "tenantId"=t AND id=book_id AND revision=previous_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId") VALUES(t,book_id,a,'PAPER',previous_revision+1,'COMMITMENT',event_id::text);
 INSERT INTO ctp_paper.admission_book_event(tenant_id,account_id,book_id,revision,cause_id,kind,previous_revision,previous_hash,state_text,state_hash)
 VALUES(t,a,book_id,previous_revision+1,reservation_id,'RESERVE',previous_revision,
  decode(inv->'target'->>'hash','hex'),after_text,after_hash);
 INSERT INTO ctp_paper.admission_issuance VALUES(t,intent.id,ord.id,a,'PAPER',decision_id,reservation_id,certificate_id,state_id,capability_id,
  (market->>'dbRuleId')::uuid,book_id,inst->>'id',inst->>'baseAsset',inst->>'quoteAsset',notional,p,response,
  sha256(convert_to(response::text,'UTF8')),source,source_hash,now_ms);
 UPDATE ctp_paper.admission_book_head h SET revision=previous_revision+1,state_hash=after_hash
  WHERE h.tenant_id=t AND h.book_id=paper_issue.book_id;
 IF deadline_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 RETURN response;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
 WHEN sequence_generator_limit_exceeded THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT';
END $$;

-- Only books actually adopted by this new authority are guarded here. The
-- published native issuance authority and reference PAPER storage fixtures are
-- untouched. A newer common Portfolio RELEASE cannot self-authorize release of
-- an issued PAPER hold. Future causal lifecycle writers need their own contract.
CREATE FUNCTION ctp_paper.check_admission_book() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE raw jsonb; t uuid; target_book uuid; h ctp_paper.admission_book_head%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 w ctp_portfolio.hold_watermark%ROWTYPE; r public.risk_reservation%ROWTYPE;
 d ctp_paper.reservation_debit%ROWTYPE; hold jsonb; actual_hold jsonb; n integer:=0;
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
  hold:=jsonb_build_object('id',d.hold_id::text,'asset',d.asset,'amount',trim_scale(d.amount)::text,'status','RESERVED','reflected',false);
  SELECT value INTO actual_hold FROM jsonb_array_elements(b.state::jsonb->'holds') WHERE value->>'id'=d.hold_id::text;
  IF NOT FOUND OR actual_hold IS DISTINCT FROM hold THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
  SELECT * INTO w FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=target_book AND "holdId"=d.hold_id::text;
  IF NOT FOUND OR w.timestamp<>i.created_ms OR w.released OR w.unknown
   OR w.fingerprint<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8'))
   OR (SELECT status FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=r.id ORDER BY revision DESC LIMIT 1) IS DISTINCT FROM 'ACTIVE'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF jsonb_array_length(b.state::jsonb->'holds')<>n
  OR (SELECT count(*) FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=target_book)<>n
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER paper_admission_book_consistent AFTER INSERT OR UPDATE ON ctp_portfolio.book
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_admission_book();
CREATE CONSTRAINT TRIGGER paper_admission_watermark_consistent AFTER INSERT OR UPDATE OR DELETE ON ctp_portfolio.hold_watermark
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_admission_book();
CREATE CONSTRAINT TRIGGER paper_admission_head_consistent AFTER INSERT OR UPDATE ON ctp_paper.admission_book_head
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_admission_book();
CREATE CONSTRAINT TRIGGER paper_admission_reservation_consistent AFTER INSERT OR UPDATE OR DELETE ON public.risk_reservation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_admission_book();
CREATE CONSTRAINT TRIGGER paper_admission_state_consistent AFTER INSERT ON ctp_paper.reservation_state_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_admission_book();

CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; r ctp_paper.admission_issuance%ROWTYPE; BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 t:=ctp_paper.admission_lock(p);
 SELECT * INTO r FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=(p->>'intentId')::uuid;
 IF NOT FOUND THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
 IF r.request IS DISTINCT FROM p THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 IF r.response_hash<>sha256(convert_to(r.response::text,'UTF8')) OR r.source_hash<>sha256(convert_to(r.source::text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN jsonb_build_object('kind','COMMITTED','request',r.request,'receipt',r.response->'receipt');
END $$;

REVOKE ALL ON FUNCTION ctp_paper.check_admission_book(),ctp_paper.admission_monotonic_head(),ctp_paper.valid_admission_runtime(),ctp_paper.admission_lock(jsonb),
 ctp_paper.admission_book(jsonb),ctp_paper.admission_inventory(jsonb,bigint),ctp_paper.admission_loss(jsonb,bigint),
 ctp_paper.admission_market(jsonb,jsonb,integer),ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
