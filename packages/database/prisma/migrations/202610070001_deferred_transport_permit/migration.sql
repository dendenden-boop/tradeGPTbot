BEGIN;

-- Version 1 is historical evidence: never clear or reinterpret its consumed timestamp.
ALTER TABLE public.submission_attempt
  ALTER COLUMN "permitConsumedAt" DROP NOT NULL,
  ADD COLUMN "permitProtocolVersion" smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT attempt_permit_protocol CHECK ("permitProtocolVersion" IN (1,2)),
  ADD CONSTRAINT attempt_permit_pair CHECK (
    ("permitProtocolVersion"=1 AND "permitConsumedAt" IS NOT NULL) OR
    ("permitProtocolVersion"=2 AND (("permitConsumedAt" IS NULL AND "transportStartedAt" IS NULL) OR
     ("permitConsumedAt" IS NOT NULL AND "transportStartedAt" IS NOT NULL
      AND "permitConsumedAt"="transportStartedAt")))
  );

CREATE OR REPLACE FUNCTION public.ctp_immutable_submission_identity() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  mutable_fields CONSTANT text[] := ARRAY[
    'status','permitConsumedAt','transportStartedAt','responseReceivedAt','resolvedAt','responseCode','evidenceHash'
  ];
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-mutable_fields) IS DISTINCT FROM (to_jsonb(OLD)-mutable_fields) THEN
    RAISE EXCEPTION 'Submission identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD."permitConsumedAt" IS DISTINCT FROM NEW."permitConsumedAt" THEN
    IF OLD."permitProtocolVersion"<>2 OR OLD."permitConsumedAt" IS NOT NULL
      OR OLD."transportStartedAt" IS NOT NULL OR NEW."permitConsumedAt" IS NULL
      OR NEW."transportStartedAt" IS DISTINCT FROM NEW."permitConsumedAt"
      OR OLD.status<>'DISPATCHING' OR NEW.status<>'DISPATCHING'
      OR NEW."permitConsumedAt"<NEW."createdAt" OR NEW."permitConsumedAt">=NEW."deadlineAt"
      OR NEW."permitConsumedAt">clock_timestamp() THEN
      RAISE EXCEPTION 'Transport permit can only be consumed once at dispatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF OLD."transportStartedAt" IS NOT NULL AND NEW."transportStartedAt" IS DISTINCT FROM OLD."transportStartedAt" THEN
    RAISE EXCEPTION 'Transport boundary cannot be rewritten' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION ctp_execution.deferred_permit_insert() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  IF NEW."workerId"='order-engine' OR NEW."permitProtocolVersion"=2
    OR (pg_has_role(current_user,'ctp_execution','MEMBER')
      AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)) THEN
    IF NEW."workerId"<>'order-engine' OR NEW."permitProtocolVersion"<>2
      OR NEW."permitConsumedAt" IS NOT NULL OR NEW."transportStartedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'New execution attempts require an unconsumed transport permit' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deferred_permit_insert BEFORE INSERT ON public.submission_attempt
 FOR EACH ROW EXECUTE FUNCTION ctp_execution.deferred_permit_insert();
REVOKE ALL ON FUNCTION public.ctp_immutable_submission_identity(),ctp_execution.deferred_permit_insert() FROM PUBLIC;
GRANT UPDATE("permitConsumedAt") ON public.submission_attempt TO ctp_execution;

COMMIT;
