BEGIN;

-- One direct successor of the first PAPER execution. No backfill or dispatch.
CREATE TABLE ctp_paper.postexecution_commitment (
 tenant_id uuid NOT NULL,
 execution_id uuid NOT NULL,
 account_id uuid NOT NULL,
 book_id uuid NOT NULL,
 intent_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 certificate_id uuid NOT NULL,
 event_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 previous_revision bigint NOT NULL CHECK(previous_revision>=2),
 previous_hash bytea NOT NULL CHECK(octet_length(previous_hash)=32),
 revision bigint NOT NULL CHECK(revision=previous_revision+1 AND revision<=9007199254740991),
 state_hash bytea NOT NULL CHECK(octet_length(state_hash)=32),
 applied_ms bigint NOT NULL CHECK(applied_ms BETWEEN 0 AND 8640000000000000),
 PRIMARY KEY(tenant_id,idempotency_key),
 UNIQUE(tenant_id,execution_id), UNIQUE(tenant_id,intent_id), UNIQUE(tenant_id,reservation_id),
 UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES ctp_paper.execution_commit(tenant_id,execution_id),
 FOREIGN KEY(tenant_id,intent_id) REFERENCES ctp_paper.admission_issuance(tenant_id,intent_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES ctp_paper.admission_issuance(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,certificate_id) REFERENCES ctp_paper.current_risk_certificate(tenant_id,id),
 FOREIGN KEY(tenant_id,book_id,previous_revision,previous_hash)
  REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash),
 FOREIGN KEY(tenant_id,book_id,revision,state_hash)
  REFERENCES ctp_paper.admission_book_event(tenant_id,book_id,revision,state_hash)
);
ALTER TABLE ctp_paper.postexecution_commitment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.postexecution_commitment FORCE ROW LEVEL SECURITY;
CREATE POLICY postexecution_tenant ON ctp_paper.postexecution_commitment
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE ctp_paper.postexecution_commitment FROM PUBLIC,ctp_paper_risk_admission;
CREATE TRIGGER postexecution_immutable BEFORE UPDATE OR DELETE ON ctp_paper.postexecution_commitment
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER postexecution_no_truncate BEFORE TRUNCATE ON ctp_paper.postexecution_commitment
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.validate_postexecution_commitment(
 x ctp_paper.execution_commit,s ctp_paper.postexecution_commitment
) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i ctp_paper.admission_issuance%ROWTYPE; r public.risk_reservation%ROWTYPE;
 j ctp_paper.reservation_state_event%ROWTYPE; d ctp_paper.reservation_debit%ROWTYPE;
 w ctp_portfolio.hold_watermark%ROWTYPE; e ctp_paper.admission_book_event%ROWTYPE;
 c ctp_paper.current_risk_certificate%ROWTYPE;
 hold jsonb; event jsonb; event_text text; before_state jsonb; after_text text;
 cert_source jsonb; captured_execution jsonb; market jsonb; cash numeric; held numeric;
 target_command jsonb; rules jsonb; model jsonb; quantity numeric; price numeric;
 tick numeric; lot numeric; fee numeric; principal_atoms numeric; debit_atoms numeric;
