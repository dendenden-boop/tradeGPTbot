BEGIN;
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['ctp_risk_certifier','ctp_risk_observer'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',n); END IF;
END LOOP; END $$;
CREATE SCHEMA ctp_certification;
REVOKE ALL ON SCHEMA ctp_certification FROM PUBLIC;
GRANT USAGE ON SCHEMA ctp_certification TO ctp_risk_certifier,ctp_risk_observer;
CREATE TABLE ctp_certification.certificate (
 "tenantId" uuid NOT NULL REFERENCES public."user"(id), key jsonb NOT NULL,
 id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 payload text NOT NULL CHECK(octet_length(payload)<=2097152), hash bytea NOT NULL CHECK(hash=sha256(convert_to(payload,'UTF8'))),
 PRIMARY KEY("tenantId",id), UNIQUE("tenantId",key,revision,id)
);
CREATE TABLE ctp_certification.identity (
 "tenantId" uuid NOT NULL REFERENCES public."user"(id), key jsonb NOT NULL, id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), PRIMARY KEY("tenantId",id), UNIQUE("tenantId",key,revision,id)
);
CREATE TABLE ctp_certification.identity_head (
 "tenantId" uuid NOT NULL, key jsonb NOT NULL, id uuid NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY("tenantId",key), FOREIGN KEY("tenantId",key,revision,id) REFERENCES ctp_certification.identity("tenantId",key,revision,id)
);
CREATE TABLE ctp_certification.certificate_head (
 "tenantId" uuid NOT NULL, key jsonb NOT NULL, id uuid NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY("tenantId",key), FOREIGN KEY("tenantId",key,revision,id) REFERENCES ctp_certification.certificate("tenantId",key,revision,id)
);
CREATE TABLE ctp_certification.observation (
 "tenantId" uuid NOT NULL REFERENCES public."user"(id), key jsonb NOT NULL, id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), payload text NOT NULL CHECK(octet_length(payload)<=1048576),
 hash bytea NOT NULL CHECK(hash=sha256(convert_to(payload,'UTF8'))), PRIMARY KEY("tenantId",id), UNIQUE("tenantId",key,revision,id)
);
CREATE TABLE ctp_certification.observation_head (
 "tenantId" uuid NOT NULL, key jsonb NOT NULL, id uuid NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY("tenantId",key), FOREIGN KEY("tenantId",key,revision,id) REFERENCES ctp_certification.observation("tenantId",key,revision,id)
);
CREATE FUNCTION ctp_certification.monotonic_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revision'-'id') IS DISTINCT FROM (to_jsonb(OLD)-'revision'-'id') OR NEW.revision<=OLD.revision THEN RAISE EXCEPTION 'RISK_SNAPSHOT_REVISION'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['certificate','identity','identity_head','certificate_head','observation','observation_head'] LOOP
 EXECUTE format('ALTER TABLE ctp_certification.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE ctp_certification.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY certificate_tenant ON ctp_certification.%I USING ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',n);
 EXECUTE format('CREATE TRIGGER certificate_no_truncate BEFORE TRUNCATE ON ctp_certification.%I FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row()',n);
 IF n IN('certificate','identity','observation') THEN
  EXECUTE format('CREATE TRIGGER certificate_immutable BEFORE UPDATE OR DELETE ON ctp_certification.%I FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row()',n);
 ELSE
  EXECUTE format('CREATE TRIGGER certificate_monotonic BEFORE UPDATE OR DELETE ON ctp_certification.%I FOR EACH ROW EXECUTE FUNCTION ctp_certification.monotonic_head()',n);
 END IF;
