BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_market_snapshot') THEN CREATE ROLE ctp_market_snapshot NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;
GRANT USAGE ON SCHEMA ctp_market TO ctp_market_snapshot;

-- Public native Market Data only. No tenant/accounting facts are accepted here.
CREATE TABLE ctp_market.snapshot_event (
 id uuid PRIMARY KEY, key jsonb NOT NULL, payload text NOT NULL CHECK(octet_length(payload)<=1048576),
 hash bytea NOT NULL CHECK(hash=sha256(convert_to(payload,'UTF8'))),
 revision bigint NOT NULL CHECK(revision>0), status text NOT NULL CHECK(status IN('APPLIED','DUPLICATE','RESYNC_REQUIRED')),
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ctp_market.snapshot_head (
 key jsonb PRIMARY KEY, revision bigint NOT NULL CHECK(revision>0),
 event uuid NOT NULL REFERENCES ctp_market.snapshot_event(id),
 native uuid REFERENCES ctp_market.snapshot_event(id), gap boolean NOT NULL
);
CREATE TRIGGER snapshot_event_immutable BEFORE UPDATE OR DELETE ON ctp_market.snapshot_event FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE FUNCTION ctp_market.snapshot_head_monotonic() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.key<>OLD.key OR NEW.revision::numeric<>OLD.revision::numeric+1 THEN RAISE EXCEPTION 'MARKET_EVIDENCE_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshot_head_monotonic BEFORE UPDATE OR DELETE ON ctp_market.snapshot_head FOR EACH ROW EXECUTE FUNCTION ctp_market.snapshot_head_monotonic();
CREATE FUNCTION ctp_market.snapshot_keys(p jsonb,k text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(p)='object' AND p ?& k AND (SELECT count(*) FROM jsonb_object_keys(p))=cardinality(k),false)
$$;
CREATE FUNCTION ctp_market.snapshot_key(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 RETURN ctp_market.snapshot_keys(p,ARRAY['scope','instrumentId','dbInstrumentId','dbRuleId'])
 AND ctp_market.snapshot_keys(p->'scope',ARRAY['exchange','region','market','environment'])
 AND p->'scope'->>'exchange' IN('BINANCE','BYBIT','OKX','HTX')
 AND p->'scope'->>'market' IN('SPOT','LINEAR_PERPETUAL','INVERSE_PERPETUAL','LINEAR_FUTURE','INVERSE_FUTURE')
 AND p->'scope'->>'environment' IN('TESTNET','DEMO','LIVE')
 AND p->'scope'->>'region' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
 AND jsonb_typeof(p->'instrumentId')='string' AND length(p->>'instrumentId') BETWEEN 1 AND 128 AND p->>'instrumentId' !~ '[[:space:][:cntrl:]]'
 AND p->>'dbInstrumentId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND p->>'dbRuleId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(p->'scope') x WHERE jsonb_typeof(x.value)<>'string');
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_market.snapshot_decimal(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(v)='string' AND v#>>'{}' ~ '^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$' AND (v#>>'{}')::numeric>0,false)
$$;
CREATE FUNCTION ctp_market.snapshot_observed(p jsonb,signed_value boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'state'='UNAVAILABLE' THEN RETURN ctp_market.snapshot_keys(p,ARRAY['state','reason']) AND p->>'reason' IN('NOT_PROVIDED','NO_EXECUTIONS','STALE'); END IF;
 IF NOT ctp_market.snapshot_keys(p,ARRAY['state','value']) OR p->>'state'<>'AVAILABLE' OR jsonb_typeof(p->'value')<>'string' THEN RETURN false; END IF;
 RETURN p->>'value'<>'-0' AND p->>'value' ~ CASE WHEN signed_value THEN '^-?(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$' ELSE '^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$' END;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_market.snapshot_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE b jsonb; t jsonb; i jsonb; side text; level jsonb; previous numeric; price numeric; BEGIN
 IF NOT ctp_market.snapshot_keys(p,CASE WHEN p->>'kind'='GAP' THEN ARRAY['id','key','expectedRevision','timestamp','kind','reason'] ELSE ARRAY['id','key','expectedRevision','timestamp','kind','record','ticker','book'] END)
 OR ctp_market.snapshot_key(p->'key') IS NOT TRUE OR jsonb_typeof(p->'id')<>'string'
 OR p->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p->'expectedRevision')<>'string' OR p->>'expectedRevision' !~ '^(0|[1-9][0-9]{0,18})$' OR (p->>'expectedRevision')::numeric>=9223372036854775807
 OR NOT ctp_risk.loss_number(p->'timestamp') THEN RETURN false; END IF;
 IF p->>'kind'='GAP' THEN RETURN jsonb_typeof(p->'reason')='string' AND p->>'reason' ~ '^[A-Z][A-Z0-9_]{0,63}$'; END IF;
 IF p->>'kind'<>'SNAPSHOT' OR NOT ctp_market.snapshot_keys(p->'record',ARRAY['instrument','rules']) THEN RETURN false; END IF;
 i:=p->'record'->'instrument'; b:=p->'book'; t:=p->'ticker';
 IF NOT ctp_market.snapshot_keys(i,ARRAY['id','scope','exchangeSymbol','displaySymbol','baseAsset','quoteAsset','settlementAsset','contract','expiryAt','status','metadataVersion'])
 OR i->>'status'<>'TRADING' OR i->>'id'<>p->'key'->>'instrumentId'
 OR i->'scope'<>p->'key'->'scope' OR p->'record'->'rules'->'scope'<>i->'scope' OR p->'record'->'rules'->>'instrumentId'<>i->>'id'
 OR jsonb_typeof(i->'metadataVersion')<>'string' OR length(i->>'metadataVersion') NOT BETWEEN 1 AND 128
 OR NOT ctp_market.snapshot_keys(t,ARRAY['scope','instrumentId','receivedAt','exchangeTime','last','bid','ask','baseVolume','quoteVolume','change','freshness'])
 OR t->'scope'<>i->'scope' OR t->>'instrumentId'<>i->>'id' OR t->>'freshness'<>'FRESH'
 OR NOT ctp_risk.loss_number(t->'receivedAt') OR NOT ctp_risk.loss_number(t->'exchangeTime')
 OR NOT ctp_market.snapshot_observed(t->'last') OR NOT ctp_market.snapshot_observed(t->'bid') OR NOT ctp_market.snapshot_observed(t->'ask')
 OR (t->'last'->>'state'='AVAILABLE' AND NOT ctp_market.snapshot_decimal(t->'last'->'value'))
 OR (t->'bid'->>'state'='AVAILABLE' AND NOT ctp_market.snapshot_decimal(t->'bid'->'value'))
 OR (t->'ask'->>'state'='AVAILABLE' AND NOT ctp_market.snapshot_decimal(t->'ask'->'value'))
 OR NOT ctp_market.snapshot_observed(t->'baseVolume') OR NOT ctp_market.snapshot_observed(t->'quoteVolume') OR NOT ctp_market.snapshot_observed(t->'change',true)
 OR NOT ctp_market.snapshot_keys(b,ARRAY['scope','instrumentId','receivedAt','exchangeTime','kind','bids','asks','sourceSequence','previousSequence','checksum','snapshotVersion','stale'])
 OR b->'scope'<>i->'scope' OR b->>'instrumentId'<>i->>'id' OR b->>'kind'<>'SNAPSHOT' OR b->'stale'<>'false'::jsonb
 OR NOT ctp_risk.loss_number(b->'receivedAt') OR (b->'exchangeTime'<>'null'::jsonb AND NOT ctp_risk.loss_number(b->'exchangeTime'))
 OR (b->'sourceSequence'='null'::jsonb AND b->'exchangeTime'='null'::jsonb)
 OR (b->'sourceSequence'<>'null'::jsonb AND (jsonb_typeof(b->'sourceSequence')<>'string' OR b->>'sourceSequence' !~ '^(0|[1-9][0-9]{0,127})$'))
 OR b->'previousSequence'<>'null'::jsonb OR jsonb_typeof(b->'snapshotVersion')<>'string' OR length(b->>'snapshotVersion') NOT BETWEEN 1 AND 128
 OR (b->'checksum'<>'null'::jsonb AND (jsonb_typeof(b->'checksum')<>'string' OR length(b->>'checksum') NOT BETWEEN 1 AND 128)) THEN RETURN false; END IF;
 FOREACH side IN ARRAY ARRAY['bids','asks'] LOOP
  IF jsonb_typeof(b->side)<>'array' OR jsonb_array_length(b->side) NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
  previous:=NULL;
  FOR level IN SELECT value FROM jsonb_array_elements(b->side) LOOP
   IF NOT ctp_market.snapshot_keys(level,ARRAY['price','quantity']) OR NOT ctp_market.snapshot_decimal(level->'price') OR NOT ctp_market.snapshot_decimal(level->'quantity') THEN RETURN false; END IF;
   price:=(level->>'price')::numeric;
   IF previous IS NOT NULL AND ((side='bids' AND price>=previous) OR (side='asks' AND price<=previous)) THEN RETURN false; END IF; previous:=price;
  END LOOP;
 END LOOP;
 RETURN (b->'bids'->0->>'price')::numeric < (b->'asks'->0->>'price')::numeric;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;

CREATE FUNCTION ctp_market.snapshot_metadata(p jsonb) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i public.instrument; r public.instrument_rule_version; n jsonb; s jsonb; now_ms bigint; BEGIN
 SELECT * INTO i FROM public.instrument WHERE id=(p->'key'->>'dbInstrumentId')::uuid FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO r FROM public.instrument_rule_version WHERE id=(p->'key'->>'dbRuleId')::uuid AND "instrumentId"=i.id FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 n:=p->'record'->'instrument'; s:=p->'key'->'scope'; now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 RETURN i.active AND r."isCurrent" AND r."effectiveAt"<=clock_timestamp() AND r."fetchedAt"<=clock_timestamp()
 AND i.exchange::text=s->>'exchange' AND i.mode::text=s->>'environment'
 AND i.market::text=CASE s->>'market' WHEN 'SPOT' THEN 'SPOT' WHEN 'LINEAR_PERPETUAL' THEN 'PERPETUAL' WHEN 'INVERSE_PERPETUAL' THEN 'PERPETUAL' ELSE 'FUTURES' END
 AND i."exchangeSymbol"=n->>'exchangeSymbol' AND i."baseAsset"=n->>'baseAsset' AND i."quoteAsset"=n->>'quoteAsset'
 AND to_jsonb(i."settlementAsset") IS NOT DISTINCT FROM NULLIF(n->'settlementAsset','null'::jsonb)
 AND (CASE WHEN i."expiryAt" IS NULL THEN n->'expiryAt'='null'::jsonb ELSE (n->>'expiryAt')::numeric=floor(extract(epoch FROM i."expiryAt")*1000) END)
 AND i."isInverse"=(s->>'market' LIKE 'INVERSE_%') AND r.rules=p->'record'->'rules'
 AND r."priceTick"=(r.rules->>'tickSize')::numeric AND r."quantityStep"=(r.rules->>'stepSize')::numeric
 AND r."minQuantity"=(r.rules->>'minQuantity')::numeric
 AND r."maxQuantity" IS NOT DISTINCT FROM (r.rules->>'maxQuantity')::numeric
 AND r."minNotional" IS NOT DISTINCT FROM (r.rules->>'minNotional')::numeric
 AND floor(extract(epoch FROM r."effectiveAt")*1000)=(r.rules->>'effectiveAt')::numeric
 AND (r.rules->>'expiresAt')::numeric>now_ms
 AND (CASE WHEN s->>'market'='SPOT' THEN n->'contract'='null'::jsonb AND r."contractSize" IS NULL AND r."contractUnit" IS NULL ELSE
 ctp_market.snapshot_keys(n->'contract',ARRAY['size','unit','version']) AND r."contractSize"=(n->'contract'->>'size')::numeric AND r."contractUnit"=n->'contract'->>'unit' END);
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION ctp_market.snapshot_fresh(p jsonb,age integer) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE at_ms bigint; now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint; v jsonb; BEGIN
 IF age NOT BETWEEN 1 AND 5000 THEN RETURN false; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(jsonb_build_array(p->'timestamp',p->'ticker'->'exchangeTime',p->'ticker'->'receivedAt',p->'book'->'receivedAt',p->'book'->'exchangeTime')) LOOP
  IF v='null'::jsonb THEN CONTINUE; END IF;
  IF NOT ctp_risk.loss_number(v) THEN RETURN false; END IF; at_ms:=v::text::bigint;
  IF at_ms>now_ms OR at_ms<now_ms-age THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;

CREATE FUNCTION ctp_market.publish_snapshot(raw text,hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; k jsonb; h ctp_market.snapshot_head; old ctp_market.snapshot_event; last_p jsonb; b jsonb; lb jsonb; t jsonb; lt jsonb;
 v bigint; result text:='APPLIED'; is_gap boolean; native uuid; same_book boolean; same_ticker boolean; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_market_snapshot') THEN RAISE EXCEPTION 'MARKET_EVIDENCE_ROLE_UNSAFE'; END IF;
 IF raw IS NULL OR octet_length(raw)>1048576 OR hash IS NULL OR hash !~ '^[a-f0-9]{64}$' OR decode(hash,'hex')<>sha256(convert_to(raw,'UTF8')) THEN RAISE EXCEPTION 'MARKET_EVIDENCE_INPUT'; END IF;
 p:=raw::jsonb;
 IF ctp_market.snapshot_valid(p) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_EVIDENCE_INPUT'; END IF;
 k:=(p->'key')-'dbRuleId';
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:market:snapshot:'||k::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:market:event:'||(p->>'id'),0));
 SELECT * INTO old FROM ctp_market.snapshot_event WHERE id=(p->>'id')::uuid;
 IF FOUND THEN
  IF old.payload::jsonb<>p THEN RAISE EXCEPTION 'MARKET_EVIDENCE_CONFLICT'; END IF;
  RETURN jsonb_build_object('id',old.id,'revision',old.revision::text,'status',old.status);
 END IF;
 SELECT * INTO h FROM ctp_market.snapshot_head WHERE key=k;
 IF COALESCE(h.revision,0)<>(p->>'expectedRevision')::bigint THEN RAISE EXCEPTION 'MARKET_EVIDENCE_STALE'; END IF;
 v:=COALESCE(h.revision,0)+1; is_gap:=p->>'kind'='GAP'; native:=h.native;
 IF is_gap THEN
  IF (p->>'timestamp')::numeric>floor(extract(epoch FROM clock_timestamp())*1000) OR (p->>'timestamp')::numeric<floor(extract(epoch FROM clock_timestamp())*1000)-5000 THEN RAISE EXCEPTION 'MARKET_EVIDENCE_STALE'; END IF;
 ELSE
  IF ctp_market.snapshot_metadata(p) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_EVIDENCE_METADATA'; END IF;
  IF ctp_market.snapshot_fresh(p,5000) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_EVIDENCE_STALE'; END IF;
  IF h.native IS NOT NULL THEN
   SELECT payload::jsonb INTO last_p FROM ctp_market.snapshot_event WHERE id=h.native;
   b:=p->'book'; lb:=last_p->'book'; t:=p->'ticker'; lt:=last_p->'ticker';
   same_book:=(b-'receivedAt'-'snapshotVersion')=(lb-'receivedAt'-'snapshotVersion'); same_ticker:=(t-'receivedAt')=(lt-'receivedAt');
   -- Metadata replacement does not erase native ordering watermarks.
   IF (b->'sourceSequence'='null'::jsonb)<>(lb->'sourceSequence'='null'::jsonb)
   OR (b->'sourceSequence'<>'null'::jsonb AND ((b->>'sourceSequence')::numeric<(lb->>'sourceSequence')::numeric OR ((b->>'sourceSequence')::numeric=(lb->>'sourceSequence')::numeric AND NOT same_book)))
   OR (b->'sourceSequence'='null'::jsonb AND ((b->>'exchangeTime')::numeric<(lb->>'exchangeTime')::numeric OR ((b->>'exchangeTime')::numeric=(lb->>'exchangeTime')::numeric AND NOT same_book)))
   OR (t->>'exchangeTime')::numeric<(lt->>'exchangeTime')::numeric OR ((t->>'exchangeTime')::numeric=(lt->>'exchangeTime')::numeric AND NOT same_ticker)
   THEN result:='RESYNC_REQUIRED'; is_gap:=true;
   -- A newer ticker alone cannot refresh an unchanged sequence-only book receipt.
   ELSIF same_book THEN result:='DUPLICATE'; v:=h.revision;
   END IF;
  END IF;
  IF result='APPLIED' THEN native:=(p->>'id')::uuid; END IF;
 END IF;
 INSERT INTO ctp_market.snapshot_event(id,key,payload,hash,revision,status) VALUES((p->>'id')::uuid,k,raw,decode(hash,'hex'),v,result);
 IF result<>'DUPLICATE' THEN
  INSERT INTO ctp_market.snapshot_head(key,revision,event,native,gap) VALUES(k,v,(p->>'id')::uuid,native,is_gap)
  ON CONFLICT(key) DO UPDATE SET revision=EXCLUDED.revision,event=EXCLUDED.event,native=EXCLUDED.native,gap=EXCLUDED.gap;
 END IF;
 RETURN jsonb_build_object('id',p->>'id','revision',v::text,'status',result);
END $$;
CREATE FUNCTION ctp_market.read_snapshot(k jsonb,age integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h ctp_market.snapshot_head; e ctp_market.snapshot_event; p jsonb; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_market_snapshot') THEN RAISE EXCEPTION 'MARKET_EVIDENCE_ROLE_UNSAFE'; END IF;
 IF ctp_market.snapshot_key(k) IS NOT TRUE OR age IS NULL OR age NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'MARKET_EVIDENCE_INPUT'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:market:snapshot:'||(k-'dbRuleId')::text,0));
 SELECT * INTO h FROM ctp_market.snapshot_head WHERE key=k-'dbRuleId';
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKET_EVIDENCE_MISSING'; END IF;
 IF h.gap THEN RAISE EXCEPTION 'MARKET_EVIDENCE_RESYNC_REQUIRED'; END IF;
 SELECT * INTO e FROM ctp_market.snapshot_event WHERE id=h.native;
 p:=e.payload::jsonb;
 IF p->'key'<>k OR ctp_market.snapshot_valid(p) IS NOT TRUE OR ctp_market.snapshot_metadata(p) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_EVIDENCE_METADATA'; END IF;
 IF ctp_market.snapshot_fresh(p,age) IS NOT TRUE THEN RAISE EXCEPTION 'MARKET_EVIDENCE_STALE'; END IF;
 RETURN jsonb_build_object('id',e.id,'revision',h.revision::text,'text',e.payload,'hash',encode(e.hash,'hex'));
END $$;
REVOKE ALL ON ctp_market.snapshot_event,ctp_market.snapshot_head FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_market.snapshot_head_monotonic(),ctp_market.snapshot_keys(jsonb,text[]),ctp_market.snapshot_key(jsonb),ctp_market.snapshot_decimal(jsonb),ctp_market.snapshot_observed(jsonb,boolean),ctp_market.snapshot_valid(jsonb),ctp_market.snapshot_metadata(jsonb),ctp_market.snapshot_fresh(jsonb,integer),ctp_market.publish_snapshot(text,text),ctp_market.read_snapshot(jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_market.publish_snapshot(text,text),ctp_market.read_snapshot(jsonb,integer) TO ctp_market_snapshot;
COMMIT;
