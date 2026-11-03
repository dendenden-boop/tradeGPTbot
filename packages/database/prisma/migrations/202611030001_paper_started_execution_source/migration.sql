BEGIN;
-- Read-only known-START source. Published1-62 and their bodies stay immutable.
-- No table, ledger effect, allocation, permission or execution grant is added.
CREATE FUNCTION ctp_paper.capture_started_execution(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE start_request jsonb; journal jsonb; capture jsonb; context jsonb; owner jsonb;
 row jsonb; entries jsonb:='[]'; expected jsonb; result jsonb;
 j ctp_paper.attempt_preparation%ROWTYPE; t uuid; a uuid; valid_until bigint; now_ms bigint;
BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','preparationKey','startKey','admission','authorization']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_STARTED_EXECUTION_CAPTURE' OR octet_length(p::text)>16384
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 start_request:=p||jsonb_build_object('kind','PAPER_EXECUTION_START');
 -- This authenticates current ownership/epochs and retains the existing lock
 -- order BEFORE looking up a historical START. Read-only: MISSING never inserts.
 journal:=ctp_paper.execution_start(start_request,true);
 IF journal->>'kind' IS DISTINCT FROM 'COMMITTED'
  OR journal->'state'->>'phase' IS DISTINCT FROM 'STARTED'
  OR journal->'unknown' IS DISTINCT FROM 'null'::jsonb
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 t:=(p->'admission'->'binding'->>'tenantId')::uuid;
 a:=(p->'admission'->'binding'->>'accountId')::uuid;
 -- Only this private route may read the unchanged pristine economic source
 -- after proving an actual START. Legacy public captures keep their guard.
 capture:=ctp_paper.capture_execution_candidates_v61(jsonb_build_object(
  'kind','PAPER_EXECUTION_CAPTURE','admission',p->'admission','authorization',p->'authorization'));
 IF capture->'candidates'->0->>'intentId' IS DISTINCT FROM p->'admission'->>'intentId'
  OR EXISTS(SELECT 1 FROM ctp_paper.attempt_start s WHERE s.tenant_id=t
   AND s.request->'admission'->'binding'->>'accountId'=a::text
   AND s.intent_id<>(p->'admission'->>'intentId')::uuid)
  OR capture->'portfolio'->>'bookId' IS DISTINCT FROM journal->'receipt'->'validation'->'book'->>'id'
  OR (capture->'portfolio'->>'revision')::bigint<(journal->'receipt'->'validation'->'book'->>'revision')::bigint
  OR ((capture->'portfolio'->>'revision')::bigint=(journal->'receipt'->'validation'->'book'->>'revision')::bigint
   AND capture->'portfolio'->>'hash' IS DISTINCT FROM journal->'receipt'->'validation'->'book'->>'hash')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 owner:=jsonb_build_object('tenantId',t::text,'accountId',a::text,'mode','PAPER');
 context:=ctp_paper.runtime_context(owner)||jsonb_build_object('kind','PAPER_RUNTIME_CONTEXT','owner',owner,
  'asOf',floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
 valid_until:=least((capture->>'validUntil')::bigint,(context->>'asOf')::bigint+
  least(5000,((context->'configuration'->>'receiptText')::jsonb->'configuration'->'model'->>'maxEvidenceAgeMs')::integer)+1);
 FOR row IN SELECT value FROM jsonb_array_elements(capture->'candidates') WITH ORDINALITY AS e(value,ordinal) ORDER BY ordinal LOOP
  SELECT * INTO j FROM ctp_paper.attempt_preparation WHERE tenant_id=t AND intent_id=(row->>'intentId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  expected:=jsonb_build_object('binding',p->'admission'->'binding','orderId',row->>'orderId','intentId',row->>'intentId','operation','PLACE','commandHash',row->>'commandHash');
  IF j.request IS DISTINCT FROM jsonb_build_object('key',j.preparation_key,'admission',expected)
   OR j.reservation_id::text IS DISTINCT FROM row->>'reservationId'
   OR j.prepared_ms>(capture->>'asOf')::bigint OR j.state_hash<>sha256(convert_to(j.state::text,'UTF8'))
   OR j.state IS DISTINCT FROM ctp_paper.prepared_attempt(j.request,j.attempt_id,j.prepared_ms)
   OR EXISTS(SELECT 1 FROM ctp_paper.attempt_not_sent WHERE tenant_id=t AND attempt_id=j.attempt_id)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF row->>'intentId'=p->'admission'->>'intentId' THEN
   IF j.preparation_key IS DISTINCT FROM p->>'preparationKey' OR j.state IS DISTINCT FROM journal->'preparation'
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   entries:=entries||jsonb_build_array(jsonb_build_object('kind','STARTED','intentId',row->>'intentId',
    'key',j.preparation_key,'preparation',j.state,'state',journal->'state'));
  ELSE
   IF EXISTS(SELECT 1 FROM ctp_paper.attempt_start WHERE tenant_id=t AND intent_id=j.intent_id)
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   entries:=entries||jsonb_build_array(jsonb_build_object('kind','PREPARED','intentId',row->>'intentId',
    'key',j.preparation_key,'preparation',j.state));
  END IF;
  valid_until:=least(valid_until,(row->'original'->>'expiresAt')::bigint);
 END LOOP;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF valid_until<=now_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 result:=jsonb_build_object('kind','PAPER_STARTED_EXECUTION_CAPTURE','request',p,'asOf',now_ms,
  'validUntil',valid_until,'capture',capture,'journal',journal,'context',context,'entries',entries);
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v62;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_STARTED_EXECUTION_CAPTURE' THEN
  IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
  RETURN ctp_paper.capture_started_execution(p);
 END IF;
 RETURN ctp_paper.reconcile_admission_v62(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.capture_started_execution(jsonb),ctp_paper.reconcile_admission_v62(jsonb),
 ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
