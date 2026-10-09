BEGIN;
-- Source ordering is proved by native history and permanent old/new client identities,
-- never by comparing exchange time against the local transport clock.
-- Same-ms transitions receive a scoped immutable amendment event identity.
CREATE OR REPLACE FUNCTION ctp_execution.monotonic_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW."tenantId",NEW."orderId") IS DISTINCT FROM ROW(OLD."tenantId",OLD."orderId")
  OR (OLD."nativeAt" IS NOT NULL AND (NEW."nativeAt" IS NULL OR NEW."nativeAt"<OLD."nativeAt")) THEN
  RAISE EXCEPTION 'Execution watermark cannot regress' USING ERRCODE='23514';
 END IF;
 IF OLD."nativeAt" IS NOT NULL AND NEW."nativeAt"=OLD."nativeAt"
  AND ROW(NEW."nativeHash",NEW."nativeStatus") IS DISTINCT FROM ROW(OLD."nativeHash",OLD."nativeStatus")
  AND NOT EXISTS(SELECT 1 FROM ctp_execution.amendment_head h JOIN ctp_execution.amendment_application j USING("tenantId","orderId",sequence)
   JOIN public."order" o ON o."tenantId"=j."tenantId" AND o.id=j."orderId"
   WHERE h."tenantId"=NEW."tenantId" AND h."orderId"=NEW."orderId" AND j."nativeHash"=NEW."nativeHash"
    AND (j.proof->'order'->>'updatedAt')::bigint=NEW."nativeAt" AND j."orderVersion"=o.version
    AND NEW."nativeStatus"=o.status AND j.proof->'order'->>'status'=CASE o.status WHEN 'SUBMITTED' THEN 'OPEN' ELSE o.status::text END) THEN
  RAISE EXCEPTION 'Execution watermark cannot regress' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ctp_execution.monotonic_progress() FROM PUBLIC;
