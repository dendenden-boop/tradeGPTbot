BEGIN;
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['ctp_paper_runtime_observer','ctp_paper_runtime_reader'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',n); END IF;
END LOOP; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_runtime_observer,ctp_paper_runtime_reader;

CREATE FUNCTION ctp_paper.valid_runtime_observation_runtime(authority text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT authority IN('OBSERVER','READER') AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname=(CASE WHEN authority='OBSERVER' THEN 'ctp_paper_runtime_observer' ELSE 'ctp_paper_runtime_reader' END)
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,(CASE WHEN authority='OBSERVER' THEN 'ctp_paper_runtime_observer' ELSE 'ctp_paper_runtime_reader' END),'MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>(CASE WHEN authority='OBSERVER' THEN 'ctp_paper_runtime_observer' ELSE 'ctp_paper_runtime_reader' END) AND pg_has_role(session_user,r.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM unnest(CASE WHEN authority='OBSERVER' THEN ARRAY['ctp_paper.publish_runtime_observation(text)','ctp_paper.lookup_runtime_observation(jsonb)','ctp_paper.read_runtime_observation_context(jsonb)'] ELSE ARRAY['ctp_paper.capture_runtime_observation(jsonb)'] END) AS required(fn)
  WHERE NOT has_function_privilege(session_user,required.fn,'EXECUTE'))
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
   <>ALL(CASE WHEN authority='OBSERVER' THEN ARRAY['ctp_paper.publish_runtime_observation(text)','ctp_paper.lookup_runtime_observation(jsonb)','ctp_paper.read_runtime_observation_context(jsonb)'] ELSE ARRAY['ctp_paper.capture_runtime_observation(jsonb)'] END))
$$;

CREATE FUNCTION ctp_paper.runtime_epoch(v jsonb,ceiling bigint) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s text; BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 s:=v#>>'{}';
 IF length(s)>19 OR s !~ '^(0|[1-9][0-9]*)$' OR s ~ '[^0-9]' THEN RETURN false; END IF;
 RETURN s::numeric<=ceiling;
END $$;
CREATE FUNCTION ctp_paper.valid_runtime_publication(p jsonb) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE o jsonb; f jsonb; k text; s text; BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['id','expectedRevision','observation']),false)
 OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR length(p->>'id')<>36
 OR p->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR NOT ctp_paper.runtime_epoch(p->'expectedRevision',9223372036854775806)
 THEN RETURN false; END IF;
 o:=p->'observation';
 IF NOT coalesce(ctp_market.snapshot_keys(o,ARRAY['owner','configurationId','configurationHash','permissionEpoch','userSessionEpoch','accountVersion','health']),false)
 OR NOT coalesce(ctp_paper.valid_owner(o->'owner'),false)
 OR jsonb_typeof(o->'configurationId') IS DISTINCT FROM 'string' OR length(o->>'configurationId')<>36
 OR o->>'configurationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR jsonb_typeof(o->'configurationHash') IS DISTINCT FROM 'string' OR length(o->>'configurationHash')<>64
 OR o->>'configurationHash' !~ '^[a-f0-9]{64}$'
 OR NOT ctp_paper.runtime_epoch(o->'permissionEpoch',9223372036854775807)
 OR NOT ctp_paper.runtime_epoch(o->'userSessionEpoch',2147483647)
 OR jsonb_typeof(o->'accountVersion') IS DISTINCT FROM 'number'
 OR o->>'accountVersion' !~ '^(0|[1-9][0-9]*)$'
 OR (o->>'accountVersion')::numeric>2147483647
 OR NOT coalesce(ctp_market.snapshot_keys(o->'health',ARRAY['database','limiter','authentication','publicMarket','executor','clock','latency','rejectRate','maintenance']),false)
 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['database','limiter','authentication','publicMarket','executor','clock','latency','rejectRate','maintenance'] LOOP
  f:=o->'health'->k;
  IF NOT coalesce(ctp_market.snapshot_keys(f,ARRAY['sourceId','asOf','status']),false)
  OR jsonb_typeof(f->'status') IS DISTINCT FROM 'string' OR f->>'status' NOT IN('HEALTHY','FAILED','UNKNOWN')
  OR jsonb_typeof(f->'sourceId') IS DISTINCT FROM 'string'
  OR length(f->>'sourceId') NOT BETWEEN 1 AND 128
  OR f->>'sourceId' !~ '^[A-Za-z0-9]' OR f->>'sourceId' ~ '[^A-Za-z0-9._:-]'
  OR jsonb_typeof(f->'asOf') IS DISTINCT FROM 'number'
  OR f->>'asOf' !~ '^(0|[1-9][0-9]*)$'
  OR (f->>'asOf')::numeric>9007199254740991
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;

