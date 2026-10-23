BEGIN;
-- Terminal collateral authority only for an actually issued irreversible
-- NOT_SENT withdrawal. Original allocation and published1-55 remain intact.
CREATE TABLE ctp_paper.withdrawal_release (
 tenant_id uuid NOT NULL, event_id uuid NOT NULL, reservation_id uuid NOT NULL,
 intent_id uuid NOT NULL, order_id uuid NOT NULL, account_id uuid NOT NULL,
 decision_id uuid NOT NULL, withdrawal_event_id uuid NOT NULL,
 command_hash bytea NOT NULL CHECK(octet_length(command_hash)=32),
 book_id uuid NOT NULL, previous_revision bigint NOT NULL CHECK(previous_revision>0),
 previous_hash bytea NOT NULL, book_revision bigint NOT NULL CHECK(book_revision=previous_revision+1 AND book_revision<=9007199254740991),
 book_hash bytea NOT NULL, observed_ms bigint NOT NULL CHECK(observed_ms BETWEEN 0 AND 8640000000000000),
 asset text NOT NULL, amount numeric(38,18) NOT NULL CHECK(amount>0), hold_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=16384),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=4194304),
 response_hash bytea NOT NULL CHECK(response_hash=sha256(convert_to(response::text,'UTF8'))),
 PRIMARY KEY(tenant_id,event_id), UNIQUE(tenant_id,reservation_id), UNIQUE(tenant_id,intent_id), UNIQUE(tenant_id,order_id),
 UNIQUE(tenant_id,withdrawal_event_id), CHECK(event_id<>withdrawal_event_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES ctp_paper.admission_issuance(tenant_id,reservation_id),
 -- The deferred private causal validator authenticates the immutable barrier.
 -- An inbound FK would mask published55 BEFORE TRUNCATE SQLSTATE23514 with0A000.
 FOREIGN KEY(tenant_id,book_id,previous_revision,previous_hash) REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash),
 FOREIGN KEY(tenant_id,book_id,book_revision,book_hash) REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash) DEFERRABLE INITIALLY DEFERRED,
 CHECK(response->>'kind'='RELEASED' AND response->'request'=request AND response->'receipt'=jsonb_build_object(
  'outcome','NOT_SENT','collateral','RELEASED','eventId',event_id::text,'withdrawalEventId',withdrawal_event_id::text,
  'reservationId',reservation_id::text,'orderId',order_id::text,'intentId',intent_id::text,'decisionId',decision_id::text,
  'commandHash',encode(command_hash,'hex'),'releaseVersion','1','releasedAt',observed_ms,
  'bookId',book_id::text,'bookRevision',book_revision::text,'bookHash',encode(book_hash,'hex'),
  'debits',jsonb_build_array(jsonb_build_object('asset',asset,'amount',trim_scale(amount)::text,'holdId',hold_id::text))))
);
CREATE INDEX withdrawal_release_account ON ctp_paper.withdrawal_release(tenant_id,account_id,reservation_id);
ALTER TABLE ctp_paper.withdrawal_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.withdrawal_release FORCE ROW LEVEL SECURITY;
CREATE POLICY release_tenant ON ctp_paper.withdrawal_release
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON ctp_paper.withdrawal_release FROM PUBLIC;
CREATE TRIGGER release_immutable BEFORE UPDATE OR DELETE ON ctp_paper.withdrawal_release FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER release_no_truncate BEFORE TRUNCATE ON ctp_paper.withdrawal_release FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
ALTER TABLE ctp_paper.admission_book_event DROP CONSTRAINT admission_book_event_kind_check;
ALTER TABLE ctp_paper.admission_book_event DROP CONSTRAINT admission_book_event_check1;
ALTER TABLE ctp_paper.admission_book_event ADD CONSTRAINT admission_book_event_kind_check CHECK(kind IN('BOOTSTRAP','RESERVE','UNKNOWN','RELEASE'));
ALTER TABLE ctp_paper.admission_book_event ADD CONSTRAINT admission_book_event_check1
 CHECK((kind='BOOTSTRAP' AND revision=1 AND previous_revision=0 AND previous_hash IS NULL AND cause_id=book_id)
 OR (kind IN('RESERVE','UNKNOWN','RELEASE') AND revision=previous_revision+1 AND octet_length(previous_hash)=32));

