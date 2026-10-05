BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_execution') THEN CREATE ROLE ctp_execution NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;
CREATE SCHEMA ctp_execution;
REVOKE ALL ON SCHEMA ctp_execution FROM PUBLIC;
GRANT USAGE ON SCHEMA public,ctp_execution,ctp_portfolio TO ctp_execution;
CREATE TABLE ctp_execution.command (
  "tenantId" uuid NOT NULL, "intentId" uuid NOT NULL, "orderId" uuid NOT NULL,
  binding text NOT NULL CHECK(octet_length(binding)<=8192), draft text NOT NULL CHECK(octet_length(draft)<=8192),
  command text NOT NULL CHECK(octet_length(command)<=8192), operation public."SubmissionOperation" NOT NULL CHECK(operation IN ('PLACE','CANCEL')),
  "requestHash" bytea NOT NULL CHECK(octet_length("requestHash")=32), "commandHash" bytea NOT NULL CHECK(octet_length("commandHash")=32),
  PRIMARY KEY("tenantId","intentId"),
  FOREIGN KEY("tenantId","intentId") REFERENCES public.order_intent("tenantId",id),
  FOREIGN KEY("tenantId","orderId") REFERENCES public."order"("tenantId",id)
);
CREATE TABLE ctp_execution.progress (
 "tenantId" uuid NOT NULL, "orderId" uuid NOT NULL, "nativeAt" bigint CHECK("nativeAt" BETWEEN 0 AND 8640000000000000), "nativeHash" bytea CHECK(octet_length("nativeHash")=32), "nativeStatus" public."OrderStatus",
 PRIMARY KEY("tenantId","orderId"), FOREIGN KEY("tenantId","orderId") REFERENCES public."order"("tenantId",id), CHECK(("nativeAt" IS NULL)=("nativeHash" IS NULL)), CHECK(("nativeAt" IS NULL)=("nativeStatus" IS NULL))
);
CREATE TABLE ctp_execution.evidence (
 "tenantId" uuid NOT NULL, "orderId" uuid NOT NULL, identity text NOT NULL CHECK(octet_length(identity) BETWEEN 1 AND 256), fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
 PRIMARY KEY("tenantId","orderId",identity), FOREIGN KEY("tenantId","orderId") REFERENCES public."order"("tenantId",id)
);
CREATE TABLE ctp_execution.fill_adoption (
 "tenantId" uuid NOT NULL, "fillId" uuid NOT NULL, book uuid NOT NULL, "eventId" text NOT NULL, ledger uuid NOT NULL,
 PRIMARY KEY("tenantId","fillId"), UNIQUE("tenantId",book,"eventId"),
 FOREIGN KEY("tenantId","fillId") REFERENCES public.fill("tenantId",id),
 FOREIGN KEY("tenantId",book,"eventId") REFERENCES ctp_portfolio.evidence("tenantId",book,id),
 FOREIGN KEY("tenantId",ledger) REFERENCES public.ledger_transaction("tenantId",id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['command','progress','evidence','fill_adoption'] LOOP
 EXECUTE format('ALTER TABLE ctp_execution.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE ctp_execution.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY execution_tenant ON ctp_execution.%I USING ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK ("tenantId"=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('REVOKE ALL ON ctp_execution.%I FROM PUBLIC',t);
 IF t<>'progress' THEN EXECUTE format('CREATE TRIGGER execution_immutable BEFORE UPDATE OR DELETE ON ctp_execution.%I FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row()',t); END IF;
END LOOP; END $$;
GRANT SELECT,INSERT ON ctp_execution.command,ctp_execution.evidence,ctp_execution.fill_adoption TO ctp_execution;
GRANT SELECT,INSERT,UPDATE ON ctp_execution.progress TO ctp_execution;
GRANT SELECT ON public.exchange_account,public.exchange_connection,public.instrument,public.instrument_rule_version,public.capability_snapshot,public.account_state_version,public.risk_decision,public.risk_reservation,public.ledger_transaction,ctp_portfolio.book,ctp_portfolio.evidence TO ctp_execution;
GRANT UPDATE("clientIdHighWatermark") ON public.exchange_account TO ctp_execution;
GRANT SELECT,INSERT ON public.order_intent,public.order_event,public.fill,public.fee,public.outbox_event TO ctp_execution;
GRANT SELECT,INSERT ON public."order",public.submission_attempt TO ctp_execution;
GRANT UPDATE(status,"reconciliationState","filledQuantity","averageFillPrice","exchangeOrderId",version,"lastExchangeAt","terminalAt","updatedAt") ON public."order" TO ctp_execution;
GRANT UPDATE(status,"transportStartedAt","responseReceivedAt","resolvedAt","responseCode","evidenceHash") ON public.submission_attempt TO ctp_execution;
CREATE UNIQUE INDEX execution_place_once ON public.submission_attempt("tenantId","intentId") WHERE operation='PLACE' AND "workerId"='order-engine';
CREATE UNIQUE INDEX execution_cancel_once ON public.submission_attempt("tenantId","intentId") WHERE operation='CANCEL' AND "workerId"='order-engine';
CREATE FUNCTION ctp_execution.monotonic_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW."tenantId",NEW."orderId") IS DISTINCT FROM ROW(OLD."tenantId",OLD."orderId") OR (OLD."nativeAt" IS NOT NULL AND (NEW."nativeAt" IS NULL OR NEW."nativeAt"<OLD."nativeAt" OR (NEW."nativeAt"=OLD."nativeAt" AND ROW(NEW."nativeHash",NEW."nativeStatus") IS DISTINCT FROM ROW(OLD."nativeHash",OLD."nativeStatus")))) THEN RAISE EXCEPTION 'Execution watermark cannot regress' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER execution_monotonic BEFORE UPDATE ON ctp_execution.progress FOR EACH ROW EXECUTE FUNCTION ctp_execution.monotonic_progress();
REVOKE ALL ON FUNCTION ctp_execution.monotonic_progress() FROM PUBLIC;
-- Namespace changes never permit counter reuse; this guard adds no backfill or rewrite.
CREATE FUNCTION ctp_execution.monotonic_client_counter() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW."clientIdHighWatermark"<OLD."clientIdHighWatermark" THEN RAISE EXCEPTION 'Client counter cannot regress' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER execution_counter_monotonic BEFORE UPDATE OF "clientIdHighWatermark" ON public.exchange_account FOR EACH ROW EXECUTE FUNCTION ctp_execution.monotonic_client_counter();
REVOKE ALL ON FUNCTION ctp_execution.monotonic_client_counter() FROM PUBLIC;
COMMIT;
