-- Cross-phase audit: preserve account-scoped financial evidence and durable identities.
-- Forward migration only; previously deployed migration checksums remain unchanged.
BEGIN;

-- Prevent concurrent writers while validating the old graph and deriving its scope.
-- The whole migration rolls back, including trigger state, if any existing row is invalid.
LOCK TABLE public.fee, public.submission_attempt, public."order", public.risk_reservation,
 public.fill, public.ledger_transaction, public.order_intent
 IN ACCESS EXCLUSIVE MODE;

-- A dedicated table owner can backfill all tenants without SUPERUSER/BYPASSRLS.
-- RLS remains enabled and applies to runtime roles. NO FORCE is owner-only and
-- invisible outside this transaction; every table is restored to FORCE before COMMIT.
ALTER TABLE public.fee NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.submission_attempt NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public."order" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_reservation NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.fill NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_transaction NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.order_intent NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.fee f
    JOIN public.fill parent ON parent."tenantId"=f."tenantId" AND parent.id=f."fillId"
    JOIN public.ledger_transaction posting
      ON posting."tenantId"=f."tenantId" AND posting.id=f."ledgerTransactionId"
    WHERE ROW(parent."accountId",parent.mode) IS DISTINCT FROM ROW(posting."accountId",posting.mode)
  ) THEN
    RAISE EXCEPTION 'Existing fee ledger scope is inconsistent' USING ERRCODE='23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.submission_attempt attempt
    JOIN public."order" parent ON parent."tenantId"=attempt."tenantId" AND parent.id=attempt."orderId"
    LEFT JOIN public.risk_reservation reservation
      ON reservation."tenantId"=attempt."tenantId" AND reservation.id=attempt."reservationId"
    JOIN public.order_intent command ON command."tenantId"=attempt."tenantId"
      AND command.id=COALESCE(reservation."intentId",parent."intentId")
    WHERE attempt.operation<>'PLACE' OR command.operation<>'PLACE'
      OR command.id<>parent."intentId"
      OR ROW(parent."accountId",parent.mode,parent."instrumentId")
        IS DISTINCT FROM ROW(command."accountId",command.mode,command."instrumentId")
      OR (reservation.id IS NOT NULL AND ROW(parent."accountId",parent.mode)
        IS DISTINCT FROM ROW(reservation."accountId",reservation.mode))
      OR attempt."commandHash" IS DISTINCT FROM command."commandHash"
  ) THEN
    RAISE EXCEPTION 'Existing submission scope is inconsistent or lacks explicit operation evidence' USING ERRCODE='23503';
  END IF;
  -- Before this migration no explicit targetOrderId existed. Do not manufacture
  -- immutable AMEND/CANCEL commands or infer their signed target from a mutable
  -- projection. Such legacy data requires an independently evidenced forward repair.
  IF EXISTS (SELECT 1 FROM public.order_intent WHERE operation IN ('AMEND','CANCEL')) THEN
    RAISE EXCEPTION 'Existing AMEND/CANCEL commands require explicit target evidence before migration' USING ERRCODE='23503';
  END IF;
END $$;

ALTER TABLE public.fee ADD COLUMN "accountId" UUID, ADD COLUMN mode public."TradingMode";
ALTER TABLE public.order_intent ADD COLUMN "targetOrderId" UUID;
ALTER TABLE public.submission_attempt
 ADD COLUMN "intentId" UUID, ADD COLUMN "accountId" UUID, ADD COLUMN mode public."TradingMode",
 ADD COLUMN "instrumentId" UUID;

-- Only derived scope is populated. Original fee identity, amounts and evidence stay intact.
-- Exclusive table lock + one transaction make the trigger suspension invisible to writers.
ALTER TABLE public.fee DISABLE TRIGGER immutable_evidence;
UPDATE public.fee f SET "accountId"=parent."accountId",mode=parent.mode
 FROM public.fill parent WHERE parent."tenantId"=f."tenantId" AND parent.id=f."fillId";
