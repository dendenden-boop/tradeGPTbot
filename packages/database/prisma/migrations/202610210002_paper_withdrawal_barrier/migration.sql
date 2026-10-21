BEGIN;
-- Negative capability only: no order status, financial state, hold, ledger or
-- permission is changed. Published1-54 remain intact; no authority is backfilled.
CREATE TABLE ctp_paper.withdrawal_barrier (
 tenant_id uuid NOT NULL, event_id uuid NOT NULL, reservation_id uuid NOT NULL,
 intent_id uuid NOT NULL, order_id uuid NOT NULL, account_id uuid NOT NULL,
 decision_id uuid NOT NULL, command_hash bytea NOT NULL CHECK(octet_length(command_hash)=32),
 book_id uuid NOT NULL, book_revision bigint NOT NULL, book_hash bytea NOT NULL,
 observed_ms bigint NOT NULL CHECK(observed_ms BETWEEN 0 AND 8640000000000000),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=16384),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=16384),
 response_hash bytea NOT NULL CHECK(response_hash=sha256(convert_to(response::text,'UTF8'))),
 PRIMARY KEY(tenant_id,event_id), UNIQUE(tenant_id,reservation_id),
 UNIQUE(tenant_id,intent_id), UNIQUE(tenant_id,order_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES ctp_paper.admission_issuance(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,book_id,book_revision,book_hash)
  REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash),
 CHECK(response=jsonb_build_object('kind','WITHDRAWN','request',request,'receipt',jsonb_build_object(
  'outcome','NOT_SENT','collateral','RETAINED','eventId',event_id::text,'reservationId',reservation_id::text,
  'orderId',order_id::text,'intentId',intent_id::text,'decisionId',decision_id::text,
  'commandHash',encode(command_hash,'hex'),'stateRevision','1','observedAt',observed_ms,
  'bookId',book_id::text,'bookRevision',book_revision::text,'bookHash',encode(book_hash,'hex'))))
);
ALTER TABLE ctp_paper.withdrawal_barrier ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.withdrawal_barrier FORCE ROW LEVEL SECURITY;
CREATE POLICY withdrawal_tenant ON ctp_paper.withdrawal_barrier
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON ctp_paper.withdrawal_barrier FROM PUBLIC;
CREATE TRIGGER withdrawal_immutable BEFORE UPDATE OR DELETE ON ctp_paper.withdrawal_barrier
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER withdrawal_no_truncate BEFORE TRUNCATE ON ctp_paper.withdrawal_barrier
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.check_withdrawal_cause() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original ctp_paper.admission_issuance%ROWTYPE; b ctp_portfolio.book%ROWTYPE;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE' USING ERRCODE='23514'; END IF;
 SELECT * INTO original FROM ctp_paper.admission_issuance WHERE tenant_id=NEW.tenant_id AND reservation_id=NEW.reservation_id;
 IF NOT FOUND OR ROW(NEW.intent_id,NEW.order_id,NEW.account_id,NEW.decision_id,NEW.book_id)
  IS DISTINCT FROM ROW(original.intent_id,original.order_id,original.account_id,original.decision_id,original.book_id)
  OR NEW.request IS DISTINCT FROM jsonb_build_object('kind','PAPER_WITHDRAW_BEFORE_DISPATCH',
   'admission',original.request,'reservationId',NEW.reservation_id::text,'eventId',NEW.event_id::text,'expectedRevision','1')
  OR NEW.command_hash IS DISTINCT FROM decode(original.request->>'commandHash','hex')
  OR original.response_hash<>sha256(convert_to(original.response::text,'UTF8'))
  OR original.source_hash<>sha256(convert_to(original.source::text,'UTF8'))
  OR NEW.observed_ms<original.created_ms OR NEW.observed_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
  OR NOT EXISTS(SELECT 1 FROM ctp_paper.reservation_state_event WHERE tenant_id=NEW.tenant_id AND reservation_id=NEW.reservation_id AND revision=1 AND status='ACTIVE')
  OR EXISTS(SELECT 1 FROM ctp_paper.reservation_state_event WHERE tenant_id=NEW.tenant_id AND reservation_id=NEW.reservation_id AND revision<>1)
  OR EXISTS(SELECT 1 FROM ctp_paper.admission_unknown_event WHERE tenant_id=NEW.tenant_id AND (reservation_id=NEW.reservation_id OR event_id=NEW.event_id))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=NEW.tenant_id AND id=NEW.book_id FOR UPDATE;
 IF NOT FOUND OR ROW(NEW.book_revision,NEW.book_hash) IS DISTINCT FROM ROW(b.revision,b.state_hash)
  OR b.state_hash<>sha256(convert_to(b.state,'UTF8'))
  OR NOT EXISTS(SELECT 1 FROM ctp_paper.admission_book_head WHERE tenant_id=NEW.tenant_id AND book_id=b.id AND revision=b.revision AND state_hash=b.state_hash)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_cause BEFORE INSERT ON ctp_paper.withdrawal_barrier
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_withdrawal_cause();

