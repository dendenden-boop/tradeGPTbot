BEGIN;
-- Current PAPER certification only. Published migrations1-69 and native market
-- publication/ordering semantics remain unchanged. A ticker-only observation
-- cannot renew an old book, or be silently omitted from the current equity mark.
CREATE INDEX snapshot_current_risk_latest_ticker ON ctp_market.snapshot_event
 (key,((payload::jsonb->'ticker'->>'exchangeTime')::bigint) DESC,revision DESC,id)
 WHERE status IN('APPLIED','DUPLICATE') AND payload::jsonb->>'kind'='SNAPSHOT';

ALTER FUNCTION ctp_paper.current_risk_facts(jsonb) RENAME TO current_risk_facts_v69;
CREATE FUNCTION ctp_paper.current_risk_facts(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE facts jsonb; snapshot jsonb; k jsonb; latest_ms bigint; selected_ms bigint;
BEGIN
 -- Retains the complete original authentication, scope, current metadata and
 -- GLOBAL -> tenant/user/account/book/public-key lock boundary. In particular,
 -- the shared logical-key lock freezes DUPLICATE inserts for this transaction.
 facts:=ctp_paper.current_risk_facts_v69(p);
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
REVOKE ALL ON FUNCTION ctp_paper.current_risk_facts_v69(jsonb),ctp_paper.current_risk_facts(jsonb)
 FROM PUBLIC,ctp_paper_risk_admission;
COMMIT;
