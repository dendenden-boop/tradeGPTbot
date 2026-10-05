BEGIN;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['ctp_risk_policy_operator','ctp_risk_policy_controller'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r); END IF;
END LOOP; END $$;
GRANT USAGE ON SCHEMA ctp_risk TO ctp_risk_policy_operator,ctp_risk_policy_controller;

CREATE TABLE ctp_risk.policy_revision (
 scope text NOT NULL CHECK(scope IN('PLATFORM','USER')), target uuid NOT NULL, "tenantId" uuid REFERENCES public."user"(id),
 mode public."TradingMode" NOT NULL, version bigint NOT NULL CHECK(version>0), id uuid NOT NULL,
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=8192), "limitsText" text NOT NULL CHECK(octet_length("limitsText")<=4096),
 "limitsHash" bytea NOT NULL CHECK("limitsHash"=sha256(convert_to("limitsText",'UTF8'))),
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((scope='PLATFORM' AND target='00000000-0000-0000-0000-000000000000' AND "tenantId" IS NULL) OR (scope='USER' AND target="tenantId" AND "tenantId" IS NOT NULL)),
 PRIMARY KEY(scope,target,mode,version), UNIQUE(scope,target,id), UNIQUE(scope,target,mode,version,id)
);
CREATE TABLE ctp_risk.policy_head (
 scope text NOT NULL, target uuid NOT NULL, "tenantId" uuid REFERENCES public."user"(id), mode public."TradingMode" NOT NULL,
 version bigint NOT NULL CHECK(version>0), id uuid NOT NULL,
 CHECK((scope='PLATFORM' AND target='00000000-0000-0000-0000-000000000000' AND "tenantId" IS NULL) OR (scope='USER' AND target="tenantId" AND "tenantId" IS NOT NULL)),
 PRIMARY KEY(scope,target,mode), FOREIGN KEY(scope,target,mode,version,id) REFERENCES ctp_risk.policy_revision(scope,target,mode,version,id)
);
CREATE TRIGGER risk_policy_revision_immutable BEFORE UPDATE OR DELETE ON ctp_risk.policy_revision FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE FUNCTION ctp_risk.monotonic_policy_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RISK_POLICY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'version'-'id') IS DISTINCT FROM (to_jsonb(OLD)-'version'-'id') OR NEW.version::numeric<>OLD.version::numeric+1 THEN RAISE EXCEPTION 'RISK_POLICY_VERSION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER risk_policy_head_monotonic BEFORE UPDATE OR DELETE ON ctp_risk.policy_head FOR EACH ROW EXECUTE FUNCTION ctp_risk.monotonic_policy_head();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['policy_revision','policy_head'] LOOP
 EXECUTE format('ALTER TABLE ctp_risk.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE ctp_risk.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY risk_policy_tenant ON ctp_risk.%I USING (scope=''PLATFORM'' OR "tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (scope=''PLATFORM'' OR "tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
END LOOP; END $$;

-- Independent SQL validation protects callers that bypass the TypeScript publisher.
CREATE FUNCTION ctp_risk.valid_limits(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE k text; keys text[]:=ARRAY['valuationAsset','maxOrderNotional','maxInstrumentExposure','maxAssetExposure','maxAccountExposure','maxUserExposure','maxConcurrentPositions','maxOpenOrders','maxLeverage','maxDailyRealizedLoss','maxDailyTotalLoss','maxDrawdownRate','maxOrdersPerMinute','minAvailableBalance','maxPriceDeviationRate','maxSpreadRate','minLiquidityNotional','maxEvidenceAgeMs']; BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& keys) OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) THEN RETURN false; END IF;
 IF jsonb_typeof(p->'valuationAsset') IS DISTINCT FROM 'string' OR length(p->>'valuationAsset') NOT BETWEEN 1 AND 128 OR p->>'valuationAsset' ~ '[[:space:][:cntrl:]]' THEN RETURN false; END IF;
 FOREACH k IN ARRAY keys LOOP
  IF k='valuationAsset' THEN CONTINUE; END IF;
  IF k IN('maxConcurrentPositions','maxOpenOrders','maxOrdersPerMinute','maxEvidenceAgeMs') THEN
   IF jsonb_typeof(p->k) IS DISTINCT FROM 'number' OR p->>k !~ '^(0|[1-9][0-9]{0,6})$' OR (p->>k)::numeric>1000000 THEN RETURN false; END IF;
   IF k='maxEvidenceAgeMs' AND (p->>k)::numeric NOT BETWEEN 1 AND 5000 THEN RETURN false; END IF;
  ELSE
   IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{0,17}[1-9])?$' THEN RETURN false; END IF;
   IF k='maxLeverage' AND ((p->>k)::numeric<=0 OR length(split_part(p->>k,'.',1))>20) THEN RETURN false; END IF;
   IF k IN('maxDrawdownRate','maxPriceDeviationRate','maxSpreadRate') AND (p->>k)::numeric>1 THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_risk.valid_policy_update(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>7 OR NOT(p ?& ARRAY['scope','mode','eventId','expectedVersion','reason','limitsText','limitsHash']) OR octet_length(p::text)>8192 THEN RETURN false; END IF;
 IF NOT(SELECT bool_and(jsonb_typeof(p->k)='string') FROM unnest(ARRAY['mode','eventId','expectedVersion','reason','limitsText','limitsHash'])k) THEN RETURN false; END IF;
 IF p->>'mode' NOT IN('PAPER','TESTNET','DEMO','LIVE') OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,18})$' OR (p->>'expectedVersion')::numeric>=9223372036854775807 OR p->>'eventId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR p->>'reason' !~ '^[A-Z][A-Z0-9_]{0,63}$' OR p->>'limitsHash' !~ '^[a-f0-9]{64}$' OR octet_length(p->>'limitsText')>4096 THEN RETURN false; END IF;
 IF decode(p->>'limitsHash','hex')<>sha256(convert_to(p->>'limitsText','UTF8')) OR NOT ctp_risk.valid_limits((p->>'limitsText')::jsonb) THEN RETURN false; END IF;
 RETURN jsonb_typeof(p->'scope')='object';
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_risk.valid_policy_publisher(expected text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT session_user=current_user OR (
  EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
  AND pg_has_role(session_user,expected,'MEMBER')
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND (r.rolname<>expected OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication) AND pg_has_role(session_user,r.oid,'MEMBER'))
 )