-- All newly received PAPER execution evidence and dispatch transitions share
-- the Risk tenant lock. Acquire the mandatory parent lock before try-locking
-- advisory locks, preserving published cash-reader/FK lock-timeout behavior.
-- This also covers not-yet-issued orders: skipping them would permit an insert
-- begun before issuance to resume after a concurrent barrier without rechecking.
-- Try-locks avoid waiting with an inverted parent/advisory-lock order.
-- Native modes take no additional locks and retain their published semantics.
CREATE FUNCTION ctp_paper.guard_withdrawal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE raw jsonb; versions jsonb[]; t uuid; target uuid; paper boolean;
BEGIN
 versions:=CASE WHEN TG_OP='INSERT' THEN ARRAY[to_jsonb(NEW)] WHEN TG_OP='DELETE' THEN ARRAY[to_jsonb(OLD)]
  ELSE ARRAY[to_jsonb(OLD),to_jsonb(NEW)] END;
 FOREACH raw IN ARRAY versions LOOP
  t:=coalesce(raw->>'tenantId',raw->>'tenant_id')::uuid;
  target:=coalesce(raw->>'orderId',raw->>'order_id',raw->>'targetOrderId')::uuid;
  IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='order' THEN target:=(raw->>'id')::uuid; END IF;
  IF TG_TABLE_SCHEMA='ctp_paper' THEN
   SELECT order_id INTO target FROM ctp_paper.admission_issuance
    WHERE tenant_id=t AND reservation_id=(raw->>'reservation_id')::uuid;
  END IF;
  IF target IS NULL THEN CONTINUE; END IF;
  SELECT mode='PAPER' INTO paper FROM public."order" WHERE "tenantId"=t AND id=target;
  IF paper IS DISTINCT FROM true THEN CONTINUE; END IF;
  PERFORM 1 FROM public."order" WHERE "tenantId"=t AND id=target FOR UPDATE;
  IF NOT pg_try_advisory_xact_lock_shared(1129599058,12)
   OR NOT pg_try_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0))
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND order_id=target)
  THEN RAISE EXCEPTION 'PAPER_WITHDRAWN_NOT_SENT' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['public."order"','public.submission_attempt','public.order_event','public.fill',
  'public.order_intent','public.algo_order','public.paper_order','ctp_execution.command','ctp_execution.progress',
  'ctp_execution.evidence','ctp_execution.authoritative_event','ctp_paper.reservation_state_event','ctp_paper.admission_unknown_event'] LOOP
  EXECUTE format('CREATE TRIGGER aaa_paper_withdrawal_barrier BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ctp_paper.guard_withdrawal()',relation);
 END LOOP;
END $$;

