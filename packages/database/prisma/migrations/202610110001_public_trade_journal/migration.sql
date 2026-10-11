BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_market_trade') THEN
 CREATE ROLE ctp_market_trade NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_market TO ctp_market_trade;

-- Global public Spot evidence only. These tables contain no tenant, account,
-- credentials, monetary allocations or execution authority. Retain the journal,
-- original seals, native identities and heads together across backup/restart.
CREATE TABLE ctp_market.trade_event (
 id uuid PRIMARY KEY, key jsonb NOT NULL, payload text NOT NULL CHECK(octet_length(payload)<=1048576),
 hash bytea NOT NULL CHECK(hash=sha256(convert_to(payload,'UTF8'))),
 revision bigint NOT NULL CHECK(revision>0), status text NOT NULL CHECK(status IN('APPLIED','DUPLICATE','RESYNC_REQUIRED'))
);
CREATE INDEX trade_event_partition ON ctp_market.trade_event(key);
CREATE INDEX trade_event_native_identity ON ctp_market.trade_event(key,((payload::jsonb)->'trade'->>'identityScope'),((payload::jsonb)->'trade'->>'tradeId')) WHERE (payload::jsonb)->>'kind'='TRADE';
CREATE TABLE ctp_market.trade_seal (
 id uuid PRIMARY KEY REFERENCES ctp_market.trade_event(id), key jsonb NOT NULL,
 hash bytea NOT NULL CHECK(octet_length(hash)=32), revision bigint NOT NULL CHECK(revision>0),
 status text NOT NULL CHECK(status IN('APPLIED','DUPLICATE','RESYNC_REQUIRED')),
 native_identity jsonb CHECK(native_identity IS NULL OR jsonb_typeof(native_identity)='object')
);
CREATE INDEX trade_seal_watermark ON ctp_market.trade_seal(key,revision DESC);
CREATE INDEX trade_seal_native_identity ON ctp_market.trade_seal(native_identity) WHERE native_identity IS NOT NULL;
CREATE TABLE ctp_market.native_trade_seen (
 identity jsonb PRIMARY KEY, event uuid NOT NULL REFERENCES ctp_market.trade_event(id), payload jsonb NOT NULL
);
CREATE INDEX native_trade_seen_partition ON ctp_market.native_trade_seen((identity->'partition'));
CREATE TABLE ctp_market.trade_head (
 key jsonb PRIMARY KEY, revision bigint NOT NULL CHECK(revision>0),
 event uuid NOT NULL REFERENCES ctp_market.trade_event(id), native uuid REFERENCES ctp_market.trade_event(id), gap boolean NOT NULL
);
CREATE TRIGGER trade_event_immutable BEFORE UPDATE OR DELETE ON ctp_market.trade_event FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER trade_event_no_truncate BEFORE TRUNCATE ON ctp_market.trade_event FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER trade_seal_immutable BEFORE UPDATE OR DELETE ON ctp_market.trade_seal FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER trade_seal_no_truncate BEFORE TRUNCATE ON ctp_market.trade_seal FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER native_trade_seen_immutable BEFORE UPDATE OR DELETE ON ctp_market.native_trade_seen FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER native_trade_seen_no_truncate BEFORE TRUNCATE ON ctp_market.native_trade_seen FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER trade_head_no_truncate BEFORE TRUNCATE ON ctp_market.trade_head FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE FUNCTION ctp_market.trade_head_monotonic() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.key<>OLD.key OR NEW.revision::numeric<>OLD.revision::numeric+1 OR (OLD.gap AND NOT NEW.gap) THEN RAISE EXCEPTION 'MARKET_TRADE_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trade_head_monotonic BEFORE UPDATE OR DELETE ON ctp_market.trade_head FOR EACH ROW EXECUTE FUNCTION ctp_market.trade_head_monotonic();

