BEGIN;
-- Readonly capture only. Published financial functions/tables and all previous
-- migrations remain unchanged. No role, table grant or monetary write is added.
CREATE FUNCTION ctp_paper.capture_executed_valuation(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; committed jsonb; cfg jsonb; original jsonb; balance jsonb; state jsonb;
 quote text; age integer; heads jsonb[]; k jsonb; h ctp_market.snapshot_head%ROWTYPE;
 e ctp_market.snapshot_event%ROWTYPE; publication jsonb; markets jsonb:='[]'::jsonb;
 result jsonb; ts bigint;
BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p IS NULL OR p->>'kind' IS DISTINCT FROM 'PAPER_EXECUTED_VALUATION_CAPTURE'
  OR octet_length(p::text)>16384
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','executionKey','preparationKey','startKey','admission','authorization']),false)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 -- Preserve GLOBAL -> tenant -> account -> book -> metadata/head catalogs.
 -- Current authentication is repeated by execution_commit after the row locks.
 t:=ctp_paper.execution_start_auth((p-'executionKey')||jsonb_build_object('kind','PAPER_EXECUTION_START'));
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND id=(p->'admission'->'binding'->>'accountId')::uuid FOR UPDATE;
 PERFORM 1 FROM ctp_portfolio.book b JOIN ctp_paper.execution_commit x ON x.tenant_id=b."tenantId" AND x.book_id=b.id
  WHERE x.tenant_id=t AND x.execution_key=p->>'executionKey' FOR SHARE OF b;
 committed:=ctp_paper.execution_commit(p||jsonb_build_object('kind','PAPER_EXECUTION_COMMIT'),true);
 IF committed->>'kind'='MISSING' THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
 cfg:=(committed->'source'->'started'->'context'->'configuration'->>'receiptText')::jsonb->'configuration';
 original:=committed->'source'->'started'->'capture'->'market';
 state:=committed->'effects'->'state'; quote:=cfg->>'valuationAsset';
 age:=least(5000,(cfg->'model'->>'maxEvidenceAgeMs')::integer);
 IF cfg->'source'->>'market' IS DISTINCT FROM 'SPOT' OR quote IS NULL OR age IS NULL OR age<1
  OR jsonb_typeof(state->'balances') IS DISTINCT FROM 'array' OR jsonb_array_length(state->'balances')>64
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Includes insert phantoms. Publishers/metadata refresh cannot interleave a
 -- different head catalog with this authenticated economic book.
 LOCK TABLE public.instrument,public.instrument_rule_version,ctp_market.snapshot_head IN SHARE MODE;
 FOR balance IN SELECT value FROM jsonb_array_elements(state->'balances') LOOP
  IF balance->>'asset'=quote THEN CONTINUE; END IF;
  SELECT array_agg(key) INTO heads FROM (
   SELECT sh.key FROM ctp_market.snapshot_head sh JOIN public.instrument i ON i.id=(sh.key->>'dbInstrumentId')::uuid
   WHERE sh.key->'scope'=cfg->'source' AND i.active AND i.market='SPOT'
    AND i.exchange::text=cfg->'source'->>'exchange' AND i.mode::text=cfg->'source'->>'environment'
    AND i."baseAsset"=balance->>'asset' AND i."quoteAsset"=quote
    AND (balance->>'asset' IS DISTINCT FROM original->'record'->'instrument'->>'baseAsset'
     OR (i.id=(original->>'dbInstrumentId')::uuid AND sh.key->>'instrumentId'=original->'record'->'instrument'->>'id'))
   ORDER BY sh.key::text LIMIT 2
  ) q;
  IF coalesce(cardinality(heads),0)<>1 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  k:=heads[1];
  SELECT * INTO h FROM ctp_market.snapshot_head WHERE key=k;
  IF NOT FOUND OR h.gap OR h.native IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  SELECT * INTO e FROM ctp_market.snapshot_event WHERE id=h.native;
  IF NOT FOUND OR e.hash<>sha256(convert_to(e.payload,'UTF8')) OR e.key-'dbRuleId'<>k
   OR e.revision>h.revision OR e.status<>'APPLIED' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  publication:=e.payload::jsonb;
  IF publication->>'id'<>e.id::text OR publication->>'kind'<>'SNAPSHOT'
   OR ctp_market.snapshot_valid(publication) IS NOT TRUE OR ctp_market.snapshot_metadata(publication) IS NOT TRUE
   OR publication->'ticker'->'last'->>'state' IS DISTINCT FROM 'AVAILABLE'
   OR NOT coalesce(ctp_market.snapshot_decimal(publication->'ticker'->'last'->'value'),false)
   OR (publication->'ticker'->'last'->>'value')::numeric<=0
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF ctp_market.snapshot_fresh(publication,age) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
  markets:=markets||jsonb_build_array(jsonb_build_object('id',e.id::text,'revision',h.revision::text,
   'hash',encode(e.hash,'hex'),'publicationText',e.payload));
  IF jsonb_array_length(markets)>64 OR octet_length(markets::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 END LOOP;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 result:=jsonb_build_object('kind','PAPER_EXECUTED_VALUATION_CAPTURE','request',p,'asOf',ts,'execution',committed,'markets',markets);
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;

ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v66;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$ BEGIN
 IF p->>'kind'='PAPER_EXECUTED_VALUATION_CAPTURE' THEN RETURN ctp_paper.capture_executed_valuation(p); END IF;
 RETURN ctp_paper.reconcile_admission_v66(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.capture_executed_valuation(jsonb),ctp_paper.reconcile_admission_v66(jsonb),
 ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
