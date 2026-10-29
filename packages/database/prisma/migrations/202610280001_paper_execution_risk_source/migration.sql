BEGIN;
-- Read-only current execution Risk evidence. Published1-59 and all mutation
-- RPC bodies/privileges remain unchanged. No START, certificate or money write.
CREATE FUNCTION ctp_paper.capture_execution_risk(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE r jsonb:=p->'admission'; auth jsonb:=p->'authorization'; capture jsonb; journal jsonb; inv jsonb; cfg jsonb;
 runtime jsonb; market jsonb; controls_text text; loss jsonb; result jsonb; now_ms bigint; t uuid; a uuid; age integer;
 platform ctp_risk.policy_revision%ROWTYPE; usr ctp_risk.policy_revision%ROWTYPE; issuance ctp_paper.admission_issuance%ROWTYPE;
BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','preparationKey','admission','authorization']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_EXECUTION_RISK_CAPTURE' OR octet_length(p::text)>16384
  OR jsonb_typeof(p->'preparationKey') IS DISTINCT FROM 'string' OR p->>'preparationKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 -- Current ownership/auth epochs precede any preparation lookup. The accepted
 -- source retains GLOBAL -> tenant -> user/sorted accounts/orders/books and
 -- catalog SHARE locks. Its no-adoption guard applies to every tenant account.
 capture:=ctp_paper.capture_execution_candidates(jsonb_build_object('kind','PAPER_EXECUTION_CAPTURE','admission',r,'authorization',auth));
 t:=(r->'binding'->>'tenantId')::uuid;a:=(r->'binding'->>'accountId')::uuid;
 journal:=ctp_paper.attempt_journal(jsonb_build_object('kind','PAPER_ATTEMPT_PREPARE','key',p->'preparationKey','admission',r,'authorization',auth),true);
 IF journal->>'kind' IS DISTINCT FROM 'COMMITTED' OR journal->'state'->>'phase' IS DISTINCT FROM 'PREPARED'
  OR journal->'withdrawal' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 SELECT * INTO issuance FROM ctp_paper.admission_issuance WHERE tenant_id=t AND account_id=a AND intent_id=(r->>'intentId')::uuid;
 IF NOT FOUND OR issuance.request IS DISTINCT FROM r THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF (issuance.response->'receipt'->>'expiresAt')::bigint<=now_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 -- The first capture has proved all causal heads exist and locked the complete
 -- account catalog. Re-reading inventory cannot initialize an unrelated book.
 inv:=ctp_paper.admission_inventory(r,now_ms);cfg:=inv->'target'->'configuration'->'configuration';
 SELECT v.* INTO platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision v USING(scope,target,mode,version,id)
  WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode='PAPER';
 IF NOT FOUND OR ctp_risk.valid_limits(platform."limitsText"::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT v.* INTO usr FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision v USING(scope,target,mode,version,id)
  WHERE h.scope='USER' AND h.target=t AND h.mode='PAPER';
 IF NOT FOUND OR ctp_risk.valid_limits(usr."limitsText"::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 age:=least((platform."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(usr."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(cfg->'model'->>'maxEvidenceAgeMs')::integer);
 market:=ctp_paper.admission_market(r,cfg,age);
 runtime:=ctp_paper.context_runtime_capture(jsonb_build_object('tenantId',t::text,'accountId',a::text,'mode','PAPER'));
 IF (SELECT count(*) FROM ctp_risk.global_head)>10000 OR (SELECT count(*) FROM ctp_risk.tenant_head WHERE "tenantId"=t)>10000
  OR (SELECT count(*) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL)>10000
  OR (SELECT count(*) FROM public.circuit_state WHERE "tenantId"=t)>10000 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 -- Same retained advisory protocol as the accepted policy/control publishers;
 -- no additional catalog lock is introduced after their BEFORE triggers.
 SELECT jsonb_build_object(
  'global',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind','GLOBAL'),
   'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY kind,key) FROM ctp_risk.global_head),'[]'::jsonb),
  'tenant',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind',scope,'tenantId',"tenantId"::text,'targetId',target::text),
   'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY scope,target,kind,key) FROM ctp_risk.tenant_head WHERE "tenantId"=t),'[]'::jsonb),
  'activePauses',coalesce((SELECT jsonb_agg(id::text ORDER BY id) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL),'[]'::jsonb),
  'circuits',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id::text,'state',status::text) ORDER BY id) FROM public.circuit_state WHERE "tenantId"=t),'[]'::jsonb)
 )::text INTO controls_text;
 -- With an authenticated issuance already present, the accepted loss helper
 -- can only read a genuine retained genesis; missing genesis raises, no insert.
 loss:=ctp_paper.admission_loss(inv,now_ms);
 result:=jsonb_build_object('kind','PAPER_EXECUTION_RISK_CAPTURE','request',p,
  'asOf',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'capture',capture,'journal',journal,
  'evidence',inv->'evidence','market',market,'runtime',runtime,'policies',jsonb_build_array(ctp_risk.policy_json(platform),ctp_risk.policy_json(usr)),
  'controls',jsonb_build_object('text',controls_text,'hash',encode(sha256(convert_to(controls_text,'UTF8')),'hex')),'loss',loss,
  'ordersInLastMinuteExcludingTarget',(SELECT count(*) FROM public.order_intent WHERE "tenantId"=t AND mode='PAPER' AND id<>issuance.intent_id
   AND "createdAt">=to_timestamp((now_ms-60000)::double precision/1000)),
  'reservation',jsonb_build_object('id',issuance.reservation_id::text,'decisionId',issuance.decision_id::text,
   'status','ACTIVE','revision','1','expiresAt',issuance.response->'receipt'->'expiresAt'));
 IF octet_length(result::text)>8388608 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_ADMISSION_%' THEN RAISE; ELSE RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v59;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_EXECUTION_RISK_CAPTURE' THEN RETURN ctp_paper.capture_execution_risk(p); END IF;
 RETURN ctp_paper.reconcile_admission_v59(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.capture_execution_risk(jsonb),ctp_paper.reconcile_admission_v59(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
