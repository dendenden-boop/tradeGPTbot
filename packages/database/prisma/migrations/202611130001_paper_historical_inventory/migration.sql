BEGIN;
-- Readonly supported tenant catalog. No financial function, role, table or
-- monetary effect is added. Published migrations 1-67 remain immutable.
CREATE FUNCTION ctp_paper.capture_historical_inventory(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; target uuid; ids uuid[]; a uuid; executed jsonb; x ctp_paper.execution_commit%ROWTYPE;
 i ctp_paper.admission_issuance%ROWTYPE; cfg jsonb; quote text; age integer; ts bigint;
 book jsonb; books jsonb:='[]'; catalog jsonb; configurations jsonb:='[]'; item jsonb; balance jsonb;
 heads jsonb[]; k jsonb; h ctp_market.snapshot_head%ROWTYPE; e ctp_market.snapshot_event%ROWTYPE;
 publication jsonb; markets jsonb:='[]'; original jsonb; result jsonb; drafts integer:=1;
BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p IS NULL OR p->>'kind' IS DISTINCT FROM 'PAPER_HISTORICAL_INVENTORY_CAPTURE'
  OR octet_length(p::text)>16384
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','executionKey','preparationKey','startKey','admission','authorization']),false)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 -- GLOBAL -> tenant -> user closes new-account FK phantoms before enumeration.
 t:=ctp_paper.execution_start_auth((p-'executionKey')||jsonb_build_object('kind','PAPER_EXECUTION_START'));
 target:=(p->'admission'->'binding'->>'accountId')::uuid;
 SELECT array_agg(id ORDER BY id) INTO ids FROM(SELECT id FROM public.exchange_account
  WHERE "tenantId"=t AND mode='PAPER' ORDER BY id LIMIT 101) q;
 IF ids IS NULL OR NOT(target=ANY(ids)) THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 IF cardinality(ids)>100 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 PERFORM 1 FROM ctp_portfolio.book WHERE "tenantId"=t AND mode='PAPER' ORDER BY "accountId",id FOR UPDATE;
 PERFORM 1 FROM public."order" WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' AND status<>'ACTIVE')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Existing committed causal validator authenticates the exact target history.
 -- It is a read: no adoption of an admission head, allocation or journal write.
 executed:=ctp_paper.capture_executed_valuation(p||jsonb_build_object('kind','PAPER_EXECUTED_VALUATION_CAPTURE'));
 IF executed->>'kind'='MISSING' THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
 SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_key=p->>'executionKey';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND reservation_id=x.reservation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF (SELECT count(*) FROM ctp_paper.execution_commit WHERE tenant_id=t)<>1
  OR EXISTS(SELECT 1 FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id<>x.intent_id)
  OR EXISTS(SELECT 1 FROM ctp_paper.attempt_start WHERE tenant_id=t AND attempt_id<>x.attempt_id)
  OR EXISTS(SELECT 1 FROM ctp_paper.attempt_preparation WHERE tenant_id=t AND attempt_id<>x.attempt_id)
  OR EXISTS(SELECT 1 FROM public."order" WHERE "tenantId"=t AND "accountId"=target AND id<>x.order_id)
  OR EXISTS(SELECT 1 FROM public.order_intent WHERE "tenantId"=t AND "accountId"=target AND id<>x.intent_id)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
 -- Never silently omit unrecognized monetary, reconciliation or native history.
 IF EXISTS(SELECT 1 FROM public.position WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.trade WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.funding_payment WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.asset_valuation WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.balance_snapshot WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.algo_order WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.paper_account WHERE "tenantId"=t)
  OR EXISTS(SELECT 1 FROM public.paper_order WHERE "tenantId"=t)
  OR EXISTS(SELECT 1 FROM public.paper_position WHERE "tenantId"=t)
  OR EXISTS(SELECT 1 FROM public.risk_reservation WHERE "tenantId"=t AND mode='PAPER' AND id<>x.reservation_id)
  OR EXISTS(SELECT 1 FROM public.risk_decision WHERE "tenantId"=t AND mode='PAPER' AND id<>i.decision_id)
  OR EXISTS(SELECT 1 FROM public.account_state_version WHERE "tenantId"=t AND mode='PAPER' AND id<>i.state_id)
  OR EXISTS(SELECT 1 FROM public.ledger_transaction l WHERE l."tenantId"=t AND l.mode='PAPER'
   AND NOT(l.id=ANY(x.ledger_ids)) AND NOT EXISTS(SELECT 1 FROM ctp_paper.initial_funding f
    WHERE f.tenant_id=t AND f.account_id=l."accountId" AND f.ledger_id=l.id))
  OR EXISTS(SELECT 1 FROM public.fill WHERE "tenantId"=t AND mode='PAPER' AND NOT(id=ANY(x.fill_ids)))
  OR EXISTS(SELECT 1 FROM public.fee WHERE "tenantId"=t AND mode='PAPER' AND NOT("fillId"=ANY(x.fill_ids)))
  OR EXISTS(SELECT 1 FROM public.submission_attempt s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
  OR EXISTS(SELECT 1 FROM ctp_execution.evidence s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
  OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 cfg:=(executed->'execution'->'source'->'started'->'context'->'configuration'->>'receiptText')::jsonb->'configuration';
 quote:=cfg->>'valuationAsset'; age:=least(5000,(cfg->'model'->>'maxEvidenceAgeMs')::integer);
 original:=x.input->'attempt'->'request'->'admission';
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 configurations:=jsonb_build_array(jsonb_build_object('configuration',cfg,'balances',x.effects->'state'->'balances'));
 FOREACH a IN ARRAY ids LOOP
  IF a=target THEN CONTINUE; END IF;
  book:=ctp_paper.risk_portfolio_book(jsonb_build_object('tenantId',t::text,'accountId',a::text,'mode','PAPER'),ts);
  cfg:=(book->'origin'->>'receiptText')::jsonb->'configuration';
  -- origin.configuration is the immutable configuration wire, not a new receipt.
  cfg:=(cfg->>'receiptText')::jsonb->'configuration';
  IF cfg->>'valuationAsset' IS DISTINCT FROM quote OR cfg->'source'->>'market' IS DISTINCT FROM 'SPOT'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  age:=least(age,(cfg->'model'->>'maxEvidenceAgeMs')::integer);
  drafts:=drafts+jsonb_array_length(book->'drafts');
  IF drafts>1000 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  books:=books||jsonb_build_array(jsonb_build_object('accountId',a::text,'book',book));
  configurations:=configurations||jsonb_build_array(jsonb_build_object('configuration',cfg,
   'balances',((book->'origin'->>'receiptText')::jsonb->>'stateText')::jsonb->'balances'));
 END LOOP;
 IF quote IS NULL OR age IS NULL OR age<1 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Target capture already holds these catalog locks; repeated for clarity.
 LOCK TABLE public.instrument,public.instrument_rule_version,ctp_market.snapshot_head IN SHARE MODE;
 FOR item IN SELECT value FROM jsonb_array_elements(configurations) LOOP
  cfg:=item->'configuration';
  -- Keep the original traded instrument mark even for a zero-fill FOK result.
  FOR balance IN SELECT value FROM jsonb_array_elements((item->'balances')||
   CASE WHEN cfg->'owner'->>'accountId'=target::text THEN jsonb_build_array(jsonb_build_object('asset',i.base)) ELSE '[]'::jsonb END) LOOP
   IF balance->>'asset'=quote THEN CONTINUE; END IF;
   SELECT array_agg(key) INTO heads FROM (
    SELECT sh.key FROM ctp_market.snapshot_head sh JOIN public.instrument ins ON ins.id=(sh.key->>'dbInstrumentId')::uuid
    WHERE sh.key->'scope'=cfg->'source' AND ins.active AND ins.market='SPOT'
     AND ins.exchange::text=cfg->'source'->>'exchange' AND ins.mode::text=cfg->'source'->>'environment'
     AND ins."baseAsset"=balance->>'asset' AND ins."quoteAsset"=quote
     AND (cfg->'owner'->>'accountId'<>target::text OR balance->>'asset'<>i.base
      OR (ins.id=(original->>'dbInstrumentId')::uuid AND sh.key->>'instrumentId'=original->'command'->>'instrumentId'))
    ORDER BY sh.key::text LIMIT 2
   ) q;
   IF coalesce(cardinality(heads),0)<>1 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   k:=heads[1]; SELECT * INTO h FROM ctp_market.snapshot_head WHERE key=k;
   IF NOT FOUND OR h.gap OR h.native IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   SELECT * INTO e FROM ctp_market.snapshot_event WHERE id=h.native;
   IF NOT FOUND OR e.hash<>sha256(convert_to(e.payload,'UTF8')) OR e.key-'dbRuleId'<>k
    OR e.revision>h.revision OR e.status<>'APPLIED' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   publication:=e.payload::jsonb;
   IF publication->>'id'<>e.id::text OR publication->>'kind'<>'SNAPSHOT'
    OR ctp_market.snapshot_valid(publication) IS NOT TRUE OR ctp_market.snapshot_metadata(publication) IS NOT TRUE
    OR publication->'ticker'->'last'->>'state' IS DISTINCT FROM 'AVAILABLE'
    OR NOT coalesce(ctp_market.snapshot_decimal(publication->'ticker'->'last'->'value'),false)
    OR (publication->'ticker'->'last'->>'value')::numeric<=0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   IF ctp_market.snapshot_fresh(publication,age) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(markets) m WHERE m->>'id'=e.id::text) THEN
    markets:=markets||jsonb_build_array(jsonb_build_object('id',e.id::text,'revision',h.revision::text,
     'hash',encode(e.hash,'hex'),'publicationText',e.payload));
   END IF;
   IF jsonb_array_length(markets)>300 OR octet_length(markets::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  END LOOP;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('accountId',id::text,'permissionEpoch',"permissionEpoch"::text,
  'reconciliationEpoch',"reconciliationEpoch"::text,'clientIdHighWatermark',"clientIdHighWatermark"::text,'version',version) ORDER BY id)
  INTO catalog FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER';
 result:=jsonb_build_object('kind','PAPER_HISTORICAL_INVENTORY_CAPTURE','request',p,'asOf',ts,
  'accountIds',to_jsonb(ids),'catalog',catalog,'executed',executed,'books',books,'markets',markets);
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;

ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v67;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_HISTORICAL_INVENTORY_CAPTURE' THEN RETURN ctp_paper.capture_historical_inventory(p); END IF;
 RETURN ctp_paper.reconcile_admission_v67(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.capture_historical_inventory(jsonb),ctp_paper.reconcile_admission_v67(jsonb),
 ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
