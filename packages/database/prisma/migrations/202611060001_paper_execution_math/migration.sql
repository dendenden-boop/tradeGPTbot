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
REVOKE ALL ON FUNCTION ctp_paper.execution_math_number(jsonb,boolean,boolean),ctp_paper.execution_math_amount(numeric,boolean),
 ctp_paper.execution_math_id(jsonb),ctp_paper.execution_math_time(jsonb),ctp_paper.execution_math_seed(jsonb,text,text,text),ctp_paper.derive_pristine_buy(jsonb)
 FROM PUBLIC,ctp_paper_risk_admission;
COMMIT;