-- This verifies private causal authority, historical full-vector economics and
-- the durable current tombstone, not merely matching JSON/hash fields.
CREATE FUNCTION ctp_paper.validate_withdrawal_release(t uuid,rid uuid) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE x ctp_paper.withdrawal_release%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 w ctp_paper.withdrawal_barrier%ROWTYPE; d ctp_paper.reservation_debit%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; wm ctp_portfolio.hold_watermark%ROWTYPE;
 previous ctp_paper.admission_book_event%ROWTYPE; e ctp_paper.admission_book_event%ROWTYPE;
 p jsonb; hold jsonb; event jsonb; after_state jsonb; after_text text;
BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO x FROM ctp_paper.withdrawal_release WHERE tenant_id=t AND reservation_id=rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND reservation_id=rid;
 IF NOT FOUND OR ROW(x.intent_id,x.order_id,x.account_id,x.decision_id,x.book_id)
  IS DISTINCT FROM ROW(i.intent_id,i.order_id,i.account_id,i.decision_id,i.book_id)
  OR i.response_hash<>sha256(convert_to(i.response::text,'UTF8')) OR i.source_hash<>sha256(convert_to(i.source::text,'UTF8'))
  OR x.command_hash<>decode(i.request->>'commandHash','hex')
  OR x.request IS DISTINCT FROM jsonb_build_object('kind','PAPER_RELEASE_WITHDRAWN','admission',i.request,
   'reservationId',rid::text,'withdrawalEventId',x.withdrawal_event_id::text,'eventId',x.event_id::text,'expectedRevision','1')
  OR x.response_hash<>sha256(convert_to(x.response::text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND event_id=x.withdrawal_event_id;
 IF NOT FOUND OR ROW(w.reservation_id,w.intent_id,w.order_id,w.account_id,w.decision_id,w.command_hash,w.book_id)
  IS DISTINCT FROM ROW(rid,x.intent_id,x.order_id,x.account_id,x.decision_id,x.command_hash,x.book_id)
  OR w.response_hash<>sha256(convert_to(w.response::text,'UTF8')) OR x.observed_ms<w.observed_ms
  OR x.previous_revision<w.book_revision OR x.observed_ms<=i.created_ms
  OR x.observed_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
  OR EXISTS(SELECT 1 FROM ctp_paper.admission_unknown_event WHERE tenant_id=t AND reservation_id=rid)
  OR (SELECT count(*) FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=rid)<>1
  OR NOT EXISTS(SELECT 1 FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=rid AND revision=1 AND status='ACTIVE' AND observed_ms=i.created_ms)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO d FROM ctp_paper.reservation_debit WHERE tenant_id=t AND reservation_id=rid AND ordinal=1;
 IF NOT FOUND OR ROW(x.asset,x.amount,x.hold_id) IS DISTINCT FROM ROW(d.asset,d.amount,d.hold_id)
  OR i.response->'debits' IS DISTINCT FROM x.response->'receipt'->'debits'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO previous FROM ctp_paper.admission_book_event WHERE tenant_id=t AND book_id=x.book_id AND revision=x.previous_revision;
 IF NOT FOUND OR previous.state_hash<>x.previous_hash OR previous.account_id<>x.account_id
  OR previous.state_hash<>sha256(convert_to(previous.state_text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO e FROM ctp_paper.admission_book_event WHERE tenant_id=t AND book_id=x.book_id AND revision=x.book_revision;
 IF NOT FOUND OR ROW(e.account_id,e.cause_id,e.kind,e.previous_revision,e.previous_hash,e.state_hash)
  IS DISTINCT FROM ROW(x.account_id,x.event_id,'RELEASE'::text,x.previous_revision,x.previous_hash,x.book_hash)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 p:=x.response->'portfolio';
 hold:=jsonb_build_object('id',d.hold_id::text,'asset',d.asset,'amount',trim_scale(d.amount)::text,'status','RESERVED','reflected',false);
 event:=jsonb_build_object('id',x.event_id::text,'type','RELEASE','timestamp',x.observed_ms,'holdId',d.hold_id::text,'resolved',false);
 IF (SELECT count(*) FROM jsonb_array_elements(previous.state_text::jsonb->'holds') q WHERE q->>'id'=d.hold_id::text)<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(previous.state_text::jsonb->'holds') q WHERE q=hold)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 after_state:=jsonb_set(previous.state_text::jsonb,'{holds}',coalesce((SELECT jsonb_agg(value ORDER BY ordinality)
  FROM jsonb_array_elements(previous.state_text::jsonb->'holds') WITH ORDINALITY WHERE value->>'id'<>d.hold_id::text),'[]'::jsonb));
 after_text:=ctp_admission.canonical(after_state);
 IF NOT coalesce(ctp_market.snapshot_keys(x.response,ARRAY['kind','request','receipt','portfolio']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['bookId','previousRevision','revision','before','event','previousWatermark','afterText','afterHash']),false)
  OR p->>'bookId' IS DISTINCT FROM x.book_id::text OR p->>'previousRevision' IS DISTINCT FROM x.previous_revision::text
  OR p->>'revision' IS DISTINCT FROM x.book_revision::text OR p->'before' IS DISTINCT FROM previous.state_text::jsonb
  OR p->'event' IS DISTINCT FROM event
  OR p->'previousWatermark' IS DISTINCT FROM jsonb_build_object('timestamp',i.created_ms,'fingerprint',encode(sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8')),'hex'),'released',false,'unknown',false)
  OR p->>'afterText' IS DISTINCT FROM after_text OR p->>'afterHash' IS DISTINCT FROM encode(x.book_hash,'hex')
  OR e.state_text<>after_text OR x.book_hash<>sha256(convert_to(after_text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=x.book_id AND "accountId"=x.account_id AND mode='PAPER';
 IF NOT FOUND OR b.state_hash<>sha256(convert_to(b.state,'UTF8'))
  OR NOT EXISTS(SELECT 1 FROM ctp_paper.admission_book_head WHERE tenant_id=t AND book_id=b.id AND revision=b.revision AND state_hash=b.state_hash)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.state::jsonb->'holds') q WHERE q->>'id'=d.hold_id::text)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO wm FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=x.book_id AND "holdId"=d.hold_id::text;
 IF NOT FOUND OR NOT wm.released OR wm.unknown OR wm.timestamp<>x.observed_ms
  OR wm.fingerprint<>sha256(convert_to(ctp_admission.canonical(event-'id'-'timestamp'),'UTF8'))
  OR NOT EXISTS(SELECT 1 FROM ctp_portfolio.evidence q WHERE q."tenantId"=t AND q.book=x.book_id AND q.id=x.event_id::text
   AND q.payload=ctp_admission.canonical(event) AND q.fingerprint=sha256(convert_to(q.payload,'UTF8')) AND q.ledger IS NULL)
  -- Outbox delivery is acknowledged by deletion. Immutable financial evidence,
  -- the private causal event and terminal watermark remain the authority.
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
END $$;

CREATE FUNCTION ctp_paper.release_withdrawn(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; k text; i ctp_paper.admission_issuance%ROWTYPE; x ctp_paper.withdrawal_release%ROWTYPE;
 w ctp_paper.withdrawal_barrier%ROWTYPE; b ctp_portfolio.book%ROWTYPE; d ctp_paper.reservation_debit%ROWTYPE;
 wm ctp_portfolio.hold_watermark%ROWTYPE; r public.risk_reservation%ROWTYPE; o public."order"%ROWTYPE;
 ctx jsonb; hold jsonb; event jsonb; response jsonb; after_state jsonb; after_text text; after_hash bytea; now_ms bigint;
BEGIN
 IF p IS NULL OR octet_length(p::text)>16384
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','admission','reservationId','withdrawalEventId','eventId','expectedRevision']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_RELEASE_WITHDRAWN' OR p->'expectedRevision' IS DISTINCT FROM '"1"'::jsonb
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOREACH k IN ARRAY ARRAY['eventId','reservationId','withdrawalEventId'] LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 IF p->>'eventId'=p->>'withdrawalEventId' THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 t:=ctp_paper.admission_lock(p->'admission');
 SELECT * INTO x FROM ctp_paper.withdrawal_release WHERE tenant_id=t AND event_id=(p->>'eventId')::uuid;
 IF FOUND THEN
  IF x.request IS DISTINCT FROM p THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF x.response_hash<>sha256(convert_to(x.response::text,'UTF8')) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF read_only THEN RETURN jsonb_build_object('kind','COMMITTED','request',p,'receipt',x.response->'receipt'); END IF;
  RETURN x.response;
 END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=(p->'admission'->>'intentId')::uuid;
 IF FOUND AND (i.request IS DISTINCT FROM p->'admission' OR i.reservation_id<>(p->>'reservationId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 IF read_only THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
 IF i.reservation_id IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_paper.withdrawal_release WHERE tenant_id=t AND reservation_id=i.reservation_id)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND event_id=(p->>'withdrawalEventId')::uuid AND reservation_id=i.reservation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_MISSING'; END IF;
 IF (SELECT count(*) FROM(SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' LIMIT 101) q)>100
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=i.order_id FOR UPDATE;
 IF NOT FOUND OR o.mode<>'PAPER' OR o."accountId"<>i.account_id OR o."intentId"<>i.intent_id
  OR o.status<>'CREATED' OR o.version<>0 OR o."filledQuantity"<>0 OR o."averageFillPrice"<>0
  OR o."connectionId" IS NOT NULL OR o."exchangeOrderId" IS NOT NULL OR o."lastExchangeAt" IS NOT NULL
  OR o."terminalAt" IS NOT NULL OR o."reconciliationState"<>'REQUIRED'
  OR EXISTS(SELECT 1 FROM public.submission_attempt WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM public.fill WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM ctp_execution.evidence WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM public.order_intent WHERE "tenantId"=t AND "targetOrderId"=o.id)
  OR (SELECT count(*) FROM public.order_event WHERE "tenantId"=t AND "orderId"=o.id)<>1
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 ctx:=ctp_paper.admission_book(jsonb_build_object('tenantId',t::text,'accountId',i.account_id::text,'mode','PAPER'));
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=i.book_id AND "accountId"=i.account_id AND mode='PAPER' FOR UPDATE;
 IF NOT FOUND OR ctx->>'bookId' IS DISTINCT FROM b.id::text THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO r FROM public.risk_reservation WHERE "tenantId"=t AND id=i.reservation_id FOR UPDATE;
 IF NOT FOUND OR r.status<>'ACTIVE' OR r.version<>0 OR r."consumedAmount"<>0 OR r."releasedAt" IS NOT NULL
  OR r."vectorSize" IS DISTINCT FROM 1 OR r."paperLegacy" OR r.asset IS NOT NULL OR r.amount IS NOT NULL OR r."budgetId" IS NOT NULL
  OR r."decisionId"<>i.decision_id OR r."intentId"<>i.intent_id OR r."accountId"<>i.account_id
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=r.id AND (revision<>1 OR status<>'ACTIVE'))
  OR NOT EXISTS(SELECT 1 FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=r.id AND revision=1 AND status='ACTIVE' AND observed_ms=i.created_ms)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO d FROM ctp_paper.reservation_debit WHERE tenant_id=t AND reservation_id=r.id AND ordinal=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 hold:=jsonb_build_object('id',d.hold_id::text,'asset',d.asset,'amount',trim_scale(d.amount)::text,'status','RESERVED','reflected',false);
 SELECT * INTO wm FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=b.id AND "holdId"=d.hold_id::text;
 IF NOT FOUND OR wm.released OR wm.unknown OR wm.timestamp<>i.created_ms
  OR wm.fingerprint<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8'))
  OR (SELECT count(*) FROM jsonb_array_elements(b.state::jsonb->'holds') q WHERE q->>'id'=d.hold_id::text)<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.state::jsonb->'holds') q WHERE q=hold)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF now_ms<=i.created_ms OR now_ms<w.observed_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF b.revision>=9007199254740991 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 event:=jsonb_build_object('id',p->>'eventId','type','RELEASE','timestamp',now_ms,'holdId',d.hold_id::text,'resolved',false);
 after_state:=jsonb_set(b.state::jsonb,'{holds}',coalesce((SELECT jsonb_agg(value ORDER BY ordinality)
  FROM jsonb_array_elements(b.state::jsonb->'holds') WITH ORDINALITY WHERE value->>'id'<>d.hold_id::text),'[]'::jsonb));
 after_text:=ctp_admission.canonical(after_state); after_hash:=sha256(convert_to(after_text,'UTF8'));
 response:=jsonb_build_object('kind','RELEASED','request',p,'receipt',jsonb_build_object(
  'outcome','NOT_SENT','collateral','RELEASED','eventId',p->>'eventId','withdrawalEventId',w.event_id::text,
  'reservationId',r.id::text,'orderId',i.order_id::text,'intentId',i.intent_id::text,'decisionId',i.decision_id::text,
  'commandHash',encode(w.command_hash,'hex'),'releaseVersion','1','releasedAt',now_ms,
  'bookId',b.id::text,'bookRevision',(b.revision+1)::text,'bookHash',encode(after_hash,'hex'),'debits',i.response->'debits'),
  'portfolio',jsonb_build_object('bookId',b.id::text,'previousRevision',b.revision::text,'revision',(b.revision+1)::text,'before',b.state::jsonb,
   'event',event,'previousWatermark',jsonb_build_object('timestamp',wm.timestamp,'fingerprint',encode(wm.fingerprint,'hex'),'released',false,'unknown',false),
   'afterText',after_text,'afterHash',encode(after_hash,'hex')));
 INSERT INTO ctp_paper.withdrawal_release(tenant_id,event_id,reservation_id,intent_id,order_id,account_id,decision_id,withdrawal_event_id,
  command_hash,book_id,previous_revision,previous_hash,book_revision,book_hash,observed_ms,asset,amount,hold_id,request,response,response_hash)
 VALUES(t,(p->>'eventId')::uuid,r.id,i.intent_id,i.order_id,i.account_id,i.decision_id,w.event_id,w.command_hash,
  b.id,b.revision,b.state_hash,b.revision+1,after_hash,now_ms,d.asset,d.amount,d.hold_id,p,response,sha256(convert_to(response::text,'UTF8')));
 UPDATE ctp_portfolio.hold_watermark SET timestamp=now_ms,released=true,unknown=false,
  fingerprint=sha256(convert_to(ctp_admission.canonical(event-'id'-'timestamp'),'UTF8')) WHERE "tenantId"=t AND book=b.id AND "holdId"=d.hold_id::text;
 INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
 VALUES(t,b.id,i.account_id,'PAPER',p->>'eventId',sha256(convert_to(ctp_admission.canonical(event),'UTF8')),ctp_admission.canonical(event),NULL);
 UPDATE ctp_portfolio.book SET state=after_text,state_hash=after_hash,revision=b.revision+1 WHERE "tenantId"=t AND id=b.id AND revision=b.revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId") VALUES(t,b.id,i.account_id,'PAPER',b.revision+1,'RELEASE',p->>'eventId');
 INSERT INTO ctp_paper.admission_book_event(tenant_id,account_id,book_id,revision,cause_id,kind,previous_revision,previous_hash,state_text,state_hash)
 VALUES(t,i.account_id,b.id,b.revision+1,(p->>'eventId')::uuid,'RELEASE',b.revision,b.state_hash,after_text,after_hash);
 UPDATE ctp_paper.admission_book_head SET revision=b.revision+1,state_hash=after_hash WHERE tenant_id=t AND book_id=b.id;
 RETURN response;
END $$;

CREATE OR REPLACE FUNCTION ctp_paper.check_admission_book_v55() RETURNS trigger
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
CREATE CONSTRAINT TRIGGER paper_admission_release_consistent AFTER INSERT ON ctp_paper.withdrawal_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_admission_book();

ALTER FUNCTION ctp_paper.admission_inventory(jsonb,bigint) RENAME TO admission_inventory_v55;
CREATE OR REPLACE FUNCTION ctp_paper.admission_inventory(p jsonb,ts bigint) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid:=(p->'binding'->>'tenantId')::uuid; target uuid:=(p->'binding'->>'accountId')::uuid;
 ids uuid[]; a uuid; b jsonb; cfg jsonb; funding jsonb; state jsonb; target_book jsonb;
 books jsonb:='[]'; balances jsonb:='[]'; holds jsonb:='[]'; reservations jsonb:='[]'; orders jsonb:='[]';
 quote text; common_quote text; i ctp_paper.admission_issuance%ROWTYPE; d ctp_paper.reservation_debit%ROWTYPE;
 r public.risk_reservation%ROWTYPE; j ctp_paper.reservation_state_event%ROWTYPE; w ctp_portfolio.hold_watermark%ROWTYPE;
 hold jsonb; event jsonb; actual_hold jsonb; total integer:=0; account_holds integer; n integer; released_count bigint;
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
 -- Bound current positive liabilities only. Permanent terminal history is
 -- authenticated separately and is never evicted or counted as a live slot.
 SELECT count(*) INTO n FROM(SELECT id FROM public.risk_reservation WHERE "tenantId"=t AND mode='PAPER' AND status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM ctp_paper.withdrawal_release x WHERE x.tenant_id=t AND x.reservation_id=public.risk_reservation.id) LIMIT 1001) q;
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
  SELECT count(*) INTO released_count FROM ctp_paper.withdrawal_release WHERE tenant_id=t AND account_id=a;
  PERFORM ctp_paper.validate_withdrawal_release(t,x.reservation_id) FROM ctp_paper.withdrawal_release x WHERE x.tenant_id=t AND x.account_id=a;
  FOR i IN SELECT * FROM ctp_paper.admission_issuance WHERE tenant_id=t AND account_id=a AND NOT EXISTS(SELECT 1 FROM ctp_paper.withdrawal_release x WHERE x.tenant_id=t AND x.reservation_id=ctp_paper.admission_issuance.reservation_id) ORDER BY reservation_id LOOP
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
   OR (SELECT count(*) FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=(b->>'bookId')::uuid)<>account_holds+released_count
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF a=target THEN target_book:=b; END IF;
  books:=books||jsonb_build_array(b);
 END LOOP;
 IF total+(SELECT count(*) FROM ctp_paper.withdrawal_release WHERE tenant_id=t)<>(SELECT count(*) FROM public.risk_reservation WHERE "tenantId"=t AND mode='PAPER') THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN jsonb_build_object('accountIds',to_jsonb(ids),'books',books,'target',target_book,'valuationAsset',common_quote,
  'evidence',jsonb_build_object('scope',jsonb_build_object('tenantId',t::text,'mode','PAPER','valuationAsset',common_quote),
   'asOf',ts,'complete',true,'accountIds',to_jsonb(ids),'positions','[]'::jsonb,'orders',orders,'reservations',reservations,'holds',holds,'balances',balances));
END $$;
ALTER FUNCTION ctp_paper.admission_book(jsonb) RENAME TO admission_book_v55;
CREATE FUNCTION ctp_paper.admission_book(o jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r jsonb; e ctp_paper.admission_book_event%ROWTYPE; rid uuid;
BEGIN
 r:=ctp_paper.admission_book_v55(o);
 SELECT * INTO e FROM ctp_paper.admission_book_event WHERE tenant_id=(o->>'tenantId')::uuid AND book_id=(r->>'bookId')::uuid AND revision=(r->>'revision')::bigint;
 IF e.kind='RELEASE' THEN
  SELECT reservation_id INTO rid FROM ctp_paper.withdrawal_release WHERE tenant_id=e.tenant_id AND book_id=e.book_id AND event_id=e.cause_id AND book_revision=e.revision AND book_hash=e.state_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  PERFORM ctp_paper.validate_withdrawal_release(e.tenant_id,rid);
 END IF;
 RETURN r;
END $$;
ALTER FUNCTION ctp_paper.evaluate_and_reserve(jsonb) RENAME TO evaluate_and_reserve_v55;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v55;
CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_RELEASE_WITHDRAWN' THEN RETURN ctp_paper.release_withdrawn(p,false); END IF;
 RETURN ctp_paper.evaluate_and_reserve_v55(p);
END $$;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_RELEASE_WITHDRAWN' THEN RETURN ctp_paper.release_withdrawn(p,true); END IF;
 RETURN ctp_paper.reconcile_admission_v55(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.evaluate_and_reserve_v55(jsonb),ctp_paper.reconcile_admission_v55(jsonb),
 ctp_paper.admission_book_v55(jsonb),ctp_paper.admission_inventory_v55(jsonb,bigint),ctp_paper.check_admission_book_v55(),
 ctp_paper.validate_withdrawal_release(uuid,uuid),ctp_paper.release_withdrawn(jsonb,boolean),
 ctp_paper.admission_book(jsonb),ctp_paper.admission_inventory(jsonb,bigint),ctp_paper.check_admission_book(),
 ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
