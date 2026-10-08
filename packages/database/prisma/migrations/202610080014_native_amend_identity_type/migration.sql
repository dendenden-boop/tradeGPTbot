BEGIN;
-- Preserve published application history; never normalize an unproved numeric identity.
ALTER TABLE ctp_execution.amendment_application ADD CONSTRAINT amendment_native_identity_type CHECK(
 jsonb_typeof(cause->'evidence'->'evidence'->'executionId') IS NOT DISTINCT FROM 'string'
 AND "executionId" IS NOT DISTINCT FROM cause->'evidence'->'evidence'->>'executionId'
);
CREATE FUNCTION ctp_execution.amendment_identity_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(NEW.cause->'evidence'->'evidence'->'executionId') IS DISTINCT FROM 'string'
  OR NEW."executionId" IS DISTINCT FROM NEW.cause->'evidence'->'evidence'->>'executionId'
 THEN RAISE EXCEPTION 'ORDER_AMEND_APPLICATION_UNPROVED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ctp_execution.amendment_identity_type() FROM PUBLIC;
CREATE TRIGGER execution_amendment_identity_type BEFORE INSERT ON ctp_execution.amendment_application
FOR EACH ROW EXECUTE FUNCTION ctp_execution.amendment_identity_type();
COMMIT;
