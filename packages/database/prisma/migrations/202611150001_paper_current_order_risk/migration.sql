BEGIN;
-- Private nonfinancial capture for exactly one untouched durable target after
-- the accepted single execution. No reserve/grant/financial dispatch is added.
-- Published migrations 1-70 and all old capture functions remain unchanged.
CREATE FUNCTION ctp_paper.current_order_target(p jsonb,candidate jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; a uuid; o public."order"%ROWTYPE; i public.order_intent%ROWTYPE;
 c ctp_execution.command%ROWTYPE; original ctp_execution.command%ROWTYPE; instrument public.instrument%ROWTYPE;
 progress ctp_execution.progress%ROWTYPE; ev public.order_event%ROWTYPE;
 b jsonb:=p->'admission'->'binding'; cmd jsonb; draft jsonb; ts bigint; created bigint; high bigint;
BEGIN
 -- Called after the unchanged sorted account/book/order locks by inventory.
 -- admission_lock authenticates the existing command and owns no new I/O right.
 IF NOT coalesce(ctp_market.snapshot_keys(candidate,ARRAY['orderId','intentId','commandHash']),false)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 t:=ctp_paper.admission_lock(candidate||jsonb_build_object('binding',b,'operation','PLACE'));
 a:=(b->>'accountId')::uuid;
 IF candidate->>'orderId'=p->'admission'->>'orderId' OR candidate->>'intentId'=p->'admission'->>'intentId'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO c FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(candidate->>'intentId')::uuid;
 SELECT * INTO original FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=(p->'admission'->>'intentId')::uuid;
 IF NOT FOUND OR original.operation<>'PLACE' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO i FROM public.order_intent WHERE "tenantId"=t AND id=c."intentId" AND "accountId"=a AND mode='PAPER';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 SELECT * INTO o FROM public."order" WHERE "tenantId"=t AND id=c."orderId" AND "intentId"=i.id AND "accountId"=a AND mode='PAPER';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 cmd:=c.command::jsonb;draft:=c.draft::jsonb;
 SELECT * INTO instrument FROM public.instrument WHERE id=i."instrumentId";
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT "clientIdHighWatermark" INTO high FROM public.exchange_account WHERE "tenantId"=t AND id=a;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 created:=floor(extract(epoch FROM i."createdAt")*1000)::bigint;
 IF i.operation<>'PLACE' OR i.destination<>'PAPER_ENGINE' OR i."connectionId" IS NOT NULL OR i."targetOrderId" IS NOT NULL
  OR o.status<>'CREATED' OR o.version<>0 OR o."reconciliationState"<>'REQUIRED' OR o."filledQuantity"<>0
  OR o."exchangeOrderId" IS NOT NULL OR o."connectionId" IS NOT NULL OR o.market<>'SPOT'
  OR o."averageFillPrice"<>0 OR o."terminalAt" IS NOT NULL OR o."lastExchangeAt" IS NOT NULL
  OR o."parentAlgoOrderId" IS NOT NULL OR o."tradeId" IS NOT NULL
  OR c."commandHash"<>i."commandHash" OR c."commandHash"<>sha256(convert_to(ctp_admission.canonical(
   jsonb_build_object('operation','createOrder','binding',b,'command',cmd)),'UTF8'))
  OR c."requestHash"<>sha256(convert_to(ctp_admission.canonical(jsonb_build_object('binding',b,'draft',draft)),'UTF8'))
  OR draft->>'dbInstrumentId' IS DISTINCT FROM i."instrumentId"::text OR draft->>'dbRuleId' IS DISTINCT FROM i."ruleVersionId"::text
  OR o."instrumentId"<>i."instrumentId" OR o."ruleVersionId"<>i."ruleVersionId"
  OR draft->>'dbInstrumentId' IS DISTINCT FROM original.draft::jsonb->>'dbInstrumentId'
  OR cmd-'clientOrderId' IS DISTINCT FROM draft->'order'
  OR i."quantityAsset" IS DISTINCT FROM instrument."baseAsset" OR i."priceAsset" IS DISTINCT FROM instrument."quoteAsset"
  OR i."positionSide"<>'NET'
  OR cmd->>'instrumentId' IS DISTINCT FROM original.command::jsonb->>'instrumentId'
  OR cmd->>'clientOrderId' IS DISTINCT FROM o."clientId" OR o."clientId" !~ '^[1-9][0-9]{0,18}$'
  OR o."clientId"::numeric>high OR o."clientId"::numeric>9223372036854775807
  OR cmd->>'side' IS DISTINCT FROM i.side::text OR cmd->>'type' IS DISTINCT FROM i."orderType"::text
  OR cmd->>'timeInForce' IS DISTINCT FROM i."timeInForce"::text
  OR cmd->'reduceOnly' IS DISTINCT FROM to_jsonb(i."reduceOnly") OR i."reduceOnly"
  OR cmd->'trigger' IS DISTINCT FROM 'null'::jsonb OR i."triggerPrice" IS NOT NULL
  OR cmd->>'side' IS DISTINCT FROM 'BUY' OR cmd->>'type' NOT IN('LIMIT','MARKET')
  OR cmd->'size'->>'kind' IS DISTINCT FROM 'BASE_QUANTITY' OR cmd->'size'->>'asset' IS DISTINCT FROM i."quantityAsset"
  OR ctp_admission.money(cmd->'size'->'value') IS NOT TRUE OR (cmd->'size'->>'value')::numeric IS DISTINCT FROM i.quantity
  OR (cmd->>'limitPrice')::numeric IS DISTINCT FROM i."limitPrice"
  OR ROW(o.side,o."positionSide",o."orderType",o."timeInForce",o."quantityAsset",o."priceAsset",o.quantity,o."limitPrice",o."reduceOnly")
   IS DISTINCT FROM ROW(i.side,i."positionSide",i."orderType",i."timeInForce",i."quantityAsset",i."priceAsset",i.quantity,i."limitPrice",i."reduceOnly")
  OR created<0 OR created>ts OR o."createdAt"<>i."createdAt" OR o."updatedAt"<>o."createdAt"
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO progress FROM ctp_execution.progress WHERE "tenantId"=t AND "orderId"=o.id;
 IF NOT FOUND OR progress."nativeAt" IS NOT NULL OR progress."nativeHash" IS NOT NULL OR progress."nativeStatus" IS NOT NULL
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF (SELECT count(*) FROM public.order_event WHERE "tenantId"=t AND "orderId"=o.id)<>1
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO ev FROM public.order_event WHERE "tenantId"=t AND "orderId"=o.id;
 IF ev.version<>0 OR ev."previousStatus" IS NOT NULL OR ev.status<>'CREATED' OR ev.source<>'CREATE'
  OR ev."sourceIdentity" IS DISTINCT FROM i.id::text OR ev."evidenceHash"<>c."commandHash" OR ev."attemptId" IS NOT NULL
  OR ev."occurredAt"<>i."createdAt" OR ev."createdAt"<>i."createdAt"
  OR EXISTS(SELECT 1 FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id=i.id)
  OR EXISTS(SELECT 1 FROM public.risk_reservation WHERE "tenantId"=t AND "intentId"=i.id)
  OR EXISTS(SELECT 1 FROM public.risk_decision WHERE "tenantId"=t AND "intentId"=i.id)
  OR EXISTS(SELECT 1 FROM public.submission_attempt WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM ctp_execution.evidence WHERE "tenantId"=t AND "orderId"=o.id)
  OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event WHERE "tenantId"=t AND "orderId"=o.id)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN jsonb_build_object('owner',jsonb_build_object('tenantId',t::text,'accountId',a::text,'mode','PAPER'),
  'orderId',o.id::text,'intentId',i.id::text,'dbInstrumentId',i."instrumentId"::text,'dbRuleId',i."ruleVersionId"::text,
  'command',cmd,'commandHash',encode(c."commandHash",'hex'),'createdAt',created,'status','CREATED','orderVersion',0);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;