CREATE FUNCTION ctp_paper.withdraw_before_dispatch(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; k text; original ctp_paper.admission_issuance%ROWTYPE;
 w ctp_paper.withdrawal_barrier%ROWTYPE; o public."order"%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; j ctp_paper.reservation_state_event%ROWTYPE;
 d ctp_paper.reservation_debit%ROWTYPE; watermark ctp_portfolio.hold_watermark%ROWTYPE;
 r public.risk_reservation%ROWTYPE; ctx jsonb; hold jsonb; response jsonb; now_ms bigint;
BEGIN
 IF p IS NULL OR octet_length(p::text)>16384
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','admission','reservationId','eventId','expectedRevision']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_WITHDRAW_BEFORE_DISPATCH' OR p->'expectedRevision' IS DISTINCT FROM '"1"'::jsonb
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOREACH k IN ARRAY ARRAY['eventId','reservationId'] LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 -- GLOBAL -> tenant -> user -> sorted accounts -> target order -> book -> reservation.
 t:=ctp_paper.admission_lock(p->'admission');
 SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND event_id=(p->>'eventId')::uuid;
 IF FOUND THEN
  IF w.request IS DISTINCT FROM p THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF w.response_hash<>sha256(convert_to(w.response::text,'UTF8')) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF read_only THEN RETURN jsonb_build_object('kind','COMMITTED','request',p,'receipt',w.response->'receipt'); END IF;
  RETURN w.response;
 END IF;
 SELECT * INTO original FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=(p->'admission'->>'intentId')::uuid;
 IF FOUND AND (original.request IS DISTINCT FROM p->'admission' OR original.reservation_id<>(p->>'reservationId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 IF read_only THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
 IF original.reservation_id IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND reservation_id=original.reservation_id)
  OR EXISTS(SELECT 1 FROM ctp_paper.admission_unknown_event WHERE tenant_id=t AND (reservation_id=original.reservation_id OR event_id=(p->>'eventId')::uuid))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 IF original.response_hash<>sha256(convert_to(original.response::text,'UTF8')) OR original.source_hash<>sha256(convert_to(original.source::text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF (SELECT count(*) FROM(SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' LIMIT 101) bounded)>100
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=original.order_id FOR UPDATE;
 IF NOT FOUND OR o.mode<>'PAPER' OR o."accountId"<>original.account_id OR o."intentId"<>original.intent_id
  OR o.status<>'CREATED' OR o.version<>0 OR o."filledQuantity"<>0 OR o."averageFillPrice"<>0
  OR o."connectionId" IS NOT NULL OR o."exchangeOrderId" IS NOT NULL OR o."lastExchangeAt" IS NOT NULL
  OR o."terminalAt" IS NOT NULL OR o."reconciliationState"<>'REQUIRED'
  OR EXISTS(SELECT 1 FROM public.submission_attempt WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM public.fill WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM ctp_execution.evidence WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM ctp_execution.progress WHERE "tenantId"=t AND "orderId"=o.id
   AND ("nativeAt" IS NOT NULL OR "nativeHash" IS NOT NULL OR "nativeStatus" IS NOT NULL))
  OR EXISTS(SELECT 1 FROM public.order_intent WHERE "tenantId"=t AND "targetOrderId"=o.id)
  OR EXISTS(SELECT 1 FROM ctp_execution.command WHERE "tenantId"=t AND "orderId"=o.id AND "intentId"<>original.intent_id)
  OR (SELECT count(*) FROM public.order_event WHERE "tenantId"=t AND "orderId"=o.id)<>1
  OR NOT EXISTS(SELECT 1 FROM public.order_event WHERE "tenantId"=t AND "orderId"=o.id AND version=0
   AND "previousStatus" IS NULL AND status='CREATED' AND source='CREATE' AND "sourceIdentity"=original.intent_id::text
   AND "attemptId" IS NULL AND "evidenceHash"=decode(p->'admission'->>'commandHash','hex') AND "occurredAt">=o."createdAt" AND "occurredAt"<=clock_timestamp())
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 ctx:=ctp_paper.admission_book(jsonb_build_object('tenantId',t::text,'accountId',original.account_id::text,'mode','PAPER'));
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=original.book_id AND "accountId"=original.account_id AND mode='PAPER' FOR UPDATE;
 IF NOT FOUND OR ctx->>'bookId' IS DISTINCT FROM b.id::text THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO r FROM public.risk_reservation WHERE "tenantId"=t AND id=original.reservation_id FOR UPDATE;
 IF NOT FOUND OR r.status<>'ACTIVE' OR r.version<>0 OR r."consumedAmount"<>0 OR r."releasedAt" IS NOT NULL
  OR r."vectorSize" IS DISTINCT FROM 1 OR r."paperLegacy" OR r.asset IS NOT NULL OR r.amount IS NOT NULL
  OR r."budgetId" IS NOT NULL OR r."decisionId"<>original.decision_id OR r."intentId"<>original.intent_id
  OR r."accountId"<>original.account_id THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO j FROM ctp_paper.reservation_state_event WHERE tenant_id=t AND reservation_id=r.id ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND OR j.revision<>1 OR j.status<>'ACTIVE' THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 SELECT * INTO d FROM ctp_paper.reservation_debit WHERE tenant_id=t AND reservation_id=r.id AND ordinal=1;
 IF NOT FOUND OR original.response->'debits' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('asset',d.asset,'amount',trim_scale(d.amount)::text,'holdId',d.hold_id::text))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO watermark FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=b.id AND "holdId"=d.hold_id::text;
 hold:=jsonb_build_object('id',d.hold_id::text,'asset',d.asset,'amount',trim_scale(d.amount)::text,'status','RESERVED','reflected',false);
 IF NOT FOUND OR watermark.released OR watermark.unknown OR watermark.timestamp<>original.created_ms
  OR watermark.fingerprint<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8'))
  OR (SELECT count(*) FROM jsonb_array_elements(b.state::jsonb->'holds') q WHERE q->>'id'=d.hold_id::text)<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.state::jsonb->'holds') q WHERE q=hold)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF now_ms<greatest(original.created_ms,j.observed_ms,watermark.timestamp)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 response:=jsonb_build_object('kind','WITHDRAWN','request',p,'receipt',jsonb_build_object(
  'outcome','NOT_SENT','collateral','RETAINED','eventId',p->>'eventId','reservationId',r.id::text,
  'orderId',o.id::text,'intentId',original.intent_id::text,'decisionId',original.decision_id::text,
  'commandHash',p->'admission'->>'commandHash','stateRevision','1','observedAt',now_ms,
  'bookId',b.id::text,'bookRevision',b.revision::text,'bookHash',encode(b.state_hash,'hex')));
 INSERT INTO ctp_paper.withdrawal_barrier(tenant_id,event_id,reservation_id,intent_id,order_id,account_id,decision_id,
  command_hash,book_id,book_revision,book_hash,observed_ms,request,response,response_hash)
 VALUES(t,(p->>'eventId')::uuid,r.id,original.intent_id,o.id,original.account_id,original.decision_id,
  decode(p->'admission'->>'commandHash','hex'),b.id,b.revision,b.state_hash,now_ms,p,response,sha256(convert_to(response::text,'UTF8')));
 RETURN response;
END $$;

-- Preserve all published bodies under private aliases. The role still has only
-- the two fixed RPCs; historical readonly reconciliation never grants dispatch.
ALTER FUNCTION ctp_paper.evaluate_and_reserve(jsonb) RENAME TO evaluate_and_reserve_v54;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v54;
REVOKE ALL ON FUNCTION ctp_paper.evaluate_and_reserve_v54(jsonb),ctp_paper.reconcile_admission_v54(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; admission jsonb; BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_WITHDRAW_BEFORE_DISPATCH' THEN RETURN ctp_paper.withdraw_before_dispatch(p,false); END IF;
 admission:=CASE WHEN p->>'kind'='PAPER_RESERVATION_UNKNOWN' THEN p->'admission' ELSE p END;
 t:=ctp_paper.admission_lock(admission);
 IF EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND intent_id=(admission->>'intentId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF p->>'kind'='PAPER_RESERVATION_UNKNOWN' AND EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND event_id=(p->>'eventId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 RETURN ctp_paper.evaluate_and_reserve_v54(p);
END $$;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_WITHDRAW_BEFORE_DISPATCH' THEN RETURN ctp_paper.withdraw_before_dispatch(p,true); END IF;
 RETURN ctp_paper.reconcile_admission_v54(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.check_withdrawal_cause(),ctp_paper.guard_withdrawal(),ctp_paper.withdraw_before_dispatch(jsonb,boolean),
 ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
