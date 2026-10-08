BEGIN;
-- Full immutable native/result evidence is required before collateral can be released.
ALTER TABLE ctp_execution.evidence ADD UNIQUE("tenantId","orderId",identity,fingerprint);
CREATE TABLE ctp_execution.authoritative_event (
 "tenantId" uuid NOT NULL,"orderId" uuid NOT NULL,identity text NOT NULL,
 fingerprint bytea NOT NULL,payload text NOT NULL CHECK(octet_length(payload)<=65536),
 CHECK(fingerprint=sha256(convert_to(payload,'UTF8'))),
 PRIMARY KEY("tenantId","orderId",identity),
 FOREIGN KEY("tenantId","orderId",identity,fingerprint) REFERENCES ctp_execution.evidence("tenantId","orderId",identity,fingerprint)
);
ALTER TABLE ctp_execution.authoritative_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_execution.authoritative_event FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_tenant ON ctp_execution.authoritative_event USING("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER execution_authority_immutable BEFORE UPDATE OR DELETE ON ctp_execution.authoritative_event FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER execution_authority_no_truncate BEFORE TRUNCATE ON ctp_execution.authoritative_event FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
REVOKE ALL ON ctp_execution.authoritative_event FROM PUBLIC;
GRANT SELECT,INSERT ON ctp_execution.authoritative_event TO ctp_execution;

CREATE TABLE ctp_admission.lifecycle_revision (
 "tenantId" uuid NOT NULL,"reservationId" uuid NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),
 "orderVersion" integer NOT NULL CHECK("orderVersion">=0),proof jsonb NOT NULL,
 fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
 status public."ReservationStatus" NOT NULL CHECK(status IN('ACTIVE','UNRESOLVED','RELEASED')),
 amount numeric NOT NULL CHECK(amount>=0 AND amount<10::numeric^30 AND scale(amount)<=18),
 "eventId" text, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY("tenantId","reservationId",sequence),
 FOREIGN KEY("tenantId","reservationId") REFERENCES public.risk_reservation("tenantId",id)
);
CREATE TABLE ctp_admission.lifecycle_head (
 "tenantId" uuid NOT NULL,"reservationId" uuid NOT NULL,sequence bigint NOT NULL,
 PRIMARY KEY("tenantId","reservationId"),
 FOREIGN KEY("tenantId","reservationId",sequence) REFERENCES ctp_admission.lifecycle_revision("tenantId","reservationId",sequence)
);
CREATE TRIGGER risk_lifecycle_immutable BEFORE UPDATE OR DELETE ON ctp_admission.lifecycle_revision FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER risk_lifecycle_no_truncate BEFORE TRUNCATE ON ctp_admission.lifecycle_revision FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE FUNCTION ctp_admission.monotonic_lifecycle_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW."tenantId",NEW."reservationId") IS DISTINCT FROM ROW(OLD."tenantId",OLD."reservationId") OR NEW.sequence<>OLD.sequence+1 THEN RAISE EXCEPTION 'RISK_LIFECYCLE_VERSION' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER risk_lifecycle_head_monotonic BEFORE UPDATE OR DELETE ON ctp_admission.lifecycle_head FOR EACH ROW EXECUTE FUNCTION ctp_admission.monotonic_lifecycle_head();
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['lifecycle_revision','lifecycle_head'] LOOP
 EXECUTE format('ALTER TABLE ctp_admission.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE ctp_admission.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY admission_tenant ON ctp_admission.%I USING ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',n);
END LOOP; END $$;

