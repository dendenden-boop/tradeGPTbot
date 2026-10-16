BEGIN;
-- Capture-only context. Published 1-48 and their role boundaries are unchanged.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_risk_context') THEN
 CREATE ROLE ctp_paper_risk_context NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_risk_context;

CREATE FUNCTION ctp_paper.valid_risk_context_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_risk_context'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_risk_context','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_risk_context' AND pg_has_role(session_user,r.oid,'MEMBER'))
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
   NOT IN('ctp_paper.capture_risk_context(jsonb)'))
$$;


-- Private invoker helpers preserve the accepted locked evidence checks. They
-- are callable only by the guarded definer owner, never by a runtime login.
CREATE FUNCTION ctp_paper.context_authority_capture(x jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b jsonb; t uuid; a public.exchange_account%ROWTYPE; u public."user"%ROWTYPE;
 platform ctp_risk.policy_revision%ROWTYPE; usr ctp_risk.policy_revision%ROWTYPE;
 controls_text text; result jsonb;
BEGIN
 -- The private helper validates input/ownership and holds GLOBAL -> tenant ->
 -- user/account/order/book and metadata/public-head locks through this COMMIT.
 b:=ctp_paper.authority_order_capture(x);
 t:=(x->'owner'->>'tenantId')::uuid;
 SELECT * INTO u FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_OWNERSHIP'; END IF;
 SELECT * INTO a FROM public.exchange_account
  WHERE "tenantId"=t AND id=(x->'owner'->>'accountId')::uuid AND mode='PAPER' AND status='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_OWNERSHIP'; END IF;
 SELECT r.* INTO platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id)
  WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode='PAPER';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_POLICY'; END IF;
 SELECT r.* INTO usr FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id)
  WHERE h.scope='USER' AND h.target=t AND h.mode='PAPER';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_POLICY'; END IF;
 IF ctp_risk.valid_limits(platform."limitsText"::jsonb) IS NOT TRUE
  OR ctp_risk.valid_limits(usr."limitsText"::jsonb) IS NOT TRUE
 THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_POLICY'; END IF;
 -- These durable controller/legacy writers share the held advisory protocol.
 -- Taking catalog SHARE locks here would invert legacy BEFORE-trigger ordering.
 IF (SELECT count(*) FROM ctp_risk.global_head)>10000
 OR (SELECT count(*) FROM ctp_risk.tenant_head WHERE "tenantId"=t)>10000
 OR (SELECT count(*) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL)>10000
 OR (SELECT count(*) FROM public.circuit_state WHERE "tenantId"=t)>10000
 THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_CAPACITY'; END IF;
 SELECT jsonb_build_object(
  'global',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind','GLOBAL'),
   'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY kind,key) FROM ctp_risk.global_head),'[]'::jsonb),
  'tenant',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind',scope,'tenantId',"tenantId"::text,'targetId',target::text),
   'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY scope,target,kind,key) FROM ctp_risk.tenant_head WHERE "tenantId"=t),'[]'::jsonb),
  'activePauses',coalesce((SELECT jsonb_agg(id::text ORDER BY id) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL),'[]'::jsonb),
  'circuits',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id::text,'state',status::text) ORDER BY id) FROM public.circuit_state WHERE "tenantId"=t),'[]'::jsonb)
 )::text INTO controls_text;
 result:=jsonb_build_object('kind','PAPER_RISK_AUTHORITY_CAPTURE','orderRisk',b,
  'identity',jsonb_build_object('tenantId',t::text,'accountId',a.id::text,'mode','PAPER',
   'connectionId',NULL,'externalAccountId',a."externalAccountId",'userSessionEpoch',u."sessionEpoch"::text,
   'permissionEpoch',a."permissionEpoch"::text,'accountVersion',a.version),
  'policies',jsonb_build_array(ctp_risk.policy_json(platform),ctp_risk.policy_json(usr)),
  'controls',jsonb_build_object('text',controls_text,'hash',encode(sha256(convert_to(controls_text,'UTF8')),'hex')));
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_CAPACITY'; END IF;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_RISK_AUTHORITY_%' THEN RAISE;
 ELSIF SQLERRM LIKE 'PAPER_ORDER_RISK_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_ORDER_RISK_','PAPER_RISK_AUTHORITY_');
 ELSE RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_CORRUPT'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_CORRUPT';
