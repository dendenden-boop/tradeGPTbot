BEGIN;
ALTER TABLE ctp_portfolio.outbox DROP CONSTRAINT outbox_type_check;
ALTER TABLE ctp_portfolio.outbox ADD CONSTRAINT outbox_type_check CHECK(type IN ('FILL','FUNDING','SNAPSHOT','COMMITMENT','RELEASE','GAP','RESOLVE_COMMITMENT'));
-- Additive trusted residual-collateral evidence; migrations 1-20 are unchanged.
ALTER TABLE ctp_admission.lifecycle_revision ADD COLUMN event jsonb;
ALTER TABLE ctp_admission.lifecycle_revision ADD CHECK(event IS NULL OR (event->>'id'="eventId" AND octet_length(event::text)<=8192));
CREATE OR REPLACE FUNCTION ctp_portfolio.monotonic_hold_watermark() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE trusted boolean; BEGIN
 trusted:=EXISTS(SELECT 1 FROM ctp_admission.lifecycle_head h JOIN ctp_admission.lifecycle_revision r USING("tenantId","reservationId",sequence)
  WHERE h."tenantId"=NEW."tenantId" AND h."reservationId"::text=NEW."holdId" AND r.event->>'type'='RESOLVE_COMMITMENT'
   AND r.status='ACTIVE' AND r.proof->>'nativeConfirmed'='true' AND r.fingerprint=sha256(convert_to(ctp_admission.canonical(r.proof),'UTF8'))
   AND (r.event->>'timestamp')::bigint=NEW.timestamp AND r.event->>'proofHash'=encode(r.fingerprint,'hex')
   AND NEW.fingerprint=sha256(convert_to(ctp_admission.canonical(r.event-'id'-'timestamp'),'UTF8')));
 IF TG_OP='DELETE' OR ROW(NEW."tenantId",NEW.book,NEW."accountId",NEW.mode,NEW."holdId") IS DISTINCT FROM ROW(OLD."tenantId",OLD.book,OLD."accountId",OLD.mode,OLD."holdId")
  OR NEW.timestamp<OLD.timestamp OR (NEW.timestamp=OLD.timestamp AND ROW(NEW.fingerprint,NEW.released,NEW.unknown) IS DISTINCT FROM ROW(OLD.fingerprint,OLD.released,OLD.unknown))
  OR (OLD.released AND NOT NEW.released) OR (OLD.unknown AND NOT NEW.unknown AND NOT NEW.released AND NOT trusted)
 THEN RAISE EXCEPTION 'Hold watermark cannot regress' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ctp_portfolio.monotonic_hold_watermark() FROM PUBLIC;
