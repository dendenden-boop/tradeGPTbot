BEGIN;
-- No financial write, native observation or dispatch authority. Published1-56
-- stay immutable. This private cause is inserted before its exact common rows
-- and validated again by a deferred constraint before the transaction commits.
CREATE TABLE ctp_paper.unsent_cancellation (
 tenant_id uuid NOT NULL, order_id uuid NOT NULL, place_intent_id uuid NOT NULL,
 intent_id uuid NOT NULL, event_id uuid NOT NULL, reservation_id uuid NOT NULL,
 key text NOT NULL CHECK(length(key) BETWEEN 1 AND 128),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=16384),
 before_order jsonb NOT NULL CHECK(octet_length(before_order::text)<=16384),
 intent_row jsonb NOT NULL CHECK(octet_length(intent_row::text)<=16384),
 command_row jsonb NOT NULL CHECK(octet_length(command_row::text)<=32768),
 event_row jsonb NOT NULL CHECK(octet_length(event_row::text)<=16384),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=65536),
 response_hash bytea NOT NULL CHECK(response_hash=sha256(convert_to(response::text,'UTF8'))),
 observed_ms bigint NOT NULL CHECK(observed_ms BETWEEN 0 AND 8640000000000000),
 permission_epoch bigint NOT NULL CHECK(permission_epoch>=0),
 session_epoch integer NOT NULL CHECK(session_epoch>=0),
 PRIMARY KEY(tenant_id,order_id), UNIQUE(tenant_id,intent_id), UNIQUE(tenant_id,event_id), UNIQUE(tenant_id,key),
 UNIQUE(tenant_id,reservation_id), UNIQUE(tenant_id,place_intent_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES ctp_paper.admission_issuance(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,intent_id) REFERENCES public.order_intent("tenantId",id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(order_id<>place_intent_id AND intent_id<>place_intent_id AND intent_id<>order_id AND event_id<>intent_id)
);
ALTER TABLE ctp_paper.unsent_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.unsent_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY cancellation_tenant ON ctp_paper.unsent_cancellation
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON ctp_paper.unsent_cancellation FROM PUBLIC;
CREATE TRIGGER cancellation_immutable BEFORE UPDATE OR DELETE ON ctp_paper.unsent_cancellation
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER cancellation_no_truncate BEFORE TRUNCATE ON ctp_paper.unsent_cancellation
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.unsent_cancel_state(o jsonb,c ctp_execution.command) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',o->'id','intentId',o->'intentId','binding',c.binding::jsonb,
  'draft',c.draft::jsonb,'command',c.command::jsonb,'status','CREATED','reconciliation','REQUIRED','version',0,
  'exchangeOrderId',NULL,'filledQuantity','0','executedQuantity','0','executionNotional','0',
  'averageFillPrice',NULL,'lastNativeStatus',NULL,'lastExchangeAt',NULL,'lastObservationHash',NULL,
  'activeAttemptId',NULL,'activeOperation',NULL,'createdAt',floor(extract(epoch FROM (o->>'createdAt')::timestamptz)*1000)::bigint)
$$;

CREATE FUNCTION ctp_paper.unsent_cancel_after(c ctp_paper.unsent_cancellation) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT c.before_order||jsonb_build_object('status','CANCELED','version',1,'reconciliationState','CONSISTENT',
  'terminalAt',to_timestamp(c.observed_ms::numeric/1000),'updatedAt',to_timestamp(c.observed_ms::numeric/1000),'isActive',false)
$$;

-- Authentic private historical authority, independent of the caller's hashes.
-- This helper permits no writes and can run before the exact common rows exist.
-- Composite row snapshots contain timestamptz JSON. Creation, historical proof
-- and full validation use function-local UTC, restored on return. Session zone
-- replacement must not change permanent identity or be an authorization flag.
CREATE FUNCTION ctp_paper.validate_unsent_cancel_origin(t uuid,oid uuid) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE x ctp_paper.unsent_cancellation%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 w ctp_paper.withdrawal_barrier%ROWTYPE; r ctp_paper.withdrawal_release%ROWTYPE;
 original public.order_intent%ROWTYPE; c ctp_execution.command%ROWTYPE;
 o jsonb; cmd jsonb; draft jsonb; command_hash bytea; request_hash bytea; receipt jsonb; source jsonb;
 at_time timestamptz; expected_intent jsonb; expected_command jsonb; expected_event jsonb;
BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO x FROM ctp_paper.unsent_cancellation WHERE tenant_id=t AND order_id=oid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND reservation_id=x.reservation_id;
 IF NOT FOUND OR ROW(x.order_id,x.place_intent_id) IS DISTINCT FROM ROW(i.order_id,i.intent_id)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 PERFORM ctp_paper.validate_withdrawal_release(t,x.reservation_id);
 SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND reservation_id=x.reservation_id;
 SELECT * INTO r FROM ctp_paper.withdrawal_release WHERE tenant_id=t AND reservation_id=x.reservation_id;
 IF w.event_id IS NULL OR r.event_id IS NULL OR x.observed_ms<r.observed_ms
  OR x.observed_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO original FROM public.order_intent WHERE "tenantId"=t AND id=i.intent_id;
 SELECT * INTO c FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=i.intent_id;
 o:=x.before_order;
 IF original.id IS NULL OR c."intentId" IS NULL OR original.operation<>'PLACE' OR original.destination<>'PAPER_ENGINE'
  OR original."targetOrderId" IS NOT NULL OR original."connectionId" IS NOT NULL OR original.mode<>'PAPER'
  OR c.operation<>'PLACE' OR c."orderId"<>oid OR c.binding::jsonb IS DISTINCT FROM i.request->'binding'
  OR c."commandHash" IS DISTINCT FROM decode(i.request->>'commandHash','hex') OR original."commandHash"<>c."commandHash"
  OR o->>'id' IS DISTINCT FROM oid::text OR o->>'intentId' IS DISTINCT FROM i.intent_id::text
  OR o->>'tenantId' IS DISTINCT FROM t::text OR o->>'accountId' IS DISTINCT FROM i.account_id::text
  OR o->>'mode' IS DISTINCT FROM 'PAPER' OR o->'connectionId' IS DISTINCT FROM 'null'::jsonb
  OR o->>'status' IS DISTINCT FROM 'CREATED' OR o->'version' IS DISTINCT FROM '0'::jsonb
  OR o->>'reconciliationState' IS DISTINCT FROM 'REQUIRED' OR (o->>'filledQuantity')::numeric<>0
  OR (o->>'averageFillPrice')::numeric<>0 OR o->'exchangeOrderId' IS DISTINCT FROM 'null'::jsonb
  OR o->'lastExchangeAt' IS DISTINCT FROM 'null'::jsonb OR o->'terminalAt' IS DISTINCT FROM 'null'::jsonb
  OR o->>'side' IS DISTINCT FROM 'BUY' OR o->>'market' IS DISTINCT FROM 'SPOT'
  OR o->>'orderType' NOT IN('MARKET','LIMIT') OR (o->>'reduceOnly')::boolean
  OR o->>'timeInForce'='POST_ONLY' OR (o->>'orderType'='MARKET' AND o->'timeInForce' IS DISTINCT FROM 'null'::jsonb)
  OR (c.command::jsonb)->'trigger' IS DISTINCT FROM 'null'::jsonb
  OR (c.command::jsonb)->'size'->>'kind' IS DISTINCT FROM 'BASE_QUANTITY'
  OR (c.draft::jsonb)->'order' IS DISTINCT FROM c.command::jsonb-'clientOrderId'
  OR (c.command::jsonb)->>'clientOrderId' IS DISTINCT FROM o->>'clientId'
  OR o->>'instrumentId' IS DISTINCT FROM original."instrumentId"::text OR o->>'ruleVersionId' IS DISTINCT FROM original."ruleVersionId"::text
  OR o->>'accountId' IS DISTINCT FROM original."accountId"::text OR original."triggerPrice" IS NOT NULL
  OR o->'parentAlgoOrderId' IS DISTINCT FROM 'null'::jsonb OR o->'tradeId' IS DISTINCT FROM 'null'::jsonb
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['side','positionSide','orderType','timeInForce','quantityAsset','priceAsset','quantity','limitPrice','reduceOnly']) field
   WHERE o->field IS DISTINCT FROM to_jsonb(original)->field)
  OR c."commandHash"<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('operation','createOrder','command',c.command::jsonb,'binding',c.binding::jsonb)),'UTF8'))
  OR x.request IS DISTINCT FROM jsonb_build_object('binding',c.binding::jsonb,'orderId',oid::text,'operation','CANCEL','key',x.key)
  OR x.response_hash<>sha256(convert_to(x.response::text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 cmd:=jsonb_build_object('instrumentId',c.command::jsonb->'instrumentId','locator',jsonb_build_object('kind','CLIENT_ID','id',o->>'clientId'));
 draft:=(c.draft::jsonb)||jsonb_build_object('key',x.key);
 command_hash:=sha256(convert_to(ctp_admission.canonical(jsonb_build_object('operation','cancelOrder','command',cmd,'binding',c.binding::jsonb)),'UTF8'));
 request_hash:=sha256(convert_to(ctp_admission.canonical(x.request-'key'),'UTF8'));
 at_time:=to_timestamp(x.observed_ms::numeric/1000);
 expected_intent:=to_jsonb(original)||jsonb_build_object('id',x.intent_id::text,'operation','CANCEL','idempotencyKey',x.key,
  'targetOrderId',oid::text,'origin','USER','signalId',NULL,'expiresAt',NULL,'commandHash',command_hash,'createdAt',at_time);
 expected_command:=jsonb_build_object('tenantId',t::text,'intentId',x.intent_id::text,'orderId',oid::text,
  'binding',c.binding,'draft',ctp_admission.canonical(draft),'command',ctp_admission.canonical(cmd),'operation','CANCEL',
  'requestHash',request_hash,'commandHash',command_hash);
 receipt:=jsonb_build_object('outcome','NOT_SENT','collateral','RELEASED','orderId',oid::text,'placeIntentId',i.intent_id::text,
  'intentId',x.intent_id::text,'eventId',x.event_id::text,'clientOrderId',o->>'clientId','requestHash',encode(request_hash,'hex'),
  'command',cmd,'commandHash',encode(command_hash,'hex'),'status','CANCELED','version','1','canceledAt',x.observed_ms,
  'reservationId',x.reservation_id::text,'withdrawalEventId',w.event_id::text,'releaseEventId',r.event_id::text);
 source:=jsonb_build_object('state',ctp_paper.unsent_cancel_state(o,c),'withdrawal',w.response->'receipt','release',r.response->'receipt');
 expected_event:=jsonb_build_object('id',x.event_id::text,'tenantId',t::text,'orderId',oid::text,'attemptId',NULL,'version',1,
  'previousStatus','CREATED','status','CANCELED','source','PAPER_NOT_SENT_CANCEL','sourceIdentity',x.intent_id::text,
  'evidenceHash',x.response_hash,'occurredAt',at_time,'createdAt',at_time);
 IF x.intent_row IS DISTINCT FROM expected_intent OR x.command_row IS DISTINCT FROM expected_command
  OR x.event_row IS DISTINCT FROM expected_event
  OR x.response IS DISTINCT FROM jsonb_build_object('kind','CANCELED','request',x.request,'source',source,'receipt',receipt)
  OR EXISTS(SELECT 1 FROM public.submission_attempt WHERE "tenantId"=t AND "orderId"=oid)
  OR EXISTS(SELECT 1 FROM public.fill WHERE "tenantId"=t AND "orderId"=oid)
  OR EXISTS(SELECT 1 FROM ctp_execution.evidence WHERE "tenantId"=t AND "orderId"=oid)
  OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event WHERE "tenantId"=t AND "orderId"=oid)
  OR NOT EXISTS(SELECT 1 FROM ctp_execution.progress WHERE "tenantId"=t AND "orderId"=oid
   AND "nativeAt" IS NULL AND "nativeHash" IS NULL AND "nativeStatus" IS NULL)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
END $$;

CREATE FUNCTION ctp_paper.validate_unsent_cancellation(t uuid,oid uuid) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE x ctp_paper.unsent_cancellation%ROWTYPE;
BEGIN
 PERFORM ctp_paper.validate_unsent_cancel_origin(t,oid);
 SELECT * INTO x FROM ctp_paper.unsent_cancellation WHERE tenant_id=t AND order_id=oid;
 IF NOT EXISTS(SELECT 1 FROM public."order" q WHERE q."tenantId"=t AND q.id=oid AND to_jsonb(q)=ctp_paper.unsent_cancel_after(x))
  OR NOT EXISTS(SELECT 1 FROM public.order_intent q WHERE q."tenantId"=t AND q.id=x.intent_id AND to_jsonb(q)=x.intent_row)
  OR NOT EXISTS(SELECT 1 FROM ctp_execution.command q WHERE q."tenantId"=t AND q."intentId"=x.intent_id AND to_jsonb(q)=x.command_row)
  OR NOT EXISTS(SELECT 1 FROM public.order_event q WHERE q."tenantId"=t AND q.id=x.event_id AND to_jsonb(q)=x.event_row)
  OR (SELECT count(*) FROM public.order_intent WHERE "tenantId"=t AND "targetOrderId"=oid)<>1
  OR (SELECT count(*) FROM ctp_execution.command WHERE "tenantId"=t AND "orderId"=oid)<>2
  OR (SELECT count(*) FROM public.order_event WHERE "tenantId"=t AND "orderId"=oid)<>2
  OR NOT EXISTS(SELECT 1 FROM public.order_event e WHERE e."tenantId"=t AND e."orderId"=oid AND e.version=0
   AND e."previousStatus" IS NULL AND e.status='CREATED' AND e.source='CREATE' AND e."sourceIdentity"=x.place_intent_id::text
   AND e."attemptId" IS NULL AND e."evidenceHash"=decode(x.response->'source'->'withdrawal'->>'commandHash','hex')
   AND e."occurredAt">=(x.before_order->>'createdAt')::timestamptz AND e."occurredAt"<=to_timestamp(x.observed_ms::numeric/1000))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
END $$;
CREATE FUNCTION ctp_paper.check_unsent_cancellation() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM ctp_paper.validate_unsent_cancellation(NEW.tenant_id,NEW.order_id); RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER cancellation_cause AFTER INSERT ON ctp_paper.unsent_cancellation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_unsent_cancellation();

-- A local cause is no general bypass: only these four exact common operations
-- can materialize it. Existing attempt/fill/native/control rejection survives.
CREATE OR REPLACE FUNCTION ctp_paper.guard_withdrawal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE raw jsonb; versions jsonb[]; t uuid; target uuid; paper boolean; x ctp_paper.unsent_cancellation%ROWTYPE; permitted boolean;
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
  -- BEGIN EXACT CANCEL CAUSE
  IF EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND order_id=target) THEN
   permitted:=false;
   SELECT * INTO x FROM ctp_paper.unsent_cancellation WHERE tenant_id=t AND order_id=target;
   IF FOUND THEN
    PERFORM ctp_paper.validate_unsent_cancel_origin(t,target);
    IF TG_OP='INSERT' THEN
     permitted:=(TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='order_intent' AND to_jsonb(NEW)=x.intent_row)
      OR (TG_TABLE_SCHEMA='ctp_execution' AND TG_TABLE_NAME='command' AND to_jsonb(NEW)=x.command_row)
      OR (TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='order_event' AND to_jsonb(NEW)=x.event_row);
    ELSIF TG_OP='UPDATE' AND TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='order' THEN
     permitted:=to_jsonb(OLD)=x.before_order AND to_jsonb(NEW)-'isActive'=ctp_paper.unsent_cancel_after(x)-'isActive';
    END IF;
   END IF;
   IF NOT coalesce(permitted,false) THEN RAISE EXCEPTION 'PAPER_WITHDRAWN_NOT_SENT' USING ERRCODE='23514'; END IF;
  END IF;
  -- END EXACT CANCEL CAUSE
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION ctp_paper.cancel_unsent(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; b jsonb:=p->'binding'; auth jsonb:=p->'authorization'; k text; owner jsonb; sem jsonb;
 a public.exchange_account%ROWTYPE; config ctp_paper.configuration%ROWTYPE; ident jsonb;
 i ctp_paper.admission_issuance%ROWTYPE; w ctp_paper.withdrawal_barrier%ROWTYPE; r ctp_paper.withdrawal_release%ROWTYPE;
 o public."order"%ROWTYPE; original public.order_intent%ROWTYPE; c ctp_execution.command%ROWTYPE;
 x ctp_paper.unsent_cancellation%ROWTYPE; cmd jsonb; draft jsonb; command_hash bytea; request_hash bytea;
 source jsonb; receipt jsonb; at_time timestamptz; result jsonb;
BEGIN
 IF p IS NULL OR octet_length(p::text)>16384 OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','binding','orderId','key','authorization']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_CANCEL_UNSENT'
  OR NOT coalesce(ctp_market.snapshot_keys(b,ARRAY['tenantId','accountId','mode','connectionId','externalAccountId','profile']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(b->'profile',ARRAY['exchange','region','market','environment','accountMode','profileVersion','endpointProfileId']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(auth,ARRAY['permissionEpoch','userSessionEpoch']),false)
  OR jsonb_typeof(p->'key') IS DISTINCT FROM 'string' OR length(p->>'key') NOT BETWEEN 1 AND 128 OR p->>'key' ~ '[[:space:][:cntrl:]]'
  OR jsonb_typeof(p->'orderId') IS DISTINCT FROM 'string' OR p->>'orderId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR b->>'mode' IS DISTINCT FROM 'PAPER' OR b->'connectionId' IS DISTINCT FROM 'null'::jsonb
  OR b->'profile'->>'market' IS DISTINCT FROM 'SPOT' OR b->'profile'->>'accountMode' IS DISTINCT FROM 'SIMULATED'
  OR b->'profile'->>'profileVersion' IS DISTINCT FROM 'spot-l2-taker-v1' OR b->'profile'->>'endpointProfileId' IS DISTINCT FROM 'paper-spot-v1'
  OR NOT coalesce(ctp_registry.valid_scope((b->'profile')-ARRAY['accountMode','profileVersion','endpointProfileId']),false)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOREACH k IN ARRAY ARRAY['permissionEpoch','userSessionEpoch'] LOOP
  IF jsonb_typeof(auth->k) IS DISTINCT FROM 'string' OR auth->>k !~ '^(0|[1-9][0-9]{0,18})$'
   OR (auth->>k)::numeric>(CASE WHEN k='permissionEpoch' THEN 9223372036854775807 ELSE 2147483647 END)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 owner:=jsonb_build_object('tenantId',b->'tenantId','accountId',b->'accountId','mode','PAPER');
 IF NOT coalesce(ctp_paper.valid_owner(owner),false) OR b->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 t:=(b->>'tenantId')::uuid;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 PERFORM 1 FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL AND "sessionEpoch"=(auth->>'userSessionEpoch')::integer FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 IF (SELECT count(*) FROM(SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' LIMIT 101) q)>100 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM public.exchange_account WHERE "tenantId"=t AND id=(b->>'accountId')::uuid;
 IF NOT FOUND OR a.mode<>'PAPER' OR a.status<>'ACTIVE' OR a."accountMode"<>'SIMULATED'
  OR a."permissionEpoch"<>(auth->>'permissionEpoch')::bigint OR a."externalAccountId" IS DISTINCT FROM b->>'externalAccountId'
  OR a.exchange::text IS DISTINCT FROM b->'profile'->>'exchange' OR a.region IS DISTINCT FROM b->'profile'->>'region'
  OR EXISTS(SELECT 1 FROM public.exchange_connection WHERE "accountId"=a.id)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO config FROM ctp_paper.configuration WHERE tenant_id=t AND account_id=a.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 PERFORM ctp_paper.wire_receipt(config.receipt_text);
 ident:=ctp_paper.account_identity(owner,(b->'profile')-ARRAY['accountMode','profileVersion','endpointProfileId']);
 IF config.request->'owner' IS DISTINCT FROM owner OR config.request->'source' IS DISTINCT FROM (b->'profile')-ARRAY['accountMode','profileVersion','endpointProfileId']
  OR config.receipt_text::jsonb->'accountIdentity' IS DISTINCT FROM ident
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 sem:=jsonb_build_object('binding',b,'orderId',p->'orderId','operation','CANCEL','key',p->'key');
 -- Permanent operation-wide lookup happens before current target/rule admission.
 SELECT * INTO x FROM ctp_paper.unsent_cancellation WHERE tenant_id=t AND key=p->>'key';
 IF FOUND THEN
  IF x.request IS DISTINCT FROM sem THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  PERFORM ctp_paper.validate_unsent_cancellation(t,x.order_id);
  IF read_only THEN RETURN x.response||jsonb_build_object('kind','COMMITTED'); END IF;
  RETURN x.response;
 END IF;
 IF EXISTS(SELECT 1 FROM public.order_intent WHERE "tenantId"=t AND operation='CANCEL' AND "idempotencyKey"=p->>'key')
  OR EXISTS(SELECT 1 FROM ctp_paper.unsent_cancellation WHERE tenant_id=t AND order_id=(p->>'orderId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 IF read_only THEN RETURN jsonb_build_object('kind','MISSING','request',sem); END IF;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=(p->>'orderId')::uuid FOR UPDATE;
 IF NOT FOUND OR o.mode<>'PAPER' OR o."accountId"<>a.id THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND order_id=o.id;
 IF NOT FOUND OR i.request->'binding' IS DISTINCT FROM b THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 PERFORM ctp_paper.admission_lock(i.request);
 SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND reservation_id=i.reservation_id;
 SELECT * INTO r FROM ctp_paper.withdrawal_release WHERE tenant_id=t AND reservation_id=i.reservation_id;
 IF w.event_id IS NULL OR r.event_id IS NULL OR o.status<>'CREATED' OR o.version<>0 OR o."reconciliationState"<>'REQUIRED'
  OR o."filledQuantity"<>0 OR o."averageFillPrice"<>0 OR o."exchangeOrderId" IS NOT NULL OR o."connectionId" IS NOT NULL
  OR o."lastExchangeAt" IS NOT NULL OR o."terminalAt" IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.order_intent WHERE "tenantId"=t AND "targetOrderId"=o.id)
  OR (SELECT count(*) FROM ctp_execution.command WHERE "tenantId"=t AND "orderId"=o.id)<>1
  OR (SELECT count(*) FROM public.order_event WHERE "tenantId"=t AND "orderId"=o.id)<>1
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 PERFORM ctp_paper.admission_book(owner);
 PERFORM 1 FROM public.risk_reservation WHERE "tenantId"=t AND id=i.reservation_id FOR UPDATE;
 PERFORM ctp_paper.validate_withdrawal_release(t,i.reservation_id);
 SELECT * INTO original FROM public.order_intent WHERE "tenantId"=t AND id=i.intent_id;
 SELECT * INTO c FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=i.intent_id;
 x.tenant_id:=t; x.order_id:=o.id; x.place_intent_id:=i.intent_id; x.reservation_id:=i.reservation_id;
 x.intent_id:=gen_random_uuid(); x.event_id:=gen_random_uuid(); x.key:=p->>'key'; x.request:=sem;
 x.before_order:=to_jsonb(o); x.observed_ms:=greatest(r.observed_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
 x.permission_epoch:=a."permissionEpoch"; x.session_epoch:=(auth->>'userSessionEpoch')::integer;
 at_time:=to_timestamp(x.observed_ms::numeric/1000);
 cmd:=jsonb_build_object('instrumentId',c.command::jsonb->'instrumentId','locator',jsonb_build_object('kind','CLIENT_ID','id',o."clientId"));
 draft:=c.draft::jsonb||jsonb_build_object('key',x.key);
 command_hash:=sha256(convert_to(ctp_admission.canonical(jsonb_build_object('operation','cancelOrder','command',cmd,'binding',b)),'UTF8'));
 request_hash:=sha256(convert_to(ctp_admission.canonical(sem-'key'),'UTF8'));
 x.intent_row:=to_jsonb(original)||jsonb_build_object('id',x.intent_id::text,'operation','CANCEL','idempotencyKey',x.key,
  'targetOrderId',o.id::text,'origin','USER','signalId',NULL,'expiresAt',NULL,'commandHash',command_hash,'createdAt',at_time);
 x.command_row:=jsonb_build_object('tenantId',t::text,'intentId',x.intent_id::text,'orderId',o.id::text,'binding',c.binding,
  'draft',ctp_admission.canonical(draft),'command',ctp_admission.canonical(cmd),'operation','CANCEL','requestHash',request_hash,'commandHash',command_hash);
 receipt:=jsonb_build_object('outcome','NOT_SENT','collateral','RELEASED','orderId',o.id::text,'placeIntentId',i.intent_id::text,
  'intentId',x.intent_id::text,'eventId',x.event_id::text,'clientOrderId',o."clientId",'requestHash',encode(request_hash,'hex'),
  'command',cmd,'commandHash',encode(command_hash,'hex'),'status','CANCELED','version','1','canceledAt',x.observed_ms,
  'reservationId',x.reservation_id::text,'withdrawalEventId',w.event_id::text,'releaseEventId',r.event_id::text);
 source:=jsonb_build_object('state',ctp_paper.unsent_cancel_state(x.before_order,c),'withdrawal',w.response->'receipt','release',r.response->'receipt');
 x.response:=jsonb_build_object('kind','CANCELED','request',sem,'source',source,'receipt',receipt);
 x.response_hash:=sha256(convert_to(x.response::text,'UTF8'));
 x.event_row:=jsonb_build_object('id',x.event_id::text,'tenantId',t::text,'orderId',o.id::text,'attemptId',NULL,'version',1,
  'previousStatus','CREATED','status','CANCELED','source','PAPER_NOT_SENT_CANCEL','sourceIdentity',x.intent_id::text,
  'evidenceHash',x.response_hash,'occurredAt',at_time,'createdAt',at_time);
 INSERT INTO ctp_paper.unsent_cancellation SELECT x.*;
 PERFORM ctp_paper.validate_unsent_cancel_origin(t,o.id);
 INSERT INTO public.order_intent SELECT (jsonb_populate_record(NULL::public.order_intent,x.intent_row)).*;
 INSERT INTO ctp_execution.command SELECT (jsonb_populate_record(NULL::ctp_execution.command,x.command_row)).*;
 UPDATE public."order" SET status='CANCELED',version=1,"reconciliationState"='CONSISTENT',"terminalAt"=at_time,"updatedAt"=at_time WHERE "tenantId"=t AND id=o.id;
 INSERT INTO public.order_event SELECT (jsonb_populate_record(NULL::public.order_event,x.event_row)).*;
 INSERT INTO public.outbox_event("tenantId","eventType","schemaVersion","aggregateType","aggregateId","aggregateVersion",payload,"occurredAt")
  VALUES(t,'PaperOrderCanceled',1,'Order',o.id,1,jsonb_build_object('orderId',o.id::text,'intentId',x.intent_id::text,'eventId',x.event_id::text,'operation','CANCEL','outcome','NOT_SENT'),at_time);
 PERFORM ctp_paper.validate_unsent_cancellation(t,o.id);
 RETURN x.response;
END $$;

-- The complete inventory definition follows below. It retains every published56
-- predicate and recognizes only independently validated private terminal causes.

ALTER FUNCTION ctp_paper.admission_inventory(jsonb,bigint) RENAME TO admission_inventory_v56;
CREATE OR REPLACE FUNCTION ctp_paper.admission_inventory(p jsonb,ts bigint) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid:=(p->'binding'->>'tenantId')::uuid; target uuid:=(p->'binding'->>'accountId')::uuid;
 ids uuid[]; a uuid; b jsonb; cfg jsonb; funding jsonb; state jsonb; target_book jsonb;
 books jsonb:='[]'; balances jsonb:='[]'; holds jsonb:='[]'; reservations jsonb:='[]'; orders jsonb:='[]';
 quote text; common_quote text; i ctp_paper.admission_issuance%ROWTYPE; d ctp_paper.reservation_debit%ROWTYPE;
 r public.risk_reservation%ROWTYPE; j ctp_paper.reservation_state_event%ROWTYPE; w ctp_portfolio.hold_watermark%ROWTYPE;
 hold jsonb; event jsonb; actual_hold jsonb; total integer:=0; account_holds integer; n integer; cancel_order uuid; released_count bigint;
BEGIN
 -- The caller already holds GLOBAL -> tenant -> user. Lock the complete exact
 -- PAPER account catalog in sorted order, closing FK insertion phantoms.
 SELECT array_agg(id ORDER BY id) INTO ids FROM(SELECT id FROM public.exchange_account
  WHERE "tenantId"=t AND mode='PAPER' ORDER BY id LIMIT 101) q;
 IF ids IS NULL OR NOT(target=ANY(ids)) OR cardinality(ids)>100 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public."order" WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 FOR cancel_order IN SELECT order_id FROM ctp_paper.unsent_cancellation WHERE tenant_id=t ORDER BY order_id LOOP
  PERFORM ctp_paper.validate_unsent_cancellation(t,cancel_order);
 END LOOP;
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
   OR x."instrumentId"<>q."instrumentId" OR x."ruleVersionId"<>q."ruleVersionId")
   AND NOT EXISTS(SELECT 1 FROM ctp_paper.unsent_cancellation z WHERE z.tenant_id=t AND (z.place_intent_id=x.id OR z.intent_id=x.id)))
 OR EXISTS(SELECT 1 FROM public.submission_attempt s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
 OR EXISTS(SELECT 1 FROM ctp_execution.evidence s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
 OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.order_event e JOIN public."order" q ON q."tenantId"=e."tenantId" AND q.id=e."orderId"
  LEFT JOIN ctp_execution.command c ON c."tenantId"=q."tenantId" AND c."intentId"=q."intentId"
  WHERE q."tenantId"=t AND q.mode='PAPER' AND (e.version<>0 OR e."previousStatus" IS NOT NULL OR e.status<>'CREATED'
   OR e.source<>'CREATE' OR e."sourceIdentity" IS DISTINCT FROM q."intentId"::text OR e."evidenceHash" IS DISTINCT FROM c."commandHash"
   OR e."attemptId" IS NOT NULL OR e."occurredAt"<q."createdAt" OR e."occurredAt">clock_timestamp())
   AND NOT EXISTS(SELECT 1 FROM ctp_paper.unsent_cancellation z WHERE z.tenant_id=t AND z.order_id=e."orderId" AND z.event_id=e.id))
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

ALTER FUNCTION ctp_paper.evaluate_and_reserve(jsonb) RENAME TO evaluate_and_reserve_v56;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v56;
CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_CANCEL_UNSENT' THEN RETURN ctp_paper.cancel_unsent(p,false); END IF;
 RETURN ctp_paper.evaluate_and_reserve_v56(p);
END $$;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_CANCEL_UNSENT' THEN RETURN ctp_paper.cancel_unsent(p,true); END IF;
 RETURN ctp_paper.reconcile_admission_v56(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.evaluate_and_reserve_v56(jsonb),ctp_paper.reconcile_admission_v56(jsonb),
 ctp_paper.admission_inventory_v56(jsonb,bigint),ctp_paper.admission_inventory(jsonb,bigint),
 ctp_paper.unsent_cancel_state(jsonb,ctp_execution.command),ctp_paper.unsent_cancel_after(ctp_paper.unsent_cancellation),
 ctp_paper.validate_unsent_cancel_origin(uuid,uuid),ctp_paper.validate_unsent_cancellation(uuid,uuid),
 ctp_paper.check_unsent_cancellation(),ctp_paper.cancel_unsent(jsonb,boolean),ctp_paper.guard_withdrawal(),
 ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