ALTER TABLE public.fee ENABLE TRIGGER immutable_evidence;
UPDATE public.submission_attempt attempt
 SET "intentId"=COALESCE(
   (SELECT reservation."intentId" FROM public.risk_reservation reservation
    WHERE reservation."tenantId"=attempt."tenantId" AND reservation.id=attempt."reservationId"),
   parent."intentId"),
   "accountId"=parent."accountId",mode=parent.mode,"instrumentId"=parent."instrumentId"
 FROM public."order" parent WHERE parent."tenantId"=attempt."tenantId" AND parent.id=attempt."orderId";

ALTER TABLE public.fee ALTER COLUMN "accountId" SET NOT NULL, ALTER COLUMN mode SET NOT NULL;
ALTER TABLE public.submission_attempt
 ALTER COLUMN "intentId" SET NOT NULL, ALTER COLUMN "accountId" SET NOT NULL, ALTER COLUMN mode SET NOT NULL,
 ALTER COLUMN "instrumentId" SET NOT NULL;

CREATE UNIQUE INDEX reservation_attempt_scope ON public.risk_reservation ("tenantId",id,"intentId","accountId",mode);

ALTER TABLE public.order_intent
 ADD CONSTRAINT intent_target_order_scope FOREIGN KEY ("tenantId","targetOrderId","accountId",mode,"instrumentId")
 REFERENCES public."order" ("tenantId",id,"accountId",mode,"instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT intent_target_operation CHECK (
   (operation IN ('AMEND','CANCEL'))=("targetOrderId" IS NOT NULL)
 );

ALTER TABLE public.fee
 DROP CONSTRAINT "fee_tenantId_fillId_fkey",
 DROP CONSTRAINT "fee_tenantId_ledgerTransactionId_fkey",
 ADD CONSTRAINT fee_fill_scope FOREIGN KEY ("tenantId","fillId","accountId",mode)
 REFERENCES public.fill ("tenantId",id,"accountId",mode) ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT fee_ledger_scope FOREIGN KEY ("tenantId","ledgerTransactionId","accountId",mode)
 REFERENCES public.ledger_transaction ("tenantId",id,"accountId",mode) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.submission_attempt
 DROP CONSTRAINT "submission_attempt_tenantId_orderId_fkey",
 DROP CONSTRAINT "submission_attempt_tenantId_reservationId_fkey",
 ADD CONSTRAINT attempt_parent_scope FOREIGN KEY ("tenantId","orderId","accountId",mode,"instrumentId")
 REFERENCES public."order" ("tenantId",id,"accountId",mode,"instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT attempt_intent_scope FOREIGN KEY ("tenantId","intentId","accountId",mode,"instrumentId")
 REFERENCES public.order_intent ("tenantId",id,"accountId",mode,"instrumentId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT attempt_reservation_scope FOREIGN KEY ("tenantId","reservationId","intentId","accountId",mode)
 REFERENCES public.risk_reservation ("tenantId",id,"intentId","accountId",mode) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The target order keeps its placement intent forever. Later operations have
-- independent immutable commands, hashes and reservations targeting that order.
-- This enforces stored identity only; risk admission and lifecycle remain writers' work.
CREATE FUNCTION public.ctp_submission_command_scope() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."order" parent
    JOIN public.order_intent command ON command."tenantId"=NEW."tenantId" AND command.id=NEW."intentId"
    WHERE parent."tenantId"=NEW."tenantId" AND parent.id=NEW."orderId"
      AND ROW(parent."accountId",parent.mode,parent."instrumentId")
        =ROW(NEW."accountId",NEW.mode,NEW."instrumentId")
      AND ROW(command."accountId",command.mode,command."instrumentId")
        =ROW(NEW."accountId",NEW.mode,NEW."instrumentId")
      AND command.operation=NEW.operation::text AND command."commandHash"=NEW."commandHash"
      AND ((NEW.operation='PLACE' AND command.id=parent."intentId" AND command."targetOrderId" IS NULL)
        OR (NEW.operation IN ('AMEND','CANCEL') AND command."targetOrderId"=parent.id))
  ) THEN
    RAISE EXCEPTION 'Submission command does not match its operation and target order' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER submission_command_scope BEFORE INSERT ON public.submission_attempt
 FOR EACH ROW EXECUTE FUNCTION public.ctp_submission_command_scope();

-- Order is the current exchange projection, so amendments may change its price/quantity.
-- Original command evidence remains in immutable OrderIntent/SubmissionAttempt. Durable
-- order identity and scope cannot change; optional exchange/parent bindings are write-once.
-- Lifecycle state machines and controlled retention writers belong to later phases.
CREATE FUNCTION public.ctp_immutable_order_identity() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Order identity cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.id,NEW."tenantId",NEW."intentId",NEW."accountId",NEW.mode,NEW."connectionId",
      NEW."instrumentId",NEW.market,NEW."clientIdNamespace",NEW."clientId",NEW."createdAt")
    IS DISTINCT FROM
      ROW(OLD.id,OLD."tenantId",OLD."intentId",OLD."accountId",OLD.mode,OLD."connectionId",
      OLD."instrumentId",OLD.market,OLD."clientIdNamespace",OLD."clientId",OLD."createdAt")
    OR (OLD."exchangeOrderId" IS NOT NULL AND NEW."exchangeOrderId" IS DISTINCT FROM OLD."exchangeOrderId")
    OR (OLD."parentAlgoOrderId" IS NOT NULL AND NEW."parentAlgoOrderId" IS DISTINCT FROM OLD."parentAlgoOrderId")
    OR (OLD."tradeId" IS NOT NULL AND NEW."tradeId" IS DISTINCT FROM OLD."tradeId") THEN
    RAISE EXCEPTION 'Order identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_order_identity BEFORE UPDATE OR DELETE ON public."order"
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_order_identity();