END LOOP; END $$;
CREATE FUNCTION ctp_certification.valid_key(p jsonb,with_intent boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE b jsonb; a jsonb; s jsonb; k text; BEGIN
 IF octet_length(p::text)>8192 OR NOT ctp_market.snapshot_keys(p,CASE WHEN with_intent THEN ARRAY['binding','instrumentId','dbInstrumentId','dbRuleId','dbCapabilityId','intentId'] ELSE ARRAY['binding','instrumentId','dbInstrumentId','dbRuleId','dbCapabilityId'] END) THEN RETURN false; END IF;
 b:=p->'binding';a:=b->'profile';
 IF NOT ctp_market.snapshot_keys(b,ARRAY['tenantId','accountId','connectionId','externalAccountId','mode','profile'])
 OR NOT ctp_market.snapshot_keys(a,CASE WHEN a ? 'credentialRef' THEN ARRAY['exchange','region','market','environment','accountMode','profileVersion','endpointProfileId','credentialRef'] ELSE ARRAY['exchange','region','market','environment','accountMode','profileVersion','endpointProfileId'] END)
 OR b->>'mode' NOT IN('TESTNET','DEMO') OR b->>'mode'<>a->>'environment'
 OR NOT EXISTS(SELECT 1 FROM jsonb_each(b) x WHERE x.key='profile')
 OR a->>'accountMode' !~ '^[A-Z][A-Z0-9_]{0,127}$' OR a->>'profileVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
 OR a->>'endpointProfileId' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
 OR (a ? 'credentialRef' AND a->>'credentialRef' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['tenantId','accountId','connectionId'] LOOP IF jsonb_typeof(b->k)<>'string' OR b->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF; END LOOP;
 FOREACH k IN ARRAY ARRAY['dbInstrumentId','dbRuleId','dbCapabilityId'] LOOP IF jsonb_typeof(p->k)<>'string' OR p->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF; END LOOP;
 IF with_intent AND (jsonb_typeof(p->'intentId')<>'string' OR p->>'intentId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RETURN false; END IF;
 IF jsonb_typeof(b->'externalAccountId')<>'string' OR length(b->>'externalAccountId') NOT BETWEEN 1 AND 128 OR b->>'externalAccountId' ~ '[[:space:][:cntrl:]]' THEN RETURN false; END IF;
 s:=jsonb_build_object('exchange',a->'exchange','region',a->'region','market',a->'market','environment',a->'environment');
 RETURN ctp_market.snapshot_key(jsonb_build_object('scope',s,'instrumentId',p->'instrumentId','dbInstrumentId',p->'dbInstrumentId','dbRuleId',p->'dbRuleId'));
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_certification.lock_key(p jsonb,with_intent boolean) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid; BEGIN
 IF ctp_certification.valid_key(p,with_intent) IS NOT TRUE THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INPUT'; END IF;
 t:=(p->'binding'->>'tenantId')::uuid;
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_SNAPSHOT_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12); PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 RETURN t;
END $$;
CREATE FUNCTION ctp_certification.next_identity(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; v bigint; identity_id uuid:=gen_random_uuid(); BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_certifier') THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
 t:=ctp_certification.lock_key(p,true);
 SELECT revision INTO v FROM ctp_certification.identity_head WHERE "tenantId"=t AND key=p;
 IF COALESCE(v,0)>=9223372036854775807 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_REVISION'; END IF; v:=COALESCE(v,0)+1;
 INSERT INTO ctp_certification.identity("tenantId",key,id,revision) VALUES(t,p,identity_id,v);
 INSERT INTO ctp_certification.identity_head("tenantId",key,id,revision) VALUES(t,p,identity_id,v) ON CONFLICT("tenantId",key) DO UPDATE SET id=EXCLUDED.id,revision=EXCLUDED.revision;
 RETURN jsonb_build_object('id',identity_id::text,'revision',v::text);
END $$;
CREATE FUNCTION ctp_certification.insert_certificate(p jsonb,raw text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; c jsonb; h ctp_certification.identity_head; old ctp_certification.certificate; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_certifier') THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
 t:=ctp_certification.lock_key(p,true);
 IF raw IS NULL OR octet_length(raw)>2097152 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INPUT'; END IF; c:=raw::jsonb;
 IF NOT ctp_market.snapshot_keys(c,ARRAY['id','revision','hash','createdAt','expiresAt','projection'])
 OR c->'projection'->'key' IS DISTINCT FROM p OR c->>'hash' !~ '^[a-f0-9]{64}$'
 OR c->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR c->>'revision' !~ '^[1-9][0-9]{0,18}$' OR (c->>'revision')::numeric>9223372036854775807
 OR NOT ctp_risk.loss_number(c->'createdAt') OR NOT ctp_risk.loss_number(c->'expiresAt')
 OR (c->>'createdAt')::numeric>floor(extract(epoch FROM clock_timestamp())*1000)
 OR (c->>'expiresAt')::numeric<floor(extract(epoch FROM clock_timestamp())*1000)
 OR (c->>'expiresAt')::numeric>(c->>'createdAt')::numeric+5000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INPUT'; END IF;
 SELECT * INTO old FROM ctp_certification.certificate WHERE "tenantId"=t AND id=(c->>'id')::uuid;
 IF FOUND THEN IF old.key<>p OR old.payload<>raw THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INSERT_CONFLICT'; END IF; RETURN; END IF;
 SELECT * INTO h FROM ctp_certification.identity_head WHERE "tenantId"=t AND key=p;
 IF h.id IS DISTINCT FROM (c->>'id')::uuid OR h.revision IS DISTINCT FROM (c->>'revision')::bigint THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INSERT_CONFLICT'; END IF;
 INSERT INTO ctp_certification.certificate("tenantId",key,id,revision,payload,hash) VALUES(t,p,h.id,h.revision,raw,sha256(convert_to(raw,'UTF8')));
 INSERT INTO ctp_certification.certificate_head("tenantId",key,id,revision) VALUES(t,p,h.id,h.revision) ON CONFLICT("tenantId",key) DO UPDATE SET id=EXCLUDED.id,revision=EXCLUDED.revision;
END $$;
CREATE FUNCTION ctp_certification.read_certificate(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; c ctp_certification.certificate; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_certifier') THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
 t:=ctp_certification.lock_key(p,true);
 SELECT v.* INTO c FROM ctp_certification.certificate v JOIN ctp_certification.certificate_head h USING("tenantId",key,id,revision) WHERE h."tenantId"=t AND h.key=p;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF c.hash<>sha256(convert_to(c.payload,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CORRUPT'; END IF;
 RETURN c.payload::jsonb;
END $$;
CREATE FUNCTION ctp_certification.capture_inventory(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; inventory_ids uuid[]; ids uuid[]; connection_ids uuid[]; b_ids uuid[]; result jsonb; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_certifier') THEN RAISE EXCEPTION 'RISK_PORTFOLIO_ROLE_UNSAFE'; END IF;
 IF NOT ctp_market.snapshot_keys(p,ARRAY['tenantId','mode','targetAccountId','maxEvidenceAgeMs'])
 OR jsonb_typeof(p->'tenantId') IS DISTINCT FROM 'string' OR p->>'tenantId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p->'targetAccountId') IS DISTINCT FROM 'string' OR p->>'targetAccountId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p->'mode') IS DISTINCT FROM 'string' OR p->>'mode' NOT IN('PAPER','TESTNET','DEMO','LIVE')
 OR jsonb_typeof(p->'maxEvidenceAgeMs') IS DISTINCT FROM 'number' OR p->>'maxEvidenceAgeMs' !~ '^[1-9][0-9]{0,3}$' OR (p->>'maxEvidenceAgeMs')::integer>5000
 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_INPUT'; END IF;
 t:=(p->>'tenantId')::uuid; m:=(p->>'mode')::public."TradingMode";
 IF t IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'RISK_PORTFOLIO_SCOPE'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 -- The tenant advisory lock serializes trusted financial writers. Row/FK locks
 -- also freeze account/connection/book inventory for ordinary API writers that
 -- do not participate in that advisory protocol. Lock all owned modes before
 -- selecting this mode, so an existing account cannot move into the selection.
 PERFORM id FROM public."user" WHERE id=t FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_PORTFOLIO_SCOPE'; END IF;
 SELECT array_agg(id ORDER BY id) INTO inventory_ids FROM
  (SELECT id FROM public.exchange_account WHERE "tenantId"=t ORDER BY id LIMIT 401)a;
 IF COALESCE(cardinality(inventory_ids),0)>400 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 PERFORM id FROM public.exchange_account WHERE "tenantId"=t AND id=ANY(inventory_ids) ORDER BY id FOR UPDATE;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode=m ORDER BY id LIMIT 101)a;
 IF cardinality(ids) IS NULL OR NOT((p->>'targetAccountId')::uuid=ANY(ids)) THEN RAISE EXCEPTION 'RISK_PORTFOLIO_SCOPE'; END IF;
 IF cardinality(ids)>100 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 SELECT array_agg(id ORDER BY "accountId",id) INTO connection_ids FROM
  (SELECT id,"accountId" FROM public.exchange_connection WHERE "tenantId"=t AND "accountId"=ANY(ids) AND mode=m ORDER BY "accountId",id LIMIT 301)c;
 IF COALESCE(cardinality(connection_ids),0)>300 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 PERFORM id FROM public.exchange_connection WHERE "tenantId"=t AND id=ANY(connection_ids) ORDER BY "accountId",id FOR SHARE;
 SELECT array_agg(id ORDER BY "accountId",wallet,id) INTO b_ids FROM (SELECT id,"accountId",wallet FROM ctp_portfolio.book WHERE "tenantId"=t AND "accountId"=ANY(ids) AND mode=m ORDER BY "accountId",wallet,id LIMIT 301)b;
 IF COALESCE(cardinality(b_ids),0)>300 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 PERFORM id FROM ctp_portfolio.book WHERE "tenantId"=t AND id=ANY(b_ids) ORDER BY "accountId",wallet,id FOR SHARE;
 IF COALESCE((SELECT sum(octet_length(state)) FROM ctp_portfolio.book WHERE "tenantId"=t AND id=ANY(b_ids)),0)>1048576 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_portfolio.book b WHERE b."tenantId"=t AND b.id=ANY(b_ids) AND
  (b.state_hash<>sha256(convert_to(b.state,'UTF8')) OR b.state::jsonb->'binding'->>'tenantId'<>t::text
   OR b.state::jsonb->'binding'->>'accountId'<>b."accountId"::text OR b.state::jsonb->'binding'->>'mode'<>m::text
   OR b.state::jsonb->'binding'->>'walletId'<>b.wallet
   OR NOT EXISTS(SELECT 1 FROM public.exchange_account a JOIN public.exchange_connection c ON c."tenantId"=a."tenantId" AND c."accountId"=a.id AND c.mode=a.mode
    WHERE a."tenantId"=t AND a.id=b."accountId" AND a.mode=m AND c.id=(b.state::jsonb->'binding'->>'connectionId')::uuid
    AND a."externalAccountId"=b.state::jsonb->'binding'->>'externalAccountId'
    AND a.exchange::text=b.state::jsonb->'binding'->'scope'->>'exchange' AND a.region=b.state::jsonb->'binding'->'scope'->>'region')))
 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CORRUPT'; END IF;
 SELECT jsonb_build_object('scope',jsonb_build_object('tenantId',t::text,'mode',m::text),
  'accounts',(SELECT jsonb_agg(jsonb_build_object('id',id::text,'exchange',exchange::text,'region',region,'externalAccountId',"externalAccountId",'accountMode',"accountMode",'status',status::text,'permissionEpoch',"permissionEpoch"::text,'reconciliationEpoch',"reconciliationEpoch"::text,'version',version) ORDER BY id) FROM public.exchange_account WHERE "tenantId"=t AND id=ANY(ids) AND mode=m),
  'books',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',b.id::text,'accountId',b."accountId"::text,'wallet',b.wallet,'revision',b.revision::text,'stateText',b.state,'hash',encode(b.state_hash,'hex'),
    'holdWatermarks',COALESCE((SELECT jsonb_agg(jsonb_build_object('holdId',w."holdId",'timestamp',w.timestamp::text,'fingerprint',encode(w.fingerprint,'hex'),'released',w.released,'unknown',w.unknown) ORDER BY w."holdId") FROM ctp_portfolio.hold_watermark w WHERE w."tenantId"=t AND w.book=b.id AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.state::jsonb->'holds')h WHERE h->>'id'=w."holdId")),'[]'::jsonb)) ORDER BY b."accountId",b.wallet,b.id) FROM ctp_portfolio.book b WHERE b."tenantId"=t AND b.id=ANY(b_ids)),'[]'::jsonb)) INTO result;
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'RISK_PORTFOLIO_CAPACITY'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION ctp_certification.publish_observation(raw text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; o jsonb; k jsonb; t uuid; old ctp_certification.observation; v bigint; fact jsonb; now_ms bigint; name text; a public.exchange_account; c public.exchange_connection; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_observer') THEN RAISE EXCEPTION 'RISK_OBSERVATION_ROLE_UNSAFE'; END IF;
 IF raw IS NULL OR octet_length(raw)>1048576 THEN RAISE EXCEPTION 'RISK_OBSERVATION_INPUT'; END IF;
 p:=raw::jsonb;o:=p->'observation';k:=o->'key';
 IF NOT ctp_market.snapshot_keys(p,ARRAY['id','expectedRevision','observation'])
 OR p->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR p->>'expectedRevision' !~ '^(0|[1-9][0-9]{0,18})$' OR (p->>'expectedRevision')::numeric>=9223372036854775807
 OR NOT ctp_market.snapshot_keys(o,ARRAY['key','permissionEpoch','permissionsVersion','positionMode','leverage','health','fee','fx','valuations','marks','execution'])
 OR o->>'permissionEpoch' !~ '^(0|[1-9][0-9]{0,18})$' OR NOT ctp_risk.loss_number(o->'permissionsVersion')
 OR o->>'positionMode' NOT IN('SPOT','ONE_WAY','HEDGE') OR NOT ctp_market.snapshot_decimal(o->'leverage')
 OR NOT ctp_market.snapshot_keys(o->'health',ARRAY['database','limiter','authentication','exchangeRest','privateStream','clock','latency','rejectRate','maintenance'])
 OR NOT ctp_market.snapshot_keys(o->'fee',ARRAY['asset','maxRate','sourceId','asOf'])
 OR NOT ctp_risk.loss_money(o->'fee'->'maxRate') OR (o->'fee'->>'maxRate')::numeric NOT BETWEEN 0 AND 1
 OR jsonb_typeof(o->'fx')<>'array' OR jsonb_array_length(o->'fx') NOT BETWEEN 1 AND 1000
 OR jsonb_typeof(o->'valuations')<>'array' OR jsonb_array_length(o->'valuations')>30000
 OR jsonb_typeof(o->'marks')<>'array' OR jsonb_array_length(o->'marks')>1000
 OR NOT ctp_market.snapshot_keys(o->'execution',ARRAY['marketId','lowerPrice','upperPrice','boundEnforced','sourceId','asOf'])
 OR NOT ctp_market.snapshot_decimal(o->'execution'->'lowerPrice') OR NOT ctp_market.snapshot_decimal(o->'execution'->'upperPrice')
 OR (o->'execution'->>'lowerPrice')::numeric>(o->'execution'->>'upperPrice')::numeric
 OR jsonb_typeof(o->'execution'->'boundEnforced')<>'boolean' THEN RAISE EXCEPTION 'RISK_OBSERVATION_INPUT'; END IF;
 t:=ctp_certification.lock_key(k,false);
 SELECT * INTO old FROM ctp_certification.observation WHERE "tenantId"=t AND id=(p->>'id')::uuid;
 IF FOUND THEN IF old.key<>k OR old.payload<>raw THEN RAISE EXCEPTION 'RISK_OBSERVATION_CONFLICT'; END IF;
  RETURN jsonb_build_object('id',old.id::text,'revision',old.revision::text,'replayed',true); END IF;
 SELECT * INTO a FROM public.exchange_account WHERE "tenantId"=t AND id=(k->'binding'->>'accountId')::uuid AND mode::text=k->'binding'->>'mode' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_OBSERVATION_SCOPE'; END IF;
 SELECT * INTO c FROM public.exchange_connection WHERE "tenantId"=t AND id=(k->'binding'->>'connectionId')::uuid AND "accountId"=a.id AND mode=a.mode FOR SHARE;
 IF NOT FOUND OR a."permissionEpoch"::text<>o->>'permissionEpoch' OR c."permissionsVersion"::numeric<>(o->>'permissionsVersion')::numeric THEN RAISE EXCEPTION 'RISK_OBSERVATION_PERMISSION'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 FOR name,fact IN SELECT key,value FROM jsonb_each(o->'health') LOOP
  IF NOT ctp_market.snapshot_keys(fact,ARRAY['sourceId','asOf','status']) OR fact->>'status' NOT IN('HEALTHY','FAILED','UNKNOWN') THEN RAISE EXCEPTION 'RISK_OBSERVATION_INPUT'; END IF;
 END LOOP;
 FOR fact IN SELECT value FROM jsonb_array_elements(o->'fx') LOOP
  IF NOT ctp_market.snapshot_keys(fact,ARRAY['sourceId','asOf','from','to','rate','kind']) OR NOT ctp_market.snapshot_decimal(fact->'rate')
  OR fact->>'kind' NOT IN('IDENTITY','OBSERVED') OR (fact->>'kind'='IDENTITY') IS DISTINCT FROM (fact->>'from'=fact->>'to')
  OR (fact->>'kind'='IDENTITY' AND fact->>'rate'<>'1') THEN RAISE EXCEPTION 'RISK_OBSERVATION_FX'; END IF;
 END LOOP;
 IF jsonb_array_length(o->'fx')<>(SELECT count(DISTINCT jsonb_build_array(value->'from',value->'to')) FROM jsonb_array_elements(o->'fx')) THEN RAISE EXCEPTION 'RISK_OBSERVATION_FX'; END IF;
 FOR fact IN SELECT value FROM jsonb_array_elements(o->'marks') LOOP
  IF NOT ctp_market.snapshot_keys(fact,ARRAY['sourceId','asOf','marketId','price','priceAsset']) OR NOT ctp_market.snapshot_decimal(fact->'price') THEN RAISE EXCEPTION 'RISK_OBSERVATION_INPUT'; END IF;
 END LOOP;
 IF jsonb_array_length(o->'marks')<>(SELECT count(DISTINCT value->'marketId') FROM jsonb_array_elements(o->'marks')) THEN RAISE EXCEPTION 'RISK_OBSERVATION_INPUT'; END IF;
 FOR fact IN SELECT value FROM jsonb_array_elements(o->'valuations') LOOP
  IF NOT ctp_market.snapshot_keys(fact,ARRAY['accountId','bookId','snapshotId','instrumentId','marketId']) THEN RAISE EXCEPTION 'RISK_OBSERVATION_INPUT'; END IF;
 END LOOP;
 FOR fact IN SELECT value FROM jsonb_each(o->'health') UNION ALL SELECT o->'fee' UNION ALL SELECT o->'execution' UNION ALL SELECT value FROM jsonb_array_elements(o->'fx') UNION ALL SELECT value FROM jsonb_array_elements(o->'marks') LOOP
  IF jsonb_typeof(fact->'sourceId')<>'string' OR length(fact->>'sourceId') NOT BETWEEN 1 AND 128 OR fact->>'sourceId' ~ '[[:space:][:cntrl:]]'
  OR NOT ctp_risk.loss_number(fact->'asOf') OR (fact->>'asOf')::numeric>now_ms OR (fact->>'asOf')::numeric<now_ms-5000 THEN RAISE EXCEPTION 'RISK_OBSERVATION_STALE'; END IF;
 END LOOP;
 SELECT revision INTO v FROM ctp_certification.observation_head WHERE "tenantId"=t AND key=k;
 IF COALESCE(v,0)::numeric<>(p->>'expectedRevision')::numeric THEN RAISE EXCEPTION 'RISK_OBSERVATION_REVISION'; END IF;v:=COALESCE(v,0)+1;
 INSERT INTO ctp_certification.observation("tenantId",key,id,revision,payload,hash) VALUES(t,k,(p->>'id')::uuid,v,raw,sha256(convert_to(raw,'UTF8'))) RETURNING * INTO old;
 INSERT INTO ctp_certification.observation_head("tenantId",key,id,revision) VALUES(t,k,old.id,v) ON CONFLICT("tenantId",key) DO UPDATE SET id=EXCLUDED.id,revision=EXCLUDED.revision;
 RETURN jsonb_build_object('id',old.id::text,'revision',v::text,'replayed',false);
END $$;
CREATE FUNCTION ctp_certification.capture_sources(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; b jsonb; profile jsonb; s jsonb; pf jsonb; policy_platform ctp_risk.policy_revision; policy_user ctp_risk.policy_revision;
 a public.exchange_account; c public.exchange_connection; u public."user"; command ctp_execution.command; cap public.capability_snapshot;
 reg ctp_registry.current_record; obs ctp_certification.observation; observation jsonb; market_ids uuid[]; native ctp_market.snapshot_event;
 markets jsonb:='[]'; loss ctp_risk.loss_batch; controls jsonb; controls_raw jsonb; result jsonb; age integer; now_ms bigint; market_id uuid; count_orders bigint; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_certifier') THEN RAISE EXCEPTION 'RISK_SNAPSHOT_ROLE_UNSAFE'; END IF;
 t:=ctp_certification.lock_key(p,true);b:=p->'binding';profile:=b->'profile';m:=(b->>'mode')::public."TradingMode";
 pf:=ctp_certification.capture_inventory(jsonb_build_object('tenantId',t::text,'mode',m::text,'targetAccountId',b->>'accountId','maxEvidenceAgeMs',5000));
 SELECT * INTO u FROM public."user" WHERE id=t; IF NOT FOUND OR u.status::text<>'ACTIVE' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_SCOPE'; END IF;
 SELECT * INTO a FROM public.exchange_account WHERE "tenantId"=t AND id=(b->>'accountId')::uuid AND mode=m;
 IF NOT FOUND OR a.status::text<>'ACTIVE' OR a.exchange::text<>profile->>'exchange' OR a.region<>profile->>'region' OR a."accountMode"<>profile->>'accountMode' OR a."externalAccountId"<>b->>'externalAccountId' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_SCOPE'; END IF;
 SELECT * INTO c FROM public.exchange_connection WHERE "tenantId"=t AND "accountId"=a.id AND id=(b->>'connectionId')::uuid AND mode=m;
 IF NOT FOUND OR c.status::text<>'ACTIVE' OR c."disabledAt" IS NOT NULL OR c."withdrawalPermissionDetected" OR c.permissions->'read' IS DISTINCT FROM 'true'::jsonb OR c.permissions->'trade' IS DISTINCT FROM 'true'::jsonb OR c.permissions->'withdrawal' IS DISTINCT FROM 'false'::jsonb OR c."permissionsVerifiedAt" IS NULL THEN RAISE EXCEPTION 'RISK_SNAPSHOT_PERMISSION'; END IF;
 SELECT * INTO command FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->>'intentId')::uuid;
 IF NOT FOUND OR command.binding::jsonb IS DISTINCT FROM b OR command.operation<>'PLACE' OR NOT EXISTS(SELECT 1 FROM public.order_intent i WHERE i."tenantId"=t AND i.id=command."intentId" AND i."accountId"=a.id AND i.mode=m AND i."connectionId"=c.id AND i."instrumentId"=(p->>'dbInstrumentId')::uuid AND i."ruleVersionId"=(p->>'dbRuleId')::uuid AND i."commandHash"=command."commandHash") THEN RAISE EXCEPTION 'RISK_SNAPSHOT_INTENT'; END IF;
 SELECT r.* INTO policy_platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id) WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode=m;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_POLICY_MISSING'; END IF;
 SELECT r.* INTO policy_user FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id) WHERE h.scope='USER' AND h.target=t AND h.mode=m;
 IF NOT FOUND THEN RAISE EXCEPTION 'RISK_POLICY_MISSING'; END IF;
 IF policy_platform."limitsText"::jsonb->>'valuationAsset'<>policy_user."limitsText"::jsonb->>'valuationAsset' THEN RAISE EXCEPTION 'RISK_POLICY_CURRENCY'; END IF;
 age:=least((policy_platform."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(policy_user."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer);
 LOCK TABLE public.instrument,public.instrument_rule_version,public.capability_snapshot IN SHARE MODE;
 SELECT * INTO cap FROM public.capability_snapshot WHERE exchange=a.exchange AND mode=m AND region=a.region AND "accountMode"=a."accountMode" AND market::text=CASE profile->>'market' WHEN 'SPOT' THEN 'SPOT' WHEN 'LINEAR_PERPETUAL' THEN 'PERPETUAL' WHEN 'INVERSE_PERPETUAL' THEN 'PERPETUAL' ELSE 'FUTURES' END ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR cap.id<>(p->>'dbCapabilityId')::uuid OR cap."verifiedAt">clock_timestamp() OR cap."expiresAt"<=clock_timestamp() OR cap."profileVersion"<>profile->>'profileVersion' OR NOT ctp_market.snapshot_keys(cap.capabilities,ARRAY['adapterVersion','features']) OR jsonb_typeof(cap.capabilities->'features')<>'array' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
 s:=jsonb_build_object('exchange',profile->'exchange','region',profile->'region','market',profile->'market','environment',profile->'environment');
 SELECT * INTO reg FROM ctp_registry.current_record WHERE scope=s AND id=p->>'instrumentId' FOR SHARE;
 IF NOT FOUND OR reg.record->'rules'->>'version'<>command.command::jsonb->>'ruleVersion' THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
 SELECT v.* INTO obs FROM ctp_certification.observation_head h JOIN ctp_certification.observation v USING("tenantId",key,id,revision) WHERE h."tenantId"=t AND h.key=p-'intentId';
 IF NOT FOUND OR obs.hash<>sha256(convert_to(obs.payload,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_OBSERVATION'; END IF;
 observation:=obs.payload::jsonb->'observation';
 SELECT array_agg(mid ORDER BY mid) INTO market_ids FROM (SELECT DISTINCT (value->>'marketId')::uuid AS mid FROM jsonb_array_elements(observation->'valuations') UNION SELECT (observation->'execution'->>'marketId')::uuid)q;
 IF COALESCE(cardinality(market_ids),0) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 -- Sorted keys freeze current GAP/head replacements while native data is verified.
 FOR market_id IN SELECT e.id FROM ctp_market.snapshot_event e WHERE e.id=ANY(market_ids) ORDER BY ((e.payload::jsonb->'key')-'dbRuleId')::text LOOP
  SELECT * INTO native FROM ctp_market.snapshot_event WHERE snapshot_event.id=market_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('ctp:market:snapshot:'||((native.payload::jsonb->'key')-'dbRuleId')::text,0));
 END LOOP;
 FOREACH market_id IN ARRAY market_ids LOOP
  SELECT e.* INTO native FROM ctp_market.snapshot_head h JOIN ctp_market.snapshot_event e ON e.id=h.native WHERE e.id=market_id AND NOT h.gap AND h.key=e.key-'dbRuleId';
  IF NOT FOUND OR native.hash<>sha256(convert_to(native.payload,'UTF8')) OR ctp_market.snapshot_valid(native.payload::jsonb) IS NOT TRUE OR ctp_market.snapshot_metadata(native.payload::jsonb) IS NOT TRUE OR ctp_market.snapshot_fresh(native.payload::jsonb,age) IS NOT TRUE THEN RAISE EXCEPTION 'RISK_SNAPSHOT_MARKET'; END IF;
  IF market_id=(observation->'execution'->>'marketId')::uuid AND native.payload::jsonb->'record'<>reg.record THEN RAISE EXCEPTION 'RISK_SNAPSHOT_METADATA'; END IF;
  markets:=markets||jsonb_build_array(jsonb_build_object('id',native.id::text,'revision',native.revision::text,'text',native.payload,'hash',encode(native.hash,'hex')));
 END LOOP;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 SELECT v.* INTO loss FROM ctp_risk.loss_head h JOIN ctp_risk.loss_batch v ON v."tenantId"=h."tenantId" AND v.id=h.id WHERE h."tenantId"=t AND h.mode=m AND h.asset=policy_platform."limitsText"::jsonb->>'valuationAsset' AND h.day=now_ms/86400000*86400000;
 IF NOT FOUND OR loss.hash<>sha256(convert_to(loss.checkpoint,'UTF8')) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_LOSS'; END IF;
 -- Unissued legacy reservations/pending commands have no certified effect proof.
 -- They block certification instead of being omitted or invented as zero.
 IF EXISTS(SELECT 1 FROM public.risk_reservation WHERE "tenantId"=t AND mode=m AND status::text<>'RELEASED') OR EXISTS(SELECT 1 FROM public."order" WHERE "tenantId"=t AND mode=m AND (status::text IN('RISK_APPROVED','SUBMITTING','SUBMITTED','PARTIALLY_FILLED','CANCEL_PENDING','UNKNOWN','RECONCILIATION_REQUIRED') OR EXISTS(SELECT 1 FROM public.submission_attempt sa WHERE sa."tenantId"=t AND sa."orderId"="order".id AND sa.status::text IN('DISPATCHING','ACKNOWLEDGED','UNKNOWN')))) THEN RAISE EXCEPTION 'RISK_SNAPSHOT_UNISSUED_EXPOSURE'; END IF;
 IF (SELECT count(*) FROM ctp_risk.global_head)>10000 OR (SELECT count(*) FROM ctp_risk.tenant_head WHERE "tenantId"=t)>10000 OR (SELECT count(*) FROM public.trading_pause WHERE "tenantId"=t)>10000 OR (SELECT count(*) FROM public.circuit_state WHERE "tenantId"=t)>10000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 controls_raw:=jsonb_build_object('global',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY kind,key) FROM ctp_risk.global_head h),'[]'), 'tenant',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY scope,target,kind,key) FROM ctp_risk.tenant_head h WHERE "tenantId"=t),'[]'),'pauses',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM public.trading_pause h WHERE "tenantId"=t),'[]'),'circuits',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM public.circuit_state h WHERE "tenantId"=t),'[]'));
 controls:=jsonb_build_object('pauses',jsonb_build_object('global',NOT EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='KILL_SWITCH' AND key='kill' AND state='RUNNING'), 'user',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='USER' AND kind='KILL_SWITCH' AND state<>'RUNNING') OR EXISTS(SELECT 1 FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL), 'connection',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='CONNECTION' AND target=c.id AND kind='KILL_SWITCH' AND state<>'RUNNING'), 'strategy',EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND scope='STRATEGY' AND kind='KILL_SWITCH' AND state<>'RUNNING')), 'circuit',CASE WHEN EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='CIRCUIT' AND state='OPEN') OR EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND kind='CIRCUIT' AND state='OPEN') OR EXISTS(SELECT 1 FROM public.circuit_state WHERE "tenantId"=t AND status::text='OPEN') THEN 'OPEN' WHEN EXISTS(SELECT 1 FROM ctp_risk.global_head WHERE kind='CIRCUIT' AND state='HALF_OPEN') OR EXISTS(SELECT 1 FROM ctp_risk.tenant_head WHERE "tenantId"=t AND kind='CIRCUIT' AND state='HALF_OPEN') OR EXISTS(SELECT 1 FROM public.circuit_state WHERE "tenantId"=t AND status::text='HALF_OPEN') THEN 'HALF_OPEN' ELSE 'CLOSED' END);
 SELECT count(*) INTO count_orders FROM public.order_intent WHERE "tenantId"=t AND mode=m AND "createdAt">=clock_timestamp()-interval '1 minute';
 IF count_orders>1000000 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 result:=jsonb_build_object('key',p,'capturedAt',now_ms,'user',jsonb_build_object('id',u.id::text,'status',u.status::text,'sessionEpoch',u."sessionEpoch"::text), 'portfolio',pf, 'policies',jsonb_build_array(ctp_risk.policy_json(policy_platform),ctp_risk.policy_json(policy_user)), 'metadata',jsonb_build_object('value',jsonb_build_object('record',reg.record,'capabilities',cap.capabilities->'features','adapterVersion',cap.capabilities->'adapterVersion'),'revision',reg.revision::text), 'intent',jsonb_build_object('id',command."intentId"::text,'operation',command.operation,'command',command.command::jsonb),'connection',jsonb_build_object('id',c.id::text,'accountId',c."accountId"::text,'mode',c.mode::text,'status',c.status::text,'permissionEpoch',a."permissionEpoch"::text,'version',c.version,'permissionsVersion',c."permissionsVersion",'verifiedAt',floor(extract(epoch FROM c."permissionsVerifiedAt")*1000)::bigint,'disabledAt',NULL,'withdrawalPermissionDetected',false,'permissions',jsonb_build_object('read',true,'trade',true,'withdrawal',false)), 'observation',jsonb_build_object('id',obs.id::text,'revision',obs.revision::text,'text',observation::text,'hash',encode(sha256(convert_to(observation::text,'UTF8')),'hex')), 'markets',markets,'loss',jsonb_build_object('checkpointText',loss.checkpoint,'hash',encode(loss.hash,'hex')), 'controls',jsonb_build_object('value',controls,'fingerprint',encode(sha256(convert_to(controls_raw::text,'UTF8')),'hex')), 'exposure',jsonb_build_object('orders','[]'::jsonb,'reservations','[]'::jsonb),'ordersInLastMinute',count_orders);
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'RISK_SNAPSHOT_CAPACITY'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA ctp_certification FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ctp_certification FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_certification.capture_sources(jsonb),ctp_certification.next_identity(jsonb),ctp_certification.insert_certificate(jsonb,text),ctp_certification.read_certificate(jsonb) TO ctp_risk_certifier;
GRANT EXECUTE ON FUNCTION ctp_certification.publish_observation(text) TO ctp_risk_observer;
COMMIT;

