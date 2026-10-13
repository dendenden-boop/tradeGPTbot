BEGIN;
-- Read-only current common book provenance; no financial table/initializer grants.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_risk_portfolio') THEN
 CREATE ROLE ctp_paper_risk_portfolio NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_risk_portfolio;

CREATE FUNCTION ctp_paper.valid_risk_portfolio_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_risk_portfolio'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_risk_portfolio','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_risk_portfolio' AND pg_has_role(session_user,r.oid,'MEMBER'))
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
   NOT IN('ctp_paper.capture_risk_portfolio(jsonb)'))
$$;

CREATE FUNCTION ctp_paper.risk_portfolio_book(o jsonb,capture_at bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; origin ctp_paper.book_origin%ROWTYPE; a public.exchange_account%ROWTYPE;
 wire jsonb; result jsonb; drafts jsonb; ts bigint:=capture_at; configured_at bigint;
BEGIN

 ctx:=ctp_paper.book_context(o);
 PERFORM ctp_paper.book_activity(o,(ctx->'configuration'->>'receiptText')::jsonb,(ctx->'funding'->>'receiptText')::jsonb);
 SELECT * INTO origin FROM ctp_paper.book_origin WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_BOOK_SOURCE_MISSING'; END IF;
 -- Lock existing common projection, including FK inserts, before checking
 -- original provenance. No writes or snapshot-time refresh occur here.
 PERFORM id FROM ctp_portfolio.book WHERE "tenantId"=origin.tenant_id AND id=origin.book FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_BOOK_SOURCE_CORRUPT'; END IF;
 wire:=ctp_paper.book_origin_wire(origin,ctx->'configuration',ctx->'funding');
 SELECT * INTO a FROM public.exchange_account WHERE "tenantId"=origin.tenant_id AND id=origin.account_id AND mode='PAPER';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_BOOK_SOURCE_OWNERSHIP'; END IF;

 configured_at:=((ctx->'configuration'->>'receiptText')::jsonb->>'createdAt')::bigint;
 IF EXISTS(SELECT 1 FROM public."order" x WHERE x."tenantId"=origin.tenant_id AND x."accountId"=origin.account_id
  AND (x."clientId" !~ '^[1-9][0-9]{0,18}$' OR x."clientId"::numeric>9223372036854775807
    OR x."clientId"::numeric>a."clientIdHighWatermark" OR x."createdAt"<to_timestamp(configured_at::double precision/1000)
    OR x."createdAt">to_timestamp(ts::double precision/1000)))
 OR EXISTS(SELECT 1 FROM public."order" x WHERE x."tenantId"=origin.tenant_id AND x."accountId"=origin.account_id GROUP BY x."clientId" HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'PAPER_BOOK_SOURCE_CORRUPT'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('orderId',x.id::text,'intentId',x."intentId"::text,
  'clientOrderId',x."clientId",'commandHash',encode(c."commandHash",'hex'),
  'createdAt',floor(extract(epoch FROM x."createdAt")*1000)::bigint) ORDER BY x."clientId"::bigint),'[]'::jsonb) INTO drafts
 FROM public."order" x JOIN ctp_execution.command c ON c."tenantId"=x."tenantId" AND c."intentId"=x."intentId" AND c."orderId"=x.id
 WHERE x."tenantId"=origin.tenant_id AND x."accountId"=origin.account_id;
 result:=jsonb_build_object('kind','PAPER_BOOK_SOURCE','asOf',ts,'origin',wire,
  'accountState',jsonb_build_object('permissionEpoch',a."permissionEpoch"::text,'reconciliationEpoch',a."reconciliationEpoch"::text,
    'clientIdHighWatermark',a."clientIdHighWatermark"::text,'version',a.version),'drafts',drafts);
 IF octet_length(result::text)>524288 THEN RAISE EXCEPTION 'PAPER_BOOK_SOURCE_CAPACITY'; END IF;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_BOOK_SOURCE_%' THEN RAISE;
 ELSIF SQLERRM LIKE 'PAPER_BOOK_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_BOOK_','PAPER_BOOK_SOURCE_');
 ELSE RAISE EXCEPTION 'PAPER_BOOK_SOURCE_CORRUPT'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_BOOK_SOURCE_CORRUPT';
END $$;
CREATE FUNCTION ctp_paper.capture_risk_portfolio(o jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; ids uuid[]; a uuid; ts bigint; books jsonb:='[]'::jsonb; book jsonb; result jsonb; drafts integer:=0;
BEGIN
 IF NOT coalesce(ctp_paper.valid_risk_portfolio_runtime(),false) THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_ROLE_UNSAFE'; END IF;
 IF o IS NULL OR octet_length(o::text)>512 OR NOT coalesce(ctp_paper.valid_owner(o),false) THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_INPUT'; END IF;
 IF o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true) THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_OWNERSHIP'; END IF;
 t:=(o->>'tenantId')::uuid;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 -- FOR UPDATE also blocks new account FK inserts while enumerating the tenant.
 PERFORM 1 FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_OWNERSHIP'; END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id LIMIT 101) q;
 IF ids IS NULL THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_OWNERSHIP'; END IF;
 IF cardinality(ids)>100 THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_CAPACITY'; END IF;
 IF NOT ((o->>'accountId')::uuid=ANY(ids)) THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_OWNERSHIP'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 FOREACH a IN ARRAY ids LOOP
  book:=ctp_paper.risk_portfolio_book(o||jsonb_build_object('accountId',a::text),ts);
  drafts:=drafts+jsonb_array_length(book->'drafts');
  IF drafts>1000 THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_CAPACITY'; END IF;
  books:=books||jsonb_build_array(book);
  result:=jsonb_build_object('kind','PAPER_RISK_PORTFOLIO_SOURCE','owner',o,'asOf',ts,'accountIds',to_jsonb(ids),'books',books);
  IF octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_CAPACITY'; END IF;
 END LOOP;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_RISK_PORTFOLIO_%' THEN RAISE;
 ELSIF SQLERRM LIKE 'PAPER_BOOK_SOURCE_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_BOOK_SOURCE_','PAPER_RISK_PORTFOLIO_');
 ELSE RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_CORRUPT'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_RISK_PORTFOLIO_CORRUPT';
END $$;
REVOKE ALL ON FUNCTION ctp_paper.valid_risk_portfolio_runtime(),ctp_paper.risk_portfolio_book(jsonb,bigint),ctp_paper.capture_risk_portfolio(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.capture_risk_portfolio(jsonb) TO ctp_paper_risk_portfolio;
COMMIT;