CREATE OR REPLACE FUNCTION ctp_admission.sync_reservation(t uuid,order_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i ctp_admission.issuance%ROWTYPE; o public."order"%ROWTYPE; rr public.risk_reservation%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; wm ctp_portfolio.hold_watermark%ROWTYPE;
 previous ctp_admission.lifecycle_revision%ROWTYPE; pg ctp_execution.progress%ROWTYPE;
 proof jsonb; fp bytea; state jsonb; hold jsonb; event jsonb; text_state text;
 native jsonb; terminal_proof boolean; not_sent boolean; definitive_reject boolean;
 unresolved boolean; native_confirmed boolean; next_amount numeric; original_amount numeric; desired public."ReservationStatus"; seq bigint; event_id text; at_ms bigint;
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
   'portfolioSnapshotId',b.state::jsonb->'snapshotId','portfolioSnapshotAt',b.state::jsonb->'snapshotAt','portfolioStatus',b.state::jsonb->'status','nativeAt',pg."nativeAt",'nativeHash',encode(pg."nativeHash",'hex'),'nativeStatus',pg."nativeStatus",
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
  native_confirmed:=COALESCE(o.status IN('SUBMITTED','PARTIALLY_FILLED') AND o."reconciliationState"='CONSISTENT'
   AND pg."nativeStatus"=o.status AND pg."nativeAt"<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND native->>'status'=CASE pg."nativeStatus" WHEN 'SUBMITTED' THEN 'OPEN' ELSE pg."nativeStatus"::text END AND native->>'clientOrderId'=o."clientId"
   AND native->>'exchangeOrderId'=o."exchangeOrderId" AND (native->>'filledQuantity')::numeric=o."filledQuantity"
   AND native->'account'=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',i.request->'binding'->>'externalAccountId')
   AND state->>'status'='RECONCILED' AND state->'pending'='[]'::jsonb AND state->'differences'='[]'::jsonb AND (state->>'snapshotAt')::bigint>=pg."nativeAt" AND native->>'side'=o.side::text AND native->>'instrumentId'=i.instrument AND (native->>'quantity')::numeric=o.quantity
   AND (o."orderType"<>'LIMIT' OR (native->'price'->>'state'='AVAILABLE' AND (native->'price'->>'value')::numeric=o."limitPrice"))
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
  desired:=CASE WHEN terminal_proof OR not_sent OR definitive_reject THEN 'RELEASED'::public."ReservationStatus" WHEN unresolved OR (rr.status='UNRESOLVED' AND NOT native_confirmed) THEN 'UNRESOLVED'::public."ReservationStatus" ELSE 'ACTIVE'::public."ReservationStatus" END;
  next_amount:=rr.amount;
  IF native_confirmed AND o.quantity>0 AND o."filledQuantity">0 AND o."filledQuantity"<o.quantity THEN
   SELECT (e.payload::jsonb->'hold'->>'amount')::numeric INTO original_amount FROM ctp_portfolio.evidence e WHERE e."tenantId"=t AND e.book=b.id AND e.id='risk-reserve-'||rr.id::text;
   IF original_amount IS NULL THEN RAISE EXCEPTION 'RISK_LIFECYCLE_ORIGINAL_AMOUNT'; END IF;
   next_amount:=least(rr.amount,ceil(original_amount*(o.quantity-o."filledQuantity")/o.quantity*10::numeric^18)/10::numeric^18);
  END IF;
  proof:=proof||jsonb_build_object('nativeConfirmed',native_confirmed,'nextAmount',trim_scale(next_amount)::text);
  fp:=sha256(convert_to(ctp_admission.canonical(proof),'UTF8'));
  IF previous.sequence IS NOT NULL AND previous.fingerprint=fp THEN CONTINUE; END IF;
  seq:=COALESCE(previous.sequence,0)+1; event_id:=NULL;
  IF next_amount IS DISTINCT FROM rr.amount OR desired IS DISTINCT FROM rr.status OR (desired='UNRESOLVED' AND hold->>'status'<>'UNKNOWN') THEN
   at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
   IF at_ms<=wm.timestamp THEN PERFORM pg_sleep(0.002); at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; END IF;
   IF at_ms<=wm.timestamp THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CLOCK'; END IF;
   event_id:='risk-lifecycle-'||rr.id::text||'-'||seq::text;
   IF desired='RELEASED' THEN
    event:=jsonb_build_object('id',event_id,'timestamp',at_ms,'type','RELEASE','holdId',rr.id::text,'resolved',true);
    state:=jsonb_set(state,'{holds}',COALESCE((SELECT jsonb_agg(h ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY z(h,n) WHERE h->>'id'<>rr.id::text),'[]'::jsonb));
    UPDATE public.risk_budget SET "reservedAmount"="reservedAmount"-rr.amount,version=version+1,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=rr."budgetId" AND "reservedAmount">=rr.amount AND version<2147483647;
    IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_BUDGET'; END IF;
   ELSIF native_confirmed AND desired='ACTIVE' THEN
    hold:=jsonb_set(jsonb_set(hold,'{amount}',to_jsonb(trim_scale(next_amount)::text)),'{status}','"RESERVED"'::jsonb);
    event:=jsonb_build_object('id',event_id,'timestamp',at_ms,'type','RESOLVE_COMMITMENT','hold',hold,'proofId',rr.id::text||':'||seq::text,'proofHash',encode(fp,'hex'));
    state:=jsonb_set(state,'{holds}',(SELECT jsonb_agg(CASE WHEN h->>'id'=rr.id::text THEN hold ELSE h END ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY z(h,n)));
    UPDATE public.risk_budget SET "reservedAmount"="reservedAmount"-(rr.amount-next_amount),version=version+1,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=rr."budgetId" AND "reservedAmount">=rr.amount-next_amount AND version<2147483647;
    IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_BUDGET'; END IF;
   ELSE
    hold:=jsonb_set(hold,'{status}','"UNKNOWN"'::jsonb);
    event:=jsonb_build_object('id',event_id,'timestamp',at_ms,'type','COMMITMENT','hold',hold);
    state:=jsonb_set(state,'{holds}',(SELECT jsonb_agg(CASE WHEN h->>'id'=rr.id::text THEN hold ELSE h END ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY z(h,n)));
   END IF;
   INSERT INTO ctp_admission.lifecycle_revision("tenantId","reservationId",sequence,"orderVersion",proof,fingerprint,status,amount,"eventId",event) VALUES(t,rr.id,seq,o.version,proof,fp,desired,next_amount,event_id,event);
   INSERT INTO ctp_admission.lifecycle_head("tenantId","reservationId",sequence) VALUES(t,rr.id,seq) ON CONFLICT("tenantId","reservationId") DO UPDATE SET sequence=EXCLUDED.sequence;
   text_state:=ctp_admission.canonical(state);
   UPDATE public.risk_reservation SET status=desired,amount=next_amount,version=version+1,"releasedAt"=CASE WHEN desired='RELEASED' THEN clock_timestamp() ELSE "releasedAt" END,"updatedAt"=clock_timestamp() WHERE "tenantId"=t AND id=rr.id AND version<2147483647;
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CAPACITY'; END IF;
   UPDATE ctp_portfolio.hold_watermark SET timestamp=at_ms,fingerprint=sha256(convert_to(ctp_admission.canonical(event-'id'-'timestamp'),'UTF8')),released=desired='RELEASED',unknown=desired='UNRESOLVED' WHERE "tenantId"=t AND book=b.id AND "holdId"=rr.id::text;
   INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger) VALUES(t,b.id,b."accountId",b.mode,event_id,sha256(convert_to(ctp_admission.canonical(event),'UTF8')),ctp_admission.canonical(event),NULL);
   UPDATE ctp_portfolio.book SET state=text_state,state_hash=sha256(convert_to(text_state,'UTF8')),revision=revision+1 WHERE "tenantId"=t AND id=b.id AND revision<2147483647;
   IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LIFECYCLE_CAPACITY'; END IF;
   INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId") VALUES(t,b.id,b."accountId",b.mode,b.revision+1,event->>'type',event_id);
  ELSE
   INSERT INTO ctp_admission.lifecycle_revision("tenantId","reservationId",sequence,"orderVersion",proof,fingerprint,status,amount,"eventId") VALUES(t,rr.id,seq,o.version,proof,fp,desired,rr.amount,NULL);
   INSERT INTO ctp_admission.lifecycle_head("tenantId","reservationId",sequence) VALUES(t,rr.id,seq) ON CONFLICT("tenantId","reservationId") DO UPDATE SET sequence=EXCLUDED.sequence;
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION ctp_admission.portfolio_lifecycle() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i record; BEGIN FOR i IN SELECT DISTINCT "orderId" FROM ctp_admission.issuance WHERE "tenantId"=NEW."tenantId" AND "bookId"=NEW.id ORDER BY "orderId" LOOP
 PERFORM ctp_admission.sync_reservation(NEW."tenantId",i."orderId"); END LOOP; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER risk_portfolio_lifecycle AFTER INSERT OR UPDATE ON ctp_portfolio.book DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_admission.portfolio_lifecycle();
REVOKE ALL ON FUNCTION ctp_admission.portfolio_lifecycle() FROM PUBLIC;
COMMIT;
