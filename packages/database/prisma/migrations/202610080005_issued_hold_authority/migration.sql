BEGIN;
-- Issued collateral belongs to the immutable Risk/lifecycle authority. Portfolio
-- events cannot self-authorize changes to its status, asset or reflected amount.
CREATE OR REPLACE FUNCTION ctp_admission.reservation_consistency() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i record; h jsonb; w ctp_portfolio.hold_watermark%ROWTYPE; expected jsonb; proof_payload text; proof_hash bytea;
BEGIN
 FOR i IN SELECT x.*,r.status,r.asset,r.amount,b.state FROM ctp_admission.issuance x
  JOIN public.risk_reservation r ON r."tenantId"=x."tenantId" AND r.id=x."reservationId"
  JOIN ctp_portfolio.book b ON b."tenantId"=x."tenantId" AND b.id=x."bookId"
  WHERE x."tenantId"=NEW."tenantId" AND ((TG_TABLE_NAME='book' AND x."bookId"=NEW.id) OR (TG_TABLE_NAME='risk_reservation' AND x."reservationId"=NEW.id)) LOOP
  SELECT value INTO h FROM jsonb_array_elements(i.state::jsonb->'holds') WHERE value->>'id'=i."reservationId"::text;
  SELECT * INTO w FROM ctp_portfolio.hold_watermark WHERE "tenantId"=i."tenantId" AND book=i."bookId" AND "holdId"=i."reservationId"::text;
  IF NOT FOUND OR i.status NOT IN('ACTIVE','UNRESOLVED','RELEASED')
   OR (i.status='RELEASED' AND (NOT w.released OR h IS NOT NULL))
   OR (i.status<>'RELEASED' AND (w.released OR h IS NULL OR h->>'asset' IS DISTINCT FROM i.asset OR (h->>'amount')::numeric IS DISTINCT FROM i.amount))
   OR (i.status='UNRESOLVED' AND (NOT w.unknown OR h->>'status' IS DISTINCT FROM 'UNKNOWN'))
  THEN RAISE EXCEPTION 'RISK_LIFECYCLE_DIVERGENCE' USING ERRCODE='23514'; END IF;
  IF i.status='RELEASED' THEN CONTINUE; END IF;
  SELECT e.payload,e.fingerprint INTO proof_payload,proof_hash FROM ctp_admission.lifecycle_revision r
   JOIN ctp_portfolio.evidence e ON e."tenantId"=r."tenantId" AND e.book=i."bookId" AND e.id=r."eventId"
   WHERE r."tenantId"=i."tenantId" AND r."reservationId"=i."reservationId" AND r."eventId" IS NOT NULL
   ORDER BY r.sequence DESC LIMIT 1;
  IF NOT FOUND THEN
   SELECT e.payload,e.fingerprint INTO proof_payload,proof_hash FROM ctp_portfolio.evidence e
    WHERE e."tenantId"=i."tenantId" AND e.book=i."bookId" AND e.id='risk-reserve-'||i."reservationId"::text;
  END IF;
  IF proof_payload IS NULL OR proof_hash IS DISTINCT FROM sha256(convert_to(proof_payload,'UTF8')) THEN RAISE EXCEPTION 'RISK_HOLD_AUTHORITY'; END IF;
  expected:=proof_payload::jsonb;
  IF (expected->>'type' IN('COMMITMENT','RESOLVE_COMMITMENT')) IS NOT TRUE OR h IS DISTINCT FROM expected->'hold' THEN RAISE EXCEPTION 'RISK_HOLD_AUTHORITY' USING ERRCODE='23514'; END IF;
 END LOOP; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ctp_admission.reservation_consistency() FROM PUBLIC;
COMMIT;