CREATE TABLE ctp_paper.runtime_observation (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, account_id uuid NOT NULL,
 configuration_id uuid NOT NULL REFERENCES ctp_paper.configuration(id) ON DELETE RESTRICT,
 revision bigint NOT NULL CHECK(revision>0),
 payload text NOT NULL CHECK(octet_length(payload)<=16384),
 hash bytea NOT NULL CHECK(hash=sha256(convert_to(payload,'UTF8'))),
 published_at bigint NOT NULL CHECK(published_at BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(tenant_id,account_id) REFERENCES public.exchange_account("tenantId",id) ON DELETE RESTRICT,
 UNIQUE(tenant_id,account_id,configuration_id,revision,id)
);
CREATE TABLE ctp_paper.runtime_observation_seal (
 id uuid PRIMARY KEY REFERENCES ctp_paper.runtime_observation(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, configuration_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), published_at bigint NOT NULL, hash bytea NOT NULL CHECK(octet_length(hash)=32)
);
CREATE TABLE ctp_paper.runtime_observation_head (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, configuration_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), id uuid NOT NULL,
 PRIMARY KEY(tenant_id,account_id),
 FOREIGN KEY(tenant_id,account_id,configuration_id,revision,id)
 REFERENCES ctp_paper.runtime_observation(tenant_id,account_id,configuration_id,revision,id) ON DELETE RESTRICT
);
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['runtime_observation','runtime_observation_seal','runtime_observation_head'] LOOP
 EXECUTE format('ALTER TABLE ctp_paper.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE ctp_paper.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY runtime_observation_tenant ON ctp_paper.%I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',n);
 EXECUTE format('CREATE TRIGGER paper_runtime_no_truncate BEFORE TRUNCATE ON ctp_paper.%I FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row()',n);
END LOOP; END $$;
CREATE TRIGGER paper_runtime_event_immutable BEFORE UPDATE OR DELETE ON ctp_paper.runtime_observation
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER paper_runtime_seal_immutable BEFORE UPDATE OR DELETE ON ctp_paper.runtime_observation_seal
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.valid_runtime_row(e ctp_paper.runtime_observation) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE p jsonb; o jsonb; BEGIN
 IF octet_length(e.payload)>16384 OR e.hash<>sha256(convert_to(e.payload,'UTF8'))
 OR e.revision<=0 OR e.published_at NOT BETWEEN 0 AND 9007199254740991 THEN RETURN false; END IF;
 p:=e.payload::jsonb; o:=p->'observation';
 RETURN coalesce(ctp_paper.valid_runtime_publication(p)
  AND p->>'id'=e.id::text AND (p->>'expectedRevision')::numeric+1=e.revision
  AND o->'owner'->>'tenantId'=e.tenant_id::text AND o->'owner'->>'accountId'=e.account_id::text
  AND o->>'configurationId'=e.configuration_id::text,false);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION ctp_paper.seal_runtime_observation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_runtime_row(NEW),false) THEN RAISE EXCEPTION 'PAPER_RUNTIME_CORRUPT'; END IF;
 INSERT INTO ctp_paper.runtime_observation_seal(id,tenant_id,account_id,configuration_id,revision,published_at,hash)
 VALUES(NEW.id,NEW.tenant_id,NEW.account_id,NEW.configuration_id,NEW.revision,NEW.published_at,NEW.hash);
 RETURN NEW;
END $$;
CREATE TRIGGER paper_runtime_seal AFTER INSERT ON ctp_paper.runtime_observation
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.seal_runtime_observation();
CREATE FUNCTION ctp_paper.runtime_head_monotonic() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR (TG_OP='INSERT' AND NEW.revision<>1)
 OR (TG_OP='UPDATE' AND ((to_jsonb(NEW)-'revision'-'id') IS DISTINCT FROM (to_jsonb(OLD)-'revision'-'id')
 OR NEW.revision::numeric<>OLD.revision::numeric+1 OR NEW.id=OLD.id))
 THEN RAISE EXCEPTION 'PAPER_RUNTIME_ORDERING' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paper_runtime_head_monotonic BEFORE INSERT OR UPDATE OR DELETE ON ctp_paper.runtime_observation_head
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.runtime_head_monotonic();

