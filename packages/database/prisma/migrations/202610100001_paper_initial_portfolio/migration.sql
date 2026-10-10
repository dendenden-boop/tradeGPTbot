BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_portfolio_reader') THEN
 CREATE ROLE ctp_paper_portfolio_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_portfolio_reader;

CREATE FUNCTION ctp_paper.valid_initial_portfolio_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_portfolio_reader'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_portfolio_reader','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_portfolio_reader' AND pg_has_role(session_user,r.oid,'MEMBER'))
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
   NOT IN('ctp_paper.capture_initial_portfolio(jsonb)'))
$$;


-- Read-only initial source. Retained provenance and the common ledger must
-- agree. Any subsequent activity requires the full PAPER lifecycle instead.
CREATE FUNCTION ctp_paper.capture_initial_portfolio(o jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f ctp_paper.initial_funding%ROWTYPE; c ctp_paper.configuration%ROWTYPE; a public.exchange_account%ROWTYPE;
 cw jsonb; fw jsonb; ci jsonb; ts bigint;
BEGIN
 IF NOT coalesce(ctp_paper.valid_initial_portfolio_runtime(),false) THEN RAISE EXCEPTION 'PAPER_PORTFOLIO_ROLE_UNSAFE'; END IF;
 IF o IS NULL OR octet_length(o::text)>512 OR NOT coalesce(ctp_paper.valid_owner(o),false) THEN RAISE EXCEPTION 'PAPER_PORTFOLIO_INPUT'; END IF;
 IF o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true) THEN RAISE EXCEPTION 'PAPER_PORTFOLIO_OWNERSHIP'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:risk:'||(o->>'tenantId'),0));
 SELECT * INTO f FROM ctp_paper.initial_funding WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_PORTFOLIO_MISSING'; END IF;
 BEGIN
  ci:=ctp_paper.funding_configuration(o,f.configuration_id);
  SELECT * INTO c FROM ctp_paper.configuration WHERE id=f.configuration_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_FUNDING_CORRUPT'; END IF;
  cw:=ctp_paper.wire_receipt(c.receipt_text);
  fw:=ctp_paper.funding_wire(f,ci);
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM IN('PAPER_CONFIGURATION_OWNERSHIP','PAPER_FUNDING_OWNERSHIP') THEN RAISE EXCEPTION 'PAPER_PORTFOLIO_OWNERSHIP';
  ELSE RAISE EXCEPTION 'PAPER_PORTFOLIO_CORRUPT'; END IF;
 END;
 -- account_identity above owns the account FOR UPDATE and active tenant FOR
 -- SHARE. New scoped FK inserts and ownership changes cannot race this view.
 SELECT * INTO a FROM public.exchange_account WHERE id=f.account_id AND "tenantId"=f.tenant_id;
 IF EXISTS(SELECT 1 FROM public.ledger_transaction WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id AND id<>f.ledger_id)
 OR EXISTS(SELECT 1 FROM public.order_intent WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id)
 OR EXISTS(SELECT 1 FROM public."order" WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id)
 OR EXISTS(SELECT 1 FROM public.risk_reservation WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id)
 OR EXISTS(SELECT 1 FROM ctp_portfolio.book WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id)
 OR EXISTS(SELECT 1 FROM public.paper_account WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id)
 OR EXISTS(SELECT 1 FROM public.paper_order WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id)
 OR EXISTS(SELECT 1 FROM public.paper_position WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id)
 OR EXISTS(SELECT 1 FROM public.position WHERE "tenantId"=f.tenant_id AND "accountId"=f.account_id)
 THEN RAISE EXCEPTION 'PAPER_PORTFOLIO_INCOMPLETE'; END IF;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 RETURN jsonb_build_object('kind','INITIAL_FUNDING_ONLY','asOf',ts,'configuration',cw,'funding',fw,
  'accountState',jsonb_build_object('permissionEpoch',a."permissionEpoch"::text,'reconciliationEpoch',a."reconciliationEpoch"::text,'version',a.version));
END $$;
REVOKE ALL ON FUNCTION ctp_paper.valid_initial_portfolio_runtime(),ctp_paper.capture_initial_portfolio(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.capture_initial_portfolio(jsonb) TO ctp_paper_portfolio_reader;
COMMIT;
