BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_instrument_registry') THEN
 CREATE ROLE ctp_instrument_registry NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
CREATE SCHEMA ctp_registry;
REVOKE ALL ON SCHEMA ctp_registry FROM PUBLIC;
GRANT USAGE ON SCHEMA ctp_registry TO ctp_instrument_registry;

-- Public market metadata, isolated from tenant credentials and monetary authority.
-- History is durable disk state; no process-age capacity or history eviction exists.
CREATE TABLE ctp_registry.record_revision (
 scope jsonb NOT NULL, id text NOT NULL, revision bigint NOT NULL CHECK(revision>0), previous_revision bigint,
 record jsonb NOT NULL CHECK(octet_length(record::text)<=32768),
 metadata_kind text NOT NULL DEFAULT 'instrument' CHECK(metadata_kind='instrument'),
 rules_kind text NOT NULL DEFAULT 'rules' CHECK(rules_kind='rules'),
 metadata_version text GENERATED ALWAYS AS (record->'instrument'->>'metadataVersion') STORED NOT NULL,
 rules_version text GENERATED ALWAYS AS (record->'rules'->>'version') STORED NOT NULL,
 CHECK((revision=1 AND previous_revision IS NULL) OR (revision>1 AND previous_revision=revision-1)),
 PRIMARY KEY(scope,id,revision),
 FOREIGN KEY(scope,id,previous_revision) REFERENCES ctp_registry.record_revision(scope,id,revision)
);
CREATE TABLE ctp_registry.current_record (
 scope jsonb NOT NULL, id text NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 record jsonb NOT NULL CHECK(octet_length(record::text)<=32768),
 PRIMARY KEY(scope,id), FOREIGN KEY(scope,id,revision) REFERENCES ctp_registry.record_revision(scope,id,revision)
);
CREATE UNIQUE INDEX registry_symbol_identity ON ctp_registry.current_record(scope,(record->'instrument'->>'exchangeSymbol'));
CREATE TABLE ctp_registry.version_history (
 scope jsonb NOT NULL, id text NOT NULL, kind text NOT NULL CHECK(kind IN('rules','instrument')),
 version text NOT NULL, revision bigint NOT NULL CHECK(revision>0), payload jsonb NOT NULL,
 PRIMARY KEY(scope,id,kind,version),
 FOREIGN KEY(scope,id,revision) REFERENCES ctp_registry.record_revision(scope,id,revision) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE ctp_registry.record_revision ADD FOREIGN KEY(scope,id,metadata_kind,metadata_version) REFERENCES ctp_registry.version_history(scope,id,kind,version);
ALTER TABLE ctp_registry.record_revision ADD FOREIGN KEY(scope,id,rules_kind,rules_version) REFERENCES ctp_registry.version_history(scope,id,kind,version);
CREATE TRIGGER registry_revision_immutable BEFORE UPDATE OR DELETE ON ctp_registry.record_revision
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER registry_revision_no_truncate BEFORE TRUNCATE ON ctp_registry.record_revision
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER registry_history_immutable BEFORE UPDATE OR DELETE ON ctp_registry.version_history
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER registry_history_no_truncate BEFORE TRUNCATE ON ctp_registry.version_history
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER registry_current_no_truncate BEFORE TRUNCATE ON ctp_registry.current_record
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE FUNCTION ctp_registry.monotonic_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.id IS DISTINCT FROM OLD.id
 OR NEW.revision::numeric<>OLD.revision::numeric+1 THEN RAISE EXCEPTION 'REGISTRY_REVISION'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER registry_head_monotonic BEFORE UPDATE OR DELETE ON ctp_registry.current_record
 FOR EACH ROW EXECUTE FUNCTION ctp_registry.monotonic_head();
ALTER TABLE ctp_registry.current_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_registry.current_record FORCE ROW LEVEL SECURITY;
ALTER TABLE ctp_registry.version_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_registry.version_history FORCE ROW LEVEL SECURITY;
ALTER TABLE ctp_registry.record_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_registry.record_revision FORCE ROW LEVEL SECURITY;
-- Only the SECURITY DEFINER migration owner has table privileges. RLS remains
-- enforceable for a migration owner without BYPASSRLS (validated by deployment).
CREATE POLICY registry_owner ON ctp_registry.current_record USING(true) WITH CHECK(true);
CREATE POLICY registry_owner ON ctp_registry.version_history USING(true) WITH CHECK(true);
CREATE POLICY registry_owner ON ctp_registry.record_revision USING(true) WITH CHECK(true);

CREATE FUNCTION ctp_registry.valid_scope(s jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ctp_market.snapshot_keys(s,ARRAY['exchange','region','market','environment'])
 AND jsonb_typeof(s->'exchange')='string' AND s->>'exchange' IN('BINANCE','BYBIT','OKX','HTX')
 AND jsonb_typeof(s->'market')='string' AND s->>'market' IN('SPOT','LINEAR_PERPETUAL','INVERSE_PERPETUAL','LINEAR_FUTURE','INVERSE_FUTURE')
 AND jsonb_typeof(s->'environment')='string' AND s->>'environment' IN('LIVE','TESTNET','DEMO')
 AND jsonb_typeof(s->'region')='string' AND s->>'region' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
$$;
CREATE FUNCTION ctp_registry.publish(s jsonb,batch jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v jsonb; i jsonb; r jsonb; ident text; previous ctp_registry.current_record%ROWTYPE;
 rev bigint; part text; ver text; result jsonb:='[]'::jsonb; k text; n numeric; tier jsonb; last_cap numeric; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_instrument_registry') THEN RAISE EXCEPTION 'REGISTRY_ROLE_UNSAFE'; END IF;
 IF NOT COALESCE(ctp_registry.valid_scope(s),false) OR jsonb_typeof(batch) IS DISTINCT FROM 'array'
 OR jsonb_array_length(batch) NOT BETWEEN 1 AND 300 OR octet_length(batch::text)>1048576
 THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
 IF (SELECT count(DISTINCT x->'instrument'->>'id') FROM jsonb_array_elements(batch)x)<>jsonb_array_length(batch) THEN RAISE EXCEPTION 'REGISTRY_DUPLICATE'; END IF;
 -- One scope lock serializes batch publication and absent-row/symbol races.
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:registry:'||s::text,0));
 FOR v IN SELECT x FROM jsonb_array_elements(batch)x ORDER BY x->'instrument'->>'id' LOOP
  i:=v->'instrument'; r:=v->'rules'; ident:=i->>'id';
  IF NOT ctp_market.snapshot_keys(v,ARRAY['instrument','rules']) OR octet_length(v::text)>32768
  OR NOT ctp_market.snapshot_keys(i,ARRAY['id','scope','exchangeSymbol','displaySymbol','baseAsset','quoteAsset','settlementAsset','contract','expiryAt','status','metadataVersion'])
  OR NOT ctp_market.snapshot_keys(r,ARRAY['instrumentId','scope','version','effectiveAt','expiresAt','tickSize','stepSize','minQuantity','maxQuantity','marketMinQuantity','marketMaxQuantity','minNotional','maxNotional','minPrice','maxPrice','quantityUnit','pricePrecision','quantityPrecision','orderTypes','timeInForce','leverageTiers'])
  OR i->'scope' IS DISTINCT FROM s OR r->'scope' IS DISTINCT FROM s OR r->>'instrumentId' IS DISTINCT FROM ident
  OR jsonb_typeof(r->'instrumentId') IS DISTINCT FROM 'string'
  OR i->>'status' NOT IN('TRADING','HALTED','DELISTED')
  OR jsonb_typeof(i->'status') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  FOREACH k IN ARRAY ARRAY['id','exchangeSymbol','displaySymbol','baseAsset','quoteAsset','metadataVersion'] LOOP
   IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR length(i->>k) NOT BETWEEN 1 AND 128
   OR i->>k ~ '[[:cntrl:]]' OR (k<>'displaySymbol' AND i->>k ~ '[[:space:]]') THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  END LOOP;
  IF i->>'displaySymbol' !~ '^[A-Z0-9._:/-]{1,96}$' OR i->>'baseAsset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'
  OR i->>'quoteAsset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$' OR i->>'baseAsset'=i->>'quoteAsset'
  OR (s->>'market'='SPOT' AND (i->'contract'<>'null'::jsonb OR i->'expiryAt'<>'null'::jsonb OR i->'settlementAsset'<>'null'::jsonb))
  THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  IF s->>'market'<>'SPOT' THEN
   IF NOT ctp_market.snapshot_keys(i->'contract',ARRAY['size','unit','version'])
   OR jsonb_typeof(i->'contract'->'size') IS DISTINCT FROM 'string' OR i->'contract'->>'size' !~ '^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$'
   OR (i->'contract'->>'size')::numeric<=0 OR jsonb_typeof(i->'contract'->'version') IS DISTINCT FROM 'string'
   OR length(i->'contract'->>'version') NOT BETWEEN 1 AND 128 OR i->'contract'->>'version' ~ '[[:space:][:cntrl:]]'
   OR jsonb_typeof(i->'contract'->'unit') IS DISTINCT FROM 'string' OR i->'contract'->>'unit' NOT IN('BASE','QUOTE')
   OR jsonb_typeof(i->'settlementAsset') IS DISTINCT FROM 'string' OR i->>'settlementAsset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'
   OR (s->>'market' LIKE 'LINEAR%' AND (i->>'settlementAsset'<>i->>'quoteAsset' OR i->'contract'->>'unit'<>'BASE'))
   OR (s->>'market' LIKE 'INVERSE%' AND (i->>'settlementAsset'<>i->>'baseAsset' OR i->'contract'->>'unit'<>'QUOTE'))
   OR (s->>'market' LIKE '%FUTURE' AND (jsonb_typeof(i->'expiryAt') IS DISTINCT FROM 'number' OR i->>'expiryAt' !~ '^(0|[1-9][0-9]{0,15})$' OR (i->>'expiryAt')::numeric>8640000000000000))
   OR (s->>'market' LIKE '%PERPETUAL' AND i->'expiryAt'<>'null'::jsonb)
   THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  END IF;
  IF jsonb_typeof(r->'version') IS DISTINCT FROM 'string' OR length(r->>'version') NOT BETWEEN 1 AND 128 OR r->>'version' ~ '[[:space:][:cntrl:]]'
  OR jsonb_typeof(r->'effectiveAt') IS DISTINCT FROM 'number' OR r->>'effectiveAt' !~ '^(0|[1-9][0-9]{0,15})$'
  OR jsonb_typeof(r->'expiresAt') IS DISTINCT FROM 'number' OR r->>'expiresAt' !~ '^(0|[1-9][0-9]{0,15})$'
  OR (r->>'effectiveAt')::numeric>floor(extract(epoch FROM clock_timestamp())*1000)
  OR (r->>'expiresAt')::numeric<=floor(extract(epoch FROM clock_timestamp())*1000)
  OR (r->>'expiresAt')::numeric<=(r->>'effectiveAt')::numeric
  OR (r->>'expiresAt')::numeric>8640000000000000
  OR jsonb_typeof(r->'quantityUnit') IS DISTINCT FROM 'string' OR r->>'quantityUnit' NOT IN('BASE','CONTRACTS')
  OR jsonb_typeof(r->'leverageTiers') IS DISTINCT FROM 'array'
  OR (s->>'market'='SPOT' AND (r->>'quantityUnit'<>'BASE' OR jsonb_array_length(r->'leverageTiers')<>0))
  THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  FOREACH k IN ARRAY ARRAY['tickSize','stepSize','minQuantity','maxQuantity','marketMinQuantity','marketMaxQuantity','minNotional','maxNotional','minPrice','maxPrice'] LOOP
   IF k IN('maxNotional','minPrice','maxPrice') AND r->k='null'::jsonb THEN CONTINUE; END IF;
   IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' OR r->>k !~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{0,17}[1-9])?$'
   OR (k<>'maxNotional' AND length(split_part(r->>k,'.',1))>20) THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
   n:=(r->>k)::numeric;
   IF n<0 OR (k<>'minNotional' AND n=0) THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['pricePrecision','quantityPrecision'] LOOP
   IF jsonb_typeof(r->k) IS DISTINCT FROM 'number' OR r->>k !~ '^(0|[1-9][0-9]?)$' OR (r->>k)::integer>18 THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  END LOOP;
  IF (r->>'minQuantity')::numeric>(r->>'maxQuantity')::numeric OR (r->>'marketMinQuantity')::numeric>(r->>'marketMaxQuantity')::numeric
  OR (r->>'minNotional')::numeric>(r->>'maxNotional')::numeric OR (r->>'minPrice')::numeric>(r->>'maxPrice')::numeric
  OR length(split_part(r->>'tickSize','.',2))>(r->>'pricePrecision')::integer
  OR length(split_part(r->>'stepSize','.',2))>(r->>'quantityPrecision')::integer THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  FOREACH k IN ARRAY ARRAY['orderTypes','timeInForce'] LOOP
   IF jsonb_typeof(r->k) IS DISTINCT FROM 'array' OR jsonb_array_length(r->k) NOT BETWEEN 1 AND 4
   OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(r->k)x)<>jsonb_array_length(r->k)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->k)x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR
    (k='orderTypes' AND x#>>'{}' NOT IN('MARKET','LIMIT','STOP_MARKET','STOP_LIMIT')) OR
    (k='timeInForce' AND x#>>'{}' NOT IN('GTC','IOC','FOK','POST_ONLY'))) THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  END LOOP;
  IF jsonb_array_length(r->'leverageTiers')>64 THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
  last_cap:=0;
  FOR tier IN SELECT x FROM jsonb_array_elements(r->'leverageTiers')x LOOP
   IF NOT ctp_market.snapshot_keys(tier,ARRAY['notionalCap','maxLeverage']) OR jsonb_typeof(tier->'notionalCap') IS DISTINCT FROM 'string'
   OR tier->>'notionalCap' !~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{0,17}[1-9])?$' OR (tier->>'notionalCap')::numeric<=last_cap
   OR jsonb_typeof(tier->'maxLeverage') IS DISTINCT FROM 'string' OR tier->>'maxLeverage' !~ '^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$'
   OR (tier->>'maxLeverage')::numeric<=0 THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
   last_cap:=(tier->>'notionalCap')::numeric;
  END LOOP;
  SELECT * INTO previous FROM ctp_registry.current_record WHERE scope=s AND id=ident FOR UPDATE;
  IF previous.record IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ctp_registry.record_revision h WHERE h.scope=s AND h.id=ident AND h.revision=previous.revision AND h.record=previous.record) THEN RAISE EXCEPTION 'REGISTRY_HISTORY_INCOMPLETE'; END IF;
  IF previous.record IS NOT NULL AND EXISTS(SELECT 1 FROM unnest(ARRAY['rules','instrument']) evidence(kind) WHERE NOT EXISTS(
   SELECT 1 FROM ctp_registry.version_history h WHERE h.scope=s AND h.id=ident AND h.kind=evidence.kind
   AND h.version=CASE WHEN evidence.kind='rules' THEN previous.record->'rules'->>'version' ELSE previous.record->'instrument'->>'metadataVersion' END
   AND h.payload=previous.record->evidence.kind AND h.revision<=previous.revision)) THEN RAISE EXCEPTION 'REGISTRY_HISTORY_INCOMPLETE'; END IF;
  IF FOUND AND previous.record=v THEN
   result:=result||jsonb_build_array(jsonb_build_object('revision',previous.revision::text,'record',previous.record)); CONTINUE;
  END IF;
  IF previous.revision=9223372036854775807 THEN RAISE EXCEPTION 'REGISTRY_REVISION'; END IF;
  IF previous.record IS NOT NULL AND (r->>'effectiveAt')::numeric<(previous.record->'rules'->>'effectiveAt')::numeric THEN RAISE EXCEPTION 'REGISTRY_REGRESSION'; END IF;
  rev:=COALESCE(previous.revision,0)+1;
  FOREACH part IN ARRAY ARRAY['rules','instrument'] LOOP
   ver:=CASE WHEN part='rules' THEN r->>'version' ELSE i->>'metadataVersion' END;
   IF EXISTS(SELECT 1 FROM ctp_registry.version_history h WHERE h.scope=s AND h.id=ident AND h.kind=part AND h.version=ver) THEN
    IF previous.record->part IS DISTINCT FROM v->part THEN RAISE EXCEPTION 'REGISTRY_VERSION_REUSE'; END IF;
   ELSE
    INSERT INTO ctp_registry.version_history(scope,id,kind,version,revision,payload) VALUES(s,ident,part,ver,rev,v->part);
   END IF;
  END LOOP;
  INSERT INTO ctp_registry.record_revision(scope,id,revision,previous_revision,record) VALUES(s,ident,rev,previous.revision,v);
  INSERT INTO ctp_registry.current_record(scope,id,revision,record) VALUES(s,ident,rev,v)
   ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision,record=excluded.record;
  result:=result||jsonb_build_array(jsonb_build_object('revision',rev::text,'record',v));
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION ctp_registry.read_current(s jsonb,ids jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_instrument_registry') THEN RAISE EXCEPTION 'REGISTRY_ROLE_UNSAFE'; END IF;
 IF NOT COALESCE(ctp_registry.valid_scope(s),false) OR jsonb_typeof(ids) IS DISTINCT FROM 'array' OR jsonb_array_length(ids) NOT BETWEEN 1 AND 300
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(ids)v WHERE jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 128 OR v#>>'{}' ~ '[[:space:][:cntrl:]]')
 OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(ids)v)<>jsonb_array_length(ids) THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_registry.current_record c WHERE c.scope=s AND c.id IN(SELECT jsonb_array_elements_text(ids))
  AND NOT EXISTS(SELECT 1 FROM ctp_registry.record_revision h WHERE h.scope=c.scope AND h.id=c.id AND h.revision=c.revision AND h.record=c.record)) THEN RAISE EXCEPTION 'REGISTRY_HISTORY_INCOMPLETE'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_registry.current_record c CROSS JOIN unnest(ARRAY['rules','instrument']) part
  WHERE c.scope=s AND c.id IN(SELECT jsonb_array_elements_text(ids)) AND NOT EXISTS(
   SELECT 1 FROM ctp_registry.version_history h WHERE h.scope=c.scope AND h.id=c.id AND h.kind=part
   AND h.version=CASE WHEN part='rules' THEN c.record->'rules'->>'version' ELSE c.record->'instrument'->>'metadataVersion' END
   AND h.payload=c.record->part AND h.revision<=c.revision)) THEN RAISE EXCEPTION 'REGISTRY_HISTORY_INCOMPLETE'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',revision::text,'record',record) ORDER BY id)
  FROM ctp_registry.current_record WHERE scope=s AND id IN(SELECT jsonb_array_elements_text(ids))),'[]'::jsonb);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA ctp_registry FROM PUBLIC,ctp_instrument_registry;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ctp_registry FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_registry.publish(jsonb,jsonb),ctp_registry.read_current(jsonb,jsonb) TO ctp_instrument_registry;
COMMIT;
