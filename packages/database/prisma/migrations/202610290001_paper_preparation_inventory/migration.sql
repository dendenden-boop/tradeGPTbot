BEGIN;
-- Read-only complete preparation inventory. No new history, grant or START.
-- All published1-60 immutable. Never infer another contender's preparation time.
CREATE FUNCTION ctp_paper.capture_preparation_inventory(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE capture jsonb; row jsonb; entries jsonb:='[]'; j ctp_paper.attempt_preparation%ROWTYPE;
 t uuid; expected jsonb; result jsonb;
BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','admission','authorization']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_PREPARATION_INVENTORY_CAPTURE' OR octet_length(p::text)>16384
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 -- Current ownership/auth before any journal lookup. Retains the same exclusive
 -- tenant lock as preparation/stop; concurrent writes cannot tear this inventory.
 capture:=ctp_paper.capture_execution_candidates(p||jsonb_build_object('kind','PAPER_EXECUTION_CAPTURE'));
 t:=(p->'admission'->'binding'->>'tenantId')::uuid;
 FOR row IN SELECT value FROM jsonb_array_elements(capture->'candidates') WITH ORDINALITY AS e(value,ordinal) ORDER BY ordinal LOOP
  SELECT * INTO j FROM ctp_paper.attempt_preparation WHERE tenant_id=t AND intent_id=(row->>'intentId')::uuid;
  IF NOT FOUND THEN
   entries:=entries||jsonb_build_array(jsonb_build_object('kind','MISSING','intentId',row->>'intentId'));
  ELSE
   expected:=jsonb_build_object('binding',p->'admission'->'binding','orderId',row->>'orderId','intentId',row->>'intentId','operation','PLACE','commandHash',row->>'commandHash');
   IF j.request IS DISTINCT FROM jsonb_build_object('key',j.preparation_key,'admission',expected)
    OR j.reservation_id::text IS DISTINCT FROM row->>'reservationId'
    OR j.prepared_ms>(capture->>'asOf')::bigint OR j.state_hash<>sha256(convert_to(j.state::text,'UTF8'))
    OR j.state IS DISTINCT FROM ctp_paper.prepared_attempt(j.request,j.attempt_id,j.prepared_ms)
    OR EXISTS(SELECT 1 FROM ctp_paper.attempt_not_sent WHERE tenant_id=t AND attempt_id=j.attempt_id)
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   entries:=entries||jsonb_build_array(jsonb_build_object('kind','PREPARED','intentId',row->>'intentId','key',j.preparation_key,'preparation',j.state));
  END IF;
 END LOOP;
 result:=jsonb_build_object('kind','PAPER_PREPARATION_INVENTORY_CAPTURE','request',p,'asOf',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'capture',capture,'entries',entries);
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v60;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_PREPARATION_INVENTORY_CAPTURE' THEN
  IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
  RETURN ctp_paper.capture_preparation_inventory(p);
 END IF;
 RETURN ctp_paper.reconcile_admission_v60(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.capture_preparation_inventory(jsonb),ctp_paper.reconcile_admission_v60(jsonb),ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
