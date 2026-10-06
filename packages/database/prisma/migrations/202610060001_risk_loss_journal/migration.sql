BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_risk_evidence_collector') THEN CREATE ROLE ctp_risk_evidence_collector NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;
GRANT USAGE ON SCHEMA ctp_risk TO ctp_risk_evidence_collector;
CREATE TABLE ctp_risk.loss_batch (
 "tenantId" uuid NOT NULL REFERENCES public."user"(id), id uuid NOT NULL, mode public."TradingMode" NOT NULL,
 asset text NOT NULL CHECK(octet_length(asset) BETWEEN 1 AND 128), day bigint NOT NULL CHECK(day>=0 AND day%86400000=0),
 sequence bigint NOT NULL CHECK(sequence>0), payload jsonb NOT NULL CHECK(octet_length(payload::text)<=262144),
 checkpoint text NOT NULL CHECK(octet_length(checkpoint)<=8192), hash bytea NOT NULL CHECK(hash=sha256(convert_to(checkpoint,'UTF8'))),
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY("tenantId",id),
 UNIQUE("tenantId",mode,asset,day,sequence,id)
);
CREATE TABLE ctp_risk.loss_head (
 "tenantId" uuid NOT NULL, mode public."TradingMode" NOT NULL, asset text NOT NULL, day bigint NOT NULL,
 sequence bigint NOT NULL, id uuid NOT NULL,
 PRIMARY KEY("tenantId",mode,asset,day), FOREIGN KEY("tenantId",mode,asset,day,sequence,id) REFERENCES ctp_risk.loss_batch("tenantId",mode,asset,day,sequence,id)
);
CREATE TABLE ctp_risk.loss_event_identity (
 "tenantId" uuid NOT NULL, id uuid NOT NULL, batch uuid NOT NULL,
 PRIMARY KEY("tenantId",id), FOREIGN KEY("tenantId",batch) REFERENCES ctp_risk.loss_batch("tenantId",id)
);
CREATE TRIGGER loss_batch_immutable BEFORE UPDATE OR DELETE ON ctp_risk.loss_batch FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER loss_event_identity_immutable BEFORE UPDATE OR DELETE ON ctp_risk.loss_event_identity FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE FUNCTION ctp_risk.loss_head_monotonic() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'sequence'-'id') IS DISTINCT FROM (to_jsonb(OLD)-'sequence'-'id') OR NEW.sequence<=OLD.sequence THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_IMMUTABLE'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER loss_head_monotonic BEFORE UPDATE OR DELETE ON ctp_risk.loss_head FOR EACH ROW EXECUTE FUNCTION ctp_risk.loss_head_monotonic();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['loss_batch','loss_head','loss_event_identity'] LOOP
 EXECUTE format('ALTER TABLE ctp_risk.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE ctp_risk.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY loss_tenant ON ctp_risk.%I USING ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
END LOOP; END $$;

CREATE FUNCTION ctp_risk.loss_result(b ctp_risk.loss_batch) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('checkpointText',b.checkpoint,'hash',encode(b.hash,'hex')) $$;
CREATE FUNCTION ctp_risk.loss_number(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT COALESCE(jsonb_typeof(v)='number' AND v::text ~ '^(0|[1-9][0-9]{0,15})$' AND v::text::numeric<=9007199254740991,false) $$;
CREATE FUNCTION ctp_risk.loss_money(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT COALESCE(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^-?(0|[1-9][0-9]{0,29})(\.[0-9]{0,17}[1-9])?$' AND v#>>'{}'<>'-0',false) $$;
CREATE FUNCTION ctp_risk.loss_proof(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT COALESCE(jsonb_typeof(p->'sourceId')='string' AND length(p->>'sourceId')=36 AND p->>'sourceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND jsonb_typeof(p->'sourceHash')='string' AND length(p->>'sourceHash')=64 AND p->>'sourceHash' ~ '^[a-f0-9]{64}$',false) $$;
CREATE FUNCTION ctp_risk.valid_loss_input(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE e jsonb; s jsonb; c jsonb; BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>262144 OR (SELECT count(*) FROM jsonb_object_keys(p))<>8 OR NOT(p ?& ARRAY['scope','dayStart','id','expectedSequence','opening','coveredThrough','events','coverage']) THEN RETURN false; END IF;
 s:=p->'scope'; c:=p->'coverage';
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>3 OR NOT(s ?& ARRAY['tenantId','mode','valuationAsset']) OR jsonb_typeof(s->'tenantId') IS DISTINCT FROM 'string' OR length(s->>'tenantId')<>36 OR s->>'tenantId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR jsonb_typeof(s->'mode') IS DISTINCT FROM 'string' OR s->>'mode' NOT IN('PAPER','TESTNET','DEMO','LIVE') OR jsonb_typeof(s->'valuationAsset') IS DISTINCT FROM 'string' OR octet_length(s->>'valuationAsset') NOT BETWEEN 1 AND 128 OR s->>'valuationAsset' ~ '[[:space:][:cntrl:]]' THEN RETURN false; END IF;
 IF NOT ctp_risk.loss_number(p->'dayStart') OR NOT ctp_risk.loss_number(p->'coveredThrough') OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR length(p->>'id')<>36 OR p->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR jsonb_typeof(p->'expectedSequence') IS DISTINCT FROM 'string' OR length(p->>'expectedSequence')>19 OR p->>'expectedSequence' !~ '^(0|[1-9][0-9]{0,18})$' OR (p->>'expectedSequence')::numeric>=9223372036854775807 THEN RETURN false; END IF;
 IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>4 OR NOT(c ?& ARRAY['from','through','sourceId','sourceHash']) OR NOT ctp_risk.loss_proof(c) OR NOT ctp_risk.loss_number(c->'from') OR NOT ctp_risk.loss_number(c->'through') THEN RETURN false; END IF;
 IF p->'opening'<>'null'::jsonb THEN IF jsonb_typeof(p->'opening') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p->'opening'))<>4 OR NOT(p->'opening' ?& ARRAY['at','equity','sourceId','sourceHash']) OR NOT ctp_risk.loss_number(p->'opening'->'at') OR NOT ctp_risk.loss_money(p->'opening'->'equity') OR NOT ctp_risk.loss_proof(p->'opening') THEN RETURN false; END IF; END IF;
 IF jsonb_typeof(p->'events') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'events') NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p->'events') LOOP IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>4 OR NOT(e ?& ARRAY['id','at','kind','amount']) OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string' OR length(e->>'id')<>36 OR e->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR NOT ctp_risk.loss_number(e->'at') OR NOT ctp_risk.loss_money(e->'amount') OR jsonb_typeof(e->'kind') IS DISTINCT FROM 'string' OR e->>'kind' NOT IN('FLOW','REALIZED','EQUITY') THEN RETURN false; END IF; END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_risk.append_loss_batch(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; a text; d bigint; old ctp_risk.loss_batch; h ctp_risk.loss_batch; e jsonb; v bigint; last_at bigint; flows numeric:=0; realized numeric:=0; equity numeric; peak numeric; opening numeric; current_equity numeric; cp text; now_ms bigint; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_evidence_collector') THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_ROLE_UNSAFE'; END IF;
 IF ctp_risk.valid_loss_input(p) IS NOT TRUE THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_INPUT'; END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['scope','dayStart','id','expectedSequence','opening','coveredThrough','events','coverage']) OR (SELECT count(*) FROM jsonb_object_keys(p))<>8 OR octet_length(p::text)>262144 THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_INPUT'; END IF;
 IF jsonb_typeof(p->'scope') IS DISTINCT FROM 'object' OR NOT(p->'scope' ?& ARRAY['tenantId','mode','valuationAsset']) OR (SELECT count(*) FROM jsonb_object_keys(p->'scope'))<>3 OR jsonb_typeof(p->'events') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'events') NOT BETWEEN 1 AND 1000 OR jsonb_typeof(p->'coverage') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p->'coverage'))<>4 OR NOT(p->'coverage' ?& ARRAY['from','through','sourceId','sourceHash']) THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_INPUT'; END IF;
 IF jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR p->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR jsonb_typeof(p->'expectedSequence') IS DISTINCT FROM 'string' OR p->>'expectedSequence' !~ '^(0|[1-9][0-9]{0,18})$' OR (p->>'expectedSequence')::numeric>=9223372036854775807 THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_INPUT'; END IF;
 t:=(p->'scope'->>'tenantId')::uuid; m:=(p->'scope'->>'mode')::public."TradingMode"; a:=p->'scope'->>'valuationAsset'; d:=(p->>'dayStart')::bigint;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid OR NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t) THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_SCOPE'; END IF;
 IF jsonb_typeof(p->'scope'->'valuationAsset') IS DISTINCT FROM 'string' OR a IS NULL OR octet_length(a) NOT BETWEEN 1 AND 128 OR a ~ '[[:space:][:cntrl:]]' OR d<0 OR d%86400000<>0 THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_INPUT'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12); PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 SELECT * INTO old FROM ctp_risk.loss_batch WHERE "tenantId"=t AND id=(p->>'id')::uuid;
 IF FOUND THEN IF old.payload<>p THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_CONFLICT'; END IF; RETURN ctp_risk.loss_result(old); END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF (p->>'coveredThrough')::numeric<d OR (p->>'coveredThrough')::numeric>=d+86400000 OR (p->>'coveredThrough')::numeric>now_ms OR (p->>'coveredThrough')::numeric<now_ms-5000 OR (p->'coverage'->>'through')::numeric<>(p->>'coveredThrough')::numeric THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_COVERAGE'; END IF;
 IF jsonb_typeof(p->'coverage'->'sourceHash') IS DISTINCT FROM 'string' OR p->'coverage'->>'sourceHash' !~ '^[a-f0-9]{64}$' OR p->'coverage'->>'sourceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_INPUT'; END IF;
 SELECT b.* INTO h FROM ctp_risk.loss_head x JOIN ctp_risk.loss_batch b ON b."tenantId"=x."tenantId" AND b.id=x.id WHERE x."tenantId"=t AND x.mode=m AND x.asset=a AND x.day=d;
 IF COALESCE(h.sequence,0)<>(p->>'expectedSequence')::bigint THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_STALE'; END IF;
 IF h.id IS NULL THEN
  IF jsonb_typeof(p->'opening') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p->'opening'))<>4 OR NOT(p->'opening' ?& ARRAY['at','equity','sourceId','sourceHash']) OR (p->'opening'->>'at')::numeric<>d OR (p->'coverage'->>'from')::numeric<>d OR jsonb_typeof(p->'opening'->'equity') IS DISTINCT FROM 'string' OR p->'opening'->>'equity' !~ '^-?(0|[1-9][0-9]{0,29})(\.[0-9]{0,17}[1-9])?$' OR p->'opening'->>'sourceHash' !~ '^[a-f0-9]{64}$' OR p->'opening'->>'sourceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_BASELINE'; END IF;
  opening:=(p->'opening'->>'equity')::numeric; peak:=opening; current_equity:=opening; last_at:=d; v:=1;
 ELSE
  IF p->'opening'<>'null'::jsonb OR (p->'coverage'->>'from')::numeric<>(h.checkpoint::jsonb->>'coveredThrough')::numeric THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_BASELINE'; END IF;
  opening:=(h.checkpoint::jsonb->>'openingEquity')::numeric; flows:=(h.checkpoint::jsonb->>'externalFlows')::numeric; realized:=(h.checkpoint::jsonb->>'netRealized')::numeric; peak:=(h.checkpoint::jsonb->>'adjustedPeakEquity')::numeric; current_equity:=(h.checkpoint::jsonb->>'adjustedCurrentEquity')::numeric; last_at:=(h.checkpoint::jsonb->>'coveredThrough')::bigint; v:=h.sequence;
 END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p->'events') LOOP
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>4 OR NOT(e ?& ARRAY['id','at','kind','amount']) OR e->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR jsonb_typeof(e->'amount') IS DISTINCT FROM 'string' OR e->>'amount' !~ '^-?(0|[1-9][0-9]{0,29})(\.[0-9]{0,17}[1-9])?$' OR e->>'amount'='-0' OR e->>'kind' NOT IN('FLOW','REALIZED','EQUITY') OR (e->>'at')::numeric<last_at OR (e->>'at')::numeric>(p->>'coveredThrough')::numeric OR (e->>'at')::numeric<>trunc((e->>'at')::numeric) THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_INPUT'; END IF;
  IF EXISTS(SELECT 1 FROM ctp_risk.loss_event_identity WHERE "tenantId"=t AND id=(e->>'id')::uuid) THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_EVENT_REUSE'; END IF;
  v:=v+1; last_at:=(e->>'at')::bigint;
  IF e->>'kind'='FLOW' THEN flows:=flows+(e->>'amount')::numeric; ELSIF e->>'kind'='REALIZED' THEN realized:=realized+(e->>'amount')::numeric; ELSE current_equity:=(e->>'amount')::numeric-flows; peak:=greatest(peak,current_equity); END IF;
 END LOOP;
 IF e->>'kind'<>'EQUITY' OR last_at<>(p->>'coveredThrough')::bigint OR jsonb_array_length(p->'events')<>(SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p->'events')) THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_COVERAGE'; END IF;
 IF greatest(abs(opening),abs(flows),abs(realized),abs(current_equity),abs(peak))>=1e30 THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_CAPACITY'; END IF;
 cp:=jsonb_build_object('scope',p->'scope','dayStart',d,'sequence',v::text,'batchId',p->>'id','coveredThrough',last_at,'openingEquity',trim_scale(opening)::text,'externalFlows',trim_scale(flows)::text,'netRealized',trim_scale(realized)::text,'adjustedCurrentEquity',trim_scale(current_equity)::text,'adjustedPeakEquity',trim_scale(peak)::text)::text;
 INSERT INTO ctp_risk.loss_batch("tenantId",id,mode,asset,day,sequence,payload,checkpoint,hash) VALUES(t,(p->>'id')::uuid,m,a,d,v,p,cp,sha256(convert_to(cp,'UTF8'))) RETURNING * INTO old;
 INSERT INTO ctp_risk.loss_event_identity("tenantId",id,batch) SELECT t,(value->>'id')::uuid,old.id FROM jsonb_array_elements(p->'events');
 INSERT INTO ctp_risk.loss_head("tenantId",mode,asset,day,sequence,id) VALUES(t,m,a,d,v,old.id) ON CONFLICT("tenantId",mode,asset,day) DO UPDATE SET sequence=EXCLUDED.sequence,id=EXCLUDED.id;
 RETURN ctp_risk.loss_result(old);