END $$;

CREATE FUNCTION ctp_paper.context_runtime_capture(o jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; e ctp_paper.runtime_observation%ROWTYPE; h ctp_paper.runtime_observation_head%ROWTYPE; p jsonb; result jsonb; BEGIN
 IF o IS NULL OR octet_length(o::text)>512 THEN RAISE EXCEPTION 'PAPER_RUNTIME_INPUT'; END IF;
 ctx:=ctp_paper.runtime_context(o);
 SELECT * INTO h FROM ctp_paper.runtime_observation_head
  WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RUNTIME_MISSING'; END IF;
 SELECT * INTO e FROM ctp_paper.runtime_observation WHERE id=h.id;
 IF NOT FOUND OR e.revision<>h.revision OR e.configuration_id<>h.configuration_id
 OR NOT coalesce(ctp_paper.checked_runtime_event(e),false)
 OR e.configuration_id::text IS DISTINCT FROM (ctx->'configuration'->>'receiptText')::jsonb->'configuration'->>'id'
 THEN RAISE EXCEPTION 'PAPER_RUNTIME_CORRUPT'; END IF;
 p:=e.payload::jsonb->'observation';
 IF p->>'permissionEpoch' IS DISTINCT FROM ctx->'current'->>'permissionEpoch'
 OR p->>'userSessionEpoch' IS DISTINCT FROM ctx->'current'->>'userSessionEpoch'
 OR p->'accountVersion' IS DISTINCT FROM ctx->'current'->'accountVersion'
 THEN RAISE EXCEPTION 'PAPER_RUNTIME_EPOCH'; END IF;
 result:=ctx||jsonb_build_object('kind','PAPER_RUNTIME_CAPTURE','owner',o,'asOf',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,
  'publication',jsonb_build_object('id',e.id::text,'revision',e.revision::text,'text',e.payload,'hash',encode(e.hash,'hex'),'publishedAt',e.published_at));
 IF octet_length(result::text)>65536 THEN RAISE EXCEPTION 'PAPER_RUNTIME_CAPACITY'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION ctp_paper.capture_risk_context(x jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a jsonb; r jsonb; result jsonb; BEGIN
 IF NOT coalesce(ctp_paper.valid_risk_context_runtime(),false)
 THEN RAISE EXCEPTION 'PAPER_RISK_CONTEXT_ROLE_UNSAFE'; END IF;
 -- GLOBAL -> tenant -> user/account/order/book -> public metadata/heads.
 -- The tenant lock also serializes runtime publishers until this COMMIT.
 a:=ctp_paper.context_authority_capture(x);
 r:=ctp_paper.context_runtime_capture(x->'owner');
 result:=jsonb_build_object('kind','PAPER_RISK_CONTEXT_CAPTURE',
  'asOf',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'authority',a,'runtime',r);
 IF octet_length(result::text)>3145728 THEN RAISE EXCEPTION 'PAPER_RISK_CONTEXT_CAPACITY'; END IF;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_RISK_CONTEXT_%' THEN RAISE;
 ELSIF SQLERRM LIKE 'PAPER_RISK_AUTHORITY_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_RISK_AUTHORITY_','PAPER_RISK_CONTEXT_');
 ELSIF SQLERRM LIKE 'PAPER_RUNTIME_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_RUNTIME_','PAPER_RISK_CONTEXT_');
 ELSE RAISE EXCEPTION 'PAPER_RISK_CONTEXT_CORRUPT'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_RISK_CONTEXT_CORRUPT';
END $$;

REVOKE ALL ON FUNCTION ctp_paper.valid_risk_context_runtime(),ctp_paper.context_authority_capture(jsonb),
 ctp_paper.context_runtime_capture(jsonb),ctp_paper.capture_risk_context(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.capture_risk_context(jsonb) TO ctp_paper_risk_context;
COMMIT;
