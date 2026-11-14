BEGIN;
-- Current PAPER evidence only. No financial dispatch, grant, reservation or
-- monetary write is introduced. Published migrations1-68 remain immutable.
CREATE SEQUENCE ctp_paper.current_loss_revision AS bigint NO CYCLE;
CREATE SEQUENCE ctp_paper.current_risk_revision AS bigint NO CYCLE;
REVOKE ALL ON SEQUENCE ctp_paper.current_loss_revision,ctp_paper.current_risk_revision FROM PUBLIC,ctp_paper_risk_admission;

CREATE TABLE ctp_paper.current_loss_baseline (
 tenant_id uuid NOT NULL, execution_id uuid NOT NULL, day_start_ms bigint NOT NULL CHECK(day_start_ms%86400000=0),
 id uuid NOT NULL, document_text text NOT NULL CHECK(octet_length(document_text)<=65536),
 document_hash bytea NOT NULL CHECK(octet_length(document_hash)=32 AND document_hash=sha256(convert_to(document_text,'UTF8'))),
 PRIMARY KEY(tenant_id,execution_id,day_start_ms), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES ctp_paper.execution_commit(tenant_id,execution_id)
);
CREATE TABLE ctp_paper.current_loss_checkpoint (
 tenant_id uuid NOT NULL, execution_id uuid NOT NULL, day_start_ms bigint NOT NULL,
 id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0), previous_revision bigint, previous_day_start_ms bigint,
 previous_hash bytea, native_closed_revision bigint NOT NULL CHECK(native_closed_revision>=0),
 input_text text NOT NULL CHECK(octet_length(input_text)<=2097152),
 input_hash bytea NOT NULL CHECK(input_hash=sha256(convert_to(input_text,'UTF8'))),
 document_text text NOT NULL CHECK(octet_length(document_text)<=65536),
 document_hash bytea NOT NULL CHECK(document_hash=sha256(convert_to(document_text,'UTF8'))),
 PRIMARY KEY(tenant_id,execution_id,day_start_ms,revision), UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,execution_id,day_start_ms,revision,document_hash),
 UNIQUE(tenant_id,execution_id,day_start_ms,revision,id,document_hash),
 CHECK((previous_revision IS NULL)=(previous_hash IS NULL)),
 CHECK((previous_revision IS NULL)=(previous_day_start_ms IS NULL)),
 CHECK(previous_day_start_ms IS NULL OR (previous_day_start_ms%86400000=0 AND previous_day_start_ms<=day_start_ms)),
 CHECK(previous_revision IS NULL OR previous_revision<revision),
 FOREIGN KEY(tenant_id,execution_id,day_start_ms) REFERENCES ctp_paper.current_loss_baseline,
 FOREIGN KEY(tenant_id,execution_id,previous_day_start_ms,previous_revision,previous_hash)
  REFERENCES ctp_paper.current_loss_checkpoint(tenant_id,execution_id,day_start_ms,revision,document_hash)
);
CREATE TABLE ctp_paper.current_loss_head (
 tenant_id uuid NOT NULL, execution_id uuid NOT NULL, day_start_ms bigint NOT NULL,
 id uuid NOT NULL, revision bigint NOT NULL, document_hash bytea NOT NULL,
 PRIMARY KEY(tenant_id,execution_id,day_start_ms),
 FOREIGN KEY(tenant_id,execution_id,day_start_ms,revision,id,document_hash)
  REFERENCES ctp_paper.current_loss_checkpoint(tenant_id,execution_id,day_start_ms,revision,id,document_hash)
);
CREATE TABLE ctp_paper.current_loss_seen (
 tenant_id uuid NOT NULL, execution_id uuid NOT NULL, day_start_ms bigint NOT NULL,
 event_id uuid NOT NULL REFERENCES ctp_market.snapshot_event(id),
 native_revision bigint NOT NULL CHECK(native_revision>0), source_hash bytea NOT NULL CHECK(octet_length(source_hash)=32),
 PRIMARY KEY(tenant_id,execution_id,day_start_ms,event_id),
 FOREIGN KEY(tenant_id,execution_id,day_start_ms) REFERENCES ctp_paper.current_loss_baseline
);
CREATE TABLE ctp_paper.current_loss_native_clock (
 tenant_id uuid NOT NULL, execution_id uuid NOT NULL, day_start_ms bigint NOT NULL,
 native_ms bigint NOT NULL CHECK(native_ms BETWEEN 0 AND 8640000000000000),
 price numeric(38,18) NOT NULL CHECK(price>0),
 event_id uuid NOT NULL REFERENCES ctp_market.snapshot_event(id),
 source_hash bytea NOT NULL CHECK(octet_length(source_hash)=32),
 PRIMARY KEY(tenant_id,execution_id,native_ms),
 FOREIGN KEY(tenant_id,execution_id,day_start_ms) REFERENCES ctp_paper.current_loss_baseline
);
CREATE TABLE ctp_paper.current_risk_certificate (
 tenant_id uuid NOT NULL, execution_id uuid NOT NULL, id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
 loss_day_start_ms bigint NOT NULL, loss_revision bigint NOT NULL, loss_id uuid NOT NULL, loss_hash bytea NOT NULL,
 created_ms bigint NOT NULL CHECK(created_ms BETWEEN 0 AND 8640000000000000),
 expires_ms bigint NOT NULL CHECK(expires_ms>created_ms AND expires_ms<=8640000000000000),
 document_text text NOT NULL CHECK(octet_length(document_text)<=16777216),
 document_hash bytea NOT NULL CHECK(document_hash=sha256(convert_to(document_text,'UTF8'))),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,execution_id,revision,id,fingerprint),
 UNIQUE(tenant_id,execution_id,fingerprint),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES ctp_paper.execution_commit(tenant_id,execution_id),
 FOREIGN KEY(tenant_id,execution_id,loss_day_start_ms,loss_revision,loss_id,loss_hash)
  REFERENCES ctp_paper.current_loss_checkpoint(tenant_id,execution_id,day_start_ms,revision,id,document_hash)
);
CREATE TABLE ctp_paper.current_risk_head (
 tenant_id uuid NOT NULL, execution_id uuid NOT NULL, id uuid NOT NULL,
 revision bigint NOT NULL, fingerprint bytea NOT NULL,
 PRIMARY KEY(tenant_id,execution_id),
 FOREIGN KEY(tenant_id,execution_id,revision,id,fingerprint)
  REFERENCES ctp_paper.current_risk_certificate(tenant_id,execution_id,revision,id,fingerprint)
);
-- This index changes no publication, payload, identity or ordering semantics.
CREATE INDEX snapshot_current_loss_history ON ctp_market.snapshot_event(key,revision,id);
CREATE INDEX snapshot_current_loss_observation ON ctp_market.snapshot_event(key,((payload::jsonb->>'timestamp')::bigint),revision,id);
CREATE INDEX funding_current_loss_scope ON ctp_paper.initial_funding(tenant_id,account_id);

