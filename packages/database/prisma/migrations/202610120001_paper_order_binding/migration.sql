BEGIN;
-- Read-only ownership proof for common PAPER drafts. No configuration, funding,
-- ledger, Risk, fill, permit or PAPER dispatch writer is granted here.
CREATE FUNCTION ctp_execution.paper_order_identity(b jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o jsonb; p jsonb:=b->'profile'; r ctp_paper.configuration%ROWTYPE; ident jsonb; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles u WHERE u.rolname=session_user
   AND NOT(u.rolsuper OR u.rolbypassrls OR u.rolcreatedb OR u.rolcreaterole OR u.rolreplication))
 OR NOT EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_execution'
   AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 OR NOT pg_has_role(session_user,'ctp_execution','MEMBER')
 OR EXISTS(SELECT 1 FROM pg_roles u WHERE u.rolname<>session_user AND u.rolname<>'ctp_execution' AND pg_has_role(session_user,u.oid,'MEMBER'))
 OR has_database_privilege(session_user,current_database(),'CREATE,TEMP')
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_')
   AND (has_schema_privilege(session_user,n.oid,'CREATE') OR pg_has_role(session_user,n.nspowner,'MEMBER')))
 OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p','v','m','f')
   AND (pg_has_role(session_user,t.relowner,'MEMBER') OR (left(n.nspname,4)='ctp_'
     AND (n.nspname||'.'||t.relname) NOT IN('ctp_execution.amendment_application','ctp_execution.amendment_head',
       'ctp_execution.command','ctp_execution.progress','ctp_execution.evidence','ctp_execution.fill_adoption',
       'ctp_execution.authoritative_event','ctp_portfolio.book','ctp_portfolio.evidence')
     AND (has_table_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
       OR has_any_column_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
     OR has_table_privilege(session_user,t.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES')))
 OR has_table_privilege(session_user,'public.ledger_transaction','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
 OR has_table_privilege(session_user,'public.ledger_entry','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
 OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
   WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(session_user,f.oid,'EXECUTE')
   AND f.oid NOT IN('ctp_risk.dispatch_gate(uuid,uuid)'::regprocedure::oid,
     'ctp_execution.apply_amendment(jsonb)'::regprocedure::oid,
     'ctp_execution.paper_order_identity(jsonb)'::regprocedure::oid))
 THEN RAISE EXCEPTION 'ORDER_PAPER_ROLE_UNSAFE'; END IF;
 o:=jsonb_build_object('tenantId',b->'tenantId','accountId',b->'accountId','mode',b->'mode');
 IF NOT coalesce(ctp_market.snapshot_keys(b,ARRAY['tenantId','accountId','mode','connectionId','externalAccountId','profile']),false)
 OR NOT coalesce(ctp_paper.valid_owner(o),false)
 OR b->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true)
 OR b->'connectionId' IS DISTINCT FROM 'null'::jsonb
 OR jsonb_typeof(b->'externalAccountId') IS DISTINCT FROM 'string'
 OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['exchange','region','market','environment','accountMode','profileVersion','endpointProfileId']),false)
 OR NOT coalesce(ctp_registry.valid_scope(p-ARRAY['accountMode','profileVersion','endpointProfileId']),false)
 OR p->>'market' IS DISTINCT FROM 'SPOT' OR p->>'accountMode' IS DISTINCT FROM 'SIMULATED'
 OR p->>'endpointProfileId' IS DISTINCT FROM 'paper-spot-v1'
 THEN RAISE EXCEPTION 'ORDER_PAPER_CONFIGURATION'; END IF;
 SELECT * INTO r FROM ctp_paper.configuration
   WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAPER_CONFIGURATION'; END IF;
 -- Validate the retained original seal, never re-seal current mutable input.
 PERFORM ctp_paper.wire_receipt(r.receipt_text);
 IF r.request->'owner' IS DISTINCT FROM o
 OR r.request->'source' IS DISTINCT FROM p-ARRAY['accountMode','profileVersion','endpointProfileId']
 OR r.request->'model'->>'version' IS DISTINCT FROM p->>'profileVersion'
 THEN RAISE EXCEPTION 'ORDER_PAPER_CONFIGURATION'; END IF;
 -- GLOBAL -> tenant locks are held by the common store. This existing proof
 -- acquires user SHARE -> account UPDATE before the common account write lock.
 ident:=ctp_paper.account_identity(o,r.request->'source');
 IF r.receipt_text::jsonb->'accountIdentity' IS DISTINCT FROM ident
 OR ident->>'externalAccountId' IS DISTINCT FROM b->>'externalAccountId'
 THEN RAISE EXCEPTION 'ORDER_PAPER_CONFIGURATION'; END IF;
 RETURN ident;
EXCEPTION WHEN OTHERS THEN
 IF SQLERRM='ORDER_PAPER_ROLE_UNSAFE' THEN RAISE EXCEPTION 'ORDER_PAPER_ROLE_UNSAFE'; END IF;
 RAISE EXCEPTION 'ORDER_PAPER_CONFIGURATION';
END $$;
REVOKE ALL ON FUNCTION ctp_execution.paper_order_identity(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_execution.paper_order_identity(jsonb) TO ctp_execution;
COMMIT;
