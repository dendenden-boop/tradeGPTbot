BEGIN;
-- Atomic PAPER order/book/public-head proof; no financial/initializer grants.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_risk_authority') THEN
 CREATE ROLE ctp_paper_risk_authority NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_risk_authority;

CREATE FUNCTION ctp_paper.valid_risk_authority_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_risk_authority'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_risk_authority','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_risk_authority' AND pg_has_role(session_user,r.oid,'MEMBER'))
 AND NOT has_database_privilege(session_user,current_database(),'CREATE,TEMP')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_')
  AND (has_schema_privilege(session_user,n.oid,'CREATE') OR pg_has_role(session_user,n.nspowner,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p','v','m','f')
  AND (pg_has_role(session_user,t.relowner,'MEMBER') OR has_table_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
   OR has_any_column_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
  WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(session_user,f.oid,'EXECUTE')
  AND (n.nspname||'.'||f.proname||'('||replace(oidvectortypes(f.proargtypes),' ','')||')')
   NOT IN('ctp_paper.capture_risk_authority(jsonb)'))
$$;

-- Private locked capture retains the published-46 guards. The old RPC and
-- its role are unchanged. Only the new guarded definer can call this helper.
CREATE FUNCTION ctp_paper.authority_order_capture(x jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o jsonb:=x->'owner'; t uuid; a uuid; target uuid; ts bigint; b jsonb; cfg jsonb;
 c ctp_execution.command%ROWTYPE; ord public."order"%ROWTYPE; i public.order_intent%ROWTYPE;
 k jsonb; sh ctp_market.snapshot_head%ROWTYPE; se ctp_market.snapshot_event%ROWTYPE;
 th ctp_market.trade_head%ROWTYPE; te ctp_market.trade_event%ROWTYPE;
 sp jsonb; tp jsonb; state jsonb; result jsonb; age integer;
BEGIN
 IF x IS NULL OR octet_length(x::text)>1024
 OR NOT coalesce(ctp_market.snapshot_keys(x,ARRAY['owner','intentId']),false)
 OR NOT coalesce(ctp_paper.valid_owner(o),false)
 OR jsonb_typeof(x->'intentId') IS DISTINCT FROM 'string'
 OR x->>'intentId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_INPUT'; END IF;
 IF o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true) THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_OWNERSHIP'; END IF;
 t:=(o->>'tenantId')::uuid; a:=(o->>'accountId')::uuid; target:=(x->>'intentId')::uuid;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 PERFORM 1 FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_OWNERSHIP'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND id=a AND mode='PAPER' AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_OWNERSHIP'; END IF;
 SELECT * INTO ord FROM public."order" WHERE "tenantId"=t AND "accountId"=a AND "intentId"=target AND mode='PAPER' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_OWNERSHIP'; END IF;
 -- Hold all account order FK mutexes before the original-book activity proof.
 IF (SELECT count(*) FROM (SELECT id FROM public."order" WHERE "tenantId"=t AND "accountId"=a LIMIT 1001) q)>1000
 THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_CAPACITY'; END IF;
 PERFORM 1 FROM public."order" WHERE "tenantId"=t AND "accountId"=a ORDER BY id FOR UPDATE;
 SELECT * INTO c FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=target AND "orderId"=ord.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_CORRUPT'; END IF;
 SELECT * INTO i FROM public.order_intent WHERE "tenantId"=t AND "accountId"=a AND id=target;
 IF NOT FOUND OR i.operation<>'PLACE' OR i.destination<>'PAPER_ENGINE' OR c.operation<>'PLACE'
 OR i.mode<>'PAPER' OR i."connectionId" IS NOT NULL OR i."targetOrderId" IS NOT NULL
 OR c."commandHash" IS DISTINCT FROM i."commandHash" OR ord."connectionId" IS NOT NULL
 OR ord.version<>0 OR ord.status<>'CREATED' OR ord."reconciliationState"<>'REQUIRED'
 OR c.draft::jsonb->>'dbInstrumentId' IS DISTINCT FROM ord."instrumentId"::text
 OR c.draft::jsonb->>'dbRuleId' IS DISTINCT FROM ord."ruleVersionId"::text
 OR i."instrumentId" IS DISTINCT FROM ord."instrumentId" OR i."ruleVersionId" IS DISTINCT FROM ord."ruleVersionId"
 THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_INCOMPLETE'; END IF;
 IF EXISTS(SELECT 1 FROM ctp_execution.evidence e JOIN public."order" q ON q."tenantId"=e."tenantId" AND q.id=e."orderId" WHERE q."tenantId"=t AND q."accountId"=a)
 OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event e JOIN public."order" q ON q."tenantId"=e."tenantId" AND q.id=e."orderId" WHERE q."tenantId"=t AND q."accountId"=a)
 OR EXISTS(SELECT 1 FROM public.order_event e JOIN public."order" q ON q."tenantId"=e."tenantId" AND q.id=e."orderId"
   JOIN ctp_execution.command cmd ON cmd."tenantId"=q."tenantId" AND cmd."intentId"=q."intentId"
   WHERE q."tenantId"=t AND q."accountId"=a AND (e.version<>0 OR e."previousStatus" IS NOT NULL OR e.status<>'CREATED'
    OR e.source<>'CREATE' OR e."sourceIdentity" IS DISTINCT FROM q."intentId"::text OR e."evidenceHash" IS DISTINCT FROM cmd."commandHash"
    OR e."attemptId" IS NOT NULL OR e."occurredAt"<q."createdAt" OR e."occurredAt">clock_timestamp()))
 OR NOT EXISTS(SELECT 1 FROM public.order_event WHERE "tenantId"=t AND "orderId"=ord.id AND version=0)
 THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_INCOMPLETE'; END IF;
 -- SHARE catalog locks prevent rule/head replacement and insertion until COMMIT.
 -- This is bounded evidence capture, never a shared monetary budget lock.
 LOCK TABLE public.instrument,public.instrument_rule_version,ctp_market.snapshot_head,ctp_market.trade_head IN SHARE MODE;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 b:=ctp_paper.risk_portfolio_book(o,ts);
 cfg:=((b->'origin'->>'receiptText')::jsonb->'configuration'->>'receiptText')::jsonb->'configuration';
 age:=least(5000,(cfg->'model'->>'maxEvidenceAgeMs')::integer);
 k:=jsonb_build_object('scope',cfg->'source','instrumentId',c.command::jsonb->'instrumentId','dbInstrumentId',ord."instrumentId"::text);
 SELECT * INTO sh FROM ctp_market.snapshot_head WHERE key=k;
 IF NOT FOUND OR sh.gap OR sh.native IS NULL THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_MARKET'; END IF;
 SELECT * INTO se FROM ctp_market.snapshot_event WHERE id=sh.native;
 IF NOT FOUND OR se.key<>k OR se.status<>'APPLIED' OR se.revision<>sh.revision OR sh.event<>sh.native
 OR se.hash<>sha256(convert_to(se.payload,'UTF8')) THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_CORRUPT'; END IF;
 sp:=se.payload::jsonb;
 IF sp->>'kind'<>'SNAPSHOT' OR sp->>'id'<>se.id::text OR sp->'key'<>k||jsonb_build_object('dbRuleId',ord."ruleVersionId"::text)
 OR ctp_market.snapshot_valid(sp) IS NOT TRUE OR ctp_market.snapshot_metadata(sp) IS NOT TRUE
 THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_MARKET'; END IF;
 state:=ctp_market.trade_checked_head(k);
 IF state->>'revision'='0' OR state->'gap'='true'::jsonb THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_MARKET'; END IF;
 SELECT * INTO th FROM ctp_market.trade_head WHERE key=k;
 SELECT * INTO te FROM ctp_market.trade_event WHERE id=th.native;
 tp:=ctp_market.trade_proof(te.id);
 IF tp->>'kind'<>'TRADE' OR tp->'key'<>sp->'key' OR tp->'record'<>sp->'record'
 OR ctp_market.snapshot_metadata(tp) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_MARKET'; END IF;
 IF ctp_market.snapshot_fresh(sp,age) IS NOT TRUE OR ctp_market.trade_fresh(tp,age) IS NOT TRUE
 THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_STALE'; END IF;
 result:=jsonb_build_object('kind','PAPER_ORDER_RISK_CAPTURE','asOf',ts,'book',b,
  'target',jsonb_build_object('orderId',ord.id::text,'intentId',target::text,'dbInstrumentId',ord."instrumentId"::text,
   'dbRuleId',ord."ruleVersionId"::text,'bindingText',c.binding,'commandText',c.command,'commandHash',encode(c."commandHash",'hex')),
  'snapshot',jsonb_build_object('id',se.id::text,'revision',sh.revision::text,'publicationText',se.payload,'hash',encode(se.hash,'hex')),
  'trade',jsonb_build_object('id',te.id::text,'revision',th.revision::text,'publicationText',te.payload,'hash',encode(te.hash,'hex')));
 IF octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_CAPACITY'; END IF;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_ORDER_RISK_%' THEN RAISE;
 ELSIF SQLERRM LIKE 'PAPER_BOOK_SOURCE_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_BOOK_SOURCE_','PAPER_ORDER_RISK_');
 ELSE RAISE EXCEPTION 'PAPER_ORDER_RISK_CORRUPT'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_ORDER_RISK_CORRUPT';