CREATE FUNCTION ctp_paper.current_order_inventory(p jsonb,candidate jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; target uuid; ids uuid[]; a uuid; executed jsonb; x ctp_paper.execution_commit%ROWTYPE;
 i ctp_paper.admission_issuance%ROWTYPE; cfg jsonb; quote text; age integer; ts bigint;
 book jsonb; books jsonb:='[]'; catalog jsonb; configurations jsonb:='[]'; item jsonb; balance jsonb;
 heads jsonb[]; k jsonb; h ctp_market.snapshot_head%ROWTYPE; e ctp_market.snapshot_event%ROWTYPE;
 publication jsonb; markets jsonb:='[]'; original jsonb; result jsonb; drafts integer:=2;
BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p IS NULL OR p->>'kind' IS DISTINCT FROM 'PAPER_HISTORICAL_INVENTORY_CAPTURE'
  OR octet_length(p::text)>16384
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','executionKey','preparationKey','startKey','admission','authorization']),false)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 -- GLOBAL -> tenant -> user closes new-account FK phantoms before enumeration.
 t:=ctp_paper.execution_start_auth((p-'executionKey')||jsonb_build_object('kind','PAPER_EXECUTION_START'));
 target:=(p->'admission'->'binding'->>'accountId')::uuid;
 SELECT array_agg(id ORDER BY id) INTO ids FROM(SELECT id FROM public.exchange_account
  WHERE "tenantId"=t AND mode='PAPER' ORDER BY id LIMIT 101) q;
 IF ids IS NULL OR NOT(target=ANY(ids)) THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 IF cardinality(ids)>100 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 PERFORM 1 FROM ctp_portfolio.book WHERE "tenantId"=t AND mode='PAPER' ORDER BY "accountId",id FOR UPDATE;
 PERFORM 1 FROM public."order" WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' AND status<>'ACTIVE')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Existing committed causal validator authenticates the exact target history.
 -- It is a read: no adoption of an admission head, allocation or journal write.
 executed:=ctp_paper.capture_executed_valuation(p||jsonb_build_object('kind','PAPER_EXECUTED_VALUATION_CAPTURE'));
 IF executed->>'kind'='MISSING' THEN RETURN jsonb_build_object('kind','MISSING','request',p); END IF;
 SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_key=p->>'executionKey';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND reservation_id=x.reservation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Only this independently authenticated untouched target may be outside the executed graph.
 PERFORM ctp_paper.current_order_target(p,candidate);
 IF (SELECT count(*) FROM ctp_paper.execution_commit WHERE tenant_id=t)<>1
  OR EXISTS(SELECT 1 FROM ctp_paper.admission_issuance WHERE tenant_id=t AND intent_id<>x.intent_id)
  OR EXISTS(SELECT 1 FROM ctp_paper.attempt_start WHERE tenant_id=t AND attempt_id<>x.attempt_id)
  OR EXISTS(SELECT 1 FROM ctp_paper.attempt_preparation WHERE tenant_id=t AND attempt_id<>x.attempt_id)
  OR EXISTS(SELECT 1 FROM public."order" WHERE "tenantId"=t AND "accountId"=target AND id<>x.order_id AND id<>(candidate->>'orderId')::uuid)
  OR EXISTS(SELECT 1 FROM public.order_intent WHERE "tenantId"=t AND "accountId"=target AND id<>x.intent_id AND id<>(candidate->>'intentId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
 -- Never silently omit unrecognized monetary, reconciliation or native history.
 IF EXISTS(SELECT 1 FROM public.position WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.trade WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.funding_payment WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.asset_valuation WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.balance_snapshot WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.algo_order WHERE "tenantId"=t AND mode='PAPER')
  OR EXISTS(SELECT 1 FROM public.paper_account WHERE "tenantId"=t)
  OR EXISTS(SELECT 1 FROM public.paper_order WHERE "tenantId"=t)
  OR EXISTS(SELECT 1 FROM public.paper_position WHERE "tenantId"=t)
  OR EXISTS(SELECT 1 FROM public.risk_reservation WHERE "tenantId"=t AND mode='PAPER' AND id<>x.reservation_id)
  OR EXISTS(SELECT 1 FROM public.risk_decision WHERE "tenantId"=t AND mode='PAPER' AND id<>i.decision_id)
  OR EXISTS(SELECT 1 FROM public.account_state_version WHERE "tenantId"=t AND mode='PAPER' AND id<>i.state_id)
  OR EXISTS(SELECT 1 FROM public.ledger_transaction l WHERE l."tenantId"=t AND l.mode='PAPER'
   AND NOT(l.id=ANY(x.ledger_ids)) AND NOT EXISTS(SELECT 1 FROM ctp_paper.initial_funding f
    WHERE f.tenant_id=t AND f.account_id=l."accountId" AND f.ledger_id=l.id))
  OR EXISTS(SELECT 1 FROM public.fill WHERE "tenantId"=t AND mode='PAPER' AND NOT(id=ANY(x.fill_ids)))
  OR EXISTS(SELECT 1 FROM public.fee WHERE "tenantId"=t AND mode='PAPER' AND NOT("fillId"=ANY(x.fill_ids)))
  OR EXISTS(SELECT 1 FROM public.submission_attempt s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
  OR EXISTS(SELECT 1 FROM ctp_execution.evidence s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
  OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event s JOIN public."order" q ON q."tenantId"=s."tenantId" AND q.id=s."orderId" WHERE q."tenantId"=t AND q.mode='PAPER')
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 cfg:=(executed->'execution'->'source'->'started'->'context'->'configuration'->>'receiptText')::jsonb->'configuration';
 quote:=cfg->>'valuationAsset'; age:=least(5000,(cfg->'model'->>'maxEvidenceAgeMs')::integer);
 original:=x.input->'attempt'->'request'->'admission';
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 configurations:=jsonb_build_array(jsonb_build_object('configuration',cfg,'balances',x.effects->'state'->'balances'));
 FOREACH a IN ARRAY ids LOOP
  IF a=target THEN CONTINUE; END IF;
  book:=ctp_paper.risk_portfolio_book(jsonb_build_object('tenantId',t::text,'accountId',a::text,'mode','PAPER'),ts);
  cfg:=(book->'origin'->>'receiptText')::jsonb->'configuration';
  -- origin.configuration is the immutable configuration wire, not a new receipt.
  cfg:=(cfg->>'receiptText')::jsonb->'configuration';
  IF cfg->>'valuationAsset' IS DISTINCT FROM quote OR cfg->'source'->>'market' IS DISTINCT FROM 'SPOT'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  age:=least(age,(cfg->'model'->>'maxEvidenceAgeMs')::integer);
  drafts:=drafts+jsonb_array_length(book->'drafts');
  IF drafts>1000 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  books:=books||jsonb_build_array(jsonb_build_object('accountId',a::text,'book',book));
  configurations:=configurations||jsonb_build_array(jsonb_build_object('configuration',cfg,
   'balances',((book->'origin'->>'receiptText')::jsonb->>'stateText')::jsonb->'balances'));
 END LOOP;
 IF quote IS NULL OR age IS NULL OR age<1 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Target capture already holds these catalog locks; repeated for clarity.
 LOCK TABLE public.instrument,public.instrument_rule_version,ctp_market.snapshot_head IN SHARE MODE;
 FOR item IN SELECT value FROM jsonb_array_elements(configurations) LOOP
  cfg:=item->'configuration';
  -- Keep the original traded instrument mark even for a zero-fill FOK result.
  FOR balance IN SELECT value FROM jsonb_array_elements((item->'balances')||
   CASE WHEN cfg->'owner'->>'accountId'=target::text THEN jsonb_build_array(jsonb_build_object('asset',i.base)) ELSE '[]'::jsonb END) LOOP
   IF balance->>'asset'=quote THEN CONTINUE; END IF;
   SELECT array_agg(key) INTO heads FROM (
    SELECT sh.key FROM ctp_market.snapshot_head sh JOIN public.instrument ins ON ins.id=(sh.key->>'dbInstrumentId')::uuid
    WHERE sh.key->'scope'=cfg->'source' AND ins.active AND ins.market='SPOT'
     AND ins.exchange::text=cfg->'source'->>'exchange' AND ins.mode::text=cfg->'source'->>'environment'
     AND ins."baseAsset"=balance->>'asset' AND ins."quoteAsset"=quote
     AND (cfg->'owner'->>'accountId'<>target::text OR balance->>'asset'<>i.base
      OR (ins.id=(original->>'dbInstrumentId')::uuid AND sh.key->>'instrumentId'=original->'command'->>'instrumentId'))
    ORDER BY sh.key::text LIMIT 2
   ) q;
   IF coalesce(cardinality(heads),0)<>1 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   k:=heads[1]; SELECT * INTO h FROM ctp_market.snapshot_head WHERE key=k;
   IF NOT FOUND OR h.gap OR h.native IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   SELECT * INTO e FROM ctp_market.snapshot_event WHERE id=h.native;
   IF NOT FOUND OR e.hash<>sha256(convert_to(e.payload,'UTF8')) OR e.key-'dbRuleId'<>k
    OR e.revision>h.revision OR e.status<>'APPLIED' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   publication:=e.payload::jsonb;
   IF publication->>'id'<>e.id::text OR publication->>'kind'<>'SNAPSHOT'
    OR ctp_market.snapshot_valid(publication) IS NOT TRUE OR ctp_market.snapshot_metadata(publication) IS NOT TRUE
    OR publication->'ticker'->'last'->>'state' IS DISTINCT FROM 'AVAILABLE'
    OR NOT coalesce(ctp_market.snapshot_decimal(publication->'ticker'->'last'->'value'),false)
    OR (publication->'ticker'->'last'->>'value')::numeric<=0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   IF ctp_market.snapshot_fresh(publication,age) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(markets) m WHERE m->>'id'=e.id::text) THEN
    markets:=markets||jsonb_build_array(jsonb_build_object('id',e.id::text,'revision',h.revision::text,
     'hash',encode(e.hash,'hex'),'publicationText',e.payload));
   END IF;
   IF jsonb_array_length(markets)>300 OR octet_length(markets::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  END LOOP;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('accountId',id::text,'permissionEpoch',"permissionEpoch"::text,
  'reconciliationEpoch',"reconciliationEpoch"::text,'clientIdHighWatermark',"clientIdHighWatermark"::text,'version',version) ORDER BY id)
  INTO catalog FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER';
 result:=jsonb_build_object('kind','PAPER_HISTORICAL_INVENTORY_CAPTURE','request',p,'asOf',ts,
  'accountIds',to_jsonb(ids),'catalog',catalog,'executed',executed,'books',books,'markets',markets);
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;


CREATE FUNCTION ctp_paper.current_order_facts_base(p jsonb,candidate jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; x ctp_paper.execution_commit%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 cfg jsonb; actual_cfg jsonb; original jsonb; k jsonb; inv jsonb; runtime jsonb; controls jsonb; control_text text;
 sh ctp_market.snapshot_head%ROWTYPE; se ctp_market.snapshot_event%ROWTYPE;
 th ctp_market.trade_head%ROWTYPE; te ctp_market.trade_event%ROWTYPE; sp jsonb; tp jsonb;
 platform ctp_risk.policy_revision%ROWTYPE; usr ctp_risk.policy_revision%ROWTYPE;
 age integer; ts bigint; inv_text text; result jsonb; target_order jsonb;
BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p IS NULL OR octet_length(p::text)>16384
  OR p->>'kind' NOT IN('PAPER_CURRENT_RISK_CERTIFY','PAPER_CURRENT_RISK_READ','PAPER_CURRENT_RISK_ADVANCE')
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','executionKey','preparationKey','startKey','admission','authorization']),false)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 t:=ctp_paper.execution_start_auth((p-'executionKey')||jsonb_build_object('kind','PAPER_EXECUTION_START'));
 SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_key=p->>'executionKey';
 IF NOT FOUND THEN RETURN jsonb_build_object('kind','MISSING'); END IF;
 SELECT * INTO i FROM ctp_paper.admission_issuance WHERE tenant_id=t AND reservation_id=x.reservation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 cfg:=(x.source->'started'->'context'->'configuration'->>'receiptText')::jsonb->'configuration';
 original:=x.input->'attempt'->'request'->'admission';
 k:=jsonb_build_object('scope',cfg->'source','instrumentId',original->'command'->'instrumentId',
  'dbInstrumentId',original->'dbInstrumentId','dbRuleId',i.rule_id::text);
 IF ctp_market.snapshot_key(k) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 k:=k-'dbRuleId';
 -- All seed cash must have proven identity valuation. Wider/nonquote funding
 -- is not omitted or valued at today's price as a guessed past external flow.
 IF EXISTS(SELECT 1 FROM ctp_paper.initial_funding f WHERE f.tenant_id=t AND
  (jsonb_array_length(f.receipt_text::jsonb->'funding'->'balances') IS DISTINCT FROM 1
   OR f.receipt_text::jsonb->'funding'->'balances'->0->>'asset' IS DISTINCT FROM cfg->>'valuationAsset'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
 -- Publisher order is GLOBAL -> logical public key -> head table/rows. These
 -- shared key locks freeze DUPLICATE inserts as well as head replacements.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:market:snapshot:'||k::text,0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ctp:market:trade:'||k::text,0));
 inv:=ctp_paper.current_order_inventory(p||jsonb_build_object('kind','PAPER_HISTORICAL_INVENTORY_CAPTURE'),candidate);
 IF inv->>'kind'='MISSING' THEN RETURN inv; END IF;
 actual_cfg:=(inv->'executed'->'execution'->'source'->'started'->'context'->'configuration'->>'receiptText')::jsonb->'configuration';
 IF cfg IS DISTINCT FROM actual_cfg THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT v.* INTO platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision v USING(scope,target,mode,version,id)
  WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode='PAPER';
 IF NOT FOUND OR ctp_risk.valid_limits(platform."limitsText"::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT v.* INTO usr FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision v USING(scope,target,mode,version,id)
  WHERE h.scope='USER' AND h.target=t AND h.mode='PAPER';
 IF NOT FOUND OR ctp_risk.valid_limits(usr."limitsText"::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF platform."limitsText"::jsonb->>'valuationAsset' IS DISTINCT FROM cfg->>'valuationAsset'
  OR usr."limitsText"::jsonb->>'valuationAsset' IS DISTINCT FROM cfg->>'valuationAsset'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 age:=least(5000,(cfg->'model'->>'maxEvidenceAgeMs')::integer,
  (platform."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(usr."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer);
 runtime:=ctp_paper.context_runtime_capture(jsonb_build_object('tenantId',t::text,'accountId',x.account_id::text,'mode','PAPER'));
 SELECT * INTO sh FROM ctp_market.snapshot_head WHERE key=k;
 IF NOT FOUND OR sh.gap OR sh.native IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO se FROM ctp_market.snapshot_event WHERE id=sh.native;
 IF NOT FOUND OR se.key<>k OR se.status<>'APPLIED' OR se.revision<>sh.revision
  OR se.hash<>sha256(convert_to(se.payload,'UTF8')) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 sp:=se.payload::jsonb;
 IF ctp_market.snapshot_valid(sp) IS NOT TRUE OR ctp_market.snapshot_metadata(sp) IS NOT TRUE
  OR ctp_market.snapshot_fresh(sp,age) IS NOT TRUE OR sp->'ticker'->'last'->>'state' IS DISTINCT FROM 'AVAILABLE'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Historical original rules remain immutable. Only the new target must bind
 -- the current market metadata captured under these same catalog locks.
 target_order:=ctp_paper.current_order_target(p,candidate);
 IF target_order->>'dbRuleId' IS DISTINCT FROM sp->'key'->>'dbRuleId'
  OR target_order->>'dbInstrumentId' IS DISTINCT FROM sp->'key'->>'dbInstrumentId'
  OR target_order->'command'->>'ruleVersion' IS DISTINCT FROM sp->'record'->'rules'->>'version'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF ctp_market.trade_checked_head(k)->'gap' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO th FROM ctp_market.trade_head WHERE key=k;
 IF NOT FOUND OR th.native IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 tp:=ctp_market.trade_proof(th.native);
 SELECT * INTO te FROM ctp_market.trade_event WHERE id=th.native;
 IF NOT FOUND OR tp->>'kind'<>'TRADE' OR tp->'key'<>sp->'key' OR tp->'record'<>sp->'record'
  OR ctp_market.snapshot_metadata(tp) IS NOT TRUE OR ctp_market.trade_fresh(tp,age) IS NOT TRUE
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF (SELECT count(*) FROM ctp_risk.global_head)>10000
  OR (SELECT count(*) FROM ctp_risk.tenant_head WHERE "tenantId"=t)>10000
  OR (SELECT count(*) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL)>10000
  OR (SELECT count(*) FROM public.circuit_state WHERE "tenantId"=t)>10000
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 SELECT jsonb_build_object(
  'global',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind','GLOBAL'),
   'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY kind,key) FROM ctp_risk.global_head),'[]'),
  'tenant',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind',scope,'tenantId',"tenantId"::text,'targetId',target::text),
   'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY scope,target,kind,key) FROM ctp_risk.tenant_head WHERE "tenantId"=t),'[]'),
  'activePauses',coalesce((SELECT jsonb_agg(id::text ORDER BY id) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL),'[]'),
  'circuits',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id::text,'state',status::text) ORDER BY id) FROM public.circuit_state WHERE "tenantId"=t),'[]'))
 INTO controls;
 control_text:=ctp_admission.canonical(controls);inv_text:=ctp_admission.canonical(inv);
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 result:=jsonb_build_object('kind','PAPER_CURRENT_RISK_FACTS','request',p||jsonb_build_object('kind','PAPER_CURRENT_RISK_CERTIFY'),
  'asOf',ts,'executionId',x.execution_id::text,'marketKey',k,'maxEvidenceAgeMs',age,
  'inventory',jsonb_build_object('text',inv_text,'hash',encode(sha256(convert_to(inv_text,'UTF8')),'hex')),
  'runtime',runtime,'policies',jsonb_build_array(ctp_risk.policy_json(platform),ctp_risk.policy_json(usr)),
  'controls',jsonb_build_object('text',control_text,'hash',encode(sha256(convert_to(control_text,'UTF8')),'hex')),
  'market',jsonb_build_object('snapshot',jsonb_build_object('text',se.payload,'hash',encode(se.hash,'hex')),
   'trade',jsonb_build_object('text',te.payload,'hash',encode(te.hash,'hex'))),
  'modelHash',encode(sha256(convert_to(ctp_admission.canonical(cfg->'model'),'UTF8')),'hex'),
  'ordersInLastMinute',(SELECT count(*) FROM public.order_intent WHERE "tenantId"=t AND mode='PAPER'
   AND "createdAt">=to_timestamp((ts-60000)::double precision/1000)));
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;


CREATE FUNCTION ctp_paper.current_order_facts(p jsonb,candidate jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE facts jsonb; snapshot jsonb; k jsonb; latest_ms bigint; selected_ms bigint;
BEGIN
 -- Retains the complete original authentication, scope, current metadata and
 -- GLOBAL -> tenant/user/account/book/public-key lock boundary. In particular,
 -- the shared logical-key lock freezes DUPLICATE inserts for this transaction.
 facts:=ctp_paper.current_order_facts_base(p,candidate);
 IF facts->>'kind'='MISSING' THEN RETURN facts; END IF;
 IF facts->>'kind' IS DISTINCT FROM 'PAPER_CURRENT_RISK_FACTS'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 snapshot:=(facts->'market'->'snapshot'->>'text')::jsonb;k:=facts->'marketKey';
 selected_ms:=(snapshot->'ticker'->>'exchangeTime')::bigint;
 SELECT (e.payload::jsonb->'ticker'->>'exchangeTime')::bigint INTO latest_ms
  FROM ctp_market.snapshot_event e WHERE e.key=k AND e.status IN('APPLIED','DUPLICATE')
   AND e.payload::jsonb->>'kind'='SNAPSHOT'
  ORDER BY (e.payload::jsonb->'ticker'->>'exchangeTime')::bigint DESC,e.revision DESC,e.id LIMIT 1;
 IF latest_ms IS NULL OR selected_ms IS NULL OR latest_ms<selected_ms
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 -- Native time, not publication order/UUID or rounded JS numbers, selects the
 -- latest retained ticker interval. Check every tied receipt: no arbitrary ID
 -- may resolve conflicting equal clocks. No newer timestamp is copied into
 -- the selected book/ticker; equal prices retain their original finite lease.
 IF EXISTS(SELECT 1 FROM ctp_market.snapshot_event e WHERE e.key=k
  AND e.status IN('APPLIED','DUPLICATE') AND e.payload::jsonb->>'kind'='SNAPSHOT'
  AND (e.payload::jsonb->'ticker'->>'exchangeTime')::bigint=latest_ms
  AND (e.payload::jsonb->'ticker'->'last'->>'state' IS DISTINCT FROM 'AVAILABLE'
   OR e.payload::jsonb->'ticker'->'last'->>'value' IS DISTINCT FROM snapshot->'ticker'->'last'->>'value'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN facts;
END $$;


CREATE FUNCTION ctp_paper.current_order_certificate(p jsonb,candidate jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE facts jsonb; source jsonb; cert ctp_paper.current_risk_certificate%ROWTYPE;
 latest_loss ctp_paper.current_loss_head%ROWTYPE; b ctp_paper.current_loss_baseline%ROWTYPE;
 t uuid; ex uuid; ts bigint; day bigint; age integer; source_heads text; pending boolean;
 pub jsonb; trade jsonb; runtime jsonb; health jsonb; until_ms bigint; tm bigint;
 capability jsonb; fingerprint text; text_value text; certificate jsonb; loss jsonb;
 certificate_id uuid:=gen_random_uuid(); certificate_revision bigint;
BEGIN
 facts:=ctp_paper.current_order_facts(p,candidate);
 IF facts->>'kind'='MISSING' THEN RETURN jsonb_build_object('kind','MISSING'); END IF;
 t:=(facts->'request'->'admission'->'binding'->>'tenantId')::uuid;
 ex:=(facts->>'executionId')::uuid;ts:=(facts->>'asOf')::bigint;day:=ts/86400000*86400000;
 source_heads:=ctp_paper.current_source_heads(facts);age:=(facts->>'maxEvidenceAgeMs')::integer;
 SELECT c.* INTO cert FROM ctp_paper.current_risk_head h JOIN ctp_paper.current_risk_certificate c
  USING(tenant_id,execution_id,revision,id,fingerprint) WHERE h.tenant_id=t AND h.execution_id=ex;
 SELECT * INTO b FROM ctp_paper.current_loss_baseline WHERE tenant_id=t AND execution_id=ex AND day_start_ms=day;
 SELECT * INTO latest_loss FROM ctp_paper.current_loss_head WHERE tenant_id=t AND execution_id=ex AND day_start_ms=day;
 pending:=b.id IS NULL OR EXISTS(SELECT 1 FROM ctp_market.snapshot_event ev WHERE ev.key=facts->'marketKey'
  AND ev.revision>=coalesce((SELECT c.native_closed_revision FROM ctp_paper.current_loss_checkpoint c
   WHERE c.tenant_id=t AND c.execution_id=ex AND c.day_start_ms=day AND c.id=latest_loss.id),0)
  AND (ev.payload::jsonb->>'timestamp')::bigint>=(b.document_text::jsonb->>'at')::bigint
  AND NOT EXISTS(SELECT 1 FROM ctp_paper.current_loss_seen s WHERE s.tenant_id=t AND s.execution_id=ex
   AND s.day_start_ms=day AND s.event_id=ev.id));
 IF cert.id IS NOT NULL AND NOT pending AND cert.expires_ms>ts
  AND cert.loss_id=latest_loss.id AND cert.loss_day_start_ms=day
  AND cert.document_text::jsonb->'source'->>'sourceHeads'=source_heads
 THEN
  -- Exact source replay returns the original sealed result and finite lease.
  -- No new capture timestamp, sequence value or checkpoint is allocated.
  IF p->>'kind'<>'PAPER_CURRENT_RISK_ADVANCE' THEN RETURN jsonb_build_object('kind','CERTIFIED',
   'certificate',jsonb_build_object('text',cert.document_text,'hash',encode(cert.document_hash,'hex'))); END IF;
 END IF;
 IF p->>'kind'='PAPER_CURRENT_RISK_READ' THEN
  RETURN jsonb_build_object('kind',CASE WHEN pending THEN 'INCOMPLETE' ELSE 'REPLACED' END);
 END IF;
 source:=ctp_paper.current_loss_advance(facts);loss:=(source->'loss'->>'text')::jsonb;
 pub:=(facts->'market'->'snapshot'->>'text')::jsonb;
 trade:=(facts->'market'->'trade'->>'text')::jsonb;runtime:=facts->'runtime';
 health:=(runtime->'publication'->>'text')::jsonb->'observation'->'health';
 IF (SELECT count(*) FROM jsonb_each(health))<>9 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 until_ms:=least(day+86400000,(loss->>'validUntil')::bigint,(pub->'record'->'rules'->>'expiresAt')::bigint);
 FOR tm IN SELECT (value->>'asOf')::bigint FROM jsonb_each(health) LOOP
  IF tm>ts OR tm<ts-age THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  until_ms:=least(until_ms,tm+age+1);
 END LOOP;
 FOREACH tm IN ARRAY ARRAY[(pub->>'timestamp')::bigint,(pub->'book'->>'receivedAt')::bigint,
  (pub->'book'->>'exchangeTime')::bigint,(pub->'ticker'->>'receivedAt')::bigint,(pub->'ticker'->>'exchangeTime')::bigint,
  (trade->>'timestamp')::bigint,(trade->'trade'->>'receivedAt')::bigint,(trade->'trade'->>'exchangeTime')::bigint] LOOP
  IF tm IS NOT NULL THEN
   IF tm>ts OR tm<ts-age THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   until_ms:=least(until_ms,tm+age+1);
  END IF;
 END LOOP;
 IF until_ms<=ts OR (runtime->'publication'->>'publishedAt')::bigint>=until_ms
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 capability:=jsonb_build_object('adapterVersion','paper-spot-l2-taker-v1','modelHash',facts->'modelHash',
  'checkedAt',runtime->'publication'->'publishedAt','expiresAt',until_ms);
 fingerprint:=encode(sha256(convert_to(ctp_admission.canonical(jsonb_build_object('sourceHeads',source_heads,
  'lossHash',source->'loss'->'hash','lossReference',source->'lossReference','capability',capability)),'UTF8')),'hex');
 source:=source||jsonb_build_object('capability',capability,'fingerprint',fingerprint);
 IF p->>'kind'='PAPER_CURRENT_RISK_ADVANCE' THEN RETURN jsonb_build_object('kind','ADVANCED','source',source); END IF;
 IF loss->'complete' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PAPER_CURRENT_RISK_INCOMPLETE'; END IF;
 certificate_revision:=nextval('ctp_paper.current_risk_revision');
 certificate:=jsonb_build_object('kind','PAPER_CURRENT_RISK_CERTIFICATE','version','paper-current-risk-v1',
  'id',certificate_id::text,'revision',certificate_revision::text,'createdAt',ts,'expiresAt',until_ms,'source',source);
 text_value:=ctp_admission.canonical(certificate);
 INSERT INTO ctp_paper.current_risk_certificate VALUES(t,ex,certificate_id,certificate_revision,decode(fingerprint,'hex'),
  (source->'lossReference'->>'dayStart')::bigint,(source->'lossReference'->>'revision')::bigint,
  (source->'lossReference'->>'id')::uuid,decode(source->'lossReference'->>'hash','hex'),
  ts,until_ms,text_value,sha256(convert_to(text_value,'UTF8')));
 INSERT INTO ctp_paper.current_risk_head VALUES(t,ex,certificate_id,certificate_revision,decode(fingerprint,'hex'))
 ON CONFLICT(tenant_id,execution_id) DO UPDATE SET id=excluded.id,revision=excluded.revision,fingerprint=excluded.fingerprint;
 RETURN jsonb_build_object('kind','CERTIFIED','certificate',jsonb_build_object('text',text_value,
  'hash',encode(sha256(convert_to(text_value,'UTF8')),'hex')));
END $$;


CREATE FUNCTION ctp_paper.current_order_risk_operation(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE source jsonb:=p->'source'; candidate jsonb:=p->'target'; reply jsonb; target jsonb; kind text;
BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p IS NULL OR octet_length(p::text)>24576
  OR p->>'kind' NOT IN('PAPER_CURRENT_ORDER_RISK_CAPTURE','PAPER_CURRENT_ORDER_RISK_READ','PAPER_CURRENT_ORDER_RISK_ADVANCE')
  OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','source','target']),false)
  OR source->>'kind' IS DISTINCT FROM 'PAPER_CURRENT_RISK_CERTIFY'
  OR NOT coalesce(ctp_market.snapshot_keys(source,ARRAY['kind','executionKey','preparationKey','startKey','admission','authorization']),false)
  OR NOT coalesce(ctp_market.snapshot_keys(candidate,ARRAY['orderId','intentId','commandHash']),false)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 -- Acquire the established GLOBAL -> tenant/user boundary before any selector
 -- is trusted. The copied inventory takes the same sorted rows as migration68.
 PERFORM ctp_paper.execution_start_auth((source-'executionKey')||jsonb_build_object('kind','PAPER_EXECUTION_START'));
 kind:=CASE p->>'kind' WHEN 'PAPER_CURRENT_ORDER_RISK_READ' THEN 'PAPER_CURRENT_RISK_READ'
  WHEN 'PAPER_CURRENT_ORDER_RISK_ADVANCE' THEN 'PAPER_CURRENT_RISK_ADVANCE' ELSE 'PAPER_CURRENT_RISK_CERTIFY' END;
 reply:=ctp_paper.current_order_certificate(source||jsonb_build_object('kind',kind),candidate);
 IF reply->>'kind' IN('MISSING','REPLACED','INCOMPLETE') THEN RETURN reply; END IF;
 target:=ctp_paper.current_order_target(source,candidate);
 RETURN (reply-'kind')||jsonb_build_object('kind',CASE WHEN reply->>'kind'='CERTIFIED' THEN 'CAPTURED' ELSE 'ADVANCED' END,
  'request',p||jsonb_build_object('kind','PAPER_CURRENT_ORDER_RISK_CAPTURE'),
  'capturedAt',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'target',target);
END $$;

ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v70;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind' IN('PAPER_CURRENT_ORDER_RISK_CAPTURE','PAPER_CURRENT_ORDER_RISK_READ','PAPER_CURRENT_ORDER_RISK_ADVANCE')
 THEN RETURN ctp_paper.current_order_risk_operation(p); END IF;
 RETURN ctp_paper.reconcile_admission_v70(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.current_order_target(jsonb,jsonb),ctp_paper.current_order_inventory(jsonb,jsonb),
 ctp_paper.current_order_facts_base(jsonb,jsonb),ctp_paper.current_order_facts(jsonb,jsonb),
 ctp_paper.current_order_certificate(jsonb,jsonb),ctp_paper.current_order_risk_operation(jsonb),
 ctp_paper.reconcile_admission_v70(jsonb),ctp_paper.reconcile_admission(jsonb)
 FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;

COMMIT;