$$;

-- Internal writer has no grant; authority-specific entry points validate scope before invoking it.
CREATE FUNCTION ctp_risk.write_policy(p jsonb,s text,t uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old ctp_risk.policy_revision; v bigint; BEGIN
 SELECT * INTO old FROM ctp_risk.policy_revision WHERE scope=s AND target=t AND id=(p->>'eventId')::uuid;
 IF FOUND THEN
  IF old.payload<>p THEN RAISE EXCEPTION 'RISK_POLICY_CONFLICT'; END IF;
  RETURN jsonb_build_object('version',old.version::text,'eventId',old.id::text,'replayed',true);
 END IF;
 SELECT version INTO v FROM ctp_risk.policy_head WHERE scope=s AND target=t AND mode=(p->>'mode')::public."TradingMode";
 IF COALESCE(v,0)<>(p->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'RISK_POLICY_STALE'; END IF;
 v:=COALESCE(v,0)+1;
 INSERT INTO ctp_risk.policy_revision(scope,target,"tenantId",mode,version,id,payload,"limitsText","limitsHash") VALUES(s,t,CASE WHEN s='USER' THEN t END,(p->>'mode')::public."TradingMode",v,(p->>'eventId')::uuid,p,p->>'limitsText',decode(p->>'limitsHash','hex'));
 INSERT INTO ctp_risk.policy_head(scope,target,"tenantId",mode,version,id) VALUES(s,t,CASE WHEN s='USER' THEN t END,(p->>'mode')::public."TradingMode",v,(p->>'eventId')::uuid) ON CONFLICT(scope,target,mode) DO UPDATE SET version=EXCLUDED.version,id=EXCLUDED.id;
 RETURN jsonb_build_object('version',v::text,'eventId',p->>'eventId','replayed',false);
END $$;
CREATE FUNCTION ctp_risk.update_platform_policy(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT ctp_risk.valid_policy_update(p) OR p->'scope'<>'{"kind":"PLATFORM"}'::jsonb THEN RAISE EXCEPTION 'RISK_POLICY_INPUT'; END IF;
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_policy_operator') THEN RAISE EXCEPTION 'RISK_POLICY_ROLE_UNSAFE'; END IF;
 PERFORM pg_advisory_xact_lock(1129599058,12);
 RETURN ctp_risk.write_policy(p,'PLATFORM','00000000-0000-0000-0000-000000000000');
END $$;
CREATE FUNCTION ctp_risk.update_user_policy(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; BEGIN
 IF NOT ctp_risk.valid_policy_update(p) OR (SELECT count(*) FROM jsonb_object_keys(p->'scope'))<>2 OR NOT(p->'scope' ?& ARRAY['kind','tenantId']) OR p->'scope'->>'kind' IS DISTINCT FROM 'USER' THEN RAISE EXCEPTION 'RISK_POLICY_INPUT'; END IF;
 t:=(p->'scope'->>'tenantId')::uuid;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid OR NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t) THEN RAISE EXCEPTION 'RISK_POLICY_SCOPE'; END IF;
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_policy_controller') THEN RAISE EXCEPTION 'RISK_POLICY_ROLE_UNSAFE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 RETURN ctp_risk.write_policy(p,'USER',t);
END $$;
CREATE FUNCTION ctp_risk.policy_json(r ctp_risk.policy_revision) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('scope',CASE WHEN r.scope='PLATFORM' THEN '{"kind":"PLATFORM"}'::jsonb ELSE jsonb_build_object('kind','USER','tenantId',r."tenantId"::text) END,'mode',r.mode::text,'version',r.version::text,'eventId',r.id::text,'limits',r."limitsText"::jsonb,'limitsHash',encode(r."limitsHash",'hex')) $$;
CREATE FUNCTION ctp_risk.read_platform_policy(m text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r ctp_risk.policy_revision; BEGIN
 IF m NOT IN('PAPER','TESTNET','DEMO','LIVE') THEN RAISE EXCEPTION 'RISK_POLICY_INPUT'; END IF;
 IF NOT(ctp_risk.valid_policy_publisher('ctp_risk_policy_operator') OR ctp_risk.valid_policy_publisher('ctp_risk_policy_controller')) THEN RAISE EXCEPTION 'RISK_POLICY_ROLE_UNSAFE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 SELECT v.* INTO r FROM ctp_risk.policy_revision v JOIN ctp_risk.policy_head h USING(scope,target,mode,version,id) WHERE h.scope='PLATFORM' AND h.mode=m::public."TradingMode";
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_POLICY_MISSING'; END IF;
 RETURN ctp_risk.policy_json(r);
END $$;
CREATE FUNCTION ctp_risk.read_current_policy(t uuid,m text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE platform jsonb; r ctp_risk.policy_revision; BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid OR NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t) THEN RAISE EXCEPTION 'RISK_POLICY_SCOPE'; END IF;
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_policy_controller') THEN RAISE EXCEPTION 'RISK_POLICY_ROLE_UNSAFE'; END IF;
 platform:=ctp_risk.read_platform_policy(m);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:risk:'||t::text,0));
 SELECT v.* INTO r FROM ctp_risk.policy_revision v JOIN ctp_risk.policy_head h USING(scope,target,mode,version,id) WHERE h.scope='USER' AND h.target=t AND h.mode=m::public."TradingMode";
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_POLICY_MISSING'; END IF;
 IF platform->'limits'->>'valuationAsset'<>r."limitsText"::jsonb->>'valuationAsset' THEN RAISE EXCEPTION 'RISK_POLICY_CURRENCY'; END IF;
 RETURN jsonb_build_array(platform,ctp_risk.policy_json(r));
END $$;
REVOKE ALL ON ctp_risk.policy_revision,ctp_risk.policy_head FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_risk.monotonic_policy_head(),ctp_risk.valid_limits(jsonb),ctp_risk.valid_policy_update(jsonb),ctp_risk.valid_policy_publisher(text),ctp_risk.write_policy(jsonb,text,uuid),ctp_risk.policy_json(ctp_risk.policy_revision),ctp_risk.update_platform_policy(jsonb),ctp_risk.update_user_policy(jsonb),ctp_risk.read_platform_policy(text),ctp_risk.read_current_policy(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_risk.update_platform_policy(jsonb),ctp_risk.read_platform_policy(text) TO ctp_risk_policy_operator;
GRANT EXECUTE ON FUNCTION ctp_risk.update_user_policy(jsonb),ctp_risk.read_current_policy(uuid,text) TO ctp_risk_policy_controller;
-- No default policy: deployment remains paused and missing policy remains a denial.
COMMIT;
