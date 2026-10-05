BEGIN;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ctp_portfolio') THEN CREATE ROLE ctp_portfolio NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;
CREATE SCHEMA ctp_portfolio;
REVOKE ALL ON SCHEMA ctp_portfolio FROM PUBLIC;
GRANT USAGE ON SCHEMA public,ctp_portfolio TO ctp_portfolio;
GRANT USAGE ON SCHEMA ctp_portfolio TO ctp_api;
GRANT SELECT ON public.exchange_account,public.exchange_connection TO ctp_portfolio;
GRANT SELECT,INSERT ON public.ledger_transaction,public.ledger_entry TO ctp_portfolio;

CREATE TABLE ctp_portfolio.book (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" uuid NOT NULL,
  "accountId" uuid NOT NULL,
  mode public."TradingMode" NOT NULL,
  wallet text NOT NULL CHECK(octet_length(wallet) BETWEEN 1 AND 128),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK(octet_length(state)<=1048576),
  state_hash bytea NOT NULL CHECK(state_hash=sha256(convert_to(state,'UTF8'))),
  UNIQUE("tenantId","accountId",mode,wallet),
  UNIQUE("tenantId",id,"accountId",mode),
  FOREIGN KEY("tenantId","accountId",mode) REFERENCES public.exchange_account("tenantId",id,mode)
);
CREATE TABLE ctp_portfolio.evidence (
  "tenantId" uuid NOT NULL,
  book uuid NOT NULL,
  "accountId" uuid NOT NULL,
  mode public."TradingMode" NOT NULL,
  id text NOT NULL CHECK(octet_length(id) BETWEEN 1 AND 128),
  fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
  payload text NOT NULL CHECK(octet_length(payload)<=1048576),
  CHECK(fingerprint=sha256(convert_to(payload,'UTF8'))),
  ledger uuid,
  PRIMARY KEY("tenantId",book,id),
  FOREIGN KEY("tenantId",book,"accountId",mode) REFERENCES ctp_portfolio.book("tenantId",id,"accountId",mode),
  FOREIGN KEY("tenantId",ledger,"accountId",mode) REFERENCES public.ledger_transaction("tenantId",id,"accountId",mode)
);
CREATE TABLE ctp_portfolio.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" uuid NOT NULL,
  book uuid NOT NULL,
  "accountId" uuid NOT NULL,
  mode public."TradingMode" NOT NULL,
  revision bigint NOT NULL CHECK(revision>0),
  "eventId" text NOT NULL,
  type text NOT NULL CHECK(type IN ('FILL','FUNDING','SNAPSHOT','COMMITMENT','RELEASE','GAP')),
  UNIQUE("tenantId",book,revision),
  FOREIGN KEY("tenantId",book,"eventId") REFERENCES ctp_portfolio.evidence("tenantId",book,id),
  FOREIGN KEY("tenantId",book,"accountId",mode) REFERENCES ctp_portfolio.book("tenantId",id,"accountId",mode)
);
CREATE FUNCTION ctp_portfolio.immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Portfolio evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER portfolio_evidence_immutable BEFORE UPDATE OR DELETE ON ctp_portfolio.evidence FOR EACH ROW EXECUTE FUNCTION ctp_portfolio.immutable_evidence();
REVOKE ALL ON ALL TABLES IN SCHEMA ctp_portfolio FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_portfolio.immutable_evidence() FROM PUBLIC;
ALTER TABLE ctp_portfolio.book ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_portfolio.book FORCE ROW LEVEL SECURITY;
ALTER TABLE ctp_portfolio.evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_portfolio.evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE ctp_portfolio.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_portfolio.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY portfolio_tenant ON ctp_portfolio.book USING("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY portfolio_tenant ON ctp_portfolio.evidence USING("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY portfolio_tenant ON ctp_portfolio.outbox USING("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK("tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON ctp_portfolio.book TO ctp_portfolio;
GRANT SELECT,INSERT ON ctp_portfolio.evidence TO ctp_portfolio;
GRANT SELECT,INSERT,DELETE ON ctp_portfolio.outbox TO ctp_portfolio;
GRANT SELECT ON ALL TABLES IN SCHEMA ctp_portfolio TO ctp_api;
COMMIT;
