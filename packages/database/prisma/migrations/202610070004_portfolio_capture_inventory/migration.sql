BEGIN;
-- Additive replacement of the published source function. Its signature, owner,
-- exact reader grant, financial rows and FORCE RLS policies are preserved.
CREATE OR REPLACE FUNCTION ctp_risk.capture_portfolio(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t uuid; m public."TradingMode"; inventory_ids uuid[]; ids uuid[]; connection_ids uuid[]; b_ids uuid[]; result jsonb; BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_risk_snapshot_reader') THEN RAISE EXCEPTION 'RISK_PORTFOLIO_ROLE_UNSAFE'; END IF;
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
REVOKE ALL ON FUNCTION ctp_risk.capture_portfolio(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_risk.capture_portfolio(jsonb) TO ctp_risk_snapshot_reader;
COMMIT;
