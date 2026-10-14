BEGIN;
-- Initial cash-only UTC proof; no financial table/initializer grants.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_risk_loss') THEN
 CREATE ROLE ctp_paper_risk_loss NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_risk_loss;

CREATE FUNCTION ctp_paper.valid_risk_loss_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_risk_loss'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_risk_loss','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_risk_loss' AND pg_has_role(session_user,r.oid,'MEMBER'))
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
   NOT IN('ctp_paper.capture_risk_loss(jsonb)'))
$$;

CREATE FUNCTION ctp_paper.capture_risk_loss(o jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; ids uuid[]; a uuid; ts bigint; books jsonb:='[]'::jsonb; book jsonb; result jsonb; drafts integer:=0; inventory_wire jsonb; funding_times jsonb:='[]'::jsonb; origin_wire jsonb; cfg jsonb; seed jsonb; quote text; common_quote text; effective_at bigint; ledger_id uuid;
BEGIN
 IF NOT coalesce(ctp_paper.valid_risk_loss_runtime(),false) THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_ROLE_UNSAFE'; END IF;
 IF o IS NULL OR octet_length(o::text)>512 OR NOT coalesce(ctp_paper.valid_owner(o),false) THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_INPUT'; END IF;
 IF o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true) THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_OWNERSHIP'; END IF;
 t:=(o->>'tenantId')::uuid;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||t::text,0));
 -- FOR UPDATE also blocks new account FK inserts while enumerating the tenant.
 PERFORM 1 FROM public."user" WHERE id=t AND status='ACTIVE' AND "emailVerifiedAt" IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_OWNERSHIP'; END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT id FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id LIMIT 101) q;
 IF ids IS NULL THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_OWNERSHIP'; END IF;
 IF cardinality(ids)>100 THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_CAPACITY'; END IF;
 IF NOT ((o->>'accountId')::uuid=ANY(ids)) THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_OWNERSHIP'; END IF;
 PERFORM 1 FROM public.exchange_account WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 -- Order FK locks also close execution evidence insertion phantoms. Only
 -- untouched common CREATED drafts are compatible with this initial proof.
 IF (SELECT count(*) FROM (SELECT id FROM public."order" WHERE "tenantId"=t AND mode='PAPER' LIMIT 1001) q)>1000
 THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_CAPACITY'; END IF;
 PERFORM 1 FROM public."order" WHERE "tenantId"=t AND mode='PAPER' ORDER BY id FOR UPDATE;
 -- Account/User FK locks close the retained tenant PAPER catalog. Every money
 -- posting must be the one sealed original funding; zero/open extra postings
 -- also reject. No history eviction, backdating, reset or monetary write.
 IF EXISTS(SELECT 1 FROM ctp_paper.initial_funding f WHERE f.tenant_id=t AND NOT(f.account_id=ANY(ids)))
 OR EXISTS(SELECT 1 FROM public.ledger_transaction x WHERE x."tenantId"=t AND x.mode='PAPER' AND NOT EXISTS(
  SELECT 1 FROM ctp_paper.initial_funding f WHERE f.tenant_id=t AND f.account_id=x."accountId" AND f.ledger_id=x.id AND f.mode=x.mode))
 OR EXISTS(SELECT 1 FROM public.ledger_entry x WHERE x."tenantId"=t AND x.mode='PAPER' AND NOT EXISTS(
  SELECT 1 FROM ctp_paper.initial_funding f WHERE f.tenant_id=t AND f.account_id=x."accountId" AND f.ledger_id=x."transactionId" AND f.mode=x.mode))
 -- A conserved seed is insufficient when independent economic evidence has
 -- not yet reached the common ledger/book. Never infer zero PnL in that case.
 OR EXISTS(SELECT 1 FROM public.trade WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.funding_payment WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.asset_valuation WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.account_state_version WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.balance_snapshot WHERE "tenantId"=t AND mode='PAPER')
 OR EXISTS(SELECT 1 FROM ctp_execution.evidence e JOIN public."order" x ON x."tenantId"=e."tenantId" AND x.id=e."orderId"
  WHERE x."tenantId"=t AND x.mode='PAPER')
 OR EXISTS(SELECT 1 FROM ctp_execution.authoritative_event e JOIN public."order" x ON x."tenantId"=e."tenantId" AND x.id=e."orderId"
  WHERE x."tenantId"=t AND x.mode='PAPER')
 OR EXISTS(SELECT 1 FROM public.order_event e JOIN public."order" x ON x."tenantId"=e."tenantId" AND x.id=e."orderId"
  LEFT JOIN ctp_execution.command c ON c."tenantId"=x."tenantId" AND c."intentId"=x."intentId" AND c."orderId"=x.id
  WHERE x."tenantId"=t AND x.mode='PAPER' AND (e.version<>0 OR e."previousStatus" IS NOT NULL OR e.status<>'CREATED'
   OR e.source<>'CREATE' OR e."sourceIdentity" IS DISTINCT FROM x."intentId"::text
   OR e."evidenceHash" IS DISTINCT FROM c."commandHash" OR e."attemptId" IS NOT NULL
   OR e."occurredAt"<x."createdAt" OR e."occurredAt">clock_timestamp()))
 OR EXISTS(SELECT 1 FROM public."order" x WHERE x."tenantId"=t AND x.mode='PAPER' AND NOT EXISTS(
  SELECT 1 FROM public.order_event e WHERE e."tenantId"=t AND e."orderId"=x.id AND e.version=0))
 THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_INCOMPLETE'; END IF;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 FOREACH a IN ARRAY ids LOOP
  book:=ctp_paper.risk_portfolio_book(o||jsonb_build_object('accountId',a::text),ts);
  drafts:=drafts+jsonb_array_length(book->'drafts');
  IF drafts>1000 THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_CAPACITY'; END IF;
  origin_wire:=(book->'origin'->>'receiptText')::jsonb;
  cfg:=((origin_wire->'configuration'->>'receiptText')::jsonb)->'configuration';
  seed:=((origin_wire->'funding'->>'receiptText')::jsonb)->'funding';
  quote:=cfg->>'valuationAsset';
  IF common_quote IS NULL THEN common_quote:=quote; END IF;
  IF quote IS DISTINCT FROM common_quote OR jsonb_array_length(seed->'balances')<>1
   OR seed->'balances'->0->>'asset' IS DISTINCT FROM quote THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_CASH_ONLY'; END IF;
  SELECT f.ledger_id,floor(extract(epoch FROM l."effectiveAt")*1000)::bigint INTO ledger_id,effective_at
   FROM ctp_paper.initial_funding f JOIN public.ledger_transaction l ON l."tenantId"=f.tenant_id AND l.id=f.ledger_id
    AND l."accountId"=f.account_id AND l.mode=f.mode WHERE f.tenant_id=t AND f.account_id=a;
  IF NOT FOUND OR ledger_id::text IS DISTINCT FROM seed->>'id'
   OR effective_at IS DISTINCT FROM ((origin_wire->'funding'->>'receiptText')::jsonb->>'createdAt')::bigint
   OR effective_at>ts THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_CORRUPT'; END IF;
  funding_times:=funding_times||jsonb_build_array(jsonb_build_object('accountId',a::text,'ledgerId',ledger_id::text,'effectiveAt',effective_at));
  books:=books||jsonb_build_array(book);
  inventory_wire:=jsonb_build_object('kind','PAPER_RISK_PORTFOLIO_SOURCE','owner',o,'asOf',ts,'accountIds',to_jsonb(ids),'books',books);
  result:=jsonb_build_object('kind','PAPER_RISK_LOSS_CAPTURE','inventory',inventory_wire,'fundingTimes',funding_times);
  IF octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_CAPACITY'; END IF;
 END LOOP;
 RETURN result;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM LIKE 'PAPER_RISK_LOSS_%' THEN RAISE;
 ELSIF SQLERRM LIKE 'PAPER_BOOK_SOURCE_%' THEN RAISE EXCEPTION '%',replace(SQLERRM,'PAPER_BOOK_SOURCE_','PAPER_RISK_LOSS_');
 ELSE RAISE EXCEPTION 'PAPER_RISK_LOSS_CORRUPT'; END IF;
WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_RISK_LOSS_CORRUPT';
END $$;
REVOKE ALL ON FUNCTION ctp_paper.valid_risk_loss_runtime(),ctp_paper.capture_risk_loss(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.capture_risk_loss(jsonb) TO ctp_paper_risk_loss;
COMMIT;