CREATE FUNCTION ctp_paper.checked_runtime_event(e ctp_paper.runtime_observation) RETURNS boolean
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE s ctp_paper.runtime_observation_seal%ROWTYPE; BEGIN
 IF NOT coalesce(ctp_paper.valid_runtime_row(e),false) THEN RETURN false; END IF;
 SELECT * INTO s FROM ctp_paper.runtime_observation_seal WHERE id=e.id;
 RETURN FOUND AND s.tenant_id=e.tenant_id AND s.account_id=e.account_id
 AND s.configuration_id=e.configuration_id AND s.revision=e.revision
 AND s.published_at=e.published_at AND s.hash=e.hash;
END $$;
CREATE FUNCTION ctp_paper.runtime_context(o jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; a public.exchange_account%ROWTYPE; u public."user"%ROWTYPE; c ctp_paper.configuration%ROWTYPE; w jsonb; ident jsonb;
BEGIN
 IF NOT coalesce(ctp_paper.valid_owner(o),false)
 OR o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true)
 THEN RAISE EXCEPTION 'PAPER_RUNTIME_OWNERSHIP'; END IF;
 t:=(o->>'tenantId')::uuid;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 SELECT * INTO u FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RUNTIME_OWNERSHIP'; END IF;
 SELECT * INTO c FROM ctp_paper.configuration WHERE tenant_id=t AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RUNTIME_MISSING'; END IF;
 w:=ctp_paper.wire_receipt(c.receipt_text);
 ident:=ctp_paper.account_identity(o,c.request->'source');
 IF c.receipt_text::jsonb->'accountIdentity' IS DISTINCT FROM ident THEN RAISE EXCEPTION 'PAPER_RUNTIME_OWNERSHIP'; END IF;
 SELECT * INTO a FROM public.exchange_account WHERE "tenantId"=t AND id=(o->>'accountId')::uuid;
 IF NOT FOUND OR a."permissionEpoch"<0 OR a.version<0 OR u."sessionEpoch"<0 THEN RAISE EXCEPTION 'PAPER_RUNTIME_EPOCH'; END IF;
 RETURN jsonb_build_object('configuration',w,'current',ident||jsonb_build_object(
  'permissionEpoch',a."permissionEpoch"::text,'userSessionEpoch',u."sessionEpoch"::text,'accountVersion',a.version));
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_RUNTIME_%' THEN RAISE;
 ELSIF SQLERRM='PAPER_CONFIGURATION_OWNERSHIP' THEN RAISE EXCEPTION 'PAPER_RUNTIME_OWNERSHIP';
 ELSE RAISE EXCEPTION 'PAPER_RUNTIME_CORRUPT'; END IF;
END $$;
CREATE FUNCTION ctp_paper.runtime_receipt(e ctp_paper.runtime_observation,replayed boolean) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',e.id::text,'owner',jsonb_build_object('tenantId',e.tenant_id::text,'accountId',e.account_id::text,'mode','PAPER'),
  'configurationId',e.configuration_id::text,'revision',e.revision::text,'hash',encode(e.hash,'hex'),'publishedAt',e.published_at,'replayed',replayed)
$$;

