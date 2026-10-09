BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_configuration') THEN
 CREATE ROLE ctp_paper_configuration NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
CREATE SCHEMA ctp_paper;
REVOKE ALL ON SCHEMA ctp_paper FROM PUBLIC;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_configuration;

-- Configuration authority only. No ledger, funding, reservation or order writer.
CREATE TABLE ctp_paper.configuration (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, account_id uuid NOT NULL UNIQUE,
 mode public."TradingMode" NOT NULL DEFAULT 'PAPER' CHECK(mode='PAPER'),
 request jsonb NOT NULL CHECK(octet_length(request::text)<=8192),
 receipt_text text NOT NULL CHECK(octet_length(receipt_text)<=8192),
 FOREIGN KEY(tenant_id,account_id,mode) REFERENCES public.exchange_account("tenantId",id,mode) ON DELETE RESTRICT
);
ALTER TABLE ctp_paper.configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.configuration FORCE ROW LEVEL SECURITY;
CREATE POLICY paper_configuration_tenant ON ctp_paper.configuration
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER paper_configuration_immutable BEFORE UPDATE OR DELETE ON ctp_paper.configuration
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER paper_configuration_no_truncate BEFORE TRUNCATE ON ctp_paper.configuration
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.valid_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_configuration'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_configuration','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_configuration' AND pg_has_role(session_user,r.oid,'MEMBER'))
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
   NOT IN('ctp_paper.register_configuration(text)','ctp_paper.read_configuration(jsonb)'))
$$;

CREATE FUNCTION ctp_paper.valid_owner(o jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ctp_market.snapshot_keys(o,ARRAY['tenantId','accountId','mode'])
 AND jsonb_typeof(o->'mode')='string' AND o->>'mode'='PAPER'
 AND jsonb_typeof(o->'tenantId')='string' AND o->>'tenantId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND jsonb_typeof(o->'accountId')='string' AND o->>'accountId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
$$;
CREATE FUNCTION ctp_paper.valid_configuration(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE m jsonb:=p->'model'; k text; v text; BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['id','owner','source','valuationAsset','model']),false)
 OR NOT coalesce(ctp_paper.valid_owner(p->'owner'),false)
 OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR p->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR NOT coalesce(ctp_registry.valid_scope(p->'source'),false) OR p->'source'->>'market' IS DISTINCT FROM 'SPOT'
 OR jsonb_typeof(p->'valuationAsset') IS DISTINCT FROM 'string' OR p->>'valuationAsset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'
 OR NOT coalesce(ctp_market.snapshot_keys(m,ARRAY['version','seed','takerFeeRate','maxSlippageRate','latencyMs','latencyJitterMs','participationRate','maxEvidenceAgeMs']),false)
 OR jsonb_typeof(m->'version') IS DISTINCT FROM 'string' OR m->>'version' IS DISTINCT FROM 'spot-l2-taker-v1'
 OR jsonb_typeof(m->'seed') IS DISTINCT FROM 'string' OR m->>'seed' !~ '^(0|-?[1-9][0-9]{0,18})$'
 THEN RETURN false; END IF;
 IF (m->>'seed')::numeric NOT BETWEEN -9223372036854775808 AND 9223372036854775807 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['takerFeeRate','maxSlippageRate','participationRate'] LOOP
  v:=m->>k;
  IF jsonb_typeof(m->k) IS DISTINCT FROM 'string' OR v !~ '^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$' THEN RETURN false; END IF;
  IF v::numeric<0 OR v::numeric>(CASE WHEN k='participationRate' THEN 1 ELSE 0.1 END)
   OR (k='participationRate' AND v::numeric=0) THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['latencyMs','latencyJitterMs','maxEvidenceAgeMs'] LOOP
  v:=m->>k;
  IF jsonb_typeof(m->k) IS DISTINCT FROM 'number' OR v !~ '^(0|[1-9][0-9]{0,4})$' THEN RETURN false; END IF;
  IF v::integer>(CASE WHEN k='maxEvidenceAgeMs' THEN 15000 ELSE 60000 END)
   OR (k<>'latencyJitterMs' AND v::integer=0) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

