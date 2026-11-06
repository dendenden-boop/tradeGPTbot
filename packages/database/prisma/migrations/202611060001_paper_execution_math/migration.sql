BEGIN;
-- Private deterministic calculation kernel for the future fixed execution
-- writer. No table, grant, permit, allocation or monetary mutation is added.
CREATE FUNCTION ctp_paper.execution_math_number(v jsonb,positive boolean DEFAULT false,wide boolean DEFAULT false) RETURNS numeric
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE n numeric; BEGIN
 IF positive IS NULL OR wide IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'string' OR v#>>'{}' !~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{0,17}[1-9])?$'
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 n:=(v#>>'{}')::numeric;
 IF (positive AND n<=0) OR (NOT wide AND n>=10::numeric^20) THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_RANGE'; END IF;
 RETURN n;
END $$;
CREATE FUNCTION ctp_paper.execution_math_amount(v numeric,signed boolean DEFAULT false) RETURNS text
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF signed IS NULL OR v IS NULL OR abs(v)>=10::numeric^20 OR scale(trim_scale(v))>18 OR (NOT signed AND v<0)
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_RANGE'; END IF;
 RETURN trim_scale(v)::text;
END $$;
CREATE FUNCTION ctp_paper.execution_math_id(v jsonb) RETURNS text
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 128 OR v#>>'{}' ~ '[[:space:][:cntrl:]]'
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 RETURN v#>>'{}';
END $$;
CREATE FUNCTION ctp_paper.execution_math_time(v jsonb) RETURNS bigint
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'number' OR v::text !~ '^(0|[1-9][0-9]{0,15})$' OR v::text::numeric>8640000000000000
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 RETURN v::text::bigint;
END $$;
CREATE FUNCTION ctp_paper.execution_math_seed(model jsonb,order_id text,purpose text,evidence_id text DEFAULT NULL) RETURNS numeric
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE b bytea; n numeric:=0; i integer; BEGIN
 b:=sha256(convert_to(ctp_admission.canonical(jsonb_build_object('model',model,'orderId',order_id,'purpose',purpose,'evidenceId',evidence_id)),'UTF8'));
 FOR i IN 0..31 LOOP n:=n*256+get_byte(b,i); END LOOP;
 RETURN n;
END $$;

CREATE FUNCTION ctp_paper.derive_pristine_buy(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE f jsonb:=p->'frame'; model jsonb:=f->'model'; rec jsonb:=f->'record'; inst jsonb:=rec->'instrument'; rules jsonb:=rec->'rules';
 book jsonb:=f->'book'; trade jsonb:=f->'trade'; cmd jsonb:=p->'order'; now_ms bigint; submitted bigint; eligible bigint;
 latency integer; jitter integer; age integer; order_id text:=p->>'orderId'; tick numeric; step numeric; qty numeric; participation numeric; fee_rate numeric; slip numeric;
 evidence_id text; book_hash text; trade_hash text; row jsonb; k text; cap numeric; volume numeric; filled numeric:=0; level_qty numeric; price numeric; raw_price numeric; take numeric; notional numeric; fee numeric;
 level integer; previous numeric; asks_used jsonb:='[]'; bids_used jsonb:='[]'; fills jsonb:='[]'; next_frame jsonb; status text; reason text; at_ms bigint; limit_price numeric; result jsonb;
BEGIN
 IF p IS NULL OR octet_length(p::text)>4194304
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['now','frame','order','orderId','submittedAt','executedQuantity','triggeredAt']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(f,ARRAY['model','record','book','trade','volumeUsed','asksUsed','bidsUsed']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(model,ARRAY['version','seed','takerFeeRate','maxSlippageRate','latencyMs','latencyJitterMs','participationRate','maxEvidenceAgeMs']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(rec,ARRAY['instrument','rules']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(inst,ARRAY['id','scope','exchangeSymbol','displaySymbol','baseAsset','quoteAsset','settlementAsset','contract','expiryAt','status','metadataVersion']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(rules,ARRAY['instrumentId','scope','version','effectiveAt','expiresAt','tickSize','stepSize','minQuantity','maxQuantity','marketMinQuantity','marketMaxQuantity','minNotional','maxNotional','minPrice','maxPrice','quantityUnit','pricePrecision','quantityPrecision','orderTypes','timeInForce','leverageTiers']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(book,ARRAY['scope','instrumentId','exchangeTime','receivedAt','kind','bids','asks','sourceSequence','previousSequence','checksum','snapshotVersion','stale']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(trade,ARRAY['scope','instrumentId','exchangeTime','receivedAt','tradeId','identityScope','price','quantity','quantityUnit','side','sourceSequence']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(cmd,ARRAY['instrumentId','ruleVersion','clientOrderId','side','type','size','limitPrice','trigger','timeInForce','reduceOnly']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(cmd->'size',ARRAY['kind','asset','value']),false)
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 -- Required strings and enum elements are checked independently. PostgreSQL
 -- NULL must never turn a negative admission predicate into an unknown IF.
 FOREACH k IN ARRAY ARRAY['id','exchangeSymbol','baseAsset','quoteAsset','metadataVersion'] LOOP PERFORM ctp_paper.execution_math_id(inst->k); END LOOP;
 FOREACH k IN ARRAY ARRAY['instrumentId','version'] LOOP PERFORM ctp_paper.execution_math_id(rules->k); END LOOP;
 FOREACH k IN ARRAY ARRAY['instrumentId','snapshotVersion'] LOOP PERFORM ctp_paper.execution_math_id(book->k); END LOOP;
 FOREACH k IN ARRAY ARRAY['instrumentId','tradeId','identityScope'] LOOP PERFORM ctp_paper.execution_math_id(trade->k); END LOOP;
 FOREACH k IN ARRAY ARRAY['instrumentId','ruleVersion','clientOrderId'] LOOP PERFORM ctp_paper.execution_math_id(cmd->k); END LOOP;
 PERFORM ctp_paper.execution_math_id(cmd->'size'->'asset');
 IF jsonb_typeof(inst->'displaySymbol') IS DISTINCT FROM 'string' OR inst->>'displaySymbol' !~ '^[A-Z0-9._:/-]{1,96}$'
  OR jsonb_typeof(cmd->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(trade->'side') IS DISTINCT FROM 'string'
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 FOREACH k IN ARRAY ARRAY['previousSequence','checksum'] LOOP IF book->k<>'null'::jsonb THEN PERFORM ctp_paper.execution_math_id(book->k); END IF; END LOOP;
 now_ms:=ctp_paper.execution_math_time(p->'now');submitted:=ctp_paper.execution_math_time(p->'submittedAt');
 IF p->'executedQuantity' IS DISTINCT FROM '"0"'::jsonb OR p->'triggeredAt' IS DISTINCT FROM 'null'::jsonb
  OR f->'volumeUsed' IS DISTINCT FROM '"0"'::jsonb OR submitted>now_ms
  OR jsonb_typeof(p->'orderId') IS DISTINCT FROM 'string' OR order_id !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR model->>'version' IS DISTINCT FROM 'spot-l2-taker-v1' OR jsonb_typeof(model->'seed') IS DISTINCT FROM 'string'
  OR model->>'seed' !~ '^(0|-?[1-9][0-9]{0,18})$' OR (model->>'seed')::numeric NOT BETWEEN -9223372036854775808 AND 9223372036854775807
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 latency:=ctp_paper.execution_math_time(model->'latencyMs');jitter:=ctp_paper.execution_math_time(model->'latencyJitterMs');age:=ctp_paper.execution_math_time(model->'maxEvidenceAgeMs');
 IF latency NOT BETWEEN 1 AND 60000 OR jitter NOT BETWEEN 0 AND 60000 OR age NOT BETWEEN 1 AND 15000 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 participation:=ctp_paper.execution_math_number(model->'participationRate',true);fee_rate:=ctp_paper.execution_math_number(model->'takerFeeRate');slip:=ctp_paper.execution_math_number(model->'maxSlippageRate');
 IF participation>1 OR fee_rate>0.1 OR slip>0.1 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 IF NOT coalesce(ctp_registry.valid_scope(inst->'scope'),false) OR inst->'scope'->>'market'<>'SPOT'
  OR rules->'scope' IS DISTINCT FROM inst->'scope' OR book->'scope' IS DISTINCT FROM inst->'scope' OR trade->'scope' IS DISTINCT FROM inst->'scope'
  OR inst->>'status' IS DISTINCT FROM 'TRADING' OR inst->'contract'<>'null'::jsonb OR inst->'expiryAt'<>'null'::jsonb OR inst->'settlementAsset'<>'null'::jsonb
  OR inst->>'baseAsset'=inst->>'quoteAsset' OR inst->>'baseAsset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$' OR inst->>'quoteAsset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'
  OR rules->>'quantityUnit' IS DISTINCT FROM 'BASE' OR trade->>'quantityUnit' IS DISTINCT FROM 'BASE'
  OR rules->>'instrumentId' IS DISTINCT FROM inst->>'id' OR book->>'instrumentId' IS DISTINCT FROM inst->>'id' OR trade->>'instrumentId' IS DISTINCT FROM inst->>'id'
  OR cmd->>'instrumentId' IS DISTINCT FROM inst->>'id' OR cmd->>'ruleVersion' IS DISTINCT FROM rules->>'version'
  OR ctp_paper.execution_math_time(rules->'effectiveAt')>now_ms OR ctp_paper.execution_math_time(rules->'expiresAt')<=now_ms
  OR cmd->>'side' IS DISTINCT FROM 'BUY' OR cmd->>'type' NOT IN('LIMIT','MARKET') OR cmd->'trigger'<>'null'::jsonb OR cmd->'reduceOnly' IS DISTINCT FROM 'false'::jsonb
  OR cmd->'size'->>'kind' IS DISTINCT FROM 'BASE_QUANTITY' OR cmd->'size'->>'asset' IS DISTINCT FROM inst->>'baseAsset'
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 IF jsonb_typeof(rules->'orderTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(rules->'orderTypes') NOT BETWEEN 1 AND 4
  OR jsonb_typeof(rules->'timeInForce') IS DISTINCT FROM 'array' OR jsonb_array_length(rules->'timeInForce') NOT BETWEEN 1 AND 4
  OR rules->'leverageTiers' IS DISTINCT FROM '[]'::jsonb OR NOT (rules->'orderTypes' ? (cmd->>'type'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(rules->'orderTypes') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(rules->'timeInForce') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(rules->'orderTypes') x WHERE x NOT IN('LIMIT','MARKET','STOP_MARKET','STOP_LIMIT'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(rules->'timeInForce') x WHERE x NOT IN('GTC','IOC','FOK','POST_ONLY'))
  OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(rules->'orderTypes'))<>jsonb_array_length(rules->'orderTypes')
  OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(rules->'timeInForce'))<>jsonb_array_length(rules->'timeInForce')
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 tick:=ctp_paper.execution_math_number(rules->'tickSize',true);step:=ctp_paper.execution_math_number(rules->'stepSize',true);qty:=ctp_paper.execution_math_number(cmd->'size'->'value',true);
 IF ctp_paper.execution_math_time(rules->'pricePrecision')>18 OR ctp_paper.execution_math_time(rules->'quantityPrecision')>18
  OR scale(trim_scale(tick))>(rules->>'pricePrecision')::integer OR scale(trim_scale(step))>(rules->>'quantityPrecision')::integer
  OR mod(qty,step)<>0 OR qty<ctp_paper.execution_math_number(rules->CASE WHEN cmd->>'type'='MARKET' THEN 'marketMinQuantity' ELSE 'minQuantity' END,true)
  OR qty>ctp_paper.execution_math_number(rules->CASE WHEN cmd->>'type'='MARKET' THEN 'marketMaxQuantity' ELSE 'maxQuantity' END,true)
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 FOREACH k IN ARRAY ARRAY['minQuantity','maxQuantity','marketMinQuantity','marketMaxQuantity'] LOOP PERFORM ctp_paper.execution_math_number(rules->k,true); END LOOP;
 IF (rules->>'minQuantity')::numeric>(rules->>'maxQuantity')::numeric OR (rules->>'marketMinQuantity')::numeric>(rules->>'marketMaxQuantity')::numeric THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 PERFORM ctp_paper.execution_math_number(rules->'minNotional');
 IF rules->'maxNotional'<>'null'::jsonb THEN PERFORM ctp_paper.execution_math_number(rules->'maxNotional',true,true); END IF;
 IF rules->'maxNotional'<>'null'::jsonb AND (rules->>'minNotional')::numeric>(rules->>'maxNotional')::numeric THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 FOREACH k IN ARRAY ARRAY['minPrice','maxPrice'] LOOP IF rules->k<>'null'::jsonb THEN PERFORM ctp_paper.execution_math_number(rules->k,true); END IF; END LOOP;
 IF rules->'minPrice'<>'null'::jsonb AND rules->'maxPrice'<>'null'::jsonb AND (rules->>'minPrice')::numeric>(rules->>'maxPrice')::numeric THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 IF cmd->>'type'='LIMIT' THEN
  limit_price:=ctp_paper.execution_math_number(cmd->'limitPrice',true);
  -- The existing generic order contract rejects an unrepresentable original
  -- LIMIT notional even if no execution is eligible yet. Never round it away.
  IF qty*limit_price>=10::numeric^30 OR scale(trim_scale(qty*limit_price))>18 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_RANGE'; END IF;
  IF jsonb_typeof(cmd->'timeInForce') IS DISTINCT FROM 'string' OR cmd->>'timeInForce' NOT IN('GTC','IOC','FOK') OR NOT (rules->'timeInForce' ? (cmd->>'timeInForce')) OR mod(limit_price,tick)<>0
   OR (rules->'minPrice'<>'null'::jsonb AND limit_price<(rules->>'minPrice')::numeric) OR (rules->'maxPrice'<>'null'::jsonb AND limit_price>(rules->>'maxPrice')::numeric)
   OR qty*limit_price<(rules->>'minNotional')::numeric OR (rules->'maxNotional'<>'null'::jsonb AND qty*limit_price>(rules->>'maxNotional')::numeric)
  THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 ELSIF cmd->'limitPrice'<>'null'::jsonb OR cmd->'timeInForce'<>'null'::jsonb THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 IF book->>'kind' IS DISTINCT FROM 'SNAPSHOT' OR book->'stale' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(book->'asks') IS DISTINCT FROM 'array' OR jsonb_typeof(book->'bids') IS DISTINCT FROM 'array'
  OR jsonb_array_length(book->'asks') NOT BETWEEN 1 AND 1000 OR jsonb_array_length(book->'bids') NOT BETWEEN 1 AND 1000
  OR jsonb_typeof(f->'asksUsed') IS DISTINCT FROM 'array' OR jsonb_typeof(f->'bidsUsed') IS DISTINCT FROM 'array'
  OR jsonb_array_length(f->'asksUsed')<>jsonb_array_length(book->'asks') OR jsonb_array_length(f->'bidsUsed')<>jsonb_array_length(book->'bids')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements((f->'asksUsed')||(f->'bidsUsed')) v WHERE v IS DISTINCT FROM '"0"'::jsonb)
  OR (book->'sourceSequence'='null'::jsonb AND book->'exchangeTime'='null'::jsonb)
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 FOREACH k IN ARRAY ARRAY['sourceSequence'] LOOP
  IF book->k<>'null'::jsonb AND (jsonb_typeof(book->k) IS DISTINCT FROM 'string' OR book->>k !~ '^(0|[1-9][0-9]{0,127})$') THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
  IF trade->k<>'null'::jsonb AND (jsonb_typeof(trade->k) IS DISTINCT FROM 'string' OR trade->>k !~ '^(0|[1-9][0-9]{0,127})$') THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['asks','bids'] LOOP
  previous:=NULL;
  FOR row IN SELECT value FROM jsonb_array_elements(book->k) LOOP
   IF NOT coalesce(ctp_market.snapshot_keys(row,ARRAY['price','quantity']),false) THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
   price:=ctp_paper.execution_math_number(row->'price',true);level_qty:=ctp_paper.execution_math_number(row->'quantity',true);
   IF previous IS NOT NULL AND ((k='asks' AND previous>=price) OR (k='bids' AND previous<=price)) THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
   previous:=price;
  END LOOP;
 END LOOP;
 IF (book->'bids'->0->>'price')::numeric>=(book->'asks'->0->>'price')::numeric THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EVIDENCE'; END IF;
 PERFORM ctp_paper.execution_math_number(trade->'price',true);PERFORM ctp_paper.execution_math_number(trade->'quantity',true);
 IF trade->>'side' NOT IN('BUY','SELL') THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 FOREACH at_ms IN ARRAY ARRAY[ctp_paper.execution_math_time(book->'receivedAt'),ctp_paper.execution_math_time(trade->'receivedAt'),ctp_paper.execution_math_time(trade->'exchangeTime')] LOOP
  IF at_ms>now_ms OR now_ms-at_ms>age THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EXPIRED'; END IF;
 END LOOP;
 IF book->'exchangeTime'<>'null'::jsonb THEN at_ms:=ctp_paper.execution_math_time(book->'exchangeTime');IF at_ms>now_ms OR now_ms-at_ms>age THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_EXPIRED'; END IF; END IF;
 eligible:=submitted+latency+mod(ctp_paper.execution_math_seed(model,order_id,'latency'),jitter+1)::bigint;
 IF eligible>8640000000000000 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_RANGE'; END IF;
 next_frame:=f;
 result:=jsonb_build_object('status','WAITING','reason','LATENCY','eligibleAfter',eligible,'triggeredAt',NULL,'quantity','0','fills','[]'::jsonb,'frame',f);
 IF now_ms<eligible OR (book->>'receivedAt')::bigint<eligible OR (trade->>'receivedAt')::bigint<eligible OR (trade->>'exchangeTime')::bigint<eligible
  OR (book->'exchangeTime'<>'null'::jsonb AND (book->>'exchangeTime')::bigint<eligible) THEN RETURN result; END IF;
 evidence_id:=encode(sha256(convert_to(ctp_admission.canonical(jsonb_build_object('scope',trade->'scope','instrumentId',trade->'instrumentId','identityScope',trade->'identityScope','tradeId',trade->'tradeId')),'UTF8')),'hex');
 slip:=slip*mod(ctp_paper.execution_math_seed(model,order_id,'slippage',evidence_id),1000001)*0.000001;
 book_hash:=encode(sha256(convert_to(ctp_admission.canonical(book||jsonb_build_object('receivedAt',0,'snapshotVersion','')),'UTF8')),'hex');
 trade_hash:=encode(sha256(convert_to(ctp_admission.canonical(trade||jsonb_build_object('receivedAt',0)),'UTF8')),'hex');
 volume:=div((trade->>'quantity')::numeric*participation,step)*step;
 asks_used:=f->'asksUsed';bids_used:=f->'bidsUsed';
 FOR row,level IN SELECT value,(ordinality-1)::integer FROM jsonb_array_elements(book->'asks') WITH ORDINALITY LOOP
  EXIT WHEN volume<=0 OR filled>=qty;
  level_qty:=div((row->>'quantity')::numeric*participation,step)*step;
  raw_price:=(row->>'price')::numeric*(1+slip);
  price:=(div(raw_price,tick)+CASE WHEN mod(raw_price,tick)>0 THEN 1 ELSE 0 END)*tick;
  IF price<=0 OR (rules->'minPrice'<>'null'::jsonb AND price<(rules->>'minPrice')::numeric) OR (rules->'maxPrice'<>'null'::jsonb AND price>(rules->>'maxPrice')::numeric) THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_PRICE'; END IF;
  EXIT WHEN limit_price IS NOT NULL AND price>limit_price;
  take:=div(least(level_qty,volume,qty-filled),step)*step;CONTINUE WHEN take<=0;
  notional:=take*price;fee:=ceil(notional*fee_rate*1000000000000000000)*0.000000000000000001;
  fills:=fills||jsonb_build_array(jsonb_build_object('id','paper-'||encode(sha256(convert_to(ctp_admission.canonical(jsonb_build_object(
   'version',model->'version','model',model,'orderId',order_id,'evidenceId',evidence_id,'book',book_hash,'trade',trade_hash,'level',level,'executedQuantity','0','offset',ctp_paper.execution_math_amount(filled))),'UTF8')),'hex'),
   'quantity',ctp_paper.execution_math_amount(take),'price',ctp_paper.execution_math_amount(price),'quoteNotional',ctp_paper.execution_math_amount(notional),'quoteFee',ctp_paper.execution_math_amount(fee),
   'baseDelta',ctp_paper.execution_math_amount(take),'quoteDelta',ctp_paper.execution_math_amount(-notional-fee,true)));
  asks_used:=jsonb_set(asks_used,ARRAY[level::text],to_jsonb(ctp_paper.execution_math_amount(take)));
  filled:=filled+take;volume:=volume-take;
 END LOOP;
 IF cmd->>'timeInForce'='FOK' AND filled<>qty THEN RETURN result||jsonb_build_object('status','EXPIRED','reason','FOK'); END IF;
 next_frame:=f||jsonb_build_object('volumeUsed',ctp_paper.execution_math_amount(filled),'asksUsed',asks_used,'bidsUsed',bids_used);
 status:=CASE WHEN filled=qty THEN 'FILLED' WHEN cmd->>'timeInForce'='IOC' OR cmd->>'type'='MARKET' THEN 'EXPIRED' WHEN filled>0 THEN 'PARTIALLY_FILLED' ELSE 'WAITING' END;
 reason:=CASE WHEN filled>0 THEN 'EXECUTION' ELSE 'LIQUIDITY' END;
 RETURN result||jsonb_build_object('status',status,'reason',reason,'quantity',ctp_paper.execution_math_amount(filled),'fills',fills,'frame',next_frame);
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_EXECUTION_MATH_%' THEN RAISE; ELSE RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT'; END IF;
 WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero OR invalid_parameter_value THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_INPUT';
END $$;
CREATE FUNCTION ctp_paper.execution_math_aggregate(v numeric) RETURNS text
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF v IS NULL OR abs(v)>=10::numeric^30 OR scale(trim_scale(v))>18 THEN RAISE EXCEPTION 'PAPER_EXECUTION_MATH_RANGE'; END IF;
 RETURN trim_scale(v)::text;
END $$;
CREATE FUNCTION ctp_paper.execution_math_cash(s jsonb,asset text,delta numeric) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE balances jsonb:='[]'; b jsonb; matched boolean:=false; k text; n numeric;
BEGIN
 IF delta=0 THEN RETURN s; END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(s->'balances') LOOP
  IF b->>'asset'=asset THEN
   matched:=true;
   FOREACH k IN ARRAY ARRAY['total','free','available'] LOOP
    IF b->k<>'null'::jsonb THEN n:=(b->>k)::numeric+delta;
     IF n<0 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_BALANCE'; END IF;
     b:=jsonb_set(b,ARRAY[k],to_jsonb(ctp_paper.execution_math_aggregate(n)));
    END IF;
   END LOOP;
  END IF;
  balances:=balances||jsonb_build_array(b);
 END LOOP;
 IF NOT matched THEN
  IF delta<0 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_BALANCE'; END IF;
  balances:=balances||jsonb_build_array(jsonb_build_object('asset',asset,'total',ctp_paper.execution_math_aggregate(delta),'free',NULL,'locked',NULL,'available',NULL));
 END IF;
 RETURN jsonb_set(s,'{balances}',balances);
END $$;

CREATE FUNCTION ctp_paper.derive_pristine_effects(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE attempt jsonb:=p->'attempt'; req jsonb:=attempt->'request'; a jsonb:=req->'admission'; binding jsonb:=a->'binding';
 frame jsonb:=p->'frame'; original jsonb:=p->'original'; r jsonb:=p->'reservation'; before_state jsonb:=p->'portfolio'; state jsonb;
 cmd jsonb:=a->'command'; old_frame jsonb; e jsonb; d jsonb; wm jsonb; hold jsonb; old_hold jsonb; b jsonb; row jsonb; fill jsonb;
 events jsonb:='[]'; postings jsonb; event jsonb; changes jsonb:='[]'; previous_wm jsonb; next_wm jsonb; next_hold jsonb;
 now_ms bigint; admitted bigint; started bigint; prepared bigint; expiry bigint; base text; quote text; k text; id text; source_scope jsonb;
 qty numeric; step numeric; upper_price numeric; maximum numeric; rate numeric; original_amount numeric; spent numeric:=0; filled numeric:=0; notional numeric:=0; fees numeric:=0; remaining_qty numeric; remaining_amount numeric; released numeric; terminal boolean; changed boolean;
BEGIN
 IF p IS NULL OR octet_length(p::text)>16777216
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['now','attempt','frame','portfolio','original','reservation']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(attempt,ARRAY['kind','version','request','requestHash','revision','phase','startedAt','lastEvent']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(req,ARRAY['attemptId','preparedAt','admission']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(a,ARRAY['binding','orderId','intentId','decisionId','reservationId','dbInstrumentId','dbRuleId','command','commandHash','admissionSequence','admittedAt','expiresAt']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(binding,ARRAY['tenantId','accountId','mode','connectionId','externalAccountId','profile']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(binding->'profile',ARRAY['exchange','region','market','environment','accountMode','profileVersion','endpointProfileId']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(attempt->'lastEvent',ARRAY['id','kind','expectedRevision','at']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(original,ARRAY['now','model','record','book','trade']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(r,ARRAY['id','decisionId','orderId','intentId','revision','status','debits','watermarks']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(before_state,ARRAY['binding','balances','positions','holds','pending','status','snapshotAt','snapshotId','lastEconomicAt','differences']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(before_state->'binding',ARRAY['tenantId','accountId','connectionId','externalAccountId','mode','walletId','scope']),false)
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_INPUT'; END IF;
 now_ms:=ctp_paper.execution_math_time(p->'now');admitted:=ctp_paper.execution_math_time(a->'admittedAt');started:=ctp_paper.execution_math_time(attempt->'startedAt');prepared:=ctp_paper.execution_math_time(req->'preparedAt');expiry:=ctp_paper.execution_math_time(a->'expiresAt');
 IF attempt->>'kind' IS DISTINCT FROM 'PAPER_EXECUTION_ATTEMPT' OR attempt->>'version' IS DISTINCT FROM 'paper-pristine-attempt-v1'
  OR attempt->'revision' IS DISTINCT FROM '"2"'::jsonb OR attempt->>'phase' IS DISTINCT FROM 'STARTED'
  OR attempt->'lastEvent'->>'kind' IS DISTINCT FROM 'START' OR attempt->'lastEvent'->'expectedRevision' IS DISTINCT FROM '"1"'::jsonb
  OR attempt->'lastEvent'->'at' IS DISTINCT FROM attempt->'startedAt' OR attempt->'lastEvent'->'id' IS NOT DISTINCT FROM req->'attemptId'
  OR prepared<admitted OR started<prepared OR started>=expiry OR now_ms<started OR now_ms>=expiry
  OR original->'now' IS DISTINCT FROM a->'admittedAt' OR original->'model' IS DISTINCT FROM frame->'model' OR original->'record' IS DISTINCT FROM frame->'record'
  OR attempt->>'requestHash' IS DISTINCT FROM encode(sha256(convert_to(ctp_admission.canonical(req),'UTF8')),'hex')
  OR a->>'commandHash' IS DISTINCT FROM encode(sha256(convert_to(ctp_admission.canonical(jsonb_build_object('operation','createOrder','command',cmd,'binding',binding)),'UTF8')),'hex')
  OR binding->>'mode' IS DISTINCT FROM 'PAPER' OR binding->'connectionId' IS DISTINCT FROM 'null'::jsonb
  OR binding->'profile'->>'market' IS DISTINCT FROM 'SPOT' OR binding->'profile'->>'accountMode' IS DISTINCT FROM 'SIMULATED'
  OR binding->'profile'->>'profileVersion' IS DISTINCT FROM 'spot-l2-taker-v1' OR binding->'profile'->>'endpointProfileId' IS DISTINCT FROM 'paper-spot-v1'
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 FOREACH k IN ARRAY ARRAY['orderId','intentId','decisionId','reservationId','dbInstrumentId','dbRuleId'] LOOP PERFORM ctp_paper.execution_math_id(a->k)::uuid; END LOOP;
 PERFORM ctp_paper.execution_math_id(req->'attemptId')::uuid;PERFORM ctp_paper.execution_math_id(attempt->'lastEvent'->'id')::uuid;
 PERFORM ctp_paper.execution_math_id(binding->'tenantId')::uuid;PERFORM ctp_paper.execution_math_id(binding->'accountId')::uuid;
 PERFORM ctp_paper.execution_math_id(binding->'externalAccountId');
 IF jsonb_typeof(a->'admissionSequence') IS DISTINCT FROM 'string' OR a->>'admissionSequence' !~ '^[1-9][0-9]{0,18}$' OR (a->>'admissionSequence')::numeric>=9223372036854775808
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_INPUT'; END IF;
 source_scope:=jsonb_build_object('exchange',binding->'profile'->'exchange','region',binding->'profile'->'region','market',binding->'profile'->'market','environment',binding->'profile'->'environment');
 IF NOT coalesce(ctp_registry.valid_scope(source_scope),false) OR before_state->'binding'->'scope' IS DISTINCT FROM source_scope
  OR before_state->'binding'->'tenantId' IS DISTINCT FROM binding->'tenantId' OR before_state->'binding'->'accountId' IS DISTINCT FROM binding->'accountId'
  OR before_state->'binding'->'mode' IS DISTINCT FROM binding->'mode' OR before_state->'binding'->'connectionId' IS DISTINCT FROM binding->'connectionId'
  OR before_state->'binding'->'externalAccountId' IS DISTINCT FROM binding->'externalAccountId'
  OR frame->'record'->'instrument'->'scope' IS DISTINCT FROM source_scope
  OR before_state->>'status' IS DISTINCT FROM 'RECONCILED' OR before_state->'positions' IS DISTINCT FROM '[]'::jsonb OR before_state->'pending' IS DISTINCT FROM '[]'::jsonb
  OR before_state->'differences' IS DISTINCT FROM '[]'::jsonb OR before_state->'lastEconomicAt' IS DISTINCT FROM 'null'::jsonb
  OR ctp_paper.execution_math_time(before_state->'snapshotAt')>now_ms
  OR jsonb_typeof(before_state->'balances') IS DISTINCT FROM 'array' OR jsonb_array_length(before_state->'balances')>1000
  OR jsonb_typeof(before_state->'holds') IS DISTINCT FROM 'array' OR jsonb_array_length(before_state->'holds')>1000
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 PERFORM ctp_paper.execution_math_id(before_state->'snapshotId');PERFORM ctp_paper.execution_math_id(before_state->'binding'->'walletId');
 IF (SELECT count(DISTINCT v->>'asset') FROM jsonb_array_elements(before_state->'balances') v)<>jsonb_array_length(before_state->'balances')
  OR (SELECT count(DISTINCT v->>'id') FROM jsonb_array_elements(before_state->'holds') v)<>jsonb_array_length(before_state->'holds')
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(before_state->'balances') LOOP
  IF NOT coalesce(ctp_market.snapshot_keys(b,ARRAY['asset','total','free','locked','available']),false) OR jsonb_typeof(b->'asset') IS DISTINCT FROM 'string' OR b->>'asset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$' THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_INPUT'; END IF;
  PERFORM ctp_paper.execution_math_number(b->'total',false,true);
  FOREACH k IN ARRAY ARRAY['free','locked','available'] LOOP IF b->k<>'null'::jsonb THEN PERFORM ctp_paper.execution_math_number(b->k,false,true); END IF; END LOOP;
  IF b->'free'<>'null'::jsonb AND b->'locked'<>'null'::jsonb AND (b->>'free')::numeric+(b->>'locked')::numeric<>(b->>'total')::numeric THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 END LOOP;
 FOR hold IN SELECT value FROM jsonb_array_elements(before_state->'holds') LOOP
  IF NOT coalesce(ctp_market.snapshot_keys(hold,ARRAY['id','asset','amount','status','reflected']),false)
   OR hold->>'status' NOT IN('RESERVED','PENDING') OR jsonb_typeof(hold->'status') IS DISTINCT FROM 'string'
   OR jsonb_typeof(hold->'reflected') IS DISTINCT FROM 'boolean' OR jsonb_typeof(hold->'asset') IS DISTINCT FROM 'string' OR hold->>'asset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'
  THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
  PERFORM ctp_paper.execution_math_id(hold->'id');PERFORM ctp_paper.execution_math_number(hold->'amount',false,true);
 END LOOP;
 e:=ctp_paper.derive_pristine_buy(jsonb_build_object('now',now_ms,'frame',frame,'order',cmd,'orderId',a->'orderId','submittedAt',started,'executedQuantity','0','triggeredAt',NULL));
 old_frame:=(original-'now')||jsonb_build_object('volumeUsed','0','asksUsed',(SELECT jsonb_agg('0'::text) FROM jsonb_array_elements(original->'book'->'asks')),'bidsUsed',(SELECT jsonb_agg('0'::text) FROM jsonb_array_elements(original->'book'->'bids')));
 PERFORM ctp_paper.derive_pristine_buy(jsonb_build_object('now',admitted,'frame',old_frame,'order',cmd,'orderId',a->'orderId','submittedAt',admitted,'executedQuantity','0','triggeredAt',NULL));
 qty:=(cmd->'size'->>'value')::numeric;step:=(frame->'record'->'rules'->>'stepSize')::numeric;rate:=(frame->'model'->>'takerFeeRate')::numeric;
 upper_price:=CASE WHEN cmd->'limitPrice'<>'null'::jsonb THEN (cmd->>'limitPrice')::numeric ELSE (frame->'record'->'rules'->>'maxPrice')::numeric END;
 IF upper_price IS NULL THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 maximum:=div(upper_price,(frame->'record'->'rules'->>'tickSize')::numeric)*(frame->'record'->'rules'->>'tickSize')::numeric;
 original_amount:=ceil(qty*maximum*1000000000000000000)*0.000000000000000001+div(qty,step)*ceil(step*maximum*rate*1000000000000000000)*0.000000000000000001;
 PERFORM ctp_paper.execution_math_amount(original_amount);
 base:=frame->'record'->'instrument'->>'baseAsset';quote:=frame->'record'->'instrument'->>'quoteAsset';
 IF r->'id' IS DISTINCT FROM a->'reservationId' OR r->'decisionId' IS DISTINCT FROM a->'decisionId' OR r->'orderId' IS DISTINCT FROM a->'orderId' OR r->'intentId' IS DISTINCT FROM a->'intentId'
  OR r->'revision' IS DISTINCT FROM '"1"'::jsonb OR r->>'status' IS DISTINCT FROM 'ACTIVE'
  OR jsonb_typeof(r->'debits') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'debits')<>1 OR jsonb_typeof(r->'watermarks') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'watermarks')<>1
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 d:=r->'debits'->0;wm:=r->'watermarks'->0;
 IF NOT coalesce(ctp_market.snapshot_keys(d,ARRAY['asset','amount','holdId']),false) OR NOT coalesce(ctp_market.snapshot_keys(wm,ARRAY['holdId','timestamp','fingerprint','released','unknown']),false)
  OR d->>'asset' IS DISTINCT FROM quote OR ctp_paper.execution_math_number(d->'amount',true)<>original_amount
  OR wm->'holdId' IS DISTINCT FROM d->'holdId' OR wm->'released' IS DISTINCT FROM 'false'::jsonb OR wm->'unknown' IS DISTINCT FROM 'false'::jsonb
  OR ctp_paper.execution_math_time(wm->'timestamp')<admitted OR ctp_paper.execution_math_time(wm->'timestamp')>now_ms
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 PERFORM ctp_paper.execution_math_id(d->'holdId')::uuid;
 old_hold:=jsonb_build_object('id',d->'holdId','asset',quote,'amount',d->'amount','status','RESERVED','reflected',false);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(before_state->'holds') h WHERE h=old_hold)
  OR wm->>'fingerprint' IS DISTINCT FROM encode(sha256(convert_to(ctp_admission.canonical(jsonb_build_object('type','COMMITMENT','hold',old_hold)),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 state:=before_state;
 IF jsonb_array_length(e->'fills')>0 THEN
  IF now_ms<=ctp_paper.execution_math_time(before_state->'snapshotAt') OR EXISTS(SELECT 1 FROM jsonb_array_elements(before_state->'balances') balance_entry WHERE balance_entry->>'asset'=base AND (balance_entry->>'total')::numeric<>0)
  THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_EVIDENCE'; END IF;
 END IF;
 FOR fill IN SELECT value FROM jsonb_array_elements(e->'fills') LOOP
  filled:=filled+(fill->>'quantity')::numeric;notional:=notional+(fill->>'quoteNotional')::numeric;fees:=fees+(fill->>'quoteFee')::numeric;
  event:=jsonb_build_object('type','PAPER_FILL','id','paper-fill:'||(fill->>'id'),'timestamp',now_ms,'internalOrderId',a->'orderId',
   'instrumentId',frame->'record'->'instrument'->'id','metadataVersion',frame->'record'->'instrument'->'metadataVersion','ruleVersion',frame->'record'->'rules'->'version',
   'base',base,'quote',quote,'positionSide','NET','bucket','SPOT','side','BUY','quantity',fill->'quantity','price',fill->'price',
   'fees',CASE WHEN fill->>'quoteFee'='0' THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('asset',quote,'amount',fill->'quoteFee','quoteEquivalent',fill->'quoteFee')) END,
   'paper',jsonb_build_object('fillId',fill->'id','modelVersion',frame->'model'->'version','scope',source_scope));
  postings:=jsonb_build_array(jsonb_build_object('asset',base,'bucket','AVAILABLE','amount',fill->'quantity'),jsonb_build_object('asset',base,'bucket','EXTERNAL','amount',ctp_paper.execution_math_amount(-(fill->>'quantity')::numeric,true)),
   jsonb_build_object('asset',quote,'bucket','AVAILABLE','amount',ctp_paper.execution_math_amount(-(fill->>'quoteNotional')::numeric,true)),jsonb_build_object('asset',quote,'bucket','EXTERNAL','amount',fill->'quoteNotional'));
  IF (fill->>'quoteFee')::numeric>0 THEN postings:=postings||jsonb_build_array(jsonb_build_object('asset',quote,'bucket','AVAILABLE','amount',ctp_paper.execution_math_amount(-(fill->>'quoteFee')::numeric,true)),jsonb_build_object('asset',quote,'bucket','FEE','amount',fill->'quoteFee')); END IF;
  events:=events||jsonb_build_array(jsonb_build_object('orderId',a->'orderId','admissionSequence',a->'admissionSequence','fillId',fill->'id','event',event,'postings',postings));
  state:=ctp_paper.execution_math_cash(state,base,(fill->>'quantity')::numeric);state:=ctp_paper.execution_math_cash(state,quote,(fill->>'quoteDelta')::numeric);
  state:=jsonb_set(state,'{pending}',(state->'pending')||jsonb_build_array(event->>'id'));
 END LOOP;
 IF filled>0 THEN
  state:=jsonb_set(state,'{lastEconomicAt}',to_jsonb(now_ms));
  state:=jsonb_set(state,'{positions}',jsonb_build_array(jsonb_build_object('instrumentId',frame->'record'->'instrument'->'id','positionSide','NET','bucket','SPOT','base',base,'quote',quote,
   'quantity',ctp_paper.execution_math_aggregate(filled),'basis',ctp_paper.execution_math_aggregate(notional),'realizedGross','0','feesQuote',ctp_paper.execution_math_aggregate(fees),'fundingQuote','0',
   'fees',CASE WHEN fees>0 THEN jsonb_build_object(quote,ctp_paper.execution_math_aggregate(fees)) ELSE '{}'::jsonb END,'funding','{}'::jsonb)));
 END IF;
 spent:=notional+fees;remaining_qty:=qty-filled;terminal:=e->>'status' IN('FILLED','EXPIRED');changed:=terminal OR filled>0;
 remaining_amount:=CASE WHEN terminal THEN 0 ELSE ceil(remaining_qty*maximum*1000000000000000000)*0.000000000000000001+div(remaining_qty,step)*ceil(step*maximum*rate*1000000000000000000)*0.000000000000000001 END;
 released:=original_amount-spent-remaining_amount;
 PERFORM ctp_paper.execution_math_amount(released);PERFORM ctp_paper.execution_math_amount(remaining_amount);
 IF changed THEN
  IF now_ms<=ctp_paper.execution_math_time(wm->'timestamp') THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_ORDERING'; END IF;
  id:='paper-transition:'||encode(sha256(convert_to(ctp_admission.canonical(jsonb_build_object('attemptId',req->'attemptId','startEventId',attempt->'lastEvent'->'id','fillIds',coalesce((SELECT jsonb_agg(v->'id' ORDER BY v->>'id') FROM jsonb_array_elements(e->'fills') v),'[]'::jsonb),'status',e->'status','at',now_ms)),'UTF8')),'hex');
  previous_wm:=wm-'holdId';
  IF terminal THEN
   event:=jsonb_build_object('id',id,'timestamp',now_ms,'type','RELEASE','holdId',d->'holdId','resolved',false);
   state:=jsonb_set(state,'{holds}',coalesce((SELECT jsonb_agg(v ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY t(v,n) WHERE v->'id' IS DISTINCT FROM d->'holdId'),'[]'::jsonb));
  ELSE
   next_hold:=old_hold||jsonb_build_object('amount',ctp_paper.execution_math_amount(remaining_amount));
   event:=jsonb_build_object('id',id,'timestamp',now_ms,'type','COMMITMENT','hold',next_hold);
   state:=jsonb_set(state,'{holds}',(SELECT jsonb_agg(CASE WHEN v->'id'=d->'holdId' THEN next_hold ELSE v END ORDER BY n) FROM jsonb_array_elements(state->'holds') WITH ORDINALITY t(v,n)));
  END IF;
  next_wm:=jsonb_build_object('timestamp',now_ms,'fingerprint',encode(sha256(convert_to(ctp_admission.canonical(event-'id'-'timestamp'),'UTF8')),'hex'),'released',terminal,'unknown',false);
  changes:=jsonb_build_array(jsonb_build_object('event',event,'previousWatermark',previous_wm,'watermark',next_wm));
 END IF;
 RETURN jsonb_build_object('execution',e,'order',jsonb_build_object('orderId',a->'orderId','intentId',a->'intentId','executedQuantity',ctp_paper.execution_math_amount(filled),'remainingQuantity',ctp_paper.execution_math_amount(remaining_qty),'status',CASE WHEN e->>'status'='WAITING' THEN 'OPEN' ELSE e->>'status' END),
  'reservation',jsonb_build_object('id',r->'id','decisionId',r->'decisionId','revision',CASE WHEN changed THEN '2' ELSE '1' END,'status',CASE WHEN terminal THEN 'RELEASED' ELSE 'ACTIVE' END,
   'debits',jsonb_build_array(jsonb_build_object('asset',quote,'holdId',d->'holdId','original',ctp_paper.execution_math_amount(original_amount),'spent',ctp_paper.execution_math_amount(spent),'remaining',ctp_paper.execution_math_amount(remaining_amount),'released',ctp_paper.execution_math_amount(released)))),
  'fills',events,'holdChanges',changes,'state',state);
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_EXECUTION_%' THEN RAISE; ELSE RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_INPUT'; END IF;
 WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero OR invalid_parameter_value THEN RAISE EXCEPTION 'PAPER_EXECUTION_EFFECTS_INPUT';
END $$;

REVOKE ALL ON FUNCTION ctp_paper.execution_math_aggregate(numeric),ctp_paper.execution_math_cash(jsonb,text,numeric),ctp_paper.derive_pristine_effects(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
REVOKE ALL ON FUNCTION ctp_paper.execution_math_number(jsonb,boolean,boolean),ctp_paper.execution_math_amount(numeric,boolean),
 ctp_paper.execution_math_id(jsonb),ctp_paper.execution_math_time(jsonb),ctp_paper.execution_math_seed(jsonb,text,text,text),ctp_paper.derive_pristine_buy(jsonb)
 FROM PUBLIC,ctp_paper_risk_admission;
COMMIT;