CREATE FUNCTION ctp_paper.current_evidence_head_monotone() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.tenant_id<>OLD.tenant_id OR NEW.execution_id<>OLD.execution_id
  OR NEW.revision<=OLD.revision
  OR (TG_TABLE_NAME='current_loss_head' AND (to_jsonb(NEW)->'day_start_ms') IS DISTINCT FROM (to_jsonb(OLD)->'day_start_ms'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['current_loss_baseline','current_loss_checkpoint','current_loss_head',
  'current_loss_seen','current_loss_native_clock','current_risk_certificate','current_risk_head'] LOOP
  EXECUTE format('ALTER TABLE ctp_paper.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE ctp_paper.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY current_risk_tenant ON ctp_paper.%I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  EXECUTE format('REVOKE ALL ON ctp_paper.%I FROM PUBLIC,ctp_paper_risk_admission',tab);
  EXECUTE format('CREATE TRIGGER current_evidence_no_truncate BEFORE TRUNCATE ON ctp_paper.%I FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row()',tab);
  IF tab IN('current_loss_head','current_risk_head') THEN
   EXECUTE format('CREATE TRIGGER current_evidence_head BEFORE UPDATE OR DELETE ON ctp_paper.%I FOR EACH ROW EXECUTE FUNCTION ctp_paper.current_evidence_head_monotone()',tab);
  ELSE
   EXECUTE format('CREATE TRIGGER current_evidence_immutable BEFORE UPDATE OR DELETE ON ctp_paper.%I FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row()',tab);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION ctp_paper.current_evidence_head_monotone() FROM PUBLIC,ctp_paper_risk_admission;

-- Private arithmetic parity. This function does not authenticate its argument,
-- certify coverage or grant authority; only the fixed source operation may do so.
CREATE FUNCTION ctp_paper.current_loss_project(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE b jsonb:=p->'baseline'; prev jsonb:=p->'previous'; day bigint:=(p->>'capturedAt')::bigint/86400000*86400000;
 at_ms bigint:=(p->>'capturedAt')::bigint; peak numeric:=(b->>'equity')::numeric; covered bigint:=(b->>'at')::bigint;
 flow_hash text; realized_hash text; prior_flow_hash text; prior_realized_hash text;
 flows numeric; current_value numeric; net_realized numeric; item jsonb; adjustment numeric;
 body jsonb; ordered_points jsonb; evidence jsonb; genesis jsonb;
BEGIN
 IF octet_length(p::text)>2097152 OR jsonb_array_length(p->'flows')>1000
  OR jsonb_array_length(p->'realized')>1000 OR jsonb_array_length(p->'points')>1000
  OR p->'scope'->>'mode' IS DISTINCT FROM 'PAPER' OR (b->>'utcDayStart')::bigint<>day
  OR (b->>'at')::bigint<day OR (b->>'at')::bigint>at_ms
  OR (b->>'expiresAt')::bigint<=at_ms OR (b->>'expiresAt')::bigint>day+86400000
  OR (p->'coverage'->>'from')::bigint<>(b->>'at')::bigint
  OR (p->'coverage'->>'through')::bigint<>at_ms OR (p->'current'->>'at')::bigint<>at_ms
  OR (p->'current'->>'sourceAt')::bigint>at_ms OR (p->>'validUntil')::bigint<=at_ms
  OR (p->>'maxEvidenceAgeMs')::integer NOT BETWEEN 1 AND 5000
  OR at_ms>=(p->'current'->>'sourceAt')::bigint+(p->>'maxEvidenceAgeMs')::integer+1
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements((p->'flows')||(p->'realized')) e
  WHERE e->>'asset' IS DISTINCT FROM p->'scope'->>'valuationAsset' OR (e->>'at')::bigint>at_ms)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'points') e
   WHERE (e->>'at')::bigint<(b->>'at')::bigint OR (e->>'at')::bigint>at_ms
    OR e->>'status' NOT IN('APPLIED','DUPLICATE'))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 FOREACH item IN ARRAY ARRAY[p->'flows',p->'realized',p->'points'] LOOP
  IF (SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(item) e)<>jsonb_array_length(item)
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 END LOOP;
 IF b->>'kind'='UTC_EQUITY' THEN
  IF (b->>'at')::bigint<>day OR b->'fundingId'<>'null'::jsonb THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 ELSIF b->>'kind'='PAPER_INCEPTION' THEN
  SELECT e INTO genesis FROM jsonb_array_elements(p->'flows') e WHERE e->>'id'=b->>'fundingId';
  IF genesis IS NULL OR genesis->'at'<>b->'at' OR genesis->>'amount'<>b->>'equity'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'flows') e WHERE (e->>'at')::bigint<(b->>'at')::bigint
    OR (e->>'id'<>b->>'fundingId' AND e->'at'=b->'at'))
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 ELSE RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT encode(sha256(convert_to(ctp_admission.canonical(coalesce(jsonb_agg(e ORDER BY e->>'id'),'[]')),'UTF8')),'hex')
 INTO flow_hash FROM jsonb_array_elements(p->'flows') e WHERE (e->>'at')::bigint<=at_ms;
 SELECT encode(sha256(convert_to(ctp_admission.canonical(coalesce(jsonb_agg(e ORDER BY e->>'id'),'[]')),'UTF8')),'hex')
 INTO realized_hash FROM jsonb_array_elements(p->'realized') e WHERE (e->>'at')::bigint<=at_ms;
 IF prev IS NOT NULL AND prev<>'null'::jsonb THEN
  SELECT encode(sha256(convert_to(ctp_admission.canonical(coalesce(jsonb_agg(e ORDER BY e->>'id'),'[]')),'UTF8')),'hex')
  INTO prior_flow_hash FROM jsonb_array_elements(p->'flows') e WHERE (e->>'at')::bigint<=(prev->>'asOf')::bigint;
  SELECT encode(sha256(convert_to(ctp_admission.canonical(coalesce(jsonb_agg(e ORDER BY e->>'id'),'[]')),'UTF8')),'hex')
  INTO prior_realized_hash FROM jsonb_array_elements(p->'realized') e WHERE (e->>'at')::bigint<=(prev->>'asOf')::bigint;
  IF prev->>'hash'<>encode(sha256(convert_to(ctp_admission.canonical(prev-'hash'),'UTF8')),'hex')
   OR p->'coverage'->>'previousHash' IS DISTINCT FROM prev->>'hash'
   OR prev->'scope' IS DISTINCT FROM p->'scope' OR prev->'executionId' IS DISTINCT FROM p->'executionId'
   OR (prev->>'asOf')::bigint>at_ms OR (prev->>'utcDayStart')::bigint>day
   OR prev->>'flowHistoryHash'<>prior_flow_hash OR prev->>'realizedHistoryHash'<>prior_realized_hash
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  IF (prev->>'utcDayStart')::bigint=day THEN
   IF prev->'baseline' IS DISTINCT FROM b THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   peak:=greatest(peak,(prev->>'adjustedPeakEquity')::numeric);covered:=(prev->>'coveredThrough')::bigint;
  ELSIF b->>'kind'<>'UTC_EQUITY' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 ELSIF p->'coverage'->'previousHash'<>'null'::jsonb THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'points') e GROUP BY e->'at' HAVING count(DISTINCT e->>'equity')>1)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 FOR item IN SELECT e FROM jsonb_array_elements(p->'points') e LOOP
  SELECT coalesce(sum((f->>'amount')::numeric),0) INTO adjustment FROM jsonb_array_elements(p->'flows') f
   WHERE (f->>'at')::bigint>=(b->>'at')::bigint AND (f->>'at')::bigint<=(item->>'at')::bigint
    AND (b->>'kind'<>'PAPER_INCEPTION' OR f->>'id'<>b->>'fundingId');
  peak:=greatest(peak,(item->>'equity')::numeric-adjustment);
 END LOOP;
 SELECT coalesce(sum((f->>'amount')::numeric),0) INTO flows FROM jsonb_array_elements(p->'flows') f
  WHERE (f->>'at')::bigint>=(b->>'at')::bigint AND (f->>'at')::bigint<=at_ms
   AND (b->>'kind'<>'PAPER_INCEPTION' OR f->>'id'<>b->>'fundingId');
 SELECT coalesce(sum((e->>'amount')::numeric),0) INTO net_realized FROM jsonb_array_elements(p->'realized') e WHERE (e->>'at')::bigint>=(b->>'at')::bigint;
 current_value:=(p->'current'->>'equity')::numeric-flows;peak:=greatest(peak,current_value);
 SELECT coalesce(jsonb_agg(e ORDER BY e->>'id'),'[]') INTO ordered_points FROM jsonb_array_elements(p->'points') e;
 evidence:=jsonb_build_object('coverage',p->'coverage','points',ordered_points,'current',p->'current');
 body:=jsonb_build_object('kind','PAPER_CURRENT_LOSS_PROJECTION','scope',p->'scope','executionId',p->'executionId','baseline',b,
  'utcDayStart',day,'asOf',at_ms,'validUntil',least((p->>'validUntil')::bigint,(b->>'expiresAt')::bigint,
   day+86400000,(p->'current'->>'sourceAt')::bigint+(p->>'maxEvidenceAgeMs')::integer+1),
  'coveredThrough',CASE WHEN (p->'coverage'->>'complete')::boolean THEN at_ms ELSE covered END,
  'complete',p->'coverage'->'complete','actualEquity',p->'current'->'equity','adjustedOpeningEquity',b->'equity',
  'adjustedCurrentEquity',trim_scale(current_value)::text,'adjustedPeakEquity',trim_scale(peak)::text,
  'externalFlows',trim_scale(flows)::text,'dailyNetRealizedPnl',trim_scale(net_realized)::text,
  'flowHistoryHash',flow_hash,'realizedHistoryHash',realized_hash,
  'evidenceHash',encode(sha256(convert_to(ctp_admission.canonical(evidence),'UTF8')),'hex'));
 RETURN body||jsonb_build_object('hash',encode(sha256(convert_to(ctp_admission.canonical(body),'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION ctp_paper.current_loss_project(jsonb) FROM PUBLIC,ctp_paper_risk_admission;

CREATE FUNCTION ctp_paper.current_risk_facts(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid; x ctp_paper.execution_commit%ROWTYPE; i ctp_paper.admission_issuance%ROWTYPE;
 cfg jsonb; actual_cfg jsonb; original jsonb; k jsonb; inv jsonb; runtime jsonb; controls jsonb; control_text text;
 sh ctp_market.snapshot_head%ROWTYPE; se ctp_market.snapshot_event%ROWTYPE;
 th ctp_market.trade_head%ROWTYPE; te ctp_market.trade_event%ROWTYPE; sp jsonb; tp jsonb;
 platform ctp_risk.policy_revision%ROWTYPE; usr ctp_risk.policy_revision%ROWTYPE;
 age integer; ts bigint; inv_text text; result jsonb;
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
 inv:=ctp_paper.capture_historical_inventory(p||jsonb_build_object('kind','PAPER_HISTORICAL_INVENTORY_CAPTURE'));
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
REVOKE ALL ON FUNCTION ctp_paper.current_risk_facts(jsonb) FROM PUBLIC,ctp_paper_risk_admission;

CREATE FUNCTION ctp_paper.current_loss_economics(facts jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE t uuid:=(facts->'request'->'admission'->'binding'->>'tenantId')::uuid;
 x ctp_paper.execution_commit%ROWTYPE; r ctp_paper.initial_funding%ROWTYPE; f public.fee%ROWTYPE;
 cfg jsonb; c jsonb; wire jsonb; receipt jsonb; seed jsonb; effective_ms bigint;
 flows jsonb:='[]'; realized jsonb:='[]'; source jsonb; quantity numeric; spent numeric;
 quote text; sp jsonb; inv jsonb; source_at bigint; ts bigint:=(facts->>'asOf')::bigint;
BEGIN
 IF facts->>'kind' IS DISTINCT FROM 'PAPER_CURRENT_RISK_FACTS' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO x FROM ctp_paper.execution_commit WHERE tenant_id=t AND execution_id=(facts->>'executionId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 cfg:=(x.source->'started'->'context'->'configuration'->>'receiptText')::jsonb->'configuration';
 quote:=cfg->>'valuationAsset';
 FOR r IN SELECT * FROM ctp_paper.initial_funding WHERE tenant_id=t ORDER BY id LOOP
  c:=ctp_paper.funding_configuration(jsonb_build_object('tenantId',t::text,'accountId',r.account_id::text,'mode','PAPER'),r.configuration_id);
  wire:=ctp_paper.funding_wire(r,c);receipt:=(wire->>'receiptText')::jsonb;seed:=receipt->'funding';
  IF jsonb_array_length(seed->'balances') IS DISTINCT FROM 1 OR seed->'balances'->0->>'asset' IS DISTINCT FROM quote
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
  SELECT floor(extract(epoch FROM l."effectiveAt")*1000)::bigint INTO effective_ms
   FROM public.ledger_transaction l WHERE l."tenantId"=t AND l.id=r.ledger_id AND l."accountId"=r.account_id AND l.mode='PAPER';
  IF NOT FOUND OR effective_ms IS DISTINCT FROM (receipt->>'createdAt')::bigint OR effective_ms>ts
   OR seed->>'id' IS DISTINCT FROM r.ledger_id::text THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  flows:=flows||jsonb_build_array(jsonb_build_object('id',seed->'id','accountId',r.account_id::text,
   'sourceHash',wire->'hash','at',effective_ms,'asset',quote,'amount',seed->'balances'->0->'amount'));
 END LOOP;
 IF jsonb_array_length(flows) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 SELECT coalesce(sum(v.quantity),0) INTO quantity FROM public.fill v WHERE v."tenantId"=t AND v.id=ANY(x.fill_ids)
  AND v."accountId"=x.account_id AND v.mode='PAPER';
 SELECT -coalesce(sum(amount),0) INTO spent FROM public.ledger_entry WHERE "tenantId"=t AND "transactionId"=ANY(x.ledger_ids)
  AND "accountId"=x.account_id AND mode='PAPER' AND asset=quote AND bucket='AVAILABLE';
 IF quantity<0 OR spent<0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 FOR f IN SELECT * FROM public.fee WHERE "tenantId"=t AND "fillId"=ANY(x.fill_ids) ORDER BY id LOOP
  IF f.asset<>quote OR f.mode<>'PAPER' OR f."accountId"<>x.account_id THEN RAISE EXCEPTION 'PAPER_ADMISSION_UNSUPPORTED'; END IF;
  source:=jsonb_build_object('id',f.id::text,'fillId',f."fillId"::text,'asset',f.asset,
   'amount',trim_scale(f.amount)::text,'at',x.evaluated_ms);
  realized:=realized||jsonb_build_array(jsonb_build_object('id',f.id::text,
   'sourceHash',encode(sha256(convert_to(ctp_admission.canonical(source),'UTF8')),'hex'),
   'at',x.evaluated_ms,'asset',quote,'amount',trim_scale(-f.amount)::text));
 END LOOP;
 IF jsonb_array_length(realized)>1000 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 sp:=(facts->'market'->'snapshot'->>'text')::jsonb;inv:=(facts->'inventory'->>'text')::jsonb;
 source_at:=least((inv->>'asOf')::bigint,(sp->>'timestamp')::bigint,
  (sp->'ticker'->>'exchangeTime')::bigint,(sp->'ticker'->>'receivedAt')::bigint,
  (sp->'book'->>'exchangeTime')::bigint,(sp->'book'->>'receivedAt')::bigint);
 RETURN jsonb_build_object('scope',jsonb_build_object('tenantId',t::text,'mode','PAPER','valuationAsset',quote),
  'executionId',x.execution_id::text,'executionAt',x.evaluated_ms,'quantity',trim_scale(quantity)::text,
  'spent',trim_scale(spent)::text,'flows',flows,'realized',realized,'sourceAt',source_at);
END $$;
CREATE FUNCTION ctp_paper.current_mark_equity(economics jsonb,at_ms bigint,price numeric,opening boolean) RETURNS numeric
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE value numeric; executed bigint:=(economics->>'executionAt')::bigint;
 q numeric:=(economics->>'quantity')::numeric; spent numeric:=(economics->>'spent')::numeric;
BEGIN
 IF price<=0 OR at_ms<0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT coalesce(sum((f->>'amount')::numeric),0) INTO value FROM jsonb_array_elements(economics->'flows') f
  WHERE CASE WHEN opening THEN (f->>'at')::bigint<at_ms ELSE (f->>'at')::bigint<=at_ms END;
 IF NOT opening AND at_ms=executed AND (q<>0 OR spent<>0) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF executed<at_ms THEN value:=value-spent+q*price; END IF;
 IF value<0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN value;
END $$;
REVOKE ALL ON FUNCTION ctp_paper.current_loss_economics(jsonb),ctp_paper.current_mark_equity(jsonb,bigint,numeric,boolean)
 FROM PUBLIC,ctp_paper_risk_admission;

-- Retained publications are validated at their original observation time, never
-- against today's metadata head or by refreshing an old quote's timestamps.
CREATE FUNCTION ctp_paper.current_loss_mark(p jsonb,at_ms bigint,age integer) RETURNS numeric
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE r public.instrument_rule_version%ROWTYPE; mark_ms bigint; tm bigint;
BEGIN
 IF ctp_market.snapshot_valid(p) IS NOT TRUE OR p->>'kind'<>'SNAPSHOT'
  OR (p->>'timestamp')::bigint<>at_ms OR p->'ticker'->'last'->>'state' IS DISTINCT FROM 'AVAILABLE'
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT * INTO r FROM public.instrument_rule_version WHERE id=(p->'key'->>'dbRuleId')::uuid
  AND "instrumentId"=(p->'key'->>'dbInstrumentId')::uuid;
 IF NOT FOUND OR r.rules IS DISTINCT FROM p->'record'->'rules'
  OR (r.rules->>'effectiveAt')::bigint>at_ms OR (r.rules->>'expiresAt')::bigint<=at_ms
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 FOREACH tm IN ARRAY ARRAY[(p->'ticker'->>'exchangeTime')::bigint,(p->'ticker'->>'receivedAt')::bigint,
  (p->'book'->>'exchangeTime')::bigint,(p->'book'->>'receivedAt')::bigint] LOOP
  IF tm IS NOT NULL AND (tm>at_ms OR at_ms-tm>age) THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 END LOOP;
 mark_ms:=(p->'ticker'->>'exchangeTime')::bigint;
 IF mark_ms IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 RETURN (p->'ticker'->'last'->>'value')::numeric;
END $$;

CREATE FUNCTION ctp_paper.current_loss_opening(facts jsonb,economics jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid:=(economics->'scope'->>'tenantId')::uuid; ex uuid:=(economics->>'executionId')::uuid;
 ts bigint:=(facts->>'asOf')::bigint; day bigint:=ts/86400000*86400000;
 b ctp_paper.current_loss_baseline%ROWTYPE; g ctp_paper.admission_genesis%ROWTYPE;
 anchor ctp_market.snapshot_event%ROWTYPE; first_flow jsonb; first_ms bigint; opening numeric;
 price numeric; source jsonb; document jsonb; text_value text; base_id uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO b FROM ctp_paper.current_loss_baseline WHERE tenant_id=t AND execution_id=ex AND day_start_ms=day;
 IF FOUND THEN RETURN b.document_text::jsonb; END IF;
 SELECT min((f->>'at')::bigint) INTO first_ms FROM jsonb_array_elements(economics->'flows') f;
 IF first_ms>=day THEN
  IF (SELECT count(*) FROM jsonb_array_elements(economics->'flows') f WHERE (f->>'at')::bigint=first_ms)<>1
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  SELECT f INTO first_flow FROM jsonb_array_elements(economics->'flows') f WHERE (f->>'at')::bigint=first_ms;
  SELECT * INTO g FROM ctp_paper.admission_genesis WHERE tenant_id=t;
  IF NOT FOUND OR g.started_ms<>first_ms OR g.funding_id::text<>first_flow->>'id'
   OR g.asset<>economics->'scope'->>'valuationAsset' OR g.initial_capital<>(first_flow->>'amount')::numeric
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  source:=jsonb_build_object('kind','GENESIS','id',g.id::text,'flow',first_flow);
  document:=jsonb_build_object('kind','PAPER_INCEPTION','id',base_id::text,
   'utcDayStart',day,'at',first_ms,'equity',trim_scale(g.initial_capital)::text,
   'expiresAt',day+86400000,'fundingId',g.funding_id::text);
 ELSE
  IF (economics->>'executionAt')::bigint<day AND (economics->>'quantity')::numeric<>0 THEN
   SELECT * INTO anchor FROM ctp_market.snapshot_event WHERE key=facts->'marketKey'
    AND (payload::jsonb->>'timestamp')::bigint<day AND status IN('APPLIED','DUPLICATE')
    ORDER BY (payload::jsonb->>'timestamp')::bigint DESC,revision DESC,id LIMIT 1;
   IF NOT FOUND OR day-(anchor.payload::jsonb->>'timestamp')::bigint>(facts->>'maxEvidenceAgeMs')::integer
    OR EXISTS(SELECT 1 FROM ctp_market.snapshot_event e WHERE e.key=facts->'marketKey'
     AND e.revision>=anchor.revision AND e.status='RESYNC_REQUIRED'
     AND (e.payload::jsonb->>'timestamp')::bigint<=day)
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   price:=ctp_paper.current_loss_mark(anchor.payload::jsonb,(anchor.payload::jsonb->>'timestamp')::bigint,
    (facts->>'maxEvidenceAgeMs')::integer);
   IF day-(anchor.payload::jsonb->'ticker'->>'exchangeTime')::bigint>(facts->>'maxEvidenceAgeMs')::integer
   THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
   source:=jsonb_build_object('kind','UTC_MARK','id',anchor.id::text,'hash',encode(anchor.hash,'hex'));
  ELSE price:=1;source:=jsonb_build_object('kind','UTC_CASH'); END IF;
  opening:=ctp_paper.current_mark_equity(economics,day,price,true);
  IF opening<=0 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  source:=source||jsonb_build_object('flows',economics->'flows','day',day);
  document:=jsonb_build_object('kind','UTC_EQUITY','id',base_id::text,'utcDayStart',day,'at',day,
   'equity',trim_scale(opening)::text,'expiresAt',day+86400000,'fundingId',NULL);
 END IF;
 document:=document||jsonb_build_object('sourceHash',encode(sha256(convert_to(ctp_admission.canonical(source),'UTF8')),'hex'));
 text_value:=ctp_admission.canonical(document);
 INSERT INTO ctp_paper.current_loss_baseline VALUES(t,ex,day,base_id,text_value,sha256(convert_to(text_value,'UTF8')));
 RETURN document;
END $$;

CREATE FUNCTION ctp_paper.current_source_heads(facts jsonb) RETURNS text
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE inv jsonb:=(facts->'inventory'->>'text')::jsonb; trade jsonb:=(facts->'market'->'trade'->>'text')::jsonb;
 r jsonb:=facts->'runtime'->'publication'; books jsonb; markets jsonb; value jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',b->'accountId',
  'hash',encode(sha256(convert_to(ctp_admission.canonical((b->'book')-'asOf'),'UTF8')),'hex')) ORDER BY ord),'[]')
 INTO books FROM jsonb_array_elements(inv->'books') WITH ORDINALITY q(b,ord);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m->'id','revision',m->'revision','hash',m->'hash') ORDER BY ord),'[]')
 INTO markets FROM jsonb_array_elements(inv->'markets') WITH ORDINALITY q(m,ord);
 value:=jsonb_build_object('request',facts->'request','catalog',inv->'catalog',
  'executionHash',encode(sha256(convert_to(ctp_admission.canonical(inv->'executed'->'execution'),'UTF8')),'hex'),
  'books',books,'markets',markets,
  'runtime',jsonb_build_object('id',r->'id','revision',r->'revision','hash',r->'hash','publishedAt',r->'publishedAt'),
  'policies',facts->'policies','controlsHash',facts->'controls'->'hash',
  'trade',jsonb_build_object('id',trade->'id','revision',((trade->>'expectedRevision')::bigint+1)::text,
   'hash',facts->'market'->'trade'->'hash'),
  'modelHash',coalesce(facts->'modelHash',facts->'capability'->'modelHash'),
  'ordersInLastMinute',facts->'ordersInLastMinute');
 RETURN encode(sha256(convert_to(ctp_admission.canonical(value),'UTF8')),'hex');
END $$;

CREATE FUNCTION ctp_paper.current_loss_advance(facts jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE economics jsonb:=ctp_paper.current_loss_economics(facts); baseline jsonb;
 t uuid:=(economics->'scope'->>'tenantId')::uuid; ex uuid:=(economics->>'executionId')::uuid;
 ts bigint:=(facts->>'asOf')::bigint; day bigint:=ts/86400000*86400000; k jsonb:=facts->'marketKey';
 previous ctp_paper.current_loss_checkpoint%ROWTYPE; e ctp_market.snapshot_event%ROWTYPE;
 seen_clock ctp_paper.current_loss_native_clock%ROWTYPE; p jsonb; points jsonb:='[]';
 native_at bigint; at_ms bigint; price numeric; equity numeric; processed integer:=0; closed bigint:=0; head_revision bigint;
 complete boolean; input jsonb; projection jsonb; input_text text; text_value text; reference jsonb;
 checkpoint_id uuid:=gen_random_uuid(); checkpoint_revision bigint; coverage jsonb; source jsonb;
BEGIN
 baseline:=ctp_paper.current_loss_opening(facts,economics);
 SELECT c.* INTO previous FROM ctp_paper.current_loss_head h JOIN ctp_paper.current_loss_checkpoint c
  USING(tenant_id,execution_id,day_start_ms,revision,id,document_hash)
  WHERE h.tenant_id=t AND h.execution_id=ex AND h.day_start_ms<=day ORDER BY h.day_start_ms DESC LIMIT 1;
 IF FOUND AND previous.day_start_ms=day THEN closed:=previous.native_closed_revision; END IF;
 SELECT revision INTO head_revision FROM ctp_market.snapshot_head WHERE key=k;
 IF head_revision IS NULL THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 IF closed=0 THEN
  SELECT coalesce(min(ev.revision),head_revision) INTO closed FROM ctp_market.snapshot_event ev
   WHERE ev.key=k AND (ev.payload::jsonb->>'timestamp')::bigint>=(baseline->>'at')::bigint;
 END IF;
 -- A bounded batch with durable seen IDs includes ticker-only DUPLICATE rows.
 -- The current revision remains open: later duplicates cannot be skipped.
 FOR e IN SELECT ev.* FROM ctp_market.snapshot_event ev WHERE ev.key=k AND ev.revision>=closed
  AND (ev.payload::jsonb->>'timestamp')::bigint>=(baseline->>'at')::bigint
  AND NOT EXISTS(SELECT 1 FROM ctp_paper.current_loss_seen s WHERE s.tenant_id=t AND s.execution_id=ex
   AND s.day_start_ms=day AND s.event_id=ev.id)
  ORDER BY ev.revision,ev.id LIMIT 129 LOOP
  processed:=processed+1;
  IF processed>128 THEN EXIT; END IF;
  p:=e.payload::jsonb;at_ms:=(p->>'timestamp')::bigint;
  IF at_ms>ts OR e.revision>head_revision OR e.status NOT IN('APPLIED','DUPLICATE')
   OR e.id::text IS DISTINCT FROM p->>'id' OR (p->'key')-'dbRuleId'<>k
   OR e.hash<>sha256(convert_to(e.payload,'UTF8'))
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  price:=ctp_paper.current_loss_mark(p,at_ms,(facts->>'maxEvidenceAgeMs')::integer);
  native_at:=(p->'ticker'->>'exchangeTime')::bigint;
  SELECT * INTO seen_clock FROM ctp_paper.current_loss_native_clock WHERE tenant_id=t AND execution_id=ex AND native_ms=native_at;
  IF FOUND AND seen_clock.price<>price THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  INSERT INTO ctp_paper.current_loss_native_clock VALUES(t,ex,day,native_at,price,e.id,e.hash) ON CONFLICT DO NOTHING;
  equity:=ctp_paper.current_mark_equity(economics,at_ms,price,false);
  points:=points||jsonb_build_array(jsonb_build_object('id',e.id::text,'sourceHash',encode(e.hash,'hex'),
   'at',at_ms,'equity',trim_scale(equity)::text,'revision',e.revision::text,'status',e.status));
  INSERT INTO ctp_paper.current_loss_seen VALUES(t,ex,day,e.id,e.revision,e.hash);
 END LOOP;
 complete:=processed<=128;
 IF complete THEN closed:=head_revision;
 ELSE SELECT min(ev.revision) INTO closed FROM ctp_market.snapshot_event ev WHERE ev.key=k
  AND (ev.payload::jsonb->>'timestamp')::bigint>=(baseline->>'at')::bigint
  AND NOT EXISTS(SELECT 1 FROM ctp_paper.current_loss_seen s WHERE s.tenant_id=t AND s.execution_id=ex
   AND s.day_start_ms=day AND s.event_id=ev.id); END IF;
 p:=(facts->'market'->'snapshot'->>'text')::jsonb;
 equity:=ctp_paper.current_mark_equity(economics,ts,(p->'ticker'->'last'->>'value')::numeric,false);
 coverage:=jsonb_build_object('id',checkpoint_id::text,'sourceHash',ctp_paper.current_source_heads(facts),
  'from',baseline->'at','through',ts,'complete',complete,'previousHash',previous.document_text::jsonb->'hash');
 input:=jsonb_build_object('scope',economics->'scope','executionId',ex::text,'capturedAt',ts,
  'validUntil',least(day+86400000,(economics->>'sourceAt')::bigint+(facts->>'maxEvidenceAgeMs')::integer+1),
  'maxEvidenceAgeMs',facts->'maxEvidenceAgeMs','baseline',baseline,'flows',economics->'flows',
  'realized',economics->'realized','points',points,'previous',previous.document_text::jsonb,
  'current',jsonb_build_object('id',p->'id','sourceHash',facts->'inventory'->'hash','at',ts,
   'sourceAt',economics->'sourceAt','equity',trim_scale(equity)::text),'coverage',coverage);
 projection:=ctp_paper.current_loss_project(input);
 input_text:=ctp_admission.canonical(input);text_value:=ctp_admission.canonical(projection);
 checkpoint_revision:=nextval('ctp_paper.current_loss_revision');
 INSERT INTO ctp_paper.current_loss_checkpoint VALUES(t,ex,day,checkpoint_id,checkpoint_revision,
  previous.revision,previous.day_start_ms,previous.document_hash,closed,input_text,sha256(convert_to(input_text,'UTF8')),
  text_value,sha256(convert_to(text_value,'UTF8')));
 INSERT INTO ctp_paper.current_loss_head VALUES(t,ex,day,checkpoint_id,checkpoint_revision,sha256(convert_to(text_value,'UTF8')))
 ON CONFLICT(tenant_id,execution_id,day_start_ms) DO UPDATE SET id=excluded.id,revision=excluded.revision,document_hash=excluded.document_hash;
 reference:=jsonb_build_object('id',checkpoint_id::text,'revision',checkpoint_revision::text,'dayStart',day,
  'hash',encode(sha256(convert_to(text_value,'UTF8')),'hex'));
 source:=(facts-'executionId'-'marketKey'-'maxEvidenceAgeMs'-'modelHash')||jsonb_build_object(
  'kind','PAPER_CURRENT_RISK_CAPTURE','sourceHeads',ctp_paper.current_source_heads(facts),
  'lossInput',input,'loss',jsonb_build_object('text',text_value,'hash',reference->'hash'),'lossReference',reference);
 RETURN source;
END $$;
REVOKE ALL ON FUNCTION ctp_paper.current_loss_mark(jsonb,bigint,integer),ctp_paper.current_loss_opening(jsonb,jsonb),
 ctp_paper.current_source_heads(jsonb),ctp_paper.current_loss_advance(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
CREATE FUNCTION ctp_paper.current_risk_operation(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE facts jsonb; source jsonb; cert ctp_paper.current_risk_certificate%ROWTYPE;
 latest_loss ctp_paper.current_loss_head%ROWTYPE; b ctp_paper.current_loss_baseline%ROWTYPE;
 t uuid; ex uuid; ts bigint; day bigint; age integer; source_heads text; pending boolean;
 pub jsonb; trade jsonb; runtime jsonb; health jsonb; until_ms bigint; tm bigint;
 capability jsonb; fingerprint text; text_value text; certificate jsonb; loss jsonb;
 certificate_id uuid:=gen_random_uuid(); certificate_revision bigint;
BEGIN
 facts:=ctp_paper.current_risk_facts(p);
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
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v68;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind' IN('PAPER_CURRENT_RISK_CERTIFY','PAPER_CURRENT_RISK_READ','PAPER_CURRENT_RISK_ADVANCE')
 THEN RETURN ctp_paper.current_risk_operation(p); END IF;
 RETURN ctp_paper.reconcile_admission_v68(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.current_risk_operation(jsonb),ctp_paper.reconcile_admission_v68(jsonb),
 ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
