BEGIN;
-- Transactional DDL locks isolate the owner-only backfill; FORCE RLS is restored
-- before commit, including when the migration owner has no BYPASSRLS privilege.
ALTER TABLE ctp_portfolio.evidence NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ctp_portfolio.book NO FORCE ROW LEVEL SECURITY;
CREATE TABLE ctp_portfolio.hold_watermark (
  "tenantId" uuid NOT NULL,
  book uuid NOT NULL,
  "accountId" uuid NOT NULL,
  mode public."TradingMode" NOT NULL,
  "holdId" text NOT NULL CHECK(octet_length("holdId") BETWEEN 1 AND 128),
  timestamp bigint NOT NULL CHECK(timestamp BETWEEN 0 AND 8640000000000000),
  fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
  released boolean NOT NULL,
  unknown boolean NOT NULL,
  PRIMARY KEY("tenantId",book,"holdId"),
  FOREIGN KEY("tenantId",book,"accountId",mode) REFERENCES ctp_portfolio.book("tenantId",id,"accountId",mode)
);
-- Legacy arrival order cannot prove a safe reservation state. Permanently retain
-- every old identity and require a newer trusted resolution; do not infer money.
INSERT INTO ctp_portfolio.hold_watermark
SELECT "tenantId",book,"accountId",mode,
  COALESCE(payload::jsonb->'hold'->>'id',payload::jsonb->>'holdId') AS hold_id,
  max((payload::jsonb->>'timestamp')::bigint),
  sha256(convert_to('legacy-hold-history:'||COALESCE(payload::jsonb->'hold'->>'id',payload::jsonb->>'holdId'),'UTF8')),
  false,true
FROM ctp_portfolio.evidence WHERE payload::jsonb->>'type' IN ('COMMITMENT','RELEASE')
GROUP BY "tenantId",book,"accountId",mode,COALESCE(payload::jsonb->'hold'->>'id',payload::jsonb->>'holdId');
WITH changed AS (
  SELECT b.id,jsonb_set(jsonb_set(b.state::jsonb,'{status}','"GAP"'::jsonb),'{holds}',
    COALESCE((SELECT jsonb_agg(jsonb_set(h,'{status}','"UNKNOWN"'::jsonb)) FROM jsonb_array_elements(b.state::jsonb->'holds') h),'[]'::jsonb))::text AS state
  FROM ctp_portfolio.book b WHERE EXISTS(SELECT 1 FROM ctp_portfolio.hold_watermark w WHERE w.book=b.id)
)
UPDATE ctp_portfolio.book b SET state=c.state,state_hash=sha256(convert_to(c.state,'UTF8')) FROM changed c WHERE c.id=b.id;
ALTER TABLE ctp_portfolio.evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE ctp_portfolio.book FORCE ROW LEVEL SECURITY;
CREATE FUNCTION ctp_portfolio.monotonic_hold_watermark() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW."tenantId",NEW.book,NEW."accountId",NEW.mode,NEW."holdId") IS DISTINCT FROM ROW(OLD."tenantId",OLD.book,OLD."accountId",OLD.mode,OLD."holdId")
    OR NEW.timestamp<OLD.timestamp
    OR (NEW.timestamp=OLD.timestamp AND ROW(NEW.fingerprint,NEW.released,NEW.unknown) IS DISTINCT FROM ROW(OLD.fingerprint,OLD.released,OLD.unknown))
    OR (OLD.released AND NOT NEW.released)
    OR (OLD.unknown AND NOT NEW.unknown AND NOT NEW.released)
  THEN RAISE EXCEPTION 'Hold watermark cannot regress' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portfolio_hold_monotonic BEFORE UPDATE ON ctp_portfolio.hold_watermark FOR EACH ROW EXECUTE FUNCTION ctp_portfolio.monotonic_hold_watermark();
REVOKE ALL ON FUNCTION ctp_portfolio.monotonic_hold_watermark() FROM PUBLIC;
REVOKE ALL ON ctp_portfolio.hold_watermark FROM PUBLIC;
ALTER TABLE ctp_portfolio.hold_watermark ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_portfolio.hold_watermark FORCE ROW LEVEL SECURITY;
CREATE POLICY portfolio_tenant ON ctp_portfolio.hold_watermark USING("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON ctp_portfolio.hold_watermark TO ctp_portfolio;
GRANT SELECT ON ctp_portfolio.hold_watermark TO ctp_api;
COMMIT;