-- Lock order tenant -> account; this path has no financial/budget locks.
-- Public PAPER records may be edited by API. They never replace this receipt.
CREATE FUNCTION ctp_paper.account_identity(o jsonb,s jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a public.exchange_account%ROWTYPE; BEGIN
 IF NOT coalesce(ctp_paper.valid_owner(o),false)
 OR o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true)
 THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_OWNERSHIP'; END IF;
 PERFORM 1 FROM public."user" WHERE id=(o->>'tenantId')::uuid AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_OWNERSHIP'; END IF;
 SELECT * INTO a FROM public.exchange_account WHERE "tenantId"=(o->>'tenantId')::uuid AND id=(o->>'accountId')::uuid FOR UPDATE;
 IF NOT FOUND OR a.mode<>'PAPER' OR a.status<>'ACTIVE' OR a."accountMode"<>'SIMULATED'
 OR a.exchange::text IS DISTINCT FROM s->>'exchange' OR a.region IS DISTINCT FROM s->>'region'
 OR EXISTS(SELECT 1 FROM public.exchange_connection WHERE "accountId"=a.id)
 OR length(a."externalAccountId") NOT BETWEEN 1 AND 128 OR a."externalAccountId" ~ '[[:space:][:cntrl:]]'
 OR length(a."clientIdEpoch") NOT BETWEEN 1 AND 64 OR a."clientIdEpoch" ~ '[[:space:][:cntrl:]]'
 THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_OWNERSHIP'; END IF;
 RETURN jsonb_build_object('externalAccountId',a."externalAccountId",'clientIdEpoch',a."clientIdEpoch");
END $$;
CREATE FUNCTION ctp_paper.wire_receipt(t text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('receiptText',t,'hash',encode(sha256(convert_to(t,'UTF8')),'hex'))
$$;
CREATE FUNCTION ctp_paper.register_configuration(t text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; ident jsonb; old ctp_paper.configuration%ROWTYPE; receipt text; BEGIN
 IF NOT coalesce(ctp_paper.valid_runtime(),false) THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_ROLE_UNSAFE'; END IF;
 IF t IS NULL OR octet_length(t)>8192 THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_INPUT'; END IF;
 p:=t::jsonb;
 IF NOT coalesce(ctp_paper.valid_configuration(p),false) THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_INPUT'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:paper-config:'||(p->>'id'),0));
 ident:=ctp_paper.account_identity(p->'owner',p->'source');
 SELECT * INTO old FROM ctp_paper.configuration WHERE account_id=(p->'owner'->>'accountId')::uuid;
 IF FOUND THEN
  IF old.request IS DISTINCT FROM p OR old.receipt_text::jsonb->'accountIdentity' IS DISTINCT FROM ident THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_CONFLICT'; END IF;
  RETURN ctp_paper.wire_receipt(old.receipt_text);
 END IF;
 -- A globally occupied configuration ID cannot be stolen for a different account.
 IF EXISTS(SELECT 1 FROM ctp_paper.configuration WHERE id=(p->>'id')::uuid) THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_CONFLICT'; END IF;
 receipt:=jsonb_build_object('configuration',p,'accountIdentity',ident,'createdAt',floor(extract(epoch FROM clock_timestamp())*1000)::bigint)::text;
 INSERT INTO ctp_paper.configuration(id,tenant_id,account_id,request,receipt_text)
 VALUES((p->>'id')::uuid,(p->'owner'->>'tenantId')::uuid,(p->'owner'->>'accountId')::uuid,p,receipt);
 RETURN ctp_paper.wire_receipt(receipt);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_CONFLICT';
END $$;
CREATE FUNCTION ctp_paper.read_configuration(o jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old ctp_paper.configuration%ROWTYPE; ident jsonb; BEGIN
 IF NOT coalesce(ctp_paper.valid_runtime(),false) THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_ROLE_UNSAFE'; END IF;
 IF NOT coalesce(ctp_paper.valid_owner(o),false) OR o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true)
 THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_OWNERSHIP'; END IF;
 SELECT * INTO old FROM ctp_paper.configuration WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN
  -- Missing configuration is not ownership evidence.
  RAISE EXCEPTION 'PAPER_CONFIGURATION_MISSING';
 END IF;
 ident:=ctp_paper.account_identity(o,old.request->'source');
 IF old.receipt_text::jsonb->'accountIdentity' IS DISTINCT FROM ident THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_OWNERSHIP'; END IF;
 RETURN ctp_paper.wire_receipt(old.receipt_text);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA ctp_paper FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ctp_paper FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.register_configuration(text),ctp_paper.read_configuration(jsonb) TO ctp_paper_configuration;
COMMIT;