END $$;
CREATE FUNCTION ctp_risk.read_loss_checkpoint(t uuid,m text,a text,d bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b ctp_risk.loss_batch; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_evidence_collector') THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_ROLE_UNSAFE'; END IF;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12); PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:risk:'||t::text,0));
 SELECT v.* INTO b FROM ctp_risk.loss_head h JOIN ctp_risk.loss_batch v ON v."tenantId"=h."tenantId" AND v.id=h.id WHERE h."tenantId"=t AND h.mode=m::public."TradingMode" AND h.asset=a AND h.day=d;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_LOSS_JOURNAL_MISSING'; END IF;
 RETURN ctp_risk.loss_result(b);
END $$;
REVOKE ALL ON ctp_risk.loss_batch,ctp_risk.loss_head,ctp_risk.loss_event_identity FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_risk.loss_head_monotonic(),ctp_risk.loss_result(ctp_risk.loss_batch),ctp_risk.loss_number(jsonb),ctp_risk.loss_money(jsonb),ctp_risk.loss_proof(jsonb),ctp_risk.valid_loss_input(jsonb),ctp_risk.append_loss_batch(jsonb),ctp_risk.read_loss_checkpoint(uuid,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_risk.append_loss_batch(jsonb),ctp_risk.read_loss_checkpoint(uuid,text,text,bigint) TO ctp_risk_evidence_collector;
COMMIT;
