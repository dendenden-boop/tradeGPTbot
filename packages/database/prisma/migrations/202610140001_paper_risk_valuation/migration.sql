BEGIN;
-- Read-only inventory/public-price capture. No financial or credential grants.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_risk_valuation') THEN
 CREATE ROLE ctp_paper_risk_valuation NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_risk_valuation;

CREATE FUNCTION ctp_paper.valid_risk_valuation_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_risk_valuation'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_risk_valuation','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_risk_valuation' AND pg_has_role(session_user,r.oid,'MEMBER'))
 AND NOT has_database_privilege(session_user,current_database(),'CREATE,TEMP')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_')
  AND (has_schema_privilege(session_user,n.oid,'CREATE') OR pg_has_role(session_user,n.nspowner,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p','v','m','f')
  AND (pg_has_role(session_user,t.relowner,'MEMBER') OR has_table_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
   OR has_any_column_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
  WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(session_user,f.oid,'EXECUTE')
  AND (n.nspname||'.'||f.proname||'('||replace(oidvectortypes(f.proargtypes),' ','')||')')
   NOT IN('ctp_paper.capture_risk_valuation(jsonb)'))
$$;



CREATE FUNCTION ctp_paper.capture_risk_valuation(o jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; ids uuid[]; a uuid; ts bigint; books jsonb:='[]'::jsonb; book jsonb; inventory_wire jsonb; result jsonb; drafts integer:=0;
 markets jsonb:='[]'::jsonb; cfg jsonb; origin_wire jsonb; seed jsonb; balance jsonb;
 quote text; common_quote text; age integer:=5000; heads jsonb[]; k jsonb; h ctp_market.snapshot_head%ROWTYPE;
 e ctp_market.snapshot_event%ROWTYPE; p jsonb; seen uuid[]:='{}'::uuid[];
BEGIN
 IF NOT coalesce(ctp_paper.valid_risk_valuation_runtime(),false) THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_ROLE_UNSAFE'; END IF;
 IF o IS NULL OR octet_length(o::text)>512 OR NOT coalesce(ctp_paper.valid_owner(o),false) THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_INPUT'; END IF;
 IF o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true) THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_OWNERSHIP'; END IF;
 t:=(o->>'tenantId')::uuid;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 PERFORM 1 FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_OWNERSHIP'; END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id LIMIT 101) q;
 IF ids IS NULL THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_OWNERSHIP'; END IF;
 IF cardinality(ids)>100 THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CAPACITY'; END IF;
 IF NOT ((o->>'accountId')::uuid=ANY(ids)) THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_OWNERSHIP'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 FOREACH a IN ARRAY ids LOOP
  book:=ctp_paper.risk_portfolio_book(o||jsonb_build_object('accountId',a::text),ts);
  drafts:=drafts+jsonb_array_length(book->'drafts');
  IF drafts>1000 THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CAPACITY'; END IF;
  books:=books||jsonb_build_array(book);
  inventory_wire:=jsonb_build_object('kind','PAPER_RISK_PORTFOLIO_SOURCE','owner',o,'asOf',ts,'accountIds',to_jsonb(ids),'books',books);
  IF octet_length(inventory_wire::text)>1048576 THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CAPACITY'; END IF;
 END LOOP;
 -- Stable complete metadata/head catalogs, including head insertion phantoms.
 -- Bounded read-side locks; no budget/reservation/financial allocation occurs.
 LOCK TABLE public.instrument,public.instrument_rule_version,ctp_market.snapshot_head IN SHARE MODE;
 FOR book IN SELECT value FROM jsonb_array_elements(books) LOOP
  origin_wire:=(book->'origin'->>'receiptText')::jsonb;
  cfg:=((origin_wire->'configuration'->>'receiptText')::jsonb)->'configuration';
  quote:=cfg->>'valuationAsset';
  IF common_quote IS NULL THEN common_quote:=quote; END IF;
  IF quote IS DISTINCT FROM common_quote THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CORRUPT'; END IF;
  age:=least(age,(cfg->'model'->>'maxEvidenceAgeMs')::integer);
 END LOOP;
 FOR book IN SELECT value FROM jsonb_array_elements(books) LOOP
  origin_wire:=(book->'origin'->>'receiptText')::jsonb;
  cfg:=((origin_wire->'configuration'->>'receiptText')::jsonb)->'configuration';
  seed:=((origin_wire->'funding'->>'receiptText')::jsonb)->'funding';
  FOR balance IN SELECT value FROM jsonb_array_elements(seed->'balances') LOOP
   IF balance->>'asset'=common_quote THEN CONTINUE; END IF;
   SELECT array_agg(key) INTO heads FROM (
    SELECT sh.key FROM ctp_market.snapshot_head sh JOIN public.instrument i ON i.id=(sh.key->>'dbInstrumentId')::uuid
    WHERE sh.key->'scope'=cfg->'source' AND i.active AND i.market='SPOT'
     AND i.exchange::text=cfg->'source'->>'exchange' AND i.mode::text=cfg->'source'->>'environment'
     AND i."baseAsset"=balance->>'asset' AND i."quoteAsset"=common_quote ORDER BY sh.key::text LIMIT 2
   ) q;
   IF coalesce(cardinality(heads),0)<>1 THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_MARKET'; END IF;
   k:=heads[1];
   SELECT * INTO h FROM ctp_market.snapshot_head WHERE key=k;
   IF NOT FOUND OR h.gap OR h.native IS NULL THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_MARKET'; END IF;
   SELECT * INTO e FROM ctp_market.snapshot_event WHERE id=h.native;
   IF NOT FOUND OR e.hash<>sha256(convert_to(e.payload,'UTF8')) OR e.key-'dbRuleId'<>k
    OR e.revision>h.revision OR e.status<>'APPLIED' THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CORRUPT'; END IF;
   p:=e.payload::jsonb;
   IF p->>'id'<>e.id::text OR p->>'kind'<>'SNAPSHOT' OR ctp_market.snapshot_valid(p) IS NOT TRUE
    OR ctp_market.snapshot_metadata(p) IS NOT TRUE OR p->'ticker'->'last'->>'state'<>'AVAILABLE'
    THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_MARKET'; END IF;
   IF ctp_market.snapshot_fresh(p,age) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_STALE'; END IF;
   IF NOT(e.id=ANY(seen)) THEN
    seen:=array_append(seen,e.id);
    IF cardinality(seen)>300 THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CAPACITY'; END IF;
    markets:=markets||jsonb_build_array(jsonb_build_object('id',e.id::text,'revision',h.revision::text,'hash',encode(e.hash,'hex'),'publicationText',e.payload));
   END IF;
   result:=jsonb_build_object('kind','PAPER_RISK_VALUATION_CAPTURE','inventory',inventory_wire,'markets',markets);
   IF octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CAPACITY'; END IF;
  END LOOP;
 END LOOP;
 result:=jsonb_build_object('kind','PAPER_RISK_VALUATION_CAPTURE','inventory',inventory_wire,'markets',markets);
 IF octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CAPACITY'; END IF;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_RISK_VALUATION_%' THEN RAISE;
 ELSIF SQLERRM LIKE 'PAPER_BOOK_SOURCE_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_BOOK_SOURCE_','PAPER_RISK_VALUATION_');
 ELSE RAISE EXCEPTION 'PAPER_RISK_VALUATION_CORRUPT'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_RISK_VALUATION_CORRUPT';
END $$;
REVOKE ALL ON FUNCTION ctp_paper.valid_risk_valuation_runtime(),ctp_paper.capture_risk_valuation(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.capture_risk_valuation(jsonb) TO ctp_paper_risk_valuation;
COMMIT;