CREATE FUNCTION ctp_market.trade_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_market_trade' AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_market_trade','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_market_trade' AND pg_has_role(session_user,r.oid,'MEMBER'))
 AND NOT has_database_privilege(session_user,current_database(),'CREATE,TEMP')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND (has_schema_privilege(session_user,n.oid,'CREATE') OR pg_has_role(session_user,n.nspowner,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p','v','m','f')
  AND (pg_has_role(session_user,t.relowner,'MEMBER') OR has_table_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(session_user,f.oid,'EXECUTE')
  AND (n.nspname||'.'||f.proname||'('||replace(oidvectortypes(f.proargtypes),' ','')||')') NOT IN('ctp_market.publish_trade(text,text)','ctp_market.read_trade(jsonb,integer)','ctp_market.trade_head_state(jsonb)'))
$$;
CREATE FUNCTION ctp_market.trade_id(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN 1 AND 128 AND v#>>'{}' !~ '[^!-~]',false)
$$;
CREATE FUNCTION ctp_market.trade_key(k jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(ctp_market.snapshot_key(k) AND k->'scope'->>'market'='SPOT' AND ctp_market.trade_id(k->'instrumentId'),false)
$$;
CREATE FUNCTION ctp_market.trade_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE t jsonb; i jsonb; BEGIN
 IF NOT ctp_market.snapshot_keys(p,CASE WHEN p->>'kind'='GAP' THEN ARRAY['id','key','expectedRevision','timestamp','kind','reason'] ELSE ARRAY['id','key','expectedRevision','timestamp','kind','record','trade'] END)
 OR ctp_market.trade_key(p->'key') IS NOT TRUE OR jsonb_typeof(p->'id')<>'string' OR p->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p->'expectedRevision')<>'string' OR p->>'expectedRevision' !~ '^(0|[1-9][0-9]{0,18})$' OR (p->>'expectedRevision')::numeric>=9223372036854775807
 OR NOT ctp_risk.loss_number(p->'timestamp') THEN RETURN false; END IF;
 IF p->>'kind'='GAP' THEN RETURN jsonb_typeof(p->'reason')='string' AND p->>'reason' ~ '^[A-Z][A-Z0-9_]{0,63}$'; END IF;
 IF p->>'kind'<>'TRADE' OR NOT ctp_market.snapshot_keys(p->'record',ARRAY['instrument','rules']) THEN RETURN false; END IF;
 i:=p->'record'->'instrument'; t:=p->'trade';
 RETURN ctp_market.snapshot_keys(i,ARRAY['id','scope','exchangeSymbol','displaySymbol','baseAsset','quoteAsset','settlementAsset','contract','expiryAt','status','metadataVersion'])
 AND i->>'status'='TRADING' AND i->>'id'=p->'key'->>'instrumentId' AND i->'scope'=p->'key'->'scope' AND i->'contract'='null'::jsonb
 AND p->'record'->'rules'->'scope'=i->'scope' AND p->'record'->'rules'->>'instrumentId'=i->>'id' AND p->'record'->'rules'->>'quantityUnit'='BASE'
 AND ctp_market.trade_id(i->'metadataVersion')
 AND ctp_market.snapshot_keys(t,ARRAY['scope','instrumentId','receivedAt','exchangeTime','tradeId','identityScope','price','quantity','quantityUnit','side','sourceSequence'])
 AND t->'scope'=i->'scope' AND t->>'instrumentId'=i->>'id' AND t->>'quantityUnit'='BASE' AND t->>'side' IN('BUY','SELL')
 AND ctp_market.trade_id(t->'tradeId') AND ctp_market.trade_id(t->'identityScope')
 AND ctp_market.snapshot_decimal(t->'price') AND ctp_market.snapshot_decimal(t->'quantity')
 AND ctp_risk.loss_number(t->'receivedAt') AND ctp_risk.loss_number(t->'exchangeTime')
 AND (t->'sourceSequence'='null'::jsonb OR (jsonb_typeof(t->'sourceSequence')='string' AND t->>'sourceSequence' ~ '^(0|[1-9][0-9]{0,127})$'));
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_market.trade_fresh(p jsonb,age integer) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; v jsonb; BEGIN
 IF age IS NULL OR age NOT BETWEEN 1 AND 5000 THEN RETURN false; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(CASE WHEN p->>'kind'='GAP' THEN jsonb_build_array(p->'timestamp') ELSE jsonb_build_array(p->'timestamp',p->'trade'->'receivedAt',p->'trade'->'exchangeTime') END) LOOP
  IF NOT ctp_risk.loss_number(v) OR v::text::numeric>now_ms OR v::text::numeric<now_ms-age OR v::text::numeric>(p->>'timestamp')::numeric THEN RETURN false; END IF;
 END LOOP; RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_market.trade_proof(eid uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e ctp_market.trade_event; s ctp_market.trade_seal; n ctp_market.native_trade_seen; p jsonb; BEGIN
 SELECT * INTO e FROM ctp_market.trade_event WHERE id=eid;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
 SELECT * INTO s FROM ctp_market.trade_seal WHERE id=eid;
 IF NOT FOUND OR s.hash<>e.hash OR s.key<>e.key OR s.revision<>e.revision OR s.status<>e.status OR e.hash<>sha256(convert_to(e.payload,'UTF8')) THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
 p:=e.payload::jsonb;
 IF ctp_market.trade_valid(p) IS NOT TRUE OR (p->>'id')::uuid<>e.id OR (p->'key')-'dbRuleId'<>e.key THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
 IF s.native_identity IS DISTINCT FROM (CASE WHEN p->>'kind'='TRADE' THEN jsonb_build_object('partition',e.key,'identityScope',p->'trade'->>'identityScope','tradeId',p->'trade'->>'tradeId') ELSE NULL END) THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
 IF e.status='APPLIED' AND p->>'kind'='TRADE' THEN
  SELECT * INTO n FROM ctp_market.native_trade_seen WHERE identity=jsonb_build_object('partition',e.key,'identityScope',p->'trade'->>'identityScope','tradeId',p->'trade'->>'tradeId');
  IF NOT FOUND OR n.event<>eid OR n.payload<>(p->'trade')-'receivedAt' THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
 END IF; RETURN p;
END $$;
CREATE FUNCTION ctp_market.trade_checked_head(k jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h ctp_market.trade_head; e ctp_market.trade_event; p jsonb; watermark bigint; BEGIN
 SELECT * INTO h FROM ctp_market.trade_head WHERE key=k;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM ctp_market.trade_event WHERE key=k) OR EXISTS(SELECT 1 FROM ctp_market.trade_seal WHERE key=k) OR EXISTS(SELECT 1 FROM ctp_market.native_trade_seen WHERE identity->'partition'=k) THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
  RETURN jsonb_build_object('revision','0','gap',false);
 END IF;
 p:=ctp_market.trade_proof(h.event); SELECT * INTO e FROM ctp_market.trade_event WHERE id=h.event;
 SELECT revision INTO watermark FROM ctp_market.trade_seal WHERE key=k ORDER BY revision DESC LIMIT 1;
 IF e.key<>k OR e.revision<>h.revision OR watermark IS DISTINCT FROM h.revision OR e.status='DUPLICATE'
 OR h.gap<>(e.status='RESYNC_REQUIRED' OR p->>'kind'='GAP') OR (NOT h.gap AND h.native IS DISTINCT FROM h.event) THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
 IF h.native IS NOT NULL THEN PERFORM ctp_market.trade_proof(h.native); END IF;
 RETURN jsonb_build_object('revision',h.revision::text,'gap',h.gap);
END $$;
CREATE FUNCTION ctp_market.publish_trade(raw text,hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; k jsonb; state jsonb; old ctp_market.trade_event; h ctp_market.trade_head; seen ctp_market.native_trade_seen;
 native_key jsonb; last_p jsonb; native uuid; v bigint; result text:='APPLIED'; gap boolean; BEGIN
 IF ctp_market.trade_runtime() IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_ROLE_UNSAFE'; END IF;
 IF raw IS NULL OR octet_length(raw)>1048576 OR hash IS NULL OR hash !~ '^[a-f0-9]{64}$' OR decode(hash,'hex')<>sha256(convert_to(raw,'UTF8')) THEN RAISE EXCEPTION 'MARKET_TRADE_INPUT'; END IF;
 BEGIN p:=raw::jsonb; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'MARKET_TRADE_INPUT'; END;
 IF ctp_market.trade_valid(p) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_INPUT'; END IF;
 k:=(p->'key')-'dbRuleId';
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:market:trade:'||k::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:market:trade-event:'||(p->>'id'),0));
 SELECT * INTO old FROM ctp_market.trade_event WHERE id=(p->>'id')::uuid;
 IF FOUND THEN
  PERFORM ctp_market.trade_proof(old.id);
  PERFORM ctp_market.trade_checked_head(old.key);
  IF old.payload::jsonb<>p THEN RAISE EXCEPTION 'MARKET_TRADE_CONFLICT'; END IF;
  RETURN jsonb_build_object('id',old.id,'revision',old.revision::text,'status',old.status);
 END IF;
 state:=ctp_market.trade_checked_head(k);
 IF state->>'revision'<>p->>'expectedRevision' THEN RAISE EXCEPTION 'MARKET_TRADE_STALE'; END IF;
 IF ctp_market.trade_fresh(p,5000) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_STALE'; END IF;
 SELECT * INTO h FROM ctp_market.trade_head WHERE key=k;
 v:=(state->>'revision')::bigint+1; gap:=COALESCE(h.gap,false) OR p->>'kind'='GAP'; native:=h.native;
 IF p->>'kind'='TRADE' THEN
  IF ctp_market.snapshot_metadata(p) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_METADATA'; END IF;
  native_key:=jsonb_build_object('partition',k,'identityScope',p->'trade'->>'identityScope','tradeId',p->'trade'->>'tradeId');
  SELECT * INTO seen FROM ctp_market.native_trade_seen WHERE identity=native_key;
  IF FOUND THEN
   last_p:=ctp_market.trade_proof(seen.event);
   IF last_p->>'kind'<>'TRADE' OR (last_p->'key')-'dbRuleId'<>k
   OR last_p->'trade'->>'identityScope'<>p->'trade'->>'identityScope' OR last_p->'trade'->>'tradeId'<>p->'trade'->>'tradeId'
   OR seen.payload<>(last_p->'trade')-'receivedAt' THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
   IF seen.payload=(p->'trade')-'receivedAt' THEN result:='DUPLICATE'; v:=h.revision;
   ELSE result:='RESYNC_REQUIRED'; gap:=true; END IF;
  ELSE
   -- Missing historical identities cannot become new trades after the head
   -- advances. Independently indexed seals retain their prior existence.
   IF EXISTS(SELECT 1 FROM ctp_market.trade_seal WHERE native_identity=native_key)
   OR EXISTS(SELECT 1 FROM ctp_market.trade_event WHERE key=k AND (payload::jsonb)->>'kind'='TRADE'
    AND (payload::jsonb)->'trade'->>'identityScope'=p->'trade'->>'identityScope' AND (payload::jsonb)->'trade'->>'tradeId'=p->'trade'->>'tradeId')
   THEN RAISE EXCEPTION 'MARKET_TRADE_CORRUPT'; END IF;
   IF native IS NOT NULL THEN
    last_p:=ctp_market.trade_proof(native);
    IF p->'trade'->>'identityScope'<>last_p->'trade'->>'identityScope'
    OR (p->'trade'->'sourceSequence'='null'::jsonb)<>(last_p->'trade'->'sourceSequence'='null'::jsonb)
    OR (p->'trade'->>'exchangeTime')::numeric<(last_p->'trade'->>'exchangeTime')::numeric
    OR (p->'trade'->'sourceSequence'<>'null'::jsonb AND (p->'trade'->>'sourceSequence')::numeric<=(last_p->'trade'->>'sourceSequence')::numeric)
    THEN result:='RESYNC_REQUIRED'; gap:=true; END IF;
   END IF;
   IF gap THEN result:='RESYNC_REQUIRED'; ELSE native:=(p->>'id')::uuid; END IF;
  END IF;
 END IF;
 INSERT INTO ctp_market.trade_event(id,key,payload,hash,revision,status) VALUES((p->>'id')::uuid,k,raw,decode(hash,'hex'),v,result);
 INSERT INTO ctp_market.trade_seal(id,key,hash,revision,status,native_identity) VALUES((p->>'id')::uuid,k,decode(hash,'hex'),v,result,native_key);
 IF p->>'kind'='TRADE' AND seen.event IS NULL THEN
  INSERT INTO ctp_market.native_trade_seen(identity,event,payload) VALUES(native_key,(p->>'id')::uuid,(p->'trade')-'receivedAt');
 END IF;
 IF result<>'DUPLICATE' THEN
  INSERT INTO ctp_market.trade_head(key,revision,event,native,gap) VALUES(k,v,(p->>'id')::uuid,native,gap)
  ON CONFLICT(key) DO UPDATE SET revision=EXCLUDED.revision,event=EXCLUDED.event,native=EXCLUDED.native,gap=EXCLUDED.gap;
 END IF;
 RETURN jsonb_build_object('id',p->>'id','revision',v::text,'status',result);
END $$;
CREATE FUNCTION ctp_market.trade_head_state(k jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF ctp_market.trade_runtime() IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_ROLE_UNSAFE'; END IF;
 IF ctp_market.trade_key(k) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_INPUT'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:market:trade:'||(k-'dbRuleId')::text,0));
 RETURN ctp_market.trade_checked_head(k-'dbRuleId');
END $$;
CREATE FUNCTION ctp_market.read_trade(k jsonb,age integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE state jsonb; h ctp_market.trade_head; e ctp_market.trade_event; p jsonb; BEGIN
 IF ctp_market.trade_runtime() IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_ROLE_UNSAFE'; END IF;
 IF ctp_market.trade_key(k) IS NOT TRUE OR age IS NULL OR age NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'MARKET_TRADE_INPUT'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:market:trade:'||(k-'dbRuleId')::text,0));
 state:=ctp_market.trade_checked_head(k-'dbRuleId');
 IF state->>'revision'='0' THEN RAISE EXCEPTION 'MARKET_TRADE_MISSING'; END IF;
 IF state->'gap'='true'::jsonb THEN RAISE EXCEPTION 'MARKET_TRADE_RESYNC_REQUIRED'; END IF;
 SELECT * INTO h FROM ctp_market.trade_head WHERE key=k-'dbRuleId';
 SELECT * INTO e FROM ctp_market.trade_event WHERE id=h.native; p:=ctp_market.trade_proof(e.id);
 IF p->'key'<>k OR ctp_market.snapshot_metadata(p) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_METADATA'; END IF;
 IF ctp_market.trade_fresh(p,age) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_TRADE_STALE'; END IF;
 RETURN jsonb_build_object('id',e.id,'revision',h.revision::text,'text',e.payload,'hash',encode(e.hash,'hex'));
END $$;
REVOKE ALL ON ctp_market.trade_event,ctp_market.trade_seal,ctp_market.native_trade_seen,ctp_market.trade_head FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_market.trade_head_monotonic(),ctp_market.trade_runtime(),ctp_market.trade_id(jsonb),ctp_market.trade_key(jsonb),ctp_market.trade_valid(jsonb),ctp_market.trade_fresh(jsonb,integer),ctp_market.trade_proof(uuid),ctp_market.trade_checked_head(jsonb),ctp_market.publish_trade(text,text),ctp_market.trade_head_state(jsonb),ctp_market.read_trade(jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_market.publish_trade(text,text),ctp_market.trade_head_state(jsonb),ctp_market.read_trade(jsonb,integer) TO ctp_market_trade;
COMMIT;