BEGIN
 IF s.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid
  OR ROW(s.tenant_id,s.execution_id,s.account_id,s.book_id,s.previous_revision,s.previous_hash)
   IS DISTINCT FROM ROW(x.tenant_id,x.execution_id,x.account_id,x.book_id,x.revision,x.state_hash)
  OR s.intent_id=x.intent_id OR s.reservation_id=x.reservation_id OR s.applied_ms<x.evaluated_ms
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=s.tenant_id AND intent_id=s.intent_id;
 IF NOT FOUND OR ROW(i.reservation_id,i.certificate_id,i.account_id,i.book_id,i.created_ms)
  IS DISTINCT FROM ROW(s.reservation_id,s.certificate_id,s.account_id,s.book_id,s.applied_ms)
  OR i.order_id=x.order_id OR i.request->>'operation' IS DISTINCT FROM 'PLACE'
  OR i.request->>'orderId' IS DISTINCT FROM i.order_id::text OR i.request->>'intentId' IS DISTINCT FROM s.intent_id::text
  OR i.request->'binding' IS DISTINCT FROM x.request #> '{admission,binding}'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT cmd.command::jsonb INTO target_command FROM ctp_execution.command cmd
  JOIN public."order" o ON o."tenantId"=cmd."tenantId" AND o.id=cmd."orderId" AND o."intentId"=cmd."intentId"
  WHERE cmd."tenantId"=s.tenant_id AND cmd."orderId"=i.order_id AND cmd."intentId"=s.intent_id
   AND cmd.operation='PLACE' AND encode(cmd."commandHash",'hex')=i.request->>'commandHash'
   AND o."accountId"=s.account_id AND o.mode='PAPER' AND o.status='CREATED' AND o.version=0
   AND o."connectionId" IS NULL AND o."ruleVersionId"=i.rule_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO c FROM ctp_paper.current_risk_certificate WHERE tenant_id=s.tenant_id AND id=s.certificate_id;
 IF NOT FOUND OR c.execution_id<>x.execution_id OR s.applied_ms NOT BETWEEN c.created_ms AND c.expires_ms-1
  OR i.source IS DISTINCT FROM c.document_text::jsonb
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 cert_source:=c.document_text::jsonb->'source';
 captured_execution:=(cert_source #>> '{inventory,text}')::jsonb #> '{executed,execution}';
 market:=(cert_source #>> '{market,snapshot,text}')::jsonb;
 IF captured_execution->'receipt' IS DISTINCT FROM x.receipt
  OR captured_execution #> '{effects,state}' IS DISTINCT FROM x.effects->'state'
  OR market #>> '{key,dbRuleId}' IS DISTINCT FROM i.rule_id::text
  OR market #>> '{record,instrument,baseAsset}' IS DISTINCT FROM i.base
  OR market #>> '{record,instrument,quoteAsset}' IS DISTINCT FROM i.quote
  OR market #>> '{record,instrument,id}' IS DISTINCT FROM i.instrument
  OR NOT EXISTS(SELECT 1 FROM public.risk_decision v WHERE v."tenantId"=s.tenant_id
   AND v.id=i.decision_id AND v.verdict='APPROVE' AND v."ruleVersionId"=i.rule_id
   AND encode(v."commandHash",'hex')=i.request->>'commandHash')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO r FROM public.risk_reservation WHERE "tenantId"=s.tenant_id AND id=s.reservation_id;
 IF NOT FOUND OR ROW(r."decisionId",r."intentId",r."accountId",r.mode,r.status,r.version,r."consumedAmount",r."vectorSize",r."paperLegacy")
  IS DISTINCT FROM ROW(i.decision_id,s.intent_id,s.account_id,'PAPER'::public."TradingMode",'ACTIVE'::public."ReservationStatus",0,0::numeric,1,false)
  OR r.asset IS NOT NULL OR r.amount IS NOT NULL OR r."budgetId" IS NOT NULL OR r."releasedAt" IS NOT NULL
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO j FROM ctp_paper.reservation_state_event WHERE tenant_id=s.tenant_id AND reservation_id=s.reservation_id
  ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND OR ROW(j.revision,j.status,j.observed_ms) IS DISTINCT FROM ROW(1::smallint,'ACTIVE'::text,s.applied_ms)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO d FROM ctp_paper.reservation_debit WHERE tenant_id=s.tenant_id AND reservation_id=s.reservation_id AND ordinal=1;
 IF NOT FOUND OR d.asset<>i.quote OR d.amount<=0
  OR i.response->'debits' IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
   'asset',d.asset,'amount',trim_scale(d.amount)::text,'holdId',d.hold_id::text))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 before_state:=x.effects->'state';
 IF before_state->>'status' IS DISTINCT FROM 'RECONCILED' OR jsonb_array_length(before_state->'holds')>=1000
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(before_state->'holds') h WHERE h->>'id'=d.hold_id::text OR h->>'status'='UNKNOWN')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT max((b->>'available')::numeric) INTO cash FROM jsonb_array_elements(before_state->'balances') b
  WHERE b->>'asset'=d.asset HAVING count(*)=1;
 SELECT coalesce(sum((h->>'amount')::numeric),0) INTO held FROM jsonb_array_elements(before_state->'holds') h
  WHERE h->>'asset'=d.asset AND h->'reflected'='false'::jsonb;
 IF cash IS NULL OR cash-held<d.amount THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 -- Recompute exact notional and reserve from the retained command, rules and model.
 rules:=market #> '{record,rules}';
 model:=(captured_execution #>> '{source,started,context,configuration,receiptText}')::jsonb #> '{configuration,model}';
 IF target_command->>'side' IS DISTINCT FROM 'BUY'
  OR target_command->>'instrumentId' IS DISTINCT FROM i.instrument
  OR target_command->>'ruleVersion' IS DISTINCT FROM rules->>'version'
  OR target_command #>> '{size,kind}' IS DISTINCT FROM 'BASE_QUANTITY'
  OR target_command #>> '{size,asset}' IS DISTINCT FROM i.base
  OR target_command->'reduceOnly' IS DISTINCT FROM 'false'::jsonb
  OR target_command->'trigger' IS DISTINCT FROM 'null'::jsonb
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 quantity:=(target_command #>> '{size,value}')::numeric;
 tick:=(rules->>'tickSize')::numeric;lot:=(rules->>'stepSize')::numeric;fee:=(model->>'takerFeeRate')::numeric;
 price:=CASE target_command->>'type' WHEN 'LIMIT' THEN (target_command->>'limitPrice')::numeric
  WHEN 'MARKET' THEN (rules->>'maxPrice')::numeric END;
 IF (quantity>0 AND tick>0 AND lot>0 AND fee>=0 AND price>=tick
  AND mod(quantity,nullif(lot,0))=0) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 price:=div(price,tick)*tick;
 principal_atoms:=ceil(quantity*price*1e18::numeric);
 debit_atoms:=principal_atoms+div(quantity,lot)*ceil(lot*price*fee*1e18::numeric);
 IF i.notional IS DISTINCT FROM principal_atoms*1e-18::numeric
  OR d.amount IS DISTINCT FROM debit_atoms*1e-18::numeric
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 hold:=jsonb_build_object('id',d.hold_id::text,'asset',d.asset,'amount',trim_scale(d.amount)::text,'status','RESERVED','reflected',false);
 event:=jsonb_build_object('id',s.event_id::text,'type','COMMITMENT','timestamp',s.applied_ms,'hold',hold);
 event_text:=ctp_admission.canonical(event);
 after_text:=ctp_admission.canonical(jsonb_set(before_state,'{holds}',(before_state->'holds')||jsonb_build_array(hold)));
 SELECT * INTO e FROM ctp_paper.admission_book_event WHERE tenant_id=s.tenant_id AND book_id=s.book_id AND revision=s.revision;
 IF NOT FOUND OR ROW(e.account_id,e.cause_id,e.kind,e.previous_revision,e.previous_hash,e.state_hash,e.state_text)
  IS DISTINCT FROM ROW(s.account_id,s.reservation_id,'RESERVE'::text,s.previous_revision,s.previous_hash,s.state_hash,after_text)
  OR s.state_hash<>sha256(convert_to(after_text,'UTF8'))
  OR NOT EXISTS(SELECT 1 FROM ctp_portfolio.evidence v WHERE v."tenantId"=s.tenant_id AND v.book=s.book_id
   AND v."accountId"=s.account_id AND v.mode='PAPER' AND v.id=s.event_id::text AND v.payload=event_text
   AND v.fingerprint=sha256(convert_to(event_text,'UTF8')) AND v.ledger IS NULL)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO w FROM ctp_portfolio.hold_watermark WHERE "tenantId"=s.tenant_id AND book=s.book_id AND "holdId"=d.hold_id::text;
 IF NOT FOUND OR w.timestamp<>s.applied_ms OR w.released OR w.unknown
  OR w.fingerprint<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN after_text;
END $$;

REVOKE ALL ON FUNCTION ctp_paper.validate_postexecution_commitment(ctp_paper.execution_commit,ctp_paper.postexecution_commitment)
 FROM PUBLIC,ctp_paper_risk_admission;

-- All original immutable execution/economics checks apply to both heads.
CREATE OR REPLACE FUNCTION ctp_paper.validate_committed_execution(t uuid,k text) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE x ctp_paper.execution_commit%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE; s ctp_paper.attempt_start%ROWTYPE;
 b ctp_portfolio.book%ROWTYPE; previous ctp_paper.admission_book_event%ROWTYPE; e ctp_paper.admission_book_event%ROWTYPE;
 o public."order"%ROWTYPE; r public.risk_reservation%ROWTYPE; j ctp_paper.reservation_state_event%ROWTYPE;
 wm ctp_portfolio.hold_watermark%ROWTYPE; f public.fill%ROWTYPE; l public.ledger_transaction%ROWTYPE; fee public.fee%ROWTYPE;
 item jsonb; event jsonb; change jsonb; event_payload text; expected jsonb; n integer:=0; notional numeric:=0; native bytea;
 successor ctp_paper.postexecution_commitment%ROWTYPE; expected_revision bigint;
 expected_hash bytea; expected_state text; companion_count integer:=0;
BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_key=k;
 IF NOT FOUND OR x.seal IS DISTINCT FROM ctp_paper.execution_commit_seal(x)
  OR x.effects IS DISTINCT FROM ctp_paper.derive_pristine_effects(x.input)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO successor FROM ctp_paper.postexecution_commitment WHERE tenant_id=t AND execution_id=x.execution_id;
 IF FOUND THEN companion_count:=1; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND reservation_id=x.reservation_id;
 IF NOT FOUND OR ROW(i.order_id,i.intent_id,i.account_id,i.book_id) IS DISTINCT FROM ROW(x.order_id,x.intent_id,x.account_id,x.book_id)
  OR i.request IS DISTINCT FROM x.request->'admission' OR i.response_hash<>sha256(convert_to(i.response::text,'UTF8'))
  OR i.source_hash<>sha256(convert_to(i.source::text,'UTF8'))
  OR (SELECT count(*) FROM ctp_paper.admission_issuance WHERE tenant_id=t AND book_id=x.book_id)<>1+companion_count
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
 expected_revision:=x.revision;expected_hash:=x.state_hash;expected_state:=e.state_text;
 IF companion_count=1 THEN
  expected_state:=ctp_paper.validate_postexecution_commitment(x,successor);
  expected_revision:=successor.revision;expected_hash:=successor.state_hash;
 END IF;
 SELECT * INTO b FROM ctp_portfolio.book WHERE "tenantId"=t AND id=x.book_id;
 IF NOT FOUND OR ROW(b."accountId",b.mode,b.revision,b.state_hash,b.state) IS DISTINCT FROM ROW(x.account_id,'PAPER'::public."TradingMode",expected_revision,expected_hash,expected_state)
  OR NOT EXISTS(SELECT 1 FROM ctp_paper.admission_book_head WHERE tenant_id=t AND book_id=x.book_id AND revision=expected_revision AND state_hash=expected_hash)
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
  IS DISTINCT FROM change->'watermark' OR (SELECT count(*) FROM ctp_portfolio.hold_watermark WHERE "tenantId"=t AND book=x.book_id)<>1+companion_count
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

CREATE FUNCTION ctp_paper.check_postexecution_commitment() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE k text;
BEGIN
 SELECT execution_key INTO k FROM ctp_paper.execution_commit
  WHERE tenant_id=NEW.tenant_id AND execution_id=NEW.execution_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 PERFORM ctp_paper.validate_committed_execution(NEW.tenant_id,k);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER postexecution_causality AFTER INSERT ON ctp_paper.postexecution_commitment
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_postexecution_commitment();
REVOKE ALL ON FUNCTION ctp_paper.check_postexecution_commitment() FROM PUBLIC,ctp_paper_risk_admission;

-- Independently evaluated in PostgreSQL from the sealed current-order capture.
CREATE FUNCTION ctp_paper.derive_postexecution_risk(jsonb) RETURNS TABLE (
 result jsonb,"cashProof" jsonb,"budgetProof" jsonb,"policyProof" jsonb,
 "operationalProof" jsonb,"orderProof" jsonb,"commitmentProof" jsonb
) LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $postexecution_proof$
WITH capture AS MATERIALIZED (
  SELECT $1::jsonb AS result
), certificate AS MATERIALIZED (
  SELECT (result #>> '{certificate,text}')::jsonb AS document,
         result->'target' AS target,
         result #> '{target,command}' AS command,
         result #> '{target,owner}' AS target_owner,
         (result #>> '{target,createdAt}')::bigint AS target_created_at
  FROM capture WHERE result->>'kind' = 'CAPTURED'
), inputs AS MATERIALIZED (
  SELECT document, target, command, target_created_at,
         (document #>> '{source,market,snapshot,text}')::jsonb AS snapshot,
         (document #>> '{source,inventory,text}')::jsonb #> '{executed,execution}' AS execution
  FROM certificate
), price_inputs AS (
  SELECT command #>> '{size,value}' AS quantity, command, snapshot,
         (document #>> '{source,market,trade,text}')::jsonb->'trade' AS trade,
         CASE command->>'type' WHEN 'LIMIT' THEN command->>'limitPrice'
                              WHEN 'MARKET' THEN snapshot #>> '{record,rules,maxPrice}' END AS ceiling,
         (snapshot #>> '{record,rules,tickSize}')::numeric AS tick,
         (snapshot #>> '{record,rules,stepSize}')::numeric AS lot,
         snapshot #>> '{record,instrument,quoteAsset}' AS asset,
         execution #> '{effects,state}' AS book,
         (cfg.model->>'takerFeeRate')::numeric AS fee_rate,
         (cfg.model->>'participationRate')::numeric AS participation
  FROM inputs
  CROSS JOIN LATERAL (
    SELECT (execution #>> '{source,started,context,configuration,receiptText}')::jsonb
           #> '{configuration,model}' AS model
  ) cfg
  WHERE command->>'side' = 'BUY' AND command #>> '{size,kind}' = 'BASE_QUANTITY'
), sized AS (
  SELECT quantity::numeric AS quantity, lot, tick, asset, book, fee_rate,
         command, snapshot, trade, participation,
         div(ceiling::numeric, nullif(tick, 0)) * tick AS maximum
  FROM price_inputs
), debit AS (
  SELECT asset, book, principal_atoms * 1e-18::numeric AS notional,
         (principal_atoms
          + div(quantity, nullif(lot, 0)) * ceil(lot * maximum * fee_rate * 1e18::numeric))
         * 1e-18::numeric AS amount
  FROM sized
  CROSS JOIN LATERAL (SELECT ceil(quantity * maximum * 1e18::numeric) AS principal_atoms) principal
  WHERE quantity > 0 AND maximum > 0 AND lot > 0
    AND mod(quantity, nullif(lot, 0)) = 0 AND fee_rate >= 0
), cash AS (
  SELECT d.asset, d.amount, d.notional, balance.available - coalesce(held.amount, 0) AS available
  FROM debit d
  CROSS JOIN LATERAL (
    SELECT max((b.value->>'available')::numeric) AS available
    FROM jsonb_array_elements(d.book->'balances') b WHERE b.value->>'asset' = d.asset
    HAVING count(*) = 1
  ) balance
  CROSS JOIN LATERAL (
    SELECT sum((h.value->>'amount')::numeric) AS amount
    FROM jsonb_array_elements(d.book->'holds') h
    WHERE h.value->>'asset' = d.asset AND h.value->'reflected' = 'false'::jsonb
  ) held
), prior_exposure AS (
  SELECT document, target_created_at,
         (execution #>> '{effects,order,executedQuantity}')::numeric AS filled,
         (execution #>> '{effects,order,remainingQuantity}')::numeric AS pending,
         (snapshot #>> '{ticker,last,value}')::numeric AS mark,
         CASE execution #>> '{effects,reservation,status}'
           WHEN 'ACTIVE' THEN 1 WHEN 'RELEASED' THEN 0
         END AS open_orders,
         CASE execution #>> '{input,attempt,request,admission,command,type}'
           WHEN 'LIMIT' THEN (execution #>> '{input,attempt,request,admission,command,limitPrice}')::numeric
           WHEN 'MARKET' THEN (execution #>> '{input,original,record,rules,maxPrice}')::numeric
         END AS original_ceiling,
         (execution #>> '{input,original,record,rules,tickSize}')::numeric AS original_tick
  FROM inputs
), exposure AS (
  -- This certificate supports one executed order, one instrument and pristine
  -- siblings. The live residual uses its original ceiling, even after a rule refresh.
  SELECT document, open_orders, notional, available - amount AS remaining,
         filled * mark + CASE open_orders WHEN 0 THEN 0
           WHEN 1 THEN pending * div(original_ceiling, nullif(original_tick, 0)) * original_tick
         END AS current_exposure,
         CASE WHEN filled > 0 OR open_orders = 1 THEN 1 ELSE 0 END AS potential_positions,
         (document #>> '{source,ordersInLastMinute}')::integer
           + CASE WHEN target_created_at < (document->>'createdAt')::bigint - 60000
                  THEN 1 ELSE 0 END AS orders_in_minute
  FROM prior_exposure CROSS JOIN cash
  WHERE filled >= 0 AND pending >= 0 AND mark > 0 AND open_orders IS NOT NULL
    AND target_created_at BETWEEN 0 AND (document->>'createdAt')::bigint
), projected AS (
  SELECT *, current_exposure + notional AS projected_exposure
  FROM exposure
), market_facts AS (
  SELECT asset, quantity, tick, lot, participation, maximum, command,
         (snapshot #>> '{book,bids,0,price}')::numeric AS bid,
         (snapshot #>> '{book,asks,0,price}')::numeric AS ask,
         (snapshot #>> '{book,bids,0,quantity}')::numeric AS bid_size,
         (snapshot #>> '{book,asks,0,quantity}')::numeric AS ask_size,
         (trade->>'quantity')::numeric AS trade_size,
         CASE WHEN snapshot #>> '{ticker,last,state}' = 'AVAILABLE'
              THEN (snapshot #>> '{ticker,last,value}')::numeric END AS reference,
         greatest(tick, (snapshot #>> '{record,rules,minPrice}')::numeric) AS lower_bound,
         (snapshot #>> '{record,rules,minNotional}')::numeric AS min_notional,
         (snapshot #>> '{record,rules,maxNotional}')::numeric AS max_notional
  FROM sized
), market AS (
  -- Exact positive lot rounding and price bounds. A missing input must never
  -- be ignored by PostgreSQL's null-tolerant LEAST.
  SELECT *, (div(lower_bound, nullif(tick, 0))
         + CASE WHEN mod(lower_bound, nullif(tick, 0)) = 0 THEN 0 ELSE 1 END) * tick AS minimum,
         (command->>'limitPrice')::numeric AS limit_price,
         CASE WHEN bid_size > 0 AND ask_size > 0 AND trade_size > 0 AND participation > 0
           THEN floor(div(least(bid_size, ask_size, trade_size) * participation, nullif(lot, 0))
                      * lot * least(bid, ask) * 1e18::numeric) * 1e-18::numeric
         END AS liquidity
  FROM market_facts
), loss AS (
  SELECT (evidence->>'utcDayStart')::bigint AS day_start,
         evidence->'complete' = 'true'::jsonb AS complete,
         (evidence->>'adjustedOpeningEquity')::numeric AS opening,
         (evidence->>'adjustedCurrentEquity')::numeric AS equity,
         (evidence->>'adjustedPeakEquity')::numeric AS peak,
         -(evidence->>'dailyNetRealizedPnl')::numeric AS realized_loss
  FROM certificate
  CROSS JOIN LATERAL (SELECT (document #>> '{source,loss,text}')::jsonb AS evidence) sealed
), budget AS (
  SELECT projected.*, policy.within_limits, policy.market_allowed, policy.loss_allowed, market.liquidity
  FROM projected CROSS JOIN market CROSS JOIN loss
  CROSS JOIN LATERAL (
    SELECT count(*) = 2
      AND count(*) FILTER (WHERE p.value #>> '{scope,kind}' = 'PLATFORM') = 1
      AND count(*) FILTER (WHERE p.value #>> '{scope,kind}' = 'USER') = 1
      AND bool_and((
        notional <= (l.limits->>'maxOrderNotional')::numeric
        AND projected_exposure <= (l.limits->>'maxInstrumentExposure')::numeric
        AND projected_exposure <= (l.limits->>'maxAssetExposure')::numeric
        AND projected_exposure <= (l.limits->>'maxAccountExposure')::numeric
        AND projected_exposure <= (l.limits->>'maxUserExposure')::numeric
        AND remaining >= (l.limits->>'minAvailableBalance')::numeric
        AND open_orders + 1 <= (l.limits->>'maxOpenOrders')::integer
        AND 1 <= (l.limits->>'maxConcurrentPositions')::integer
        AND orders_in_minute BETWEEN 1 AND (l.limits->>'maxOrdersPerMinute')::integer
      ) IS TRUE) AS within_limits,
      bool_and((
        asset = l.limits->>'valuationAsset'
        AND 1 <= (l.limits->>'maxLeverage')::numeric
        AND reference > 0 AND bid > 0 AND bid <= ask
        AND minimum <= bid AND maximum >= ask AND minimum <= maximum
        AND quantity * coalesce(limit_price, minimum) >= min_notional
        AND (max_notional IS NULL OR quantity * coalesce(limit_price, maximum) <= max_notional)
        AND abs(coalesce(limit_price, minimum) - reference)
              <= reference * (l.limits->>'maxPriceDeviationRate')::numeric
        AND abs(coalesce(limit_price, maximum) - reference)
              <= reference * (l.limits->>'maxPriceDeviationRate')::numeric
        AND ask - bid <= reference * (l.limits->>'maxSpreadRate')::numeric
        AND liquidity >= notional AND liquidity >= (l.limits->>'minLiquidityNotional')::numeric
      ) IS TRUE) AS market_allowed,
      bool_and((
        complete AND day_start = ((document->>'createdAt')::bigint / 86400000) * 86400000
        AND opening > 0 AND equity > 0 AND peak >= opening AND peak >= equity
        AND (realized_loss <= 0 OR realized_loss < (l.limits->>'maxDailyRealizedLoss')::numeric)
        AND (opening <= equity OR opening - equity < (l.limits->>'maxDailyTotalLoss')::numeric)
        AND (peak <= equity OR peak - equity < peak * (l.limits->>'maxDrawdownRate')::numeric)
      ) IS TRUE) AS loss_allowed
    FROM jsonb_array_elements(document #> '{source,policies}') p
    CROSS JOIN LATERAL (SELECT p.value->'limits' AS limits) l
  ) policy
), operational_sources AS (
  SELECT document, target_owner, document #> '{source,runtime}' AS runtime,
         (document #>> '{source,controls,text}')::jsonb AS controls,
         (document->>'createdAt')::bigint AS captured_at,
         (document->>'expiresAt')::bigint AS expires_at,
         (document #>> '{source,lossInput,maxEvidenceAgeMs}')::bigint AS age
  FROM certificate
), operational_facts AS (
  SELECT *,
         (runtime #>> '{configuration,receiptText}')::jsonb AS configuration,
         (runtime #>> '{publication,text}')::jsonb->'observation' AS observation,
         (runtime #>> '{publication,publishedAt}')::bigint AS published_at
  FROM operational_sources
), operational AS (
  SELECT (
    target_owner = runtime->'owner' AND target_owner = observation->'owner'
    AND target_owner = configuration #> '{configuration,owner}'
    AND observation->'configurationId' = configuration #> '{configuration,id}'
    AND observation->'configurationHash' = runtime #> '{configuration,hash}'
    AND runtime #>> '{configuration,hash}' =
        encode(sha256(convert_to(runtime #>> '{configuration,receiptText}', 'UTF8')), 'hex')
    AND runtime #>> '{publication,hash}' =
        encode(sha256(convert_to(runtime #>> '{publication,text}', 'UTF8')), 'hex')
    AND observation->'permissionEpoch' = runtime #> '{current,permissionEpoch}'
    AND observation->'userSessionEpoch' = runtime #> '{current,userSessionEpoch}'
    AND observation->'accountVersion' = runtime #> '{current,accountVersion}'
    AND observation->'permissionEpoch' = document #> '{source,request,authorization,permissionEpoch}'
    AND observation->'userSessionEpoch' = document #> '{source,request,authorization,userSessionEpoch}'
    AND published_at <= (runtime->>'asOf')::bigint AND (runtime->>'asOf')::bigint <= captured_at
    AND expires_at > captured_at AND age BETWEEN 1 AND 5000
    AND (observation->'health') ?& ARRAY[
      'database','limiter','authentication','publicMarket','executor','clock',
      'latency','rejectRate','maintenance'
    ]
    AND (SELECT count(*) FROM jsonb_each(observation->'health')) = 9
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(observation->'health') h
      CROSS JOIN LATERAL (SELECT (h.value->>'asOf')::bigint AS observed_at) health
      WHERE (h.value->>'status' = 'HEALTHY'
        AND observed_at >= (configuration->>'createdAt')::bigint
        AND observed_at <= published_at
        AND observed_at BETWEEN captured_at - age AND captured_at
        AND expires_at <= observed_at + age + 1) IS NOT TRUE
    )
  ) IS TRUE AS runtime_ready,
  (
    document #>> '{source,controls,hash}' =
      encode(sha256(convert_to(document #>> '{source,controls,text}', 'UTF8')), 'hex')
    AND jsonb_typeof(controls->'tenant') = 'array' AND jsonb_typeof(controls->'circuits') = 'array'
    AND jsonb_array_length(controls->'activePauses') = 0
    AND (SELECT count(*) FROM jsonb_array_elements(controls->'global') g
         WHERE g->>'kind' = 'KILL_SWITCH' AND g->>'key' = 'kill') = 1
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(controls->'global') g
         WHERE g->>'kind' = 'KILL_SWITCH' AND g->>'key' = 'kill'
           AND g #>> '{scope,kind}' = 'GLOBAL' AND g->>'state' = 'RUNNING')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(controls->'tenant') h
         WHERE h->>'kind' = 'KILL_SWITCH' AND h->>'state' IS DISTINCT FROM 'RUNNING')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements((controls->'global') || (controls->'tenant')) h
         WHERE h->>'kind' = 'CIRCUIT' AND h->>'state' IS DISTINCT FROM 'CLOSED')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(controls->'circuits') h
         WHERE h->>'state' IS DISTINCT FROM 'CLOSED')
  ) IS TRUE AS trading_ready
  FROM operational_facts
), order_facts AS (
  SELECT i.target, s.command, s.quantity, s.lot, s.tick, s.snapshot->'key' AS market_key,
         s.snapshot #> '{record,instrument}' AS instrument,
         s.snapshot #> '{record,rules}' AS rules, s.command->>'type' AS order_type,
         i.document #> '{source,capability}' AS capability,
         (i.document #>> '{source,runtime,publication,publishedAt}')::bigint AS published_at,
         (i.document->>'createdAt')::bigint AS captured_at,
         (i.document->>'expiresAt')::bigint AS expires_at
  FROM inputs i CROSS JOIN sized s
), order_checks AS (
  SELECT (
    target->'dbInstrumentId' = market_key->'dbInstrumentId'
    AND target->'dbRuleId' = market_key->'dbRuleId'
    AND command->'instrumentId' = market_key->'instrumentId'
    AND market_key->'instrumentId' = instrument->'id'
    AND instrument->'id' = rules->'instrumentId'
    AND market_key->'scope' = instrument->'scope' AND instrument->'scope' = rules->'scope'
    AND instrument #>> '{scope,market}' = 'SPOT' AND instrument->>'status' = 'TRADING'
    AND (instrument->'expiryAt' = 'null'::jsonb OR (instrument->>'expiryAt')::bigint >= expires_at)
    AND command->'ruleVersion' = rules->'version'
    AND (rules->>'effectiveAt')::bigint <= captured_at
    AND (rules->>'expiresAt')::bigint >= expires_at
    AND command #>> '{size,asset}' = instrument->>'baseAsset'
    AND command->'reduceOnly' = 'false'::jsonb AND command->'trigger' = 'null'::jsonb
    AND rules->>'quantityUnit' = 'BASE'
    AND order_type IN ('LIMIT', 'MARKET')
    AND jsonb_typeof(rules->'orderTypes') = 'array' AND (rules->'orderTypes') ? order_type
    AND jsonb_typeof(rules->'timeInForce') = 'array'
    AND (command->'timeInForce' = 'null'::jsonb OR (rules->'timeInForce') ? (command->>'timeInForce'))
    AND quantity BETWEEN (CASE order_type WHEN 'MARKET' THEN rules->>'marketMinQuantity'
                            ELSE rules->>'minQuantity' END)::numeric
                     AND (CASE order_type WHEN 'MARKET' THEN rules->>'marketMaxQuantity'
                            ELSE rules->>'maxQuantity' END)::numeric
    AND quantity > 0 AND lot > 0 AND mod(quantity, nullif(lot, 0)) = 0
    AND tick > 0
    AND CASE order_type
      WHEN 'MARKET' THEN command->'limitPrice' = 'null'::jsonb
      WHEN 'LIMIT' THEN (command->>'limitPrice')::numeric > 0
        AND mod((command->>'limitPrice')::numeric, nullif(tick, 0)) = 0
        AND (rules->'minPrice' = 'null'::jsonb OR
             (command->>'limitPrice')::numeric >= (rules->>'minPrice')::numeric)
        AND (rules->'maxPrice' = 'null'::jsonb OR
             (command->>'limitPrice')::numeric <= (rules->>'maxPrice')::numeric)
    END
  ) IS TRUE AS rules_allowed,
  (
    order_type IN ('LIMIT', 'MARKET')
    AND capability->>'adapterVersion' = 'paper-spot-l2-taker-v1'
    AND (capability->>'checkedAt')::bigint = published_at
    AND published_at <= captured_at
    AND captured_at < expires_at
    AND (capability->>'expiresAt')::bigint = expires_at
  ) IS TRUE AS capability_ready
  FROM order_facts
), commitment_inputs AS (
  SELECT target->'owner' AS owner,
         execution #> '{effects,state}' AS book,
         execution #>> '{source,started,capture,portfolio,bookId}' AS book_id,
         (execution #>> '{source,started,capture,portfolio,revision}')::numeric AS original_revision,
         cash.asset, cash.amount, cash.available
  FROM inputs CROSS JOIN cash
), commitment AS (
  SELECT *, (
    original_revision = trunc(original_revision)
    AND original_revision BETWEEN 1 AND 9007199254740989
    AND book->>'status' = 'RECONCILED'
    AND owner = jsonb_build_object('tenantId', book #> '{binding,tenantId}',
      'accountId', book #> '{binding,accountId}', 'mode', book #> '{binding,mode}')
    AND book #> '{binding,mode}' = '"PAPER"'::jsonb
    AND book #> '{binding,connectionId}' = 'null'::jsonb
    AND jsonb_typeof(book->'holds') = 'array'
    AND jsonb_array_length(book->'holds') < 1000
    AND (SELECT count(DISTINCT h->>'id') FROM jsonb_array_elements(book->'holds') h)
        = jsonb_array_length(book->'holds')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(book->'holds') h
      WHERE (h->>'status' IN ('PENDING', 'RESERVED')) IS NOT TRUE)
    AND amount > 0 AND available >= amount
  ) IS TRUE AS ready
  FROM commitment_inputs
)
SELECT result,
       (SELECT jsonb_build_object('asset', asset, 'amount', trim_scale(amount)::text,
          'available', trim_scale(available)::text, 'remaining', trim_scale(available-amount)::text)
        FROM cash WHERE available IS NOT NULL) AS "cashProof",
       (SELECT jsonb_build_object('notional', trim_scale(notional)::text,
          'currentExposure', trim_scale(current_exposure)::text,
          'projectedExposure', trim_scale(projected_exposure)::text,
          'openOrders', open_orders, 'potentialPositions', potential_positions,
          'ordersInLastMinute', orders_in_minute, 'withinLimits', within_limits)
        FROM budget) AS "budgetProof",
       (SELECT jsonb_build_object('liquidity', trim_scale(liquidity)::text,
          'marketAllowed', market_allowed, 'lossAllowed', loss_allowed)
        FROM budget) AS "policyProof",
       (SELECT jsonb_build_object('runtimeReady', runtime_ready, 'tradingReady', trading_ready)
        FROM operational) AS "operationalProof",
       (SELECT jsonb_build_object('rulesAllowed', rules_allowed, 'capabilityReady', capability_ready)
        FROM order_checks) AS "orderProof",
       (SELECT jsonb_build_object('bookId', book_id,
          'revision', trim_scale(original_revision + 1)::text,
          'nextRevision', trim_scale(original_revision + 2)::text,
          'ready', ready,
          'after', CASE WHEN ready THEN jsonb_set(book, '{holds}',
            (book->'holds') || jsonb_build_array(jsonb_build_object(
              'asset', asset, 'amount', trim_scale(amount)::text,
              'status', 'RESERVED', 'reflected', false))) END)
        FROM commitment) AS "commitmentProof"
FROM capture
$postexecution_proof$;
REVOKE ALL ON FUNCTION ctp_paper.derive_postexecution_risk(jsonb) FROM PUBLIC,ctp_paper_risk_admission;

CREATE FUNCTION ctp_paper.postexecution_receipt(
 s ctp_paper.postexecution_commitment,i ctp_paper.admission_issuance
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('kind','PAPER_POSTEXECUTION_RESERVED','key',s.idempotency_key,
  'intentId',s.intent_id,'orderId',i.order_id,'decisionId',i.decision_id,'reservationId',s.reservation_id,
  'certificateId',s.certificate_id,'bookId',s.book_id,'revision',s.revision::text,
  'debits',i.response->'debits')
$$;

CREATE FUNCTION ctp_paper.postexecution_reserve(p jsonb,read_only boolean) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE source_request jsonb:=p->'source'; target jsonb:=p->'target'; request jsonb; auth jsonb;
 t uuid; a uuid; target_intent uuid; target_order uuid; rule_id uuid; cert_id uuid; k text;
 x ctp_paper.execution_commit%ROWTYPE; s ctp_paper.postexecution_commitment%ROWTYPE;
 i ctp_paper.admission_issuance%ROWTYPE; c ctp_paper.current_risk_certificate%ROWTYPE;
 book_event ctp_paper.admission_book_event%ROWTYPE;
 saved_event ctp_portfolio.evidence%ROWTYPE; watermark ctp_portfolio.hold_watermark%ROWTYPE;
 account_row public.exchange_account%ROWTYPE; profile_row public.risk_profile%ROWTYPE;
 captured jsonb; proof record; document jsonb; w jsonb; market jsonb; policy jsonb;
 policy_hash bytea; platform jsonb; usr jsonb; capability jsonb; features jsonb; feature text;
 binding jsonb; quote text; base text; instrument text; amount numeric; notional numeric;
 decision_id uuid:=gen_random_uuid(); reservation_id uuid:=gen_random_uuid(); hold_id uuid:=gen_random_uuid();
 event_id uuid:=gen_random_uuid(); state_id uuid:=gen_random_uuid(); capability_id uuid:=gen_random_uuid();
 now_ms bigint; state_version bigint; observed_at timestamptz; expiration timestamptz;
 hold jsonb; event jsonb; event_text text; after_text text; after_hash bytea; response jsonb;
BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','key','source','target']),false)
  OR octet_length(p::text)>24576 OR jsonb_typeof(p->'key') IS DISTINCT FROM 'string'
  OR p->>'key' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p->>'kind' IS DISTINCT FROM (CASE WHEN read_only THEN 'PAPER_POSTEXECUTION_READ' ELSE 'PAPER_POSTEXECUTION_RESERVE' END)
  OR NOT coalesce(ctp_market.snapshot_keys(source_request,ARRAY['kind','executionKey','preparationKey','startKey','admission','authorization']),false)
  OR source_request->>'kind' IS DISTINCT FROM 'PAPER_CURRENT_RISK_CERTIFY'
  OR jsonb_typeof(source_request->'executionKey') IS DISTINCT FROM 'string'
  OR source_request->>'executionKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR NOT coalesce(ctp_market.snapshot_keys(target,ARRAY['orderId','intentId','commandHash']),false)
  OR jsonb_typeof(target->'commandHash') IS DISTINCT FROM 'string' OR target->>'commandHash' !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 target_intent:=(target->>'intentId')::uuid;target_order:=(target->>'orderId')::uuid;
 IF target->>'intentId' IS DISTINCT FROM target_intent::text OR target->>'orderId' IS DISTINCT FROM target_order::text
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 t:=ctp_paper.execution_start_auth((source_request-'executionKey')||jsonb_build_object('kind','PAPER_EXECUTION_START'));
 auth:=source_request->'authorization';binding:=source_request #> '{admission,binding}';
 a:=(binding->>'accountId')::uuid;k:=p->>'key';
 SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_key=source_request->>'executionKey';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_MISSING'; END IF;
 IF x.request IS DISTINCT FROM source_request-'kind'-'authorization' OR x.account_id<>a
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 request:=target||jsonb_build_object('binding',binding,'operation','PLACE');
 SELECT * INTO s FROM ctp_paper.postexecution_commitment WHERE tenant_id=t AND idempotency_key=k;
 IF FOUND THEN
  SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=s.intent_id;
  IF NOT FOUND OR s.execution_id<>x.execution_id OR i.request IS DISTINCT FROM request
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
  PERFORM ctp_paper.validate_committed_execution(t,x.execution_key);
  RETURN jsonb_build_object('kind','REPLAYED','receipt',ctp_paper.postexecution_receipt(s,i));
 END IF;
 IF EXISTS(SELECT 1 FROM ctp_paper.postexecution_commitment
   WHERE tenant_id=t AND (execution_id=x.execution_id OR intent_id=target_intent))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 IF read_only THEN RETURN jsonb_build_object('kind','MISSING','key',k); END IF;

 -- The fixed capture authenticates both durable orders, locks all current
 -- accounts, books, catalog and market sources, then seals the current facts.
 captured:=ctp_paper.current_order_risk_operation(
  (p-'key')||jsonb_build_object('kind','PAPER_CURRENT_ORDER_RISK_CAPTURE'));
 IF captured->>'kind' IS DISTINCT FROM 'CAPTURED' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO proof FROM ctp_paper.derive_postexecution_risk(captured);
 IF NOT FOUND OR proof."orderProof"->'rulesAllowed' IS DISTINCT FROM 'true'::jsonb
  OR proof."orderProof"->'capabilityReady' IS DISTINCT FROM 'true'::jsonb
  OR proof."operationalProof"->'runtimeReady' IS DISTINCT FROM 'true'::jsonb
  OR proof."operationalProof"->'tradingReady' IS DISTINCT FROM 'true'::jsonb
  OR captured #>> '{target,intentId}' IS DISTINCT FROM target_intent::text
  OR captured #>> '{target,orderId}' IS DISTINCT FROM target_order::text
  OR captured #>> '{target,commandHash}' IS DISTINCT FROM target->>'commandHash'
  OR proof."commitmentProof"->>'bookId' IS DISTINCT FROM x.book_id::text
  OR proof."commitmentProof"->>'revision' IS DISTINCT FROM x.revision::text
  OR proof."commitmentProof"->>'nextRevision' IS DISTINCT FROM (x.revision+1)::text
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF proof."budgetProof"->'withinLimits' IS DISTINCT FROM 'true'::jsonb
  OR proof."policyProof"->'marketAllowed' IS DISTINCT FROM 'true'::jsonb
  OR proof."policyProof"->'lossAllowed' IS DISTINCT FROM 'true'::jsonb
  OR proof."commitmentProof"->'ready' IS DISTINCT FROM 'true'::jsonb
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 document:=(captured #>> '{certificate,text}')::jsonb;w:=document->'source';cert_id:=(document->>'id')::uuid;
 SELECT * INTO STRICT c FROM ctp_paper.current_risk_certificate WHERE tenant_id=t AND id=cert_id AND execution_id=x.execution_id;
 IF c.document_text IS DISTINCT FROM captured #>> '{certificate,text}'
  OR encode(c.document_hash,'hex') IS DISTINCT FROM captured #>> '{certificate,hash}'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF now_ms<c.created_ms OR now_ms>=c.expires_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 observed_at:=to_timestamp(now_ms::double precision/1000);expiration:=to_timestamp(c.expires_ms::double precision/1000);
 SELECT * INTO STRICT account_row FROM public.exchange_account WHERE "tenantId"=t AND id=a AND mode='PAPER';
 IF account_row."permissionEpoch"::text IS DISTINCT FROM auth->>'permissionEpoch' THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 market:=(w #>> '{market,snapshot,text}')::jsonb;
 rule_id:=(market #>> '{key,dbRuleId}')::uuid;
 quote:=market #>> '{record,instrument,quoteAsset}';base:=market #>> '{record,instrument,baseAsset}';
 instrument:=market #>> '{record,instrument,id}';
 amount:=(proof."cashProof"->>'amount')::numeric;notional:=(proof."budgetProof"->>'notional')::numeric;
 IF quote IS DISTINCT FROM proof."cashProof"->>'asset' OR (amount>0 AND notional>0) IS NOT TRUE
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT value INTO STRICT platform FROM jsonb_array_elements(w->'policies') WHERE value #>> '{scope,kind}'='PLATFORM';
 SELECT value INTO STRICT usr FROM jsonb_array_elements(w->'policies') WHERE value #>> '{scope,kind}'='USER';
 policy:=jsonb_build_object('platform',platform,'user',usr);
 policy_hash:=sha256(convert_to(policy::text,'UTF8'));
 SELECT * INTO profile_row FROM public.risk_profile WHERE "tenantId"=t AND name='paper-certified-'||encode(policy_hash,'hex') AND version=1;
 IF NOT FOUND THEN
  INSERT INTO public.risk_profile("tenantId",name,version,"policyHash","valuationAsset","maxNotional","maxDailyLoss","maxDrawdownRate","maxOpenOrders",policy,"effectiveAt")
  VALUES(t,'paper-certified-'||encode(policy_hash,'hex'),1,policy_hash,quote,
   least((platform #>> '{limits,maxUserExposure}')::numeric,(usr #>> '{limits,maxUserExposure}')::numeric),
   least((platform #>> '{limits,maxDailyTotalLoss}')::numeric,(usr #>> '{limits,maxDailyTotalLoss}')::numeric),
   least((platform #>> '{limits,maxDrawdownRate}')::numeric,(usr #>> '{limits,maxDrawdownRate}')::numeric),
   least((platform #>> '{limits,maxOpenOrders}')::integer,(usr #>> '{limits,maxOpenOrders}')::integer),policy,observed_at)
  RETURNING * INTO profile_row;
 ELSIF profile_row."policyHash"<>policy_hash OR profile_row.policy<>policy THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 capability:=w->'capability';features:='[]'::jsonb;
 FOREACH feature IN ARRAY ARRAY['LIMIT_ORDER','MARKET_ORDER'] LOOP
  features:=features||jsonb_build_array(jsonb_build_object('profile',binding->'profile','feature',feature,
   'support','SUPPORTED','implementation','SYNTHETIC','constraints',jsonb_build_object('instrumentIds',jsonb_build_array(instrument)),
   'evidenceUrl','https://github.com/dendenden-boop/tradeGPTbot/blob/8dd14f4b77c3bda8a5f0df3003be54adde55bd07/packages/paper-engine/src/model.ts',
   'checkedAt',capability->'checkedAt','expiresAt',c.expires_ms,'adapterVersion',capability->'adapterVersion'));
 END LOOP;
 INSERT INTO public.capability_snapshot(id,exchange,market,mode,region,"accountMode",version,"profileVersion","verifiedAt","expiresAt",capabilities,"evidenceHash")
 VALUES(capability_id,account_row.exchange,'SPOT','PAPER',account_row.region,'SIMULATED',nextval('ctp_paper.admission_capability_version')::integer,
  'spot-l2-taker-v1',to_timestamp((capability->>'checkedAt')::double precision/1000),expiration,
  jsonb_build_object('adapterVersion',capability->'adapterVersion','features',features),sha256(convert_to(features::text,'UTF8')));
 SELECT coalesce(max(version),0)+1 INTO state_version FROM public.account_state_version WHERE "tenantId"=t AND "accountId"=a AND mode='PAPER';
 INSERT INTO public.account_state_version(id,"tenantId","accountId",mode,version,"sourceCursor","sourceAt","receivedAt","reconciledAt","reconciliationEpoch","stateHash")
 VALUES(state_id,t,a,'PAPER',state_version,'paper-certificate-'||cert_id::text,
  to_timestamp(c.created_ms::double precision/1000),observed_at,observed_at,account_row."reconciliationEpoch",c.document_hash);
 INSERT INTO public.risk_decision(id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId",
  "capabilitySnapshotId",verdict,"policyVersion","commandHash","reasonCodes","permissionEpoch","expiresAt")
 VALUES(decision_id,t,target_intent,a,'PAPER',profile_row.id,state_id,rule_id,capability_id,'APPROVE',1,
  decode(target->>'commandHash','hex'),ARRAY['CERTIFIED_PAPER_POSTEXECUTION'],account_row."permissionEpoch",expiration);
 -- Historical execution replay checks constraints immediately. Restore the
 -- declared deferred mode only for constraints covering this multi-row write.
 SET CONSTRAINTS public.paper_reservation_vector_complete,ctp_paper.paper_reservation_debit_complete,
  public.paper_admission_reservation_consistent,ctp_paper.paper_admission_state_consistent,
  ctp_portfolio.paper_admission_book_consistent,ctp_portfolio.paper_admission_watermark_consistent,
  ctp_paper.paper_admission_head_consistent,ctp_paper.postexecution_causality DEFERRED;
 INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"vectorSize","expiresAt","updatedAt","createdAt")
 VALUES(reservation_id,t,decision_id,target_intent,a,'PAPER',1,expiration,observed_at,observed_at);
 INSERT INTO ctp_paper.reservation_debit VALUES(t,reservation_id,target_intent,a,'PAPER',1,quote,amount,hold_id);
 PERFORM ctp_paper.append_reservation_state(t,reservation_id,gen_random_uuid(),0,'ACTIVE',now_ms);
 hold:=jsonb_build_object('id',hold_id,'asset',quote,'amount',trim_scale(amount)::text,'status','RESERVED','reflected',false);
 event:=jsonb_build_object('id',event_id,'type','COMMITMENT','timestamp',now_ms,'hold',hold);
 event_text:=ctp_admission.canonical(event);
 after_text:=ctp_admission.canonical(jsonb_set(x.effects->'state','{holds}',
  (x.effects #> '{state,holds}')||jsonb_build_array(hold)));
 after_hash:=sha256(convert_to(after_text,'UTF8'));
 response:=jsonb_build_object('kind','RESERVED','request',request,'debits',jsonb_build_array(
  jsonb_build_object('asset',quote,'amount',trim_scale(amount)::text,'holdId',hold_id)));
 INSERT INTO ctp_paper.admission_issuance VALUES(t,target_intent,target_order,a,'PAPER',decision_id,reservation_id,cert_id,
  state_id,capability_id,rule_id,x.book_id,instrument,base,quote,notional,request,response,
  sha256(convert_to(response::text,'UTF8')),document,sha256(convert_to(document::text,'UTF8')),now_ms)
 RETURNING * INTO i;
 INSERT INTO ctp_portfolio.hold_watermark VALUES(t,x.book_id,a,'PAPER',hold_id::text,now_ms,
  sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8')),false,false)
 RETURNING * INTO watermark;
 INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
 VALUES(t,x.book_id,a,'PAPER',event_id::text,sha256(convert_to(event_text,'UTF8')),event_text,NULL)
 RETURNING * INTO saved_event;
 INSERT INTO ctp_paper.admission_book_event(tenant_id,account_id,book_id,revision,cause_id,kind,previous_revision,previous_hash,state_text,state_hash)
 VALUES(t,a,x.book_id,x.revision+1,reservation_id,'RESERVE',x.revision,x.state_hash,after_text,after_hash)
 RETURNING * INTO book_event;
 UPDATE ctp_portfolio.book SET revision=x.revision+1,state=after_text,state_hash=after_hash
 WHERE "tenantId"=t AND id=x.book_id AND revision=x.revision AND state_hash=x.state_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 UPDATE ctp_paper.admission_book_head SET revision=x.revision+1,state_hash=after_hash
 WHERE tenant_id=t AND book_id=x.book_id AND revision=x.revision AND state_hash=x.state_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_CONFLICT'; END IF;
 INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId")
 VALUES(t,x.book_id,a,'PAPER',x.revision+1,'COMMITMENT',event_id::text);
 INSERT INTO ctp_paper.postexecution_commitment VALUES(t,x.execution_id,a,x.book_id,target_intent,reservation_id,
  cert_id,event_id,k,x.revision,x.state_hash,x.revision+1,after_hash,now_ms)
 RETURNING * INTO s;
 SET CONSTRAINTS ALL IMMEDIATE;
 IF floor(extract(epoch FROM clock_timestamp())*1000)::bigint>=c.expires_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 RETURN jsonb_build_object('kind','WRITTEN','receipt',ctp_paper.postexecution_receipt(s,i),
  'evidence',to_jsonb(proof),'event',saved_event.payload::jsonb,'eventHash',encode(saved_event.fingerprint,'hex'),
  'ledger',saved_event.ledger,
  'book',jsonb_build_object('previousHash',encode(book_event.previous_hash,'hex'),'state',book_event.state_text,
   'stateHash',encode(book_event.state_hash,'hex')),
  'watermark',jsonb_build_object('timestamp',watermark.timestamp,'fingerprint',encode(watermark.fingerprint,'hex'),
   'released',watermark.released,'unknown',watermark.unknown));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
 WHEN sequence_generator_limit_exceeded THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT';
END $$;

ALTER FUNCTION ctp_paper.evaluate_and_reserve(jsonb) RENAME TO evaluate_and_reserve_before_postexecution;
CREATE FUNCTION ctp_paper.evaluate_and_reserve(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_POSTEXECUTION_RESERVE' THEN RETURN ctp_paper.postexecution_reserve(p,false); END IF;
 RETURN ctp_paper.evaluate_and_reserve_before_postexecution(p);
END $$;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_before_postexecution;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_POSTEXECUTION_READ' THEN RETURN ctp_paper.postexecution_reserve(p,true); END IF;
 RETURN ctp_paper.reconcile_admission_before_postexecution(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.postexecution_reserve(jsonb,boolean),
 ctp_paper.postexecution_receipt(ctp_paper.postexecution_commitment,ctp_paper.admission_issuance),
 ctp_paper.evaluate_and_reserve_before_postexecution(jsonb),ctp_paper.reconcile_admission_before_postexecution(jsonb),
 ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.evaluate_and_reserve(jsonb),ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;

COMMIT;
