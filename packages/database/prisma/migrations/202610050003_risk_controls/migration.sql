BEGIN;
DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['ctp_risk_control','ctp_risk_operator'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name); END IF;
END LOOP; END $$;
CREATE SCHEMA ctp_risk;
REVOKE ALL ON SCHEMA ctp_risk FROM PUBLIC;
GRANT USAGE ON SCHEMA ctp_risk TO ctp_risk_control,ctp_risk_operator,ctp_execution;
CREATE TABLE ctp_risk.global_head (
 kind text NOT NULL, key text NOT NULL, state text NOT NULL, epoch bigint NOT NULL CHECK(epoch>0),
 PRIMARY KEY(kind,key), CHECK(key ~ '^[a-z][a-z0-9_]{0,63}$'),
 CHECK((kind='KILL_SWITCH' AND key='kill' AND state IN('PAUSED','RUNNING')) OR (kind='CIRCUIT' AND state IN('OPEN','CLOSED','HALF_OPEN')))
);
CREATE TABLE ctp_risk.global_event (
 id uuid PRIMARY KEY, payload jsonb NOT NULL CHECK(octet_length(payload::text)<=4096), epoch bigint NOT NULL CHECK(epoch>0), "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ctp_risk.tenant_head (
 "tenantId" uuid NOT NULL REFERENCES public."user"(id), scope text NOT NULL CHECK(scope IN('USER','CONNECTION','STRATEGY')),
 target uuid NOT NULL, "connectionId" uuid, "strategyId" uuid,
 kind text NOT NULL, key text NOT NULL, state text NOT NULL, epoch bigint NOT NULL CHECK(epoch>0),
 PRIMARY KEY("tenantId",scope,target,kind,key), CHECK(key ~ '^[a-z][a-z0-9_]{0,63}$'),
 CHECK((scope='USER' AND target="tenantId" AND "connectionId" IS NULL AND "strategyId" IS NULL) OR (scope='CONNECTION' AND "connectionId"=target AND "connectionId" IS NOT NULL AND "strategyId" IS NULL) OR (scope='STRATEGY' AND "strategyId"=target AND "strategyId" IS NOT NULL AND "connectionId" IS NULL)),
 CHECK((kind='KILL_SWITCH' AND key='kill' AND state IN('PAUSED','RUNNING')) OR (kind='CIRCUIT' AND state IN('OPEN','CLOSED','HALF_OPEN'))),
 FOREIGN KEY("tenantId","connectionId") REFERENCES public.exchange_connection("tenantId",id),
 FOREIGN KEY("tenantId","strategyId") REFERENCES public.strategy_instance("tenantId",id)
);
CREATE TABLE ctp_risk.tenant_event (
 "tenantId" uuid NOT NULL REFERENCES public."user"(id), id uuid NOT NULL, payload jsonb NOT NULL CHECK(octet_length(payload::text)<=4096), epoch bigint NOT NULL CHECK(epoch>0), "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY("tenantId",id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['tenant_head','tenant_event'] LOOP
 EXECUTE format('ALTER TABLE ctp_risk.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE ctp_risk.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY risk_control_tenant ON ctp_risk.%I USING ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
END LOOP; END $$;
CREATE TRIGGER risk_global_event_immutable BEFORE UPDATE OR DELETE ON ctp_risk.global_event FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER risk_tenant_event_immutable BEFORE UPDATE OR DELETE ON ctp_risk.tenant_event FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE FUNCTION ctp_risk.monotonic_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RISK_CONTROL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'state'-'epoch') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'epoch') OR NEW.epoch::numeric<>OLD.epoch::numeric+1 THEN RAISE EXCEPTION 'RISK_CONTROL_EPOCH' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER risk_global_head_monotonic BEFORE UPDATE OR DELETE ON ctp_risk.global_head FOR EACH ROW EXECUTE FUNCTION ctp_risk.monotonic_head();
CREATE TRIGGER risk_tenant_head_monotonic BEFORE UPDATE OR DELETE ON ctp_risk.tenant_head FOR EACH ROW EXECUTE FUNCTION ctp_risk.monotonic_head();
CREATE FUNCTION ctp_risk.valid_update(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(p)='object' AND (SELECT count(*) FROM jsonb_object_keys(p))=8
 AND p ?& ARRAY['scope','kind','key','state','eventId','expectedEpoch','reason','evidenceHash']
 AND (SELECT bool_and(jsonb_typeof(p->k)='string') FROM unnest(ARRAY['kind','key','state','eventId','expectedEpoch','reason','evidenceHash'])k)
 AND p->>'kind' IN('KILL_SWITCH','CIRCUIT') AND p->>'key' ~ '^[a-z][a-z0-9_]{0,63}$'
 AND ((p->>'kind'='KILL_SWITCH' AND p->>'key'='kill' AND p->>'state' IN('RUNNING','PAUSED')) OR (p->>'kind'='CIRCUIT' AND p->>'state' IN('OPEN','CLOSED','HALF_OPEN')))
 AND p->>'expectedEpoch' ~ '^(0|[1-9][0-9]{0,18})$' AND (p->>'expectedEpoch')::numeric<9223372036854775807
 AND p->>'reason' ~ '^[A-Z][A-Z0-9_]{0,63}$' AND p->>'evidenceHash' ~ '^[a-f0-9]{64}$'
 AND p->>'eventId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 AND jsonb_typeof(p->'scope')='object',false)
$$;
-- All functions are SQL-owned. Controller roles have no direct table privileges.
CREATE FUNCTION ctp_risk.update_global(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_event ctp_risk.global_event; e bigint; BEGIN
 IF NOT ctp_risk.valid_update(p) OR p->'scope'<>'{"kind":"GLOBAL"}'::jsonb THEN RAISE EXCEPTION 'RISK_CONTROL_INPUT'; END IF;
 PERFORM pg_advisory_xact_lock(1129599058,12);
 SELECT * INTO old_event FROM ctp_risk.global_event WHERE id=(p->>'eventId')::uuid;
 IF FOUND THEN IF old_event.payload<>p THEN RAISE EXCEPTION 'RISK_CONTROL_CONFLICT'; END IF; RETURN jsonb_build_object('epoch',old_event.epoch::text,'state',old_event.payload->>'state','replayed',true); END IF;
 SELECT epoch INTO e FROM ctp_risk.global_head WHERE kind=p->>'kind' AND key=p->>'key';
 IF COALESCE(e,0)<>(p->>'expectedEpoch')::bigint THEN RAISE EXCEPTION 'RISK_CONTROL_STALE'; END IF;
 e:=COALESCE(e,0)+1;
 INSERT INTO ctp_risk.global_event(id,payload,epoch) VALUES((p->>'eventId')::uuid,p,e);
 INSERT INTO ctp_risk.global_head(kind,key,state,epoch) VALUES(p->>'kind',p->>'key',p->>'state',e) ON CONFLICT(kind,key) DO UPDATE SET state=EXCLUDED.state,epoch=EXCLUDED.epoch;
 RETURN jsonb_build_object('epoch',e::text,'state',p->>'state','replayed',false);
END $$;
CREATE FUNCTION ctp_risk.update_tenant(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; s text; target_id uuid; old_event ctp_risk.tenant_event; e bigint; BEGIN
 IF NOT ctp_risk.valid_update(p) OR (SELECT count(*) FROM jsonb_object_keys(p->'scope'))<>3 OR NOT (p->'scope' ?& ARRAY['kind','tenantId','targetId']) THEN RAISE EXCEPTION 'RISK_CONTROL_INPUT'; END IF;
 t:=(p->'scope'->>'tenantId')::uuid; s:=p->'scope'->>'kind'; target_id:=(p->'scope'->>'targetId')::uuid;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid OR NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t) OR s NOT IN('USER','CONNECTION','STRATEGY') OR (s='USER' AND target_id<>t) OR (s='CONNECTION' AND NOT EXISTS(SELECT 1 FROM public.exchange_connection WHERE "tenantId"=t AND id=target_id)) OR (s='STRATEGY' AND NOT EXISTS(SELECT 1 FROM public.strategy_instance WHERE "tenantId"=t AND id=target_id)) THEN RAISE EXCEPTION 'RISK_CONTROL_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 SELECT * INTO old_event FROM ctp_risk.tenant_event WHERE "tenantId"=t AND id=(p->>'eventId')::uuid;
 IF FOUND THEN IF old_event.payload<>p THEN RAISE EXCEPTION 'RISK_CONTROL_CONFLICT'; END IF; RETURN jsonb_build_object('epoch',old_event.epoch::text,'state',old_event.payload->>'state','replayed',true); END IF;
 SELECT epoch INTO e FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope=s AND target=target_id AND kind=p->>'kind' AND key=p->>'key';
 IF COALESCE(e,0)<>(p->>'expectedEpoch')::bigint THEN RAISE EXCEPTION 'RISK_CONTROL_STALE'; END IF;
 e:=COALESCE(e,0)+1;
 INSERT INTO ctp_risk.tenant_event("tenantId",id,payload,epoch) VALUES(t,(p->>'eventId')::uuid,p,e);
 INSERT INTO ctp_risk.tenant_head("tenantId",scope,target,"connectionId","strategyId",kind,key,state,epoch) VALUES(t,s,target_id,CASE WHEN s='CONNECTION' THEN target_id END,CASE WHEN s='STRATEGY' THEN target_id END,p->>'kind',p->>'key',p->>'state',e) ON CONFLICT("tenantId",scope,target,kind,key) DO UPDATE SET state=EXCLUDED.state,epoch=EXCLUDED.epoch;
 RETURN jsonb_build_object('epoch',e::text,'state',p->>'state','replayed',false);
END $$;
CREATE FUNCTION ctp_risk.dispatch_gate(t uuid, connection_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid OR NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t) OR (connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exchange_connection WHERE "tenantId"=t AND id=connection_id)) THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:risk:'||t::text,0));
 RETURN EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill' AND state='RUNNING')
 AND NOT EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE state NOT IN('RUNNING','CLOSED'))
 AND NOT EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND state NOT IN('RUNNING','CLOSED') AND (scope IN('USER','STRATEGY') OR (scope='CONNECTION' AND target=connection_id)))
 AND NOT EXISTS(SELECT 1 FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.circuit_state WHERE "tenantId"=t AND status<>'CLOSED');