-- Explicit mutable-field allowlists keep new dispatch/delivery evidence columns immutable.
CREATE FUNCTION public.ctp_immutable_submission_identity() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  mutable_fields CONSTANT text[] := ARRAY[
    'status','transportStartedAt','responseReceivedAt','resolvedAt','responseCode','evidenceHash'
  ];
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-mutable_fields) IS DISTINCT FROM (to_jsonb(OLD)-mutable_fields) THEN
    RAISE EXCEPTION 'Submission identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_submission_identity BEFORE UPDATE OR DELETE ON public.submission_attempt
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_submission_identity();

CREATE FUNCTION public.ctp_immutable_outbox_identity() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  mutable_fields CONSTANT text[] := ARRAY[
    'availableAt','attempts','claimedBy','claimExpiresAt','deliveredAt','lastErrorCode'
  ];
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-mutable_fields) IS DISTINCT FROM (to_jsonb(OLD)-mutable_fields) THEN
    RAISE EXCEPTION 'Outbox identity and payload are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_outbox_identity BEFORE UPDATE OR DELETE ON public.outbox_event
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_outbox_identity();

CREATE FUNCTION public.ctp_immutable_inbox_identity() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'retainUntil') IS DISTINCT FROM (to_jsonb(OLD)-'retainUntil')
    OR NEW."retainUntil"<OLD."retainUntil" THEN
    RAISE EXCEPTION 'Inbox identity and replay horizon cannot be reduced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_inbox_identity BEFORE UPDATE OR DELETE ON public.consumer_inbox
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_inbox_identity();

REVOKE ALL ON FUNCTION public.ctp_immutable_order_identity(),public.ctp_immutable_submission_identity(),
 public.ctp_immutable_outbox_identity(),public.ctp_immutable_inbox_identity(),
 public.ctp_submission_command_scope() FROM PUBLIC;

ALTER TABLE public.fee FORCE ROW LEVEL SECURITY;
ALTER TABLE public.submission_attempt FORCE ROW LEVEL SECURITY;
ALTER TABLE public."order" FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_reservation FORCE ROW LEVEL SECURITY;
ALTER TABLE public.fill FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_transaction FORCE ROW LEVEL SECURITY;
ALTER TABLE public.order_intent FORCE ROW LEVEL SECURITY;

COMMIT;
