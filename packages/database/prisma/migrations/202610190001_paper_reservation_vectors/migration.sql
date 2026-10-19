BEGIN;
-- Storage representation only. No financial writer, grant, certificate or
-- dispatch authority is added. Existing native scalar semantics are unchanged.
LOCK TABLE public.risk_reservation IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.risk_reservation NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_reservation
 ADD COLUMN "vectorSize" integer,
 ADD COLUMN "paperLegacy" boolean NOT NULL DEFAULT false,
 ALTER COLUMN "budgetId" DROP NOT NULL,
 ALTER COLUMN asset DROP NOT NULL,
 ALTER COLUMN amount DROP NOT NULL;
-- Preserve every old economic field and FK. This is an explicit untrusted
-- legacy tag, never a reconstructed vector, cash credit or admission.
UPDATE public.risk_reservation SET "paperLegacy"=true WHERE mode='PAPER';
-- Validate all queued original constraints before subsequent DDL; do not skip them.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE public.risk_reservation
 ADD CONSTRAINT risk_reservation_representation CHECK (
  (mode='PAPER' AND "paperLegacy" AND "vectorSize" IS NULL
   AND "budgetId" IS NOT NULL AND asset IS NOT NULL AND amount IS NOT NULL)
  OR (mode='PAPER' AND NOT "paperLegacy" AND status='ACTIVE' AND version=0 AND "releasedAt" IS NULL AND "vectorSize" IS NOT NULL AND "vectorSize" IN(1,2)
   AND "budgetId" IS NULL AND asset IS NULL AND amount IS NULL AND "consumedAmount"=0)
  OR (mode<>'PAPER' AND NOT "paperLegacy" AND "vectorSize" IS NULL
   AND "budgetId" IS NOT NULL AND asset IS NOT NULL AND amount IS NOT NULL)
 );

ALTER TABLE public.risk_reservation FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX risk_reservation_paper_intent_identity
 ON public.risk_reservation("tenantId","intentId") WHERE mode='PAPER' AND NOT "paperLegacy";
CREATE INDEX risk_reservation_paper_legacy_tenant ON public.risk_reservation("tenantId")
 WHERE mode='PAPER' AND "paperLegacy";

CREATE TABLE ctp_paper.reservation_debit (
 tenant_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 intent_id uuid NOT NULL,
 account_id uuid NOT NULL,
 mode public."TradingMode" NOT NULL CHECK(mode='PAPER'),
 ordinal smallint NOT NULL CHECK(ordinal IN(1,2)),
 asset varchar(32) NOT NULL CHECK(length(asset)>0),
 amount numeric NOT NULL CHECK(amount>0 AND amount<10::numeric^20 AND scale(amount)<=18),
 hold_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,reservation_id,ordinal),
 UNIQUE(tenant_id,reservation_id,asset),
 UNIQUE(tenant_id,hold_id),
 FOREIGN KEY(tenant_id,reservation_id,intent_id,account_id,mode)
  REFERENCES public.risk_reservation("tenantId",id,"intentId","accountId",mode)
  ON UPDATE RESTRICT ON DELETE RESTRICT
);
ALTER TABLE ctp_paper.reservation_debit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.reservation_debit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ctp_paper.reservation_debit
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON ctp_paper.reservation_debit FROM PUBLIC;
CREATE TRIGGER reservation_debit_no_truncate BEFORE TRUNCATE ON ctp_paper.reservation_debit
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

-- Original vector and shared parent identity remain permanent. A future
-- certified lifecycle writer requires a separately reviewed additive contract;
-- this migration deliberately enables no update/release path for PAPER.
CREATE FUNCTION ctp_paper.immutable_reservation_vector() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW."paperLegacy" THEN
   RAISE EXCEPTION 'PAPER_RESERVATION_LEGACY_WRITE_FORBIDDEN' USING ERRCODE='23514';
  END IF;
  IF NEW.mode='PAPER' THEN
   IF EXISTS(SELECT 1 FROM public.risk_reservation r WHERE r."tenantId"=NEW."tenantId" AND r.mode='PAPER' AND r."paperLegacy") THEN
    RAISE EXCEPTION 'PAPER_RESERVATION_LEGACY_SCOPE' USING ERRCODE='23514';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='reservation_debit' OR OLD.mode='PAPER'
  OR (TG_OP='UPDATE' AND NEW.mode='PAPER') THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER immutable_paper_reservation BEFORE INSERT OR UPDATE OR DELETE ON public.risk_reservation
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.immutable_reservation_vector();
CREATE TRIGGER immutable_paper_reservation_debit BEFORE UPDATE OR DELETE ON ctp_paper.reservation_debit
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.immutable_reservation_vector();

CREATE FUNCTION ctp_paper.check_reservation_vector() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.risk_reservation%ROWTYPE; i public.order_intent%ROWTYPE;
 n integer; base text; quote text;
BEGIN
 IF TG_TABLE_NAME='risk_reservation' THEN
  IF NEW.mode<>'PAPER' THEN RETURN NULL; END IF;
  r:=NEW;
 ELSE
  SELECT * INTO r FROM public.risk_reservation WHERE "tenantId"=NEW.tenant_id AND id=NEW.reservation_id;
  IF NOT FOUND OR r.mode<>'PAPER' THEN
   RAISE EXCEPTION 'PAPER_RESERVATION_SCOPE' USING ERRCODE='23514';
  END IF;
 END IF;
 IF r."paperLegacy" OR r."vectorSize" IS NULL THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_LEGACY_VECTOR_FORBIDDEN' USING ERRCODE='23514';
 END IF;
 SELECT * INTO i FROM public.order_intent WHERE "tenantId"=r."tenantId" AND id=r."intentId"
  AND "accountId"=r."accountId" AND mode='PAPER';
 IF NOT FOUND OR i.operation<>'PLACE' OR i.destination<>'PAPER_ENGINE' OR i."connectionId" IS NOT NULL THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_SCOPE' USING ERRCODE='23514';
 END IF;
 SELECT "baseAsset","quoteAsset" INTO base,quote FROM public.instrument WHERE id=i."instrumentId" AND market='SPOT';
 IF NOT FOUND OR base=quote OR i."quantityAsset"<>base OR i."priceAsset"<>quote THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_SCOPE' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO n FROM ctp_paper.reservation_debit WHERE tenant_id=r."tenantId" AND reservation_id=r.id;
 IF n<>r."vectorSize" OR EXISTS(
  SELECT 1 FROM ctp_paper.reservation_debit d WHERE d.tenant_id=r."tenantId" AND d.reservation_id=r.id
   AND (d.ordinal>r."vectorSize" OR (i.side='BUY' AND d.asset<>quote) OR (i.side='SELL' AND d.asset NOT IN(base,quote))))
  OR (i.side='BUY' AND n<>1)
  OR (i.side='SELL' AND NOT EXISTS(SELECT 1 FROM ctp_paper.reservation_debit d
   WHERE d.tenant_id=r."tenantId" AND d.reservation_id=r.id AND d.asset=base)) THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_VECTOR' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER paper_reservation_vector_complete AFTER INSERT ON public.risk_reservation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_reservation_vector();
CREATE CONSTRAINT TRIGGER paper_reservation_debit_complete AFTER INSERT ON ctp_paper.reservation_debit
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_reservation_vector();
REVOKE ALL ON FUNCTION ctp_paper.immutable_reservation_vector(),ctp_paper.check_reservation_vector() FROM PUBLIC;
COMMIT;