END $$;
CREATE FUNCTION ctp_risk.read_global() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY kind,key),'[]'::jsonb) FROM (SELECT * FROM ctp_risk.global_head ORDER BY kind,key LIMIT 10001)h $$;
-- Compatibility blockers also participate in the same permit ordering.
CREATE FUNCTION ctp_risk.lock_legacy_control() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; BEGIN
 IF TG_OP='UPDATE' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN RAISE EXCEPTION 'RISK_CONTROL_SCOPE' USING ERRCODE='23514'; END IF;
 t:=CASE WHEN TG_OP='DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER risk_legacy_pause_gate BEFORE INSERT OR UPDATE OR DELETE ON public.trading_pause FOR EACH ROW EXECUTE FUNCTION ctp_risk.lock_legacy_control();
CREATE TRIGGER risk_legacy_circuit_gate BEFORE INSERT OR UPDATE OR DELETE ON public.circuit_state FOR EACH ROW EXECUTE FUNCTION ctp_risk.lock_legacy_control();
CREATE FUNCTION ctp_risk.read_tenant(t uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid OR NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t) THEN RAISE EXCEPTION 'RISK_CONTROL_SCOPE'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind',scope,'tenantId',"tenantId"::text,'targetId',target::text),'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY scope,target,kind,key) FROM (SELECT * FROM ctp_risk.tenant_head WHERE "tenantId"=t ORDER BY scope,target,kind,key LIMIT 10001)h),'[]'::jsonb);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA ctp_risk FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ctp_risk FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_risk.update_global(jsonb),ctp_risk.read_global() TO ctp_risk_operator;
GRANT EXECUTE ON FUNCTION ctp_risk.update_tenant(jsonb),ctp_risk.read_tenant(uuid),ctp_risk.read_global() TO ctp_risk_control;
GRANT EXECUTE ON FUNCTION ctp_risk.dispatch_gate(uuid,uuid) TO ctp_execution;
INSERT INTO ctp_risk.global_head(kind,key,state,epoch) VALUES('KILL_SWITCH','kill','PAUSED',1);
INSERT INTO ctp_risk.global_event(id,payload,epoch) VALUES('00000000-0000-4000-8000-000000000012','{"scope":{"kind":"GLOBAL"},"kind":"KILL_SWITCH","key":"kill","state":"PAUSED","eventId":"00000000-0000-4000-8000-000000000012","expectedEpoch":"0","reason":"DEPLOYMENT_PAUSE","evidenceHash":"0000000000000000000000000000000000000000000000000000000000000000"}',1);
COMMIT;