CREATE FUNCTION ctp_paper.read_runtime_observation_context(o jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; BEGIN
 IF NOT coalesce(ctp_paper.valid_runtime_observation_runtime('OBSERVER'),false) THEN RAISE EXCEPTION 'PAPER_RUNTIME_ROLE_UNSAFE'; END IF;
 IF o IS NULL OR octet_length(o::text)>512 THEN RAISE EXCEPTION 'PAPER_RUNTIME_INPUT'; END IF;
 ctx:=ctp_paper.runtime_context(o);
 RETURN ctx||jsonb_build_object('kind','PAPER_RUNTIME_CONTEXT','owner',o,'asOf',floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
END $$;

CREATE FUNCTION ctp_paper.publish_runtime_observation(t text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; o jsonb; owner jsonb; ctx jsonb; cfg jsonb; e ctp_paper.runtime_observation%ROWTYPE;
 h ctp_paper.runtime_observation_head%ROWTYPE; previous ctp_paper.runtime_observation%ROWTYPE;
 revision bigint; ts bigint; age integer; k text; f jsonb; old_fact jsonb;
BEGIN
 IF NOT coalesce(ctp_paper.valid_runtime_observation_runtime('OBSERVER'),false) THEN RAISE EXCEPTION 'PAPER_RUNTIME_ROLE_UNSAFE'; END IF;
 IF t IS NULL OR octet_length(t)>16384 THEN RAISE EXCEPTION 'PAPER_RUNTIME_INPUT'; END IF;
 p:=t::jsonb;
 IF NOT coalesce(ctp_paper.valid_runtime_publication(p),false) THEN RAISE EXCEPTION 'PAPER_RUNTIME_INPUT'; END IF;
 o:=p->'observation'; owner:=o->'owner'; ctx:=ctp_paper.runtime_context(owner);
 cfg:=(ctx->'configuration'->>'receiptText')::jsonb;
 IF o->>'configurationId' IS DISTINCT FROM cfg->'configuration'->>'id'
 OR o->>'configurationHash' IS DISTINCT FROM ctx->'configuration'->>'hash'
 THEN RAISE EXCEPTION 'PAPER_RUNTIME_CONFLICT'; END IF;
 SELECT * INTO e FROM ctp_paper.runtime_observation WHERE id=(p->>'id')::uuid;
 IF FOUND THEN
  IF e.payload IS DISTINCT FROM t THEN RAISE EXCEPTION 'PAPER_RUNTIME_CONFLICT'; END IF;
  IF NOT coalesce(ctp_paper.checked_runtime_event(e),false) THEN RAISE EXCEPTION 'PAPER_RUNTIME_CORRUPT'; END IF;
  RETURN ctp_paper.runtime_receipt(e,true);
 END IF;
 IF o->>'permissionEpoch' IS DISTINCT FROM ctx->'current'->>'permissionEpoch'
 OR o->>'userSessionEpoch' IS DISTINCT FROM ctx->'current'->>'userSessionEpoch'
 OR o->'accountVersion' IS DISTINCT FROM ctx->'current'->'accountVersion'
 THEN RAISE EXCEPTION 'PAPER_RUNTIME_EPOCH'; END IF;
 SELECT * INTO h FROM ctp_paper.runtime_observation_head
 WHERE tenant_id=(owner->>'tenantId')::uuid AND account_id=(owner->>'accountId')::uuid FOR UPDATE;
 IF FOUND THEN
  IF h.revision=9223372036854775807 THEN RAISE EXCEPTION 'PAPER_RUNTIME_CAPACITY'; END IF;
  IF (p->>'expectedRevision')::bigint<>h.revision THEN RAISE EXCEPTION 'PAPER_RUNTIME_CONFLICT'; END IF;
  SELECT * INTO previous FROM ctp_paper.runtime_observation WHERE id=h.id;
  IF NOT FOUND OR previous.configuration_id<>h.configuration_id OR previous.revision<>h.revision
  OR NOT coalesce(ctp_paper.checked_runtime_event(previous),false) THEN RAISE EXCEPTION 'PAPER_RUNTIME_CORRUPT'; END IF;
  IF (o->>'permissionEpoch')::numeric<(previous.payload::jsonb->'observation'->>'permissionEpoch')::numeric
  OR (o->>'userSessionEpoch')::numeric<(previous.payload::jsonb->'observation'->>'userSessionEpoch')::numeric
  OR (o->>'accountVersion')::numeric<(previous.payload::jsonb->'observation'->>'accountVersion')::numeric
  THEN RAISE EXCEPTION 'PAPER_RUNTIME_EPOCH'; END IF;
  revision:=h.revision+1;
 ELSE
  IF p->>'expectedRevision'<>'0' THEN RAISE EXCEPTION 'PAPER_RUNTIME_CONFLICT'; END IF;
  revision:=1;
 END IF;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 age:=least(5000,(cfg->'configuration'->'model'->>'maxEvidenceAgeMs')::integer);
 FOREACH k IN ARRAY ARRAY['database','limiter','authentication','publicMarket','executor','clock','latency','rejectRate','maintenance'] LOOP
  f:=o->'health'->k;
  IF (f->>'asOf')::bigint<(cfg->>'createdAt')::bigint OR (f->>'asOf')::bigint>ts OR ts-(f->>'asOf')::bigint>age
  THEN RAISE EXCEPTION 'PAPER_RUNTIME_STALE'; END IF;
  IF previous.id IS NOT NULL THEN
   old_fact:=previous.payload::jsonb->'observation'->'health'->k;
   IF (f->>'asOf')::bigint<(old_fact->>'asOf')::bigint
   OR ((f->>'asOf')::bigint=(old_fact->>'asOf')::bigint AND f IS DISTINCT FROM old_fact)
   THEN RAISE EXCEPTION 'PAPER_RUNTIME_ORDERING'; END IF;
  END IF;
 END LOOP;
 INSERT INTO ctp_paper.runtime_observation(id,tenant_id,account_id,configuration_id,revision,payload,hash,published_at)
 VALUES((p->>'id')::uuid,(owner->>'tenantId')::uuid,(owner->>'accountId')::uuid,(o->>'configurationId')::uuid,revision,t,sha256(convert_to(t,'UTF8')),ts) RETURNING * INTO e;
 INSERT INTO ctp_paper.runtime_observation_head(tenant_id,account_id,configuration_id,revision,id)
 VALUES(e.tenant_id,e.account_id,e.configuration_id,e.revision,e.id)
 ON CONFLICT(tenant_id,account_id) DO UPDATE SET revision=EXCLUDED.revision,id=EXCLUDED.id;
 RETURN ctp_paper.runtime_receipt(e,false);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'PAPER_RUNTIME_CONFLICT';
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_RUNTIME_INPUT';
END $$;

CREATE FUNCTION ctp_paper.lookup_runtime_observation(x jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; e ctp_paper.runtime_observation%ROWTYPE; h ctp_paper.runtime_observation_head%ROWTYPE; BEGIN
 IF NOT coalesce(ctp_paper.valid_runtime_observation_runtime('OBSERVER'),false) THEN RAISE EXCEPTION 'PAPER_RUNTIME_ROLE_UNSAFE'; END IF;
 IF x IS NULL OR octet_length(x::text)>1024 OR NOT coalesce(ctp_market.snapshot_keys(x,ARRAY['owner','id']),false)
 OR jsonb_typeof(x->'id') NOT IN('string','null')
 OR (jsonb_typeof(x->'id')='string' AND (length(x->>'id')<>36 OR x->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
 THEN RAISE EXCEPTION 'PAPER_RUNTIME_INPUT'; END IF;
 ctx:=ctp_paper.runtime_context(x->'owner');
 IF jsonb_typeof(x->'id')='null' THEN
  SELECT * INTO h FROM ctp_paper.runtime_observation_head
   WHERE tenant_id=(x->'owner'->>'tenantId')::uuid AND account_id=(x->'owner'->>'accountId')::uuid FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO e FROM ctp_paper.runtime_observation WHERE id=h.id;
  IF NOT FOUND OR e.revision<>h.revision OR e.configuration_id<>h.configuration_id THEN RAISE EXCEPTION 'PAPER_RUNTIME_CORRUPT'; END IF;
 ELSE
  SELECT * INTO e FROM ctp_paper.runtime_observation WHERE id=(x->>'id')::uuid
   AND tenant_id=(x->'owner'->>'tenantId')::uuid AND account_id=(x->'owner'->>'accountId')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 IF NOT coalesce(ctp_paper.checked_runtime_event(e),false)
 OR e.configuration_id::text IS DISTINCT FROM (ctx->'configuration'->>'receiptText')::jsonb->'configuration'->>'id'
 THEN RAISE EXCEPTION 'PAPER_RUNTIME_CORRUPT'; END IF;
 RETURN ctp_paper.runtime_receipt(e,true);
END $$;
CREATE FUNCTION ctp_paper.capture_runtime_observation(o jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; e ctp_paper.runtime_observation%ROWTYPE; h ctp_paper.runtime_observation_head%ROWTYPE; p jsonb; result jsonb; BEGIN
 IF NOT coalesce(ctp_paper.valid_runtime_observation_runtime('READER'),false) THEN RAISE EXCEPTION 'PAPER_RUNTIME_ROLE_UNSAFE'; END IF;
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

REVOKE ALL ON ctp_paper.runtime_observation,ctp_paper.runtime_observation_seal,ctp_paper.runtime_observation_head FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_paper.valid_runtime_observation_runtime(text),ctp_paper.runtime_epoch(jsonb,bigint),ctp_paper.valid_runtime_publication(jsonb),
 ctp_paper.valid_runtime_row(ctp_paper.runtime_observation),ctp_paper.seal_runtime_observation(),ctp_paper.runtime_head_monotonic(),
 ctp_paper.checked_runtime_event(ctp_paper.runtime_observation),ctp_paper.runtime_context(jsonb),ctp_paper.runtime_receipt(ctp_paper.runtime_observation,boolean),
 ctp_paper.publish_runtime_observation(text),ctp_paper.lookup_runtime_observation(jsonb),ctp_paper.capture_runtime_observation(jsonb),ctp_paper.read_runtime_observation_context(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.publish_runtime_observation(text),ctp_paper.lookup_runtime_observation(jsonb),ctp_paper.read_runtime_observation_context(jsonb) TO ctp_paper_runtime_observer;
GRANT EXECUTE ON FUNCTION ctp_paper.capture_runtime_observation(jsonb) TO ctp_paper_runtime_reader;
COMMIT;