CREATE OR REPLACE FUNCTION ctp_execution.apply_amendment(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; order_id uuid; attempt_id uuid; o public."order"; a public.submission_attempt;
 k ctp_execution.command; original ctp_execution.command; pg ctp_execution.progress;
 issue ctp_admission.issuance; old ctp_execution.amendment_application;
 b jsonb; c jsonb; before jsonb; after jsonb; ev jsonb; native jsonb; cause jsonb; fp bytea;
 event jsonb; event_fp bytea; identity text; now_ms bigint; seq bigint; qty numeric; filled numeric; executed numeric; notional numeric;
 native_status public."OrderStatus"; reconciled public."ReconciliationState"; account jsonb; scope jsonb;
BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_execution') OR NOT ctp_market.snapshot_keys(p,ARRAY['binding','orderId','attemptId','proof'])
  OR NOT ctp_market.snapshot_keys(p->'proof',ARRAY['evidence','order','nativeReceivedAt']) OR octet_length(p::text)>49152
 THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 t:=(p->'binding'->>'tenantId')::uuid; order_id:=(p->>'orderId')::uuid; attempt_id:=(p->>'attemptId')::uuid;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND id=(p->'binding'->>'accountId')::uuid FOR UPDATE;
 PERFORM 1 FROM ctp_portfolio.book WHERE "tenantId"=t AND "accountId"=(p->'binding'->>'accountId')::uuid AND mode='TESTNET' ORDER BY id FOR UPDATE;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=order_id FOR UPDATE;
 SELECT * INTO a FROM public.submission_attempt WHERE "tenantId"=t AND id=attempt_id AND "orderId"=order_id FOR UPDATE;
 SELECT * INTO k FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=a."intentId" AND "orderId"=order_id;
 SELECT * INTO original FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=o."intentId" AND "orderId"=order_id AND operation='PLACE';
 IF k.command IS NULL OR k.operation IS DISTINCT FROM 'AMEND'::public."SubmissionOperation" OR a.operation IS DISTINCT FROM k.operation
  OR a."accountId" IS DISTINCT FROM o."accountId" OR a.mode IS DISTINCT FROM o.mode OR a."instrumentId" IS DISTINCT FROM o."instrumentId"
  OR a."commandHash" IS DISTINCT FROM k."commandHash" OR k.binding::jsonb IS DISTINCT FROM p->'binding' OR original.binding IS DISTINCT FROM k.binding
  OR o.mode IS DISTINCT FROM 'TESTNET'::public."TradingMode" OR k.binding::jsonb->'profile'->>'endpointProfileId' IS DISTINCT FROM 'binance-spot-testnet-v1'
  OR k.binding::jsonb->'profile'->>'exchange' IS DISTINCT FROM 'BINANCE' OR k.binding::jsonb->'profile'->>'market' IS DISTINCT FROM 'SPOT'
 THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 b:=k.binding::jsonb;c:=k.command::jsonb;ev:=p->'proof'->'evidence';native:=p->'proof'->'order';after:=c->'replacement';
 account:=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',b->>'externalAccountId');
 scope:=(b->'profile')-'accountMode'-'profileVersion'-'endpointProfileId'-'credentialRef';
 IF ev->>'kind' IS DISTINCT FROM 'APPLIED_EVIDENCE' OR NOT ctp_market.snapshot_keys(ev,ARRAY['kind','account','scope','instrumentId','receivedAt','evidence'])
  OR NOT ctp_market.snapshot_keys(ev->'evidence',ARRAY['executionId','time','exchangeOrderId','oldClientOrderId','newClientOrderId','originalQuantity','newQuantity'])
  OR ev->'account' IS DISTINCT FROM account OR ev->'scope' IS DISTINCT FROM scope OR ev->>'instrumentId' IS DISTINCT FROM after->>'instrumentId'
  OR ev->'evidence'->>'executionId' IS NULL OR octet_length(ev->'evidence'->>'executionId') NOT BETWEEN 1 AND 128
  OR ev->'evidence'->>'exchangeOrderId' IS DISTINCT FROM c->'locator'->'locator'->>'id'
  OR ev->'evidence'->>'oldClientOrderId' IS DISTINCT FROM c->'target'->'current'->>'clientOrderId'
  OR ev->'evidence'->>'newClientOrderId' IS DISTINCT FROM after->>'clientOrderId'
  OR ev->'evidence'->>'originalQuantity' IS DISTINCT FROM c->'target'->'current'->'size'->>'value'
  OR ev->'evidence'->>'newQuantity' IS DISTINCT FROM after->'size'->>'value'
 THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 cause:=jsonb_build_object('command',c,'evidence',ev-'receivedAt');fp:=sha256(convert_to(ctp_admission.canonical(cause),'UTF8'));
 SELECT * INTO old FROM ctp_execution.amendment_application WHERE "tenantId"=t AND "intentId"=k."intentId";
 IF FOUND THEN
  IF old."attemptId" IS DISTINCT FROM attempt_id OR old."orderId" IS DISTINCT FROM order_id OR old.fingerprint IS DISTINCT FROM fp OR old.cause IS DISTINCT FROM cause THEN RAISE EXCEPTION 'ORDER_EVIDENCE_CONFLICT'; END IF;
  RETURN;
 END IF;
 SELECT * INTO issue FROM ctp_admission.issuance WHERE "tenantId"=t AND "intentId"=k."intentId";
 SELECT * INTO pg FROM ctp_execution.progress WHERE "tenantId"=t AND "orderId"=order_id;
 before:=ctp_execution.effective_command(t,order_id);now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF jsonb_typeof(ev->'receivedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(ev->'evidence'->'time') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p->'proof'->'nativeReceivedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(native->'updatedAt') IS DISTINCT FROM 'number'
  OR jsonb_typeof(native->'createdAt') IS DISTINCT FROM 'number' OR jsonb_typeof(native->'filledQuantity') IS DISTINCT FROM 'string'
  OR ev->>'receivedAt' !~ '^[0-9]{1,16}$' OR ev->'evidence'->>'time' !~ '^[0-9]{1,16}$'
  OR p->'proof'->>'nativeReceivedAt' !~ '^[0-9]{1,16}$' OR native->>'updatedAt' !~ '^[0-9]{1,16}$' OR native->>'createdAt' !~ '^[0-9]{1,16}$'
 THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 IF COALESCE((issue."primaryReservationId" IS NULL OR issue."reservationId" IS DISTINCT FROM a."reservationId" OR issue.request->'binding' IS DISTINCT FROM b
  OR issue.control->'command' IS DISTINCT FROM c OR issue.certificate_hash IS DISTINCT FROM sha256(convert_to(issue.certificate,'UTF8'))
  OR a.status NOT IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED') OR a."transportStartedAt" IS NULL OR a."permitConsumedAt" IS NULL
  OR a."transportStartedAt" IS DISTINCT FROM a."permitConsumedAt" OR a."permitProtocolVersion"<>2
  OR EXISTS(SELECT 1 FROM public.submission_attempt x WHERE x."tenantId"=t AND x."orderId"=order_id AND x.id<>a.id AND x.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED'))
  OR c->>'semantics' IS DISTINCT FROM 'IN_PLACE' OR c->'identity' IS DISTINCT FROM '{"exchangeOrderId":"PRESERVED","clientOrderId":"REPLACED"}'::jsonb
  OR c->'target'->>'internalOrderId' IS DISTINCT FROM o.id::text OR c->'target'->>'placeIntentId' IS DISTINCT FROM o."intentId"::text
  OR c->'target'->'current' IS DISTINCT FROM before OR c->'locator'->'locator'->>'id' IS DISTINCT FROM o."exchangeOrderId"
  OR after->>'instrumentId' IS DISTINCT FROM before->>'instrumentId' OR after->>'side' IS DISTINCT FROM before->>'side'
  OR before->>'type' IS DISTINCT FROM 'LIMIT' OR after->>'type' IS DISTINCT FROM 'LIMIT' OR before->>'timeInForce' IS DISTINCT FROM 'GTC' OR after->>'timeInForce' IS DISTINCT FROM 'GTC'
  OR before->'reduceOnly' IS DISTINCT FROM 'false'::jsonb OR after->'reduceOnly' IS DISTINCT FROM 'false'::jsonb OR before->'trigger' IS DISTINCT FROM 'null'::jsonb OR after->'trigger' IS DISTINCT FROM 'null'::jsonb
  OR after->'limitPrice' IS DISTINCT FROM before->'limitPrice' OR after->'size'->>'kind' IS DISTINCT FROM 'BASE_QUANTITY'
  OR after->'size'->>'asset' IS DISTINCT FROM before->'size'->>'asset' OR after->>'clientOrderId'=before->>'clientOrderId'
  OR (after->'size'->>'value')::numeric<=0 OR (after->'size'->>'value')::numeric>=(before->'size'->>'value')::numeric
  OR (ev->>'receivedAt')::bigint>now_ms OR now_ms-(ev->>'receivedAt')::bigint>5000
  OR (p->'proof'->>'nativeReceivedAt')::bigint>now_ms OR now_ms-(p->'proof'->>'nativeReceivedAt')::bigint>5000
  OR (ev->'evidence'->>'time')::bigint<(c->'target'->>'nativeUpdatedAt')::bigint
  OR (ev->'evidence'->>'time')::bigint>(ev->>'receivedAt')::bigint
  OR (native->>'updatedAt')::bigint<(ev->'evidence'->>'time')::bigint OR (native->>'updatedAt')::bigint>(p->'proof'->>'nativeReceivedAt')::bigint
  OR (native->>'updatedAt')::bigint<pg."nativeAt"),true) THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 IF COALESCE((NOT ctp_market.snapshot_keys(native,ARRAY['scope','account','instrumentId','internalOrderId','intentId','clientOrderId','exchangeOrderId','side','type','status','price','stopPrice','quantity','quantityUnit','filledQuantity','averageFillPrice','fees','createdAt','updatedAt'])
  OR native->'account' IS DISTINCT FROM account OR native->'scope' IS DISTINCT FROM scope
  OR native->>'internalOrderId' IS DISTINCT FROM o.id::text OR native->>'intentId' IS DISTINCT FROM o."intentId"::text
  OR native->>'exchangeOrderId' IS DISTINCT FROM o."exchangeOrderId" OR native->>'clientOrderId' IS DISTINCT FROM after->>'clientOrderId'
  OR native->>'instrumentId' IS DISTINCT FROM after->>'instrumentId' OR native->>'side' IS DISTINCT FROM after->>'side' OR native->>'type' IS DISTINCT FROM 'LIMIT'
  OR native->>'quantityUnit' IS DISTINCT FROM 'BASE' OR native->'quantity' IS DISTINCT FROM after->'size'->'value'
  OR native->'price'->>'state' IS DISTINCT FROM 'AVAILABLE' OR native->'price'->'value' IS DISTINCT FROM after->'limitPrice'
  OR (native->>'createdAt')::bigint<floor(extract(epoch FROM o."createdAt")*1000)::bigint OR (native->>'createdAt')::bigint>(native->>'updatedAt')::bigint
  OR native->>'status' NOT IN('OPEN','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','REJECTED')
  OR jsonb_typeof(native->'fees') IS DISTINCT FROM 'array' OR jsonb_array_length(native->'fees')>100),true) THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 qty:=(after->'size'->>'value')::numeric;filled:=(native->>'filledQuantity')::numeric;
 SELECT COALESCE(sum(quantity),0),COALESCE(sum("quoteAmount"),0) INTO executed,notional FROM public.fill WHERE "tenantId"=t AND "orderId"=order_id;
 IF COALESCE((filled<o."filledQuantity" OR filled<executed OR filled>qty OR filled<0 OR (native->>'status'='FILLED' AND filled<>qty)
  OR (filled=0 AND native->'averageFillPrice'->>'state' IS DISTINCT FROM 'UNAVAILABLE')
  OR (filled>0 AND (native->'averageFillPrice'->>'state' IS DISTINCT FROM 'AVAILABLE' OR (native->'averageFillPrice'->>'value')::numeric<=0))),true) THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 native_status:=(CASE native->>'status' WHEN 'OPEN' THEN 'SUBMITTED' ELSE native->>'status' END)::public."OrderStatus";
 IF o.status IN('FILLED','CANCELED','EXPIRED','REJECTED') AND native_status IS DISTINCT FROM o.status THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED'; END IF;
 reconciled:=CASE WHEN filled=executed AND (filled=0 OR (native->'averageFillPrice'->>'value')::numeric=ctp_execution.amendment_average(notional,executed)) THEN 'CONSISTENT'::public."ReconciliationState" ELSE 'REQUIRED'::public."ReconciliationState" END;
 SELECT COALESCE(max(sequence),0)+1 INTO seq FROM ctp_execution.amendment_head WHERE "tenantId"=t AND "orderId"=order_id;
 INSERT INTO ctp_execution.amendment_application("tenantId","intentId","orderId","attemptId","accountId",mode,"instrumentId","exchangeOrderId","executionId",sequence,cause,fingerprint,proof,replacement,"nativeHash","orderVersion")
 VALUES(t,k."intentId",order_id,attempt_id,o."accountId",o.mode,o."instrumentId",o."exchangeOrderId",ev->'evidence'->>'executionId',seq,cause,fp,p->'proof',after,sha256(convert_to(ctp_admission.canonical(native),'UTF8')),o.version+1);
 INSERT INTO ctp_execution.amendment_head VALUES(t,order_id,seq) ON CONFLICT("tenantId","orderId") DO UPDATE SET sequence=EXCLUDED.sequence;
 event:=jsonb_build_object('type','NATIVE','order',native);event_fp:=sha256(convert_to(ctp_admission.canonical(event),'UTF8'));identity:='native:'||(native->>'updatedAt')||':amend:'||k."intentId"::text;
 INSERT INTO ctp_execution.evidence VALUES(t,order_id,identity,event_fp);
 INSERT INTO ctp_execution.authoritative_event("tenantId","orderId",identity,fingerprint,payload) VALUES(t,order_id,identity,event_fp,ctp_admission.canonical(event));
 UPDATE public."order" SET status=native_status,"reconciliationState"=reconciled,"filledQuantity"=filled,"averageFillPrice"=CASE WHEN filled=0 THEN 0 ELSE (native->'averageFillPrice'->>'value')::numeric END,
  version=o.version+1,"lastExchangeAt"=to_timestamp((native->>'updatedAt')::double precision/1000),"terminalAt"=CASE WHEN native_status IN('FILLED','CANCELED','EXPIRED','REJECTED') THEN COALESCE("terminalAt",clock_timestamp()) ELSE "terminalAt" END,"updatedAt"=clock_timestamp()
  WHERE "tenantId"=t AND id=order_id AND version<2147483646;
 IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_ID_EXHAUSTED'; END IF;
 UPDATE ctp_execution.progress SET "nativeAt"=(native->>'updatedAt')::bigint,"nativeHash"=sha256(convert_to(ctp_admission.canonical(native),'UTF8')),"nativeStatus"=native_status WHERE "tenantId"=t AND "orderId"=order_id;
 UPDATE public.submission_attempt SET status='RECONCILED',"resolvedAt"=clock_timestamp(),"evidenceHash"=fp WHERE "tenantId"=t AND id=attempt_id;
 INSERT INTO public.order_event("tenantId","orderId",version,"previousStatus",status,source,"sourceIdentity","evidenceHash","occurredAt") VALUES(t,order_id,o.version+1,o.status,native_status,'AMEND_APPLICATION',k."intentId"::text,fp,clock_timestamp());
 INSERT INTO public.outbox_event("tenantId","eventType","schemaVersion","aggregateType","aggregateId","aggregateVersion",payload,"occurredAt") VALUES(t,'OrderUpdated',1,'Order',order_id,o.version+1,jsonb_build_object('orderId',order_id::text,'intentId',o."intentId"::text,'status',native_status,'reconciliation',reconciled),clock_timestamp());
 PERFORM ctp_admission.sync_reservation(t,order_id);
END $$;
REVOKE ALL ON FUNCTION ctp_execution.apply_amendment(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_execution.apply_amendment(jsonb) TO ctp_execution;
-- Coverage must also cross the local native receipt; source clock skew cannot advance a prior Portfolio cut.
CREATE OR REPLACE FUNCTION ctp_admission.sync_reservation(t uuid,order_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i ctp_admission.issuance%ROWTYPE; o public."order"%ROWTYPE; rr public.risk_reservation%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; wm ctp_portfolio.hold_watermark%ROWTYPE;
 previous ctp_admission.lifecycle_revision%ROWTYPE; pg ctp_execution.progress%ROWTYPE;
 proof jsonb; fp bytea; state jsonb; hold jsonb; event jsonb; text_state text;
 native jsonb; control_applied boolean; effective jsonb; control_reject boolean; expired_unused boolean; terminal_proof boolean; not_sent boolean; definitive_reject boolean;
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
  expired_unused:=i."primaryReservationId" IS NOT NULL AND rr.status='ACTIVE' AND rr.amount=0 AND i.notional=0 AND i."reductionQuantity"=0
   AND rr."expiresAt"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."intentId"=i."intentId");
  proof:=proof||jsonb_build_object('expiredUnusedControl',expired_unused);
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
  effective:=ctp_execution.effective_command(t,order_id);
  terminal_proof:=COALESCE(o.status IN('FILLED','CANCELED','REJECTED','EXPIRED') AND o."reconciliationState"='CONSISTENT'
   AND pg."nativeStatus"=o.status AND pg."nativeAt"<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND native->>'status'=pg."nativeStatus"::text AND native->>'clientOrderId'=effective->>'clientOrderId'
   AND native->>'internalOrderId'=o.id::text AND native->>'intentId'=o."intentId"::text
   AND native->>'exchangeOrderId'=o."exchangeOrderId" AND (native->>'filledQuantity')::numeric=o."filledQuantity"
   AND native->'account'=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',i.request->'binding'->>'externalAccountId')
   AND native->>'instrumentId'=i.instrument AND (native->>'quantity')::numeric=(effective->'size'->>'value')::numeric
   AND o."filledQuantity"=(SELECT COALESCE(sum(quantity),0) FROM public.fill WHERE "tenantId"=t AND "orderId"=order_id)
   AND NOT EXISTS(SELECT 1 FROM public.fill f LEFT JOIN ctp_execution.fill_adoption a ON a."tenantId"=f."tenantId" AND a."fillId"=f.id LEFT JOIN ctp_portfolio.evidence e ON e."tenantId"=a."tenantId" AND e.book=a.book AND e.id=a."eventId"
    WHERE f."tenantId"=t AND f."orderId"=order_id AND (a.book IS DISTINCT FROM b.id OR e.ledger IS NULL OR floor(extract(epoch FROM f.timestamp)*1000)::bigint>(state->>'snapshotAt')::bigint))
   AND NOT EXISTS(SELECT 1 FROM public.submission_attempt s WHERE s."tenantId"=t AND s."orderId"=order_id AND s.status IN('DISPATCHING','UNKNOWN','ACKNOWLEDGED')),false);
  native_confirmed:=COALESCE(o.status IN('SUBMITTED','PARTIALLY_FILLED') AND o."reconciliationState"='CONSISTENT'
   AND pg."nativeStatus"=o.status AND pg."nativeAt"<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND native->>'status'=CASE pg."nativeStatus" WHEN 'SUBMITTED' THEN 'OPEN' ELSE pg."nativeStatus"::text END AND native->>'clientOrderId'=effective->>'clientOrderId'
   AND native->>'internalOrderId'=o.id::text AND native->>'intentId'=o."intentId"::text
   AND native->>'exchangeOrderId'=o."exchangeOrderId" AND (native->>'filledQuantity')::numeric=o."filledQuantity"
   AND native->'account'=jsonb_build_object('tenantId',t::text,'connectionId',o."connectionId"::text,'externalAccountId',i.request->'binding'->>'externalAccountId')
   AND state->>'status'='RECONCILED' AND state->'pending'='[]'::jsonb AND state->'differences'='[]'::jsonb AND (state->>'snapshotAt')::bigint>=pg."nativeAt"
   AND (NOT EXISTS(SELECT 1 FROM ctp_execution.amendment_head h WHERE h."tenantId"=t AND h."orderId"=order_id)
    OR EXISTS(SELECT 1 FROM ctp_execution.amendment_head h JOIN ctp_execution.amendment_application j USING("tenantId","orderId",sequence)
     WHERE h."tenantId"=t AND h."orderId"=order_id AND (state->>'snapshotAt')::bigint>=(j.proof->>'nativeReceivedAt')::bigint)) AND native->>'side'=o.side::text AND native->>'instrumentId'=i.instrument AND (native->>'quantity')::numeric=(effective->'size'->>'value')::numeric
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
  control_reject:=i."primaryReservationId" IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.submission_attempt a JOIN ctp_execution.authoritative_event e ON e."tenantId"=a."tenantId" AND e."orderId"=a."orderId" AND e.identity='result:'||a.id::text
    WHERE a."tenantId"=t AND a."intentId"=i."intentId" AND a.operation='AMEND' AND a.status='REJECTED'
    AND a."reservationId"=rr.id AND a."commandHash"=decode(i.request->>'commandHash','hex')
    AND e.payload::jsonb->>'operation'='AMEND' AND e.payload::jsonb->>'attemptId'=a.id::text
    AND e.payload::jsonb->'outcome'->>'kind'='DEFINITIVELY_REJECTED'
    AND ((a."responseCode"='NOT_SENT' AND a."transportStartedAt" IS NULL AND a."permitConsumedAt" IS NULL)
     OR (a."responseCode"='DEFINITIVELY_REJECTED' AND a."transportStartedAt" IS NOT NULL AND a."permitConsumedAt" IS NOT NULL)));
  control_applied:=i."primaryReservationId" IS NOT NULL AND rr.amount=0 AND EXISTS(
   SELECT 1 FROM ctp_execution.amendment_application app JOIN public.submission_attempt a ON a."tenantId"=app."tenantId" AND a.id=app."attemptId"
    WHERE app."tenantId"=t AND app."intentId"=i."intentId" AND app."orderId"=order_id AND a.status='RECONCILED'
    AND a."reservationId"=rr.id AND a."transportStartedAt" IS NOT NULL AND a."permitConsumedAt" IS NOT NULL
    AND app.fingerprint=sha256(convert_to(ctp_admission.canonical(app.cause),'UTF8')) AND app.replacement=i.control->'command'->'replacement');
  desired:=CASE WHEN control_applied OR expired_unused OR control_reject OR terminal_proof OR not_sent OR definitive_reject THEN 'RELEASED'::public."ReservationStatus" WHEN unresolved OR (rr.status='UNRESOLVED' AND NOT native_confirmed) THEN 'UNRESOLVED'::public."ReservationStatus" ELSE 'ACTIVE'::public."ReservationStatus" END;
  next_amount:=rr.amount;
  IF native_confirmed AND i."primaryReservationId" IS NULL AND o.quantity>0 AND (effective->'size'->>'value')::numeric>o."filledQuantity" AND ((effective->'size'->>'value')::numeric<o.quantity OR o."filledQuantity">0) THEN
   SELECT (e.payload::jsonb->'hold'->>'amount')::numeric INTO original_amount FROM ctp_portfolio.evidence e WHERE e."tenantId"=t AND e.book=b.id AND e.id='risk-reserve-'||rr.id::text;
   IF original_amount IS NULL THEN RAISE EXCEPTION 'RISK_LIFECYCLE_ORIGINAL_AMOUNT'; END IF;
   next_amount:=least(rr.amount,ceil(original_amount*((effective->'size'->>'value')::numeric-o."filledQuantity")/o.quantity*10::numeric^18)/10::numeric^18);
  END IF;
  proof:=proof||jsonb_build_object('nativeConfirmed',native_confirmed,'nativeBodyHash',CASE WHEN native IS NULL THEN NULL ELSE encode(sha256(convert_to(ctp_admission.canonical(native),'UTF8')),'hex') END,'nextAmount',trim_scale(next_amount)::text);
  expired_unused:=i."primaryReservationId" IS NOT NULL AND rr.status='ACTIVE' AND rr.amount=0 AND i.notional=0 AND i."reductionQuantity"=0
   AND rr."expiresAt"<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."intentId"=i."intentId");
  proof:=proof||jsonb_build_object('expiredUnusedControl',expired_unused);
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
REVOKE ALL ON FUNCTION ctp_admission.sync_reservation(uuid,uuid) FROM PUBLIC;
COMMIT;
