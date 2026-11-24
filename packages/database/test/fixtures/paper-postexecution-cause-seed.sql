-- Test-owner only assembly of a successor from a real certificate and draft.
-- This deliberately does not implement the runtime admission or write RPC.
CREATE OR REPLACE FUNCTION pg_temp.stage_paper_postexecution_successor(
 t uuid,k text,target_order uuid,target_intent uuid,command_hash text,certificate uuid,
 debit numeric,notional numeric,idempotency_key text
) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE x ctp_paper.execution_commit%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 c ctp_paper.current_risk_certificate%ROWTYPE; market jsonb; request jsonb; response jsonb;
 hold jsonb; event jsonb; state_text text; event_text text; successor_hash bytea;
 result_id uuid:=gen_random_uuid(); decision_id uuid:=gen_random_uuid();
 hold_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); committed_at timestamptz;
BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid
 THEN RAISE EXCEPTION 'FIXTURE_TENANT_REQUIRED'; END IF;
 PERFORM ctp_paper.validate_committed_execution(t,k);
 SELECT * INTO STRICT x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_key=k;
 SELECT * INTO STRICT i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND reservation_id=x.reservation_id;
 SELECT * INTO STRICT c FROM ctp_paper.current_risk_certificate WHERE tenant_id=t AND id=certificate AND execution_id=x.execution_id;
 market:=(c.document_text::jsonb #>> '{source,market,snapshot,text}')::jsonb;
 committed_at:=to_timestamp(c.created_ms::double precision/1000);
 request:=jsonb_build_object('binding',x.request #> '{admission,binding}','operation','PLACE',
  'orderId',target_order,'intentId',target_intent,'commandHash',command_hash);
 hold:=jsonb_build_object('id',hold_id,'asset',i.quote,'amount',trim_scale(debit)::text,'status','RESERVED','reflected',false);
 event:=jsonb_build_object('id',event_id,'type','COMMITMENT','timestamp',c.created_ms,'hold',hold);
 event_text:=ctp_admission.canonical(event);
 state_text:=ctp_admission.canonical(jsonb_set(x.effects->'state','{holds}',
  (x.effects #> '{state,holds}')||jsonb_build_array(hold)));
 successor_hash:=sha256(convert_to(state_text,'UTF8'));
 response:=jsonb_build_object('kind','RESERVED','debits',jsonb_build_array(
  jsonb_build_object('asset',i.quote,'amount',trim_scale(debit)::text,'holdId',hold_id)));
 INSERT INTO public.risk_decision(id,"tenantId","intentId","accountId",mode,"profileId","stateVersionId","ruleVersionId",
  "capabilitySnapshotId",verdict,"policyVersion","commandHash","reasonCodes","permissionEpoch","expiresAt")
 SELECT decision_id,t,target_intent,x.account_id,'PAPER',"profileId",i.state_id,(market #>> '{key,dbRuleId}')::uuid,
  i.capability_id,'APPROVE',"policyVersion",decode(command_hash,'hex'),ARRAY['STORAGE_FIXTURE'],"permissionEpoch",
  to_timestamp(c.expires_ms::double precision/1000)
 FROM public.risk_decision WHERE "tenantId"=t AND id=i.decision_id;
 INSERT INTO public.risk_reservation(id,"tenantId","decisionId","intentId","accountId",mode,"vectorSize","expiresAt","updatedAt","createdAt")
 VALUES(result_id,t,decision_id,target_intent,x.account_id,'PAPER',1,to_timestamp(c.expires_ms::double precision/1000),committed_at,committed_at);
 INSERT INTO ctp_paper.reservation_debit VALUES(t,result_id,target_intent,x.account_id,'PAPER',1,i.quote,debit,hold_id);
 PERFORM ctp_paper.append_reservation_state(t,result_id,gen_random_uuid(),0,'ACTIVE',c.created_ms);
 INSERT INTO ctp_paper.admission_issuance VALUES(t,target_intent,target_order,x.account_id,'PAPER',decision_id,result_id,c.id,
  i.state_id,i.capability_id,(market #>> '{key,dbRuleId}')::uuid,x.book_id,i.instrument,i.base,i.quote,notional,request,response,
  sha256(convert_to(response::text,'UTF8')),c.document_text::jsonb,sha256(convert_to((c.document_text::jsonb)::text,'UTF8')),c.created_ms);
 INSERT INTO ctp_portfolio.hold_watermark VALUES(t,x.book_id,x.account_id,'PAPER',hold_id::text,c.created_ms,
  sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',hold)),'UTF8')),false,false);
 INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
 VALUES(t,x.book_id,x.account_id,'PAPER',event_id::text,sha256(convert_to(event_text,'UTF8')),event_text,NULL);
 INSERT INTO ctp_paper.admission_book_event(tenant_id,account_id,book_id,revision,cause_id,kind,previous_revision,previous_hash,state_text,state_hash)
 VALUES(t,x.account_id,x.book_id,x.revision+1,result_id,'RESERVE',x.revision,x.state_hash,state_text,successor_hash);
 UPDATE ctp_portfolio.book SET revision=x.revision+1,state=state_text,state_hash=successor_hash
 WHERE "tenantId"=t AND id=x.book_id AND revision=x.revision AND state_hash=x.state_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'FIXTURE_HEAD_CHANGED'; END IF;
 UPDATE ctp_paper.admission_book_head SET revision=x.revision+1,state_hash=successor_hash
 WHERE tenant_id=t AND book_id=x.book_id AND revision=x.revision AND state_hash=x.state_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'FIXTURE_HEAD_CHANGED'; END IF;
 INSERT INTO ctp_portfolio.outbox("tenantId",book,"accountId",mode,revision,type,"eventId")
 VALUES(t,x.book_id,x.account_id,'PAPER',x.revision+1,'COMMITMENT',event_id::text);
 INSERT INTO ctp_paper.postexecution_commitment VALUES(t,x.execution_id,x.account_id,x.book_id,target_intent,result_id,
  c.id,event_id,idempotency_key,x.revision,x.state_hash,x.revision+1,successor_hash,c.created_ms);
 RETURN result_id;
END $$;