END $$;

CREATE FUNCTION ctp_paper.capture_risk_authority(x jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b jsonb; t uuid; a public.exchange_account%ROWTYPE; u public."user"%ROWTYPE;
 platform ctp_risk.policy_revision%ROWTYPE; usr ctp_risk.policy_revision%ROWTYPE;
 controls_text text; result jsonb;
BEGIN
 IF NOT coalesce(ctp_paper.valid_risk_authority_runtime(),false)
 THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_ROLE_UNSAFE'; END IF;
 -- The private helper validates input/ownership and holds GLOBAL -> tenant ->
 -- user/account/order/book and metadata/public-head locks through this COMMIT.
 b:=ctp_paper.authority_order_capture(x);
 t:=(x->'owner'->>'tenantId')::uuid;
 SELECT * INTO u FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_OWNERSHIP'; END IF;
 SELECT * INTO a FROM public.exchange_account
  WHERE "tenantId"=t AND id=(x->'owner'->>'accountId')::uuid AND mode='PAPER' AND status='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_OWNERSHIP'; END IF;
 SELECT r.* INTO platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id)
  WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode='PAPER';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_POLICY'; END IF;
 SELECT r.* INTO usr FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision r USING(scope,target,mode,version,id)
  WHERE h.scope='USER' AND h.target=t AND h.mode='PAPER';
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_POLICY'; END IF;
 IF ctp_risk.valid_limits(platform."limitsText"::jsonb) IS NOT TRUE
  OR ctp_risk.valid_limits(usr."limitsText"::jsonb) IS NOT TRUE
 THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_POLICY'; END IF;
 -- These durable controller/legacy writers share the held advisory protocol.
 -- Taking catalog SHARE locks here would invert legacy BEFORE-trigger ordering.
 IF (SELECT count(*) FROM ctp_risk.global_head)>10000
 OR (SELECT count(*) FROM ctp_risk.tenant_head WHERE "tenantId"=t)>10000
 OR (SELECT count(*) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL)>10000
 OR (SELECT count(*) FROM public.circuit_state WHERE "tenantId"=t)>10000
 THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_CAPACITY'; END IF;
 SELECT jsonb_build_object(
  'global',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind','GLOBAL'),
   'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY kind,key) FROM ctp_risk.global_head),'[]'::jsonb),
  'tenant',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',jsonb_build_object('kind',scope,'tenantId',"tenantId"::text,'targetId',target::text),
   'kind',kind,'key',key,'state',state,'epoch',epoch::text) ORDER BY scope,target,kind,key) FROM ctp_risk.tenant_head WHERE "tenantId"=t),'[]'::jsonb),
  'activePauses',coalesce((SELECT jsonb_agg(id::text ORDER BY id) FROM public.trading_pause WHERE "tenantId"=t AND "resumedAt" IS NULL),'[]'::jsonb),
  'circuits',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id::text,'state',status::text) ORDER BY id) FROM public.circuit_state WHERE "tenantId"=t),'[]'::jsonb)
 )::text INTO controls_text;
 result:=jsonb_build_object('kind','PAPER_RISK_AUTHORITY_CAPTURE','orderRisk',b,
  'identity',jsonb_build_object('tenantId',t::text,'accountId',a.id::text,'mode','PAPER',
   'connectionId',NULL,'externalAccountId',a."externalAccountId",'userSessionEpoch',u."sessionEpoch"::text,
   'permissionEpoch',a."permissionEpoch"::text,'accountVersion',a.version),
  'policies',jsonb_build_array(ctp_risk.policy_json(platform),ctp_risk.policy_json(usr)),
  'controls',jsonb_build_object('text',controls_text,'hash',encode(sha256(convert_to(controls_text,'UTF8')),'hex')));
 IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_CAPACITY'; END IF;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_RISK_AUTHORITY_%' THEN RAISE;
 ELSIF SQLERRM LIKE 'PAPER_ORDER_RISK_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_ORDER_RISK_','PAPER_RISK_AUTHORITY_');
 ELSE RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_CORRUPT'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_RISK_AUTHORITY_CORRUPT';
END $$;

REVOKE ALL ON FUNCTION ctp_paper.valid_risk_authority_runtime(),ctp_paper.authority_order_capture(jsonb),ctp_paper.capture_risk_authority(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.capture_risk_authority(jsonb) TO ctp_paper_risk_authority;
COMMIT;
