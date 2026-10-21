BEGIN;
-- Conservative quarantine only. No release, resolution, grant, financial
-- dispatch, capital movement or authority backfill. Published1-53 are immutable.
CREATE TABLE ctp_paper.admission_unknown_event (
 tenant_id uuid NOT NULL, event_id uuid NOT NULL, reservation_id uuid NOT NULL,
 intent_id uuid NOT NULL, account_id uuid NOT NULL, book_id uuid NOT NULL,
 state_revision smallint NOT NULL DEFAULT 2 CHECK(state_revision=2),
 observed_ms bigint NOT NULL CHECK(observed_ms BETWEEN 0 AND 8640000000000000),
 book_revision bigint NOT NULL, book_hash bytea NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=16384),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=4194304),
 response_hash bytea NOT NULL CHECK(response_hash=sha256(convert_to(response::text,'UTF8'))),
 PRIMARY KEY(tenant_id,event_id), UNIQUE(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES ctp_paper.admission_issuance(tenant_id,reservation_id),
 -- Exact immutable state revision/event/time is validated by the deferred
 -- causal guard below. An inbound FK would mask published52's owner-visible
 -- BEFORE TRUNCATE SQLSTATE23514 with PostgreSQL's earlier FK SQLSTATE0A000.
 FOREIGN KEY(tenant_id,book_id,book_revision,book_hash)
  REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE ctp_paper.admission_unknown_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.admission_unknown_event FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_tenant ON ctp_paper.admission_unknown_event
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON ctp_paper.admission_unknown_event FROM PUBLIC;
CREATE TRIGGER admission_immutable BEFORE UPDATE OR DELETE ON ctp_paper.admission_unknown_event
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER admission_no_truncate BEFORE TRUNCATE ON ctp_paper.admission_unknown_event
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

ALTER TABLE ctp_paper.admission_book_event DROP CONSTRAINT admission_book_event_kind_check;
ALTER TABLE ctp_paper.admission_book_event DROP CONSTRAINT admission_book_event_check1;
ALTER TABLE ctp_paper.admission_book_event ADD CONSTRAINT admission_book_event_kind_check CHECK(kind IN('BOOTSTRAP','RESERVE','UNKNOWN'));
ALTER TABLE ctp_paper.admission_book_event ADD CONSTRAINT admission_book_event_check1
 CHECK((kind='BOOTSTRAP' AND revision=1 AND previous_revision=0 AND previous_hash IS NULL AND cause_id=book_id)
 OR (kind IN('RESERVE','UNKNOWN') AND revision=previous_revision+1 AND octet_length(previous_hash)=32));

CREATE FUNCTION ctp_paper.reservation_unknown(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; k text; original ctp_paper.admission_issuance%ROWTYPE;
 u ctp_paper.admission_unknown_event%ROWTYPE; b ctp_portfolio.book%ROWTYPE;
 j ctp_paper.reservation_state_event%ROWTYPE; d ctp_paper.reservation_debit%ROWTYPE;
 w ctp_portfolio.hold_watermark%ROWTYPE; ctx jsonb; before_state jsonb; after_state jsonb;
 old_hold jsonb; hold jsonb; event jsonb; response jsonb; after_text text; after_hash bytea;
 now_ms bigint; previous_revision bigint; a uuid;
BEGIN
 IF p IS NULL OR octet_length(p::text)>16384
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','admission','reservationId','eventId','expectedRevision']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_RESERVATION_UNKNOWN'
  OR p->'expectedRevision' IS DISTINCT FROM '"1"'::jsonb
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOREACH k IN ARRAY ARRAY['eventId','reservationId'] LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 -- GLOBAL -> tenant -> user -> sorted accounts -> common book -> reservation.
 -- Same tenant lock as admission serializes distinct accounts and event keys.
 t:=ctp_paper.admission_lock(p->'admission');
 SELECT * INTO u FROM ctp_paper.admission_unknown_event WHERE tenant_id=t AND event_id=(p->>'eventId')::uuid;
 IF FOUND THEN
  IF u.request IS DISTINCT FROM p THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF u.response_hash<>sha256(convert_to(u.response::text,'UTF8')) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF read_only THEN RETURN jsonb_build_object('kind','COMMITTED','request',p,'receipt',u.response->'receipt'); END IF;
  RETURN u.response;
 END IF;
 SELECT * INTO original FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=(p->'admission'->>'intentId')::uuid;
 IF FOUND AND (original.request IS DISTINCT FROM p->'admission' OR original.reservation_id<>(p->>'reservationId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 IF read_only THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
 IF original.reservation_id IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_paper.admission_unknown_event WHERE tenant_id=t AND reservation_id=original.reservation_id)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 IF original.response_hash<>sha256(convert_to(original.response::text,'UTF8')) OR original.source_hash<>sha256(convert_to(original.source::text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF (SELECT count(*) FROM(SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' LIMIT 101) bounded)>100
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 a:=original.account_id;
 ctx:=ctp_paper.admission_book(jsonb_build_object('tenantId',t::text,'accountId',a::text,'mode','PAPER'));
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=original.book_id AND "accountId"=a AND mode='PAPER' FOR UPDATE;
 IF NOT FOUND OR ctx->>'bookId' IS DISTINCT FROM b.id::text THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 PERFORM 1 FROM public.risk_reservation WHERE "tenantId"=t AND id=original.reservation_id FOR UPDATE;
 SELECT * INTO j FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=original.reservation_id ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND OR j.revision<>1 OR j.status<>'ACTIVE' THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 SELECT * INTO d FROM ctp_paper.reservation_debit WHERE tenant_id=t AND reservation_id=original.reservation_id AND ordinal=1;
 IF NOT FOUND OR original.response->'debits' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('asset',d.asset,'amount',trim_scale(d.amount)::text,'holdId',d.hold_id::text))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO w FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=b.id AND "holdId"=d.hold_id::text;
 IF NOT FOUND OR w.released OR w.unknown OR w.timestamp<>original.created_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 before_state:=b.state::jsonb;
 old_hold:=jsonb_build_object('id',d.hold_id::text,'asset',d.asset,'amount',trim_scale(d.amount)::text,'status','RESERVED','reflected',false);
 IF (SELECT count(*) FROM jsonb_array_elements(before_state->'holds') q WHERE q->>'id'=d.hold_id::text)<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(before_state->'holds') q WHERE q=old_hold)
  OR w.fingerprint<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',old_hold)),'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 -- Never synthesize future time or weaken the published strict monotone clock.
 IF now_ms<=greatest(w.timestamp,j.observed_ms) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 hold:=old_hold||jsonb_build_object('status','UNKNOWN');
 event:=jsonb_build_object('id',p->>'eventId','type','COMMITMENT','timestamp',now_ms,'hold',hold);
 after_state:=jsonb_set(before_state,'{holds}',(SELECT jsonb_agg(CASE WHEN value->>'id'=d.hold_id::text THEN hold ELSE value END ORDER BY ordinality)
  FROM jsonb_array_elements(before_state->'holds') WITH ORDINALITY));
 after_text:=ctp_admission.canonical(after_state); after_hash:=sha256(convert_to(after_text,'UTF8')); previous_revision:=b.revision;
 IF previous_revision>=9007199254740991 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 response:=jsonb_build_object('kind','UNKNOWN','request',p,'receipt',jsonb_build_object(
  'eventId',p->>'eventId','reservationId',original.reservation_id::text,'orderId',original.order_id::text,'intentId',original.intent_id::text,
  'decisionId',original.decision_id::text,'revision','2','observedAt',now_ms,'bookId',b.id::text,'bookRevision',(previous_revision+1)::text,'bookHash',encode(after_hash,'hex')),
  'portfolio',jsonb_build_object('bookId',b.id::text,'previousRevision',previous_revision::text,'revision',(previous_revision+1)::text,'before',before_state,'event',event,
   'previousWatermark',jsonb_build_object('timestamp',w.timestamp,'fingerprint',encode(w.fingerprint,'hex'),'released',false,'unknown',false),
   'afterText',after_text,'afterHash',encode(after_hash,'hex')));
 PERFORM ctp_paper.append_reservation_state(t,original.reservation_id,(p->>'eventId')::uuid,1,'UNKNOWN',now_ms);
 UPDATE ctp_portfolio.hold_watermark SET timestamp=now_ms,unknown=true,
  fingerprint=sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8'))
  WHERE "tenantId"=t AND book=b.id AND "holdId"=d.hold_id::text;
 INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
 VALUES(t,b.id,a,'PAPER',p->>'eventId',sha256(convert_to(ctp_admission.canonical(event),'UTF8')),ctp_admission.canonical(event),NULL);
 UPDATE ctp_portfolio.book SET state=after_text,state_hash=after_hash,revision=previous_revision+1 WHERE "tenantId"=t AND id=b.id AND revision=previous_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId") VALUES(t,b.id,a,'PAPER',previous_revision+1,'COMMITMENT',p->>'eventId');
 INSERT INTO ctp_paper.admission_book_event(tenant_id,account_id,book_id,revision,cause_id,kind,previous_revision,previous_hash,state_text,state_hash)
 VALUES(t,a,b.id,previous_revision+1,(p->>'eventId')::uuid,'UNKNOWN',previous_revision,b.state_hash,after_text,after_hash);
 INSERT INTO ctp_paper.admission_unknown_event(tenant_id,event_id,reservation_id,intent_id,account_id,book_id,observed_ms,book_revision,book_hash,request,response,response_hash)
 VALUES(t,(p->>'eventId')::uuid,original.reservation_id,original.intent_id,a,b.id,now_ms,previous_revision+1,after_hash,p,response,sha256(convert_to(response::text,'UTF8')));
 UPDATE ctp_paper.admission_book_head SET revision=previous_revision+1,state_hash=after_hash WHERE tenant_id=t AND book_id=b.id;
 RETURN response;
END $$;

-- The original bodies remain intact behind non-callable private signatures.
-- Only the same two fixed RPCs are callable by the restricted server role.
ALTER FUNCTION ctp_paper.evaluate_and_reserve(jsonb) RENAME TO evaluate_and_reserve_v53;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v53;
REVOKE ALL ON FUNCTION ctp_paper.evaluate_and_reserve_v53(jsonb),ctp_paper.reconcile_admission_v53(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_RESERVATION_UNKNOWN' THEN RETURN ctp_paper.reservation_unknown(p,false); END IF;
 t:=ctp_paper.admission_lock(p);
 -- Historical exact CREATE replay is still durable. It must not renew a usable
 -- admission receipt once its financial reservation has been quarantined.
 IF EXISTS(SELECT 1 FROM ctp_paper.admission_unknown_event WHERE tenant_id=t AND intent_id=(p->>'intentId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN ctp_paper.evaluate_and_reserve_v53(p);
END $$;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_RESERVATION_UNKNOWN' THEN RETURN ctp_paper.reservation_unknown(p,true); END IF;
 RETURN ctp_paper.reconcile_admission_v53(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.reservation_unknown(jsonb,boolean),ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;

CREATE OR REPLACE FUNCTION ctp_paper.admission_book(o jsonb) RETURNS jsonb
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
 IF e.kind='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM ctp_paper.admission_unknown_event u
  WHERE u.tenant_id=e.tenant_id AND u.event_id=e.cause_id AND u.book_id=e.book_id
   AND u.book_revision=e.revision AND u.book_hash=e.state_hash
   AND u.response_hash=sha256(convert_to(u.response::text,'UTF8'))
   AND u.response->'portfolio'->>'afterText'=e.state_text)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN jsonb_build_object('bookId',r.book::text,'revision',b.revision::text,'state',b.state::jsonb,'hash',encode(b.state_hash,'hex'),'origin',p,'configuration',(c->>'receiptText')::jsonb,'funding',(f->>'receiptText')::jsonb);
END $$;

CREATE OR REPLACE FUNCTION ctp_paper.check_admission_book() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE raw jsonb; t uuid; target_book uuid; h ctp_paper.admission_book_head%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 w ctp_portfolio.hold_watermark%ROWTYPE; r public.risk_reservation%ROWTYPE;
 d ctp_paper.reservation_debit%ROWTYPE; hold jsonb; actual_hold jsonb; n integer:=0;
 u ctp_paper.admission_unknown_event%ROWTYPE; j ctp_paper.reservation_state_event%ROWTYPE;
 expected_status text; expected_time bigint;
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
 IF jsonb_array_length(b.state::jsonb->'holds')<>n
  OR (SELECT count(*) FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=target_book)<>n
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER paper_admission_unknown_consistent AFTER INSERT ON ctp_paper.admission_unknown_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_admission_book();

COMMIT;
