BEGIN;
-- Historical rows remain recoverable evidence, never a fallback transport grant.
-- Every new transport boundary must have an exact certified atomic issuance.
CREATE OR REPLACE FUNCTION ctp_admission.current_dispatch_trigger() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF OLD."transportStartedAt" IS NULL AND NEW."transportStartedAt" IS NOT NULL THEN
  PERFORM ctp_admission.validate_dispatch(NEW."tenantId",NEW.id);
 END IF;
 RETURN NEW;
END $$;
COMMIT;
