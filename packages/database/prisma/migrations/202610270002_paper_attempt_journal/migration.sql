BEGIN;
-- Preparation/history only: no positive START, permit, fill or monetary effect.
-- Published1-58 remain immutable; existing orders acquire no inferred authority.
CREATE TABLE ctp_paper.attempt_preparation (
 tenant_id uuid NOT NULL, preparation_key text NOT NULL CHECK(preparation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 attempt_id uuid NOT NULL, intent_id uuid NOT NULL, reservation_id uuid NOT NULL,
 prepared_ms bigint NOT NULL CHECK(prepared_ms BETWEEN 0 AND 8640000000000000),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=16384),
 state jsonb NOT NULL CHECK(octet_length(state::text)<=32768),
 state_hash bytea NOT NULL CHECK(state_hash=sha256(convert_to(state::text,'UTF8'))),
 PRIMARY KEY(tenant_id,preparation_key), UNIQUE(tenant_id,attempt_id), UNIQUE(tenant_id,intent_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES ctp_paper.admission_issuance(tenant_id,reservation_id)
);
CREATE TABLE ctp_paper.attempt_not_sent (
 tenant_id uuid NOT NULL, stop_key text NOT NULL CHECK(stop_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 attempt_id uuid NOT NULL, withdrawal_event_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=16384),
 state jsonb NOT NULL CHECK(octet_length(state::text)<=32768),
 state_hash bytea NOT NULL CHECK(state_hash=sha256(convert_to(state::text,'UTF8'))),
 PRIMARY KEY(tenant_id,stop_key), UNIQUE(tenant_id,attempt_id),
 FOREIGN KEY(tenant_id,attempt_id) REFERENCES ctp_paper.attempt_preparation(tenant_id,attempt_id),
 FOREIGN KEY(tenant_id,withdrawal_event_id) REFERENCES ctp_paper.withdrawal_barrier(tenant_id,event_id)
);
ALTER TABLE ctp_paper.attempt_preparation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.attempt_preparation FORCE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.attempt_not_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.attempt_not_sent FORCE ROW LEVEL SECURITY;
CREATE POLICY attempt_preparation_tenant ON ctp_paper.attempt_preparation
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY attempt_not_sent_tenant ON ctp_paper.attempt_not_sent
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON ctp_paper.attempt_preparation,ctp_paper.attempt_not_sent FROM PUBLIC,ctp_paper_risk_admission;
CREATE TRIGGER attempt_preparation_immutable BEFORE UPDATE OR DELETE ON ctp_paper.attempt_preparation
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER attempt_preparation_no_truncate BEFORE TRUNCATE ON ctp_paper.attempt_preparation
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER attempt_not_sent_immutable BEFORE UPDATE OR DELETE ON ctp_paper.attempt_not_sent
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER attempt_not_sent_no_truncate BEFORE TRUNCATE ON ctp_paper.attempt_not_sent
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.prepared_attempt(p jsonb,attempt uuid,prepared bigint) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i ctp_paper.admission_issuance%ROWTYPE; c ctp_execution.command%ROWTYPE; r jsonb; t uuid:=(p->'admission'->'binding'->>'tenantId')::uuid;
BEGIN
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=(p->'admission'->>'intentId')::uuid;
 IF NOT FOUND OR i.request IS DISTINCT FROM p->'admission'
  OR i.response_hash<>sha256(convert_to(i.response::text,'UTF8')) OR i.source_hash<>sha256(convert_to(i.source::text,'UTF8'))
  OR prepared<i.created_ms OR prepared>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
  OR prepared>=(i.response->'receipt'->>'expiresAt')::bigint
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO c FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=i.intent_id;
 IF NOT FOUND OR c."orderId"<>i.order_id OR c.operation<>'PLACE' OR c.binding::jsonb IS DISTINCT FROM i.request->'binding'
  OR encode(c."commandHash",'hex') IS DISTINCT FROM i.request->>'commandHash'
  OR c.command::jsonb->>'side' IS DISTINCT FROM 'BUY' OR c.command::jsonb->>'type' NOT IN('LIMIT','MARKET')
  OR c.command::jsonb->'trigger' IS DISTINCT FROM 'null'::jsonb OR c.command::jsonb->'reduceOnly' IS DISTINCT FROM 'false'::jsonb
  OR c.command::jsonb->'size'->>'kind' IS DISTINCT FROM 'BASE_QUANTITY'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 r:=jsonb_build_object('attemptId',attempt::text,'preparedAt',prepared,'admission',jsonb_build_object(
  'binding',i.request->'binding','orderId',i.order_id::text,'intentId',i.intent_id::text,'decisionId',i.decision_id::text,
  'reservationId',i.reservation_id::text,'dbInstrumentId',c.draft::jsonb->'dbInstrumentId','dbRuleId',i.rule_id::text,
  'command',c.command::jsonb,'commandHash',encode(c."commandHash",'hex'),
  'admissionSequence',i.response->'certificate'->'revision','admittedAt',i.created_ms,'expiresAt',i.response->'receipt'->'expiresAt'));
 RETURN jsonb_build_object('kind','PAPER_EXECUTION_ATTEMPT','version','paper-pristine-attempt-v1','request',r,
  'requestHash',encode(sha256(convert_to(ctp_admission.canonical(r),'UTF8')),'hex'),'revision','1','phase','PREPARED',
  'startedAt',NULL,'lastEvent',jsonb_build_object('id',attempt::text,'kind','PREPARE','at',prepared));
END $$;

CREATE FUNCTION ctp_paper.check_attempt_journal_cause() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ctp_paper.attempt_preparation%ROWTYPE; w ctp_paper.withdrawal_barrier%ROWTYPE; expected jsonb;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='attempt_preparation' THEN
  IF NOT coalesce(ctp_market.snapshot_keys(NEW.request,ARRAY['key','admission']),false)
   OR NEW.request->>'key' IS DISTINCT FROM NEW.preparation_key
   OR NEW.request->'admission'->>'intentId' IS DISTINCT FROM NEW.intent_id::text
   OR NEW.state->'request'->'admission'->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text
   OR NEW.state IS DISTINCT FROM ctp_paper.prepared_attempt(NEW.request,NEW.attempt_id,NEW.prepared_ms)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO j FROM ctp_paper.attempt_preparation WHERE tenant_id=NEW.tenant_id AND attempt_id=NEW.attempt_id;
  IF NOT FOUND OR j.state_hash<>sha256(convert_to(j.state::text,'UTF8'))
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
  SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=NEW.tenant_id AND event_id=NEW.withdrawal_event_id;
  IF NOT FOUND OR w.reservation_id<>j.reservation_id OR w.intent_id<>j.intent_id
   OR w.request->'admission' IS DISTINCT FROM j.request->'admission'
   OR w.response_hash<>sha256(convert_to(w.response::text,'UTF8')) OR w.observed_ms<j.prepared_ms
   OR NEW.request->>'reason' NOT IN('CONTROL','DEADLINE','AUTHORIZATION','RULES','HEALTH','CANCELLED')
   OR NOT coalesce(ctp_market.snapshot_keys(NEW.request,ARRAY['key','admission','stopKey','reason']),false)
   OR NEW.request-'stopKey'-'reason' IS DISTINCT FROM j.request OR NEW.request->>'stopKey' IS DISTINCT FROM NEW.stop_key
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
  expected:=j.state||jsonb_build_object('revision','2','phase','NOT_SENT','lastEvent',jsonb_build_object(
   'id',w.event_id::text,'kind','NOT_SENT','expectedRevision','1','at',w.observed_ms,'reason',NEW.request->>'reason'));
  IF NEW.state IS DISTINCT FROM expected THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attempt_preparation_cause BEFORE INSERT ON ctp_paper.attempt_preparation
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_attempt_journal_cause();
CREATE TRIGGER attempt_not_sent_cause BEFORE INSERT ON ctp_paper.attempt_not_sent
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_attempt_journal_cause();

CREATE FUNCTION ctp_paper.attempt_journal(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r jsonb:=p->'admission'; auth jsonb:=p->'authorization'; stop boolean:=p->>'kind'='PAPER_ATTEMPT_STOP';
 t uuid; a uuid; j ctp_paper.attempt_preparation%ROWTYPE; s ctp_paper.attempt_not_sent%ROWTYPE;
 w ctp_paper.withdrawal_barrier%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 sem jsonb; result jsonb; head jsonb; receipt jsonb:='null'; k text; value jsonb; now_ms bigint; attempt uuid;
BEGIN
 IF p IS NULL OR octet_length(p::text)>16384 OR p->>'kind' NOT IN('PAPER_ATTEMPT_PREPARE','PAPER_ATTEMPT_STOP')
  OR NOT coalesce(ctp_market.snapshot_keys(p,CASE WHEN stop THEN ARRAY['kind','key','admission','authorization','stopKey','reason']
   ELSE ARRAY['kind','key','admission','authorization'] END),false)
  OR NOT coalesce(ctp_market.snapshot_keys(auth,ARRAY['permissionEpoch','userSessionEpoch']),false)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOREACH k IN ARRAY CASE WHEN stop THEN ARRAY['key','stopKey'] ELSE ARRAY['key'] END LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 IF stop AND (jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR p->>'reason' NOT IN('CONTROL','DEADLINE','AUTHORIZATION','RULES','HEALTH','CANCELLED'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOR value IN SELECT v FROM jsonb_each(auth) x(k,v) LOOP
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' !~ '^(0|[1-9][0-9]{0,18})$'
   OR (value#>>'{}')::numeric>9223372036854775807 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 IF (auth->>'userSessionEpoch')::numeric>2147483647 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 -- Published lock order: GLOBAL -> tenant -> user; current ownership/auth
 -- remains mandatory even when only returning immutable historical content.
 t:=ctp_paper.admission_lock(r); a:=(r->'binding'->>'accountId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t AND "sessionEpoch"=(auth->>'userSessionEpoch')::integer)
  OR NOT EXISTS(SELECT 1 FROM public.exchange_account WHERE "tenantId"=t AND id=a AND "permissionEpoch"=(auth->>'permissionEpoch')::bigint)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 sem:=p-'kind'-'authorization';
 SELECT * INTO j FROM ctp_paper.attempt_preparation WHERE tenant_id=t AND preparation_key=p->>'key';
 IF j.attempt_id IS NOT NULL THEN
  IF j.request IS DISTINCT FROM sem-'stopKey'-'reason' THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF j.state_hash<>sha256(convert_to(j.state::text,'UTF8')) OR j.state IS DISTINCT FROM ctp_paper.prepared_attempt(j.request,j.attempt_id,j.prepared_ms)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM ctp_paper.attempt_preparation WHERE tenant_id=t AND intent_id=(r->>'intentId')::uuid)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF read_only THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
  IF stop THEN RAISE EXCEPTION 'PAPER_ADMISSION_MISSING'; END IF;
  -- Complete authenticated pristine inventory and current metadata. This read
  -- cannot adopt a book. It is still not the future final Risk dispatch gate.
  PERFORM ctp_paper.capture_execution_candidates(jsonb_build_object('kind','PAPER_EXECUTION_CAPTURE','admission',r,'authorization',auth));
  SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=(r->>'intentId')::uuid;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF now_ms>=(i.response->'receipt'->>'expiresAt')::bigint THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
  attempt:=gen_random_uuid(); head:=ctp_paper.prepared_attempt(sem,attempt,now_ms);
  INSERT INTO ctp_paper.attempt_preparation(tenant_id,preparation_key,attempt_id,intent_id,reservation_id,prepared_ms,request,state,state_hash)
   VALUES(t,p->>'key',attempt,i.intent_id,i.reservation_id,now_ms,sem,head,sha256(convert_to(head::text,'UTF8'))) RETURNING * INTO j;
 END IF;
 SELECT * INTO s FROM ctp_paper.attempt_not_sent WHERE tenant_id=t AND attempt_id=j.attempt_id;
 IF stop THEN
  IF EXISTS(SELECT 1 FROM ctp_paper.attempt_not_sent WHERE tenant_id=t AND stop_key=p->>'stopKey' AND request IS DISTINCT FROM sem)
   OR (s.attempt_id IS NOT NULL AND s.request IS DISTINCT FROM sem) THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  IF s.attempt_id IS NULL THEN
   IF read_only THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
   SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND reservation_id=j.reservation_id;
   IF w.event_id IS NULL THEN
    result:=ctp_paper.withdraw_before_dispatch(jsonb_build_object('kind','PAPER_WITHDRAW_BEFORE_DISPATCH','admission',r,
     'reservationId',j.reservation_id::text,'eventId',gen_random_uuid()::text,'expectedRevision','1'),false);
    SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND reservation_id=j.reservation_id;
   ELSE
    result:=ctp_paper.withdraw_before_dispatch(w.request,true);
    IF result->>'kind' IS DISTINCT FROM 'COMMITTED' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   END IF;
   head:=j.state||jsonb_build_object('revision','2','phase','NOT_SENT','lastEvent',jsonb_build_object(
    'id',w.event_id::text,'kind','NOT_SENT','expectedRevision','1','at',w.observed_ms,'reason',p->>'reason'));
   INSERT INTO ctp_paper.attempt_not_sent(tenant_id,stop_key,attempt_id,withdrawal_event_id,request,state,state_hash)
    VALUES(t,p->>'stopKey',j.attempt_id,w.event_id,sem,head,sha256(convert_to(head::text,'UTF8'))) RETURNING * INTO s;
  END IF;
 END IF;
 head:=j.state;
 IF s.attempt_id IS NOT NULL THEN
  SELECT * INTO w FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND event_id=s.withdrawal_event_id;
  IF NOT FOUND OR s.state_hash<>sha256(convert_to(s.state::text,'UTF8')) OR w.response_hash<>sha256(convert_to(w.response::text,'UTF8'))
   OR w.reservation_id<>j.reservation_id OR s.request-'stopKey'-'reason' IS DISTINCT FROM j.request
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  head:=j.state||jsonb_build_object('revision','2','phase','NOT_SENT','lastEvent',jsonb_build_object(
   'id',w.event_id::text,'kind','NOT_SENT','expectedRevision','1','at',w.observed_ms,'reason',s.request->>'reason'));
  IF s.state IS DISTINCT FROM head THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  receipt:=w.response->'receipt';
 END IF;
 RETURN jsonb_build_object('kind',CASE WHEN read_only THEN 'COMMITTED' WHEN stop THEN 'STOPPED' ELSE 'PREPARED' END,
  'request',p,'preparation',j.state,'state',head,'withdrawal',receipt);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT';
END $$;

ALTER FUNCTION ctp_paper.evaluate_and_reserve(jsonb) RENAME TO evaluate_and_reserve_v58;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v58;
CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind' IN('PAPER_ATTEMPT_PREPARE','PAPER_ATTEMPT_STOP') THEN RETURN ctp_paper.attempt_journal(p,false); END IF;
 RETURN ctp_paper.evaluate_and_reserve_v58(p);
END $$;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind' IN('PAPER_ATTEMPT_PREPARE','PAPER_ATTEMPT_STOP') THEN RETURN ctp_paper.attempt_journal(p,true); END IF;
 RETURN ctp_paper.reconcile_admission_v58(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.prepared_attempt(jsonb,uuid,bigint),ctp_paper.check_attempt_journal_cause(),
 ctp_paper.attempt_journal(jsonb,boolean),ctp_paper.evaluate_and_reserve_v58(jsonb),ctp_paper.reconcile_admission_v58(jsonb),
 ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