CREATE FUNCTION ctp_admission.sync_reservation(t uuid,order_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i ctp_admission.issuance%ROWTYPE; o public."order"%ROWTYPE; rr public.risk_reservation%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; wm ctp_portfolio.hold_watermark%ROWTYPE;
 previous ctp_admission.lifecycle_revision%ROWTYPE; pg ctp_execution.progress%ROWTYPE;
 proof jsonb; fp bytea; state jsonb; hold jsonb; event jsonb; text_state text;
 native jsonb; terminal_proof boolean; not_sent boolean; definitive_reject boolean;
 unresolved boolean; desired public."ReservationStatus"; seq bigint; event_id text; at_ms bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ctp_admission.issuance WHERE "tenantId"=t AND "orderId"=order_id) THEN RETURN; END IF;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_LIFECYCLE_SCOPE'; END IF;
 -- Every caller already owns GLOBAL -> tenant. Acquire the same locks also for direct owner writes.
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 PERFORM 1 FROM public.exchange_account a WHERE a."tenantId"=t AND a.id IN(SELECT "accountId" FROM ctp_admission.issuance WHERE "tenantId"=t AND "orderId"=order_id) ORDER BY a.id FOR UPDATE;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=order_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 FOR i IN SELECT * FROM ctp_admission.issuance WHERE "tenantId"=t AND "orderId"=order_id ORDER BY "accountId","reservationId" LOOP
  SELECT * INTO rr FROM public.risk_reservation WHERE "tenantId"=t AND id=i."reservationId" FOR UPDATE;
  SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=i."bookId" FOR UPDATE;
  SELECT * INTO wm FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=b.id AND "holdId"=rr.id::text FOR UPDATE;
  IF NOT FOUND OR b."accountId" IS DISTINCT FROM i."accountId" OR b.mode IS DISTINCT FROM i.mode THEN RAISE EXCEPTION 'RISK_LIFECYCLE_HOLD'; END IF;
  SELECT r.* INTO previous FROM ctp_admission.lifecycle_head h JOIN ctp_admission.lifecycle_revision r USING("tenantId","reservationId",sequence) WHERE h."tenantId"=t AND h."reservationId"=rr.id FOR UPDATE OF h;
  SELECT * INTO pg FROM ctp_execution.progress WHERE "tenantId"=t AND "orderId"=order_id;
  proof:=jsonb_build_object('orderVersion',o.version,'status',o.status,'reconciliation',o."reconciliationState",'filledQuantity',trim_scale(o."filledQuantity")::text,
   'nativeAt',pg."nativeAt",'nativeHash',encode(pg."nativeHash",'hex'),'nativeStatus',pg."nativeStatus",
   'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'status',s.status,'response',s."responseCode",'evidence',encode(s."evidenceHash",'hex'),'started',s."transportStartedAt",'consumed',s."permitConsumedAt") ORDER BY s.id) FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id),'[]'::jsonb));
  fp:=sha256(convert_to(ctp_admission.canonical(proof),'UTF8'));
  IF previous.sequence IS NOT NULL AND previous."orderVersion">o.version THEN RAISE EXCEPTION 'RISK_LIFECYCLE_VERSION'; END IF;
  IF previous.sequence IS NOT NULL AND previous.fingerprint=fp THEN CONTINUE; END IF;
  -- A durable released tombstone is irreversible even when late outcome evidence arrives.
  IF rr.status='RELEASED' OR wm.released THEN
   IF rr.status IS DISTINCT FROM 'RELEASED'::public."ReservationStatus" OR NOT wm.released OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.state::jsonb->'holds')h WHERE h->>'id'=rr.id::text) THEN RAISE EXCEPTION 'RISK_LIFECYCLE_DIVERGENCE'; END IF;
   CONTINUE;
  END IF;
  state:=b.state::jsonb;
  SELECT value INTO hold FROM jsonb_array_elements(state->'holds') WHERE value->>'id'=rr.id::text;
  IF NOT FOUND OR hold->>'asset' IS DISTINCT FROM rr.asset OR (hold->>'amount')::numeric IS DISTINCT FROM rr.amount THEN RAISE EXCEPTION 'RISK_LIFECYCLE_DIVERGENCE'; END IF;
  SELECT e.payload::jsonb->'order' INTO native FROM ctp_execution.authoritative_event e
   WHERE e."tenantId"=t AND e."orderId"=order_id AND e.payload::jsonb->>'type'='NATIVE'
   AND sha256(convert_to(ctp_admission.canonical(e.payload::jsonb->'order'),'UTF8'))=pg."nativeHash"
   AND (e.payload::jsonb->'order'->>'updatedAt')::bigint=pg."nativeAt" LIMIT 1;
  terminal_proof:=COALESCE(o.status IN('FILLED','CANCELED','REJECTED','EXPIRED') AND o."reconciliationState"='CONSISTENT'
   AND pg."nativeStatus"=o.status AND pg."nativeAt"<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND native->>'status'=pg."nativeStatus"::text AND native->>'clientOrderId'=o."clientId"
   AND native->>'exchangeOrderId'=o."exchangeOrderId" AND (native->>'filledQuantity')::numeric=o."filledQuantity"
   AND native->'account'=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',i.request->'binding'->>'externalAccountId')
   AND native->>'instrumentId'=i.instrument AND (native->>'quantity')::numeric=o.quantity
   AND o."filledQuantity"=(SELECT COALESCE(sum(quantity),0) FROM public.fill WHERE "tenantId"=t AND "orderId"=order_id)
   AND NOT EXISTS(SELECT 1 FROM public.fill f LEFT JOIN ctp_execution.fill_adoption a ON a."tenantId"=f."tenantId" AND a."fillId"=f.id LEFT JOIN ctp_portfolio.evidence e ON e."tenantId"=a."tenantId" AND e.book=a.book AND e.id=a."eventId"
    WHERE f."tenantId"=t AND f."orderId"=order_id AND (a.book IS DISTINCT FROM b.id OR e.ledger IS NULL OR floor(extract(epoch FROM f.timestamp)*1000)::bigint>(state->>'snapshotAt')::bigint))
   AND NOT EXISTS(SELECT 1 FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id AND s.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED')),false);
  not_sent:=o.status='REJECTED' AND o."reconciliationState"='CONSISTENT' AND EXISTS(
   SELECT 1 FROM public.submission_attempt s JOIN ctp_execution.authoritative_event e ON e."tenantId"=s."tenantId" AND e."orderId"=s."orderId" AND e.identity='result:'||s.id::text
   WHERE s."tenantId"=t AND s."intentId"=i."intentId" AND s.status='REJECTED' AND s."responseCode"='NOT_SENT' AND s."transportStartedAt" IS NULL AND s."permitConsumedAt" IS NULL
    AND e.payload::jsonb->'outcome'->>'kind'='DEFINITIVELY_REJECTED');
  definitive_reject:=o.status='REJECTED' AND o."reconciliationState"='CONSISTENT' AND EXISTS(
   SELECT 1 FROM public.submission_attempt s JOIN ctp_execution.authoritative_event e ON e."tenantId"=s."tenantId" AND e."orderId"=s."orderId" AND e.identity='result:'||s.id::text
   WHERE s."tenantId"=t AND s."intentId"=i."intentId" AND s.status='REJECTED' AND s."responseCode"='DEFINITIVELY_REJECTED' AND s."transportStartedAt" IS NOT NULL
    AND e.payload::jsonb->'outcome'->>'kind'='DEFINITIVELY_REJECTED');
  unresolved:=o.status IN('UNKNOWN','RECONCILIATION_REQUIRED') OR EXISTS(SELECT 1 FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id AND s.status='UNKNOWN');
  desired:=CASE WHEN terminal_proof OR not_sent OR definitive_reject THEN 'RELEASED'::public."ReservationStatus" WHEN unresolved OR rr.status='UNRESOLVED' THEN 'UNRESOLVED'::public."ReservationStatus" ELSE 'ACTIVE'::public."ReservationStatus" END;
  seq:=COALESCE(previous.sequence,0)+1; event_id:=NULL;
  IF desired IS DISTINCT FROM rr.status OR (desired='UNRESOLVED' AND hold->>'status'<>'UNKNOWN') THEN
   at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
   IF at_ms<=wm.timestamp THEN PERFORM pg_sleep(0.002); at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; END IF;
   IF at_ms<=wm.timestamp THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CLOCK'; END IF;
   event_id:='risk-lifecycle-'||rr.id::text||'-'||seq::text;
   IF desired='RELEASED' THEN
    event:=jsonb_build_object('id',event_id,'timestamp',at_ms,'type','RELEASE','holdId',rr.id::text,'resolved',true);
    state:=jsonb_set(state,'{holds}',COALESCE((SELECT jsonb_agg(h ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY z(h,n) WHERE h->>'id'<>rr.id::text),'[]'::jsonb));
    UPDATE public.risk_budget SET "reservedAmount"="reservedAmount"-rr.amount,version=version+1,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=rr."budgetId" AND "reservedAmount">=rr.amount AND version<2147483647;
    IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_BUDGET'; END IF;
   ELSE
    hold:=jsonb_set(hold,'{status}','"UNKNOWN"'::jsonb);
    event:=jsonb_build_object('id',event_id,'timestamp',at_ms,'type','COMMITMENT','hold',hold);
    state:=jsonb_set(state,'{holds}',(SELECT jsonb_agg(CASE WHEN h->>'id'=rr.id::text THEN hold ELSE h END ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY z(h,n)));
   END IF;
   text_state:=ctp_admission.canonical(state);
   UPDATE public.risk_reservation SET status=desired,version=version+1,"releasedAt"=CASE WHEN desired='RELEASED' THEN clock_timestamp() ELSE "releasedAt" END,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=rr.id AND version<2147483647;
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CAPACITY'; END IF;
   UPDATE ctp_portfolio.hold_watermark SET timestamp=at_ms,fingerprint=sha256(convert_to(ctp_admission.canonical(event-'id'-'timestamp'),'UTF8')),released=desired='RELEASED',unknown=desired='UNRESOLVED' WHERE "tenantId"=t AND book=b.id AND "holdId"=rr.id::text;
   INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger) VALUES(t,b.id,b."accountId",b.mode,event_id,sha256(convert_to(ctp_admission.canonical(event),'UTF8')),ctp_admission.canonical(event),NULL);
   UPDATE ctp_portfolio.book SET state=text_state,state_hash=sha256(convert_to(text_state,'UTF8')),revision=revision+1 WHERE "tenantId"=t AND id=b.id AND revision<2147483647;
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CAPACITY'; END IF;
   INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId") VALUES(t,b.id,b."accountId",b.mode,b.revision+1,event->>'type',event_id);
  END IF;
  INSERT INTO ctp_admission.lifecycle_revision("tenantId","reservationId",sequence,"orderVersion",proof,fingerprint,status,amount,"eventId") VALUES(t,rr.id,seq,o.version,proof,fp,desired,rr.amount,event_id);
  INSERT INTO ctp_admission.lifecycle_head("tenantId","reservationId",sequence) VALUES(t,rr.id,seq) ON CONFLICT("tenantId","reservationId") DO UPDATE SET sequence=EXCLUDED.sequence;
 END LOOP;
END $$;
CREATE FUNCTION ctp_admission.execution_lifecycle() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='order' THEN PERFORM ctp_admission.sync_reservation(NEW."tenantId",NEW.id);
 ELSE PERFORM ctp_admission.sync_reservation(NEW."tenantId",NEW."orderId"); END IF; RETURN NULL;
END $$;
-- Deferred triggers see the final Order/progress/attempt/adoption state, never an intermediate ACK.
CREATE CONSTRAINT TRIGGER risk_order_lifecycle AFTER INSERT OR UPDATE ON public."order" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_admission.execution_lifecycle();
CREATE CONSTRAINT TRIGGER risk_attempt_lifecycle AFTER INSERT OR UPDATE ON public.submission_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_admission.execution_lifecycle();
CREATE FUNCTION ctp_admission.reservation_consistency() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i record; h jsonb; w ctp_portfolio.hold_watermark%ROWTYPE;
BEGIN
 FOR i IN SELECT x.*,r.status,r.asset,r.amount,b.state FROM ctp_admission.issuance x
  JOIN public.risk_reservation r ON r."tenantId"=x."tenantId" AND r.id=x."reservationId"
  JOIN ctp_portfolio.book b ON b."tenantId"=x."tenantId" AND b.id=x."bookId"
  WHERE x."tenantId"=NEW."tenantId" AND ((TG_TABLE_NAME='book' AND x."bookId"=NEW.id) OR (TG_TABLE_NAME='risk_reservation' AND x."reservationId"=NEW.id)) LOOP
  SELECT value INTO h FROM jsonb_array_elements(i.state::jsonb->'holds') WHERE value->>'id'=i."reservationId"::text;
  SELECT * INTO w FROM ctp_portfolio.hold_watermark WHERE "tenantId"=i."tenantId" AND book=i."bookId" AND "holdId"=i."reservationId"::text;
  IF NOT FOUND OR i.status NOT IN('ACTIVE','UNRESOLVED','RELEASED')
   OR (i.status='RELEASED' AND (NOT w.released OR h IS NOT NULL))
   OR (i.status<>'RELEASED' AND (w.released OR h IS NULL OR h->>'asset' IS DISTINCT FROM i.asset OR (h->>'amount')::numeric IS DISTINCT FROM i.amount))
   OR (i.status='UNRESOLVED' AND (NOT w.unknown OR h->>'status' IS DISTINCT FROM 'UNKNOWN'))
  THEN RAISE EXCEPTION 'RISK_LIFECYCLE_DIVERGENCE' USING ERRCODE='23514'; END IF;
 END LOOP; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER risk_hold_consistency AFTER INSERT OR UPDATE ON ctp_portfolio.book DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_admission.reservation_consistency();
CREATE CONSTRAINT TRIGGER risk_reservation_consistency AFTER INSERT OR UPDATE ON public.risk_reservation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_admission.reservation_consistency();
REVOKE ALL ON ALL TABLES IN SCHEMA ctp_admission FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_admission.monotonic_lifecycle_head(),ctp_admission.sync_reservation(uuid,uuid),ctp_admission.execution_lifecycle(),ctp_admission.reservation_consistency() FROM PUBLIC;
COMMIT;
