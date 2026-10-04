BEGIN;
-- Public market data has no tenant principal. Isolate it from financial/auth writers.
CREATE SCHEMA ctp_market;
REVOKE ALL ON SCHEMA ctp_market FROM PUBLIC;
GRANT USAGE ON SCHEMA ctp_market TO ctp_ingest, ctp_api;

CREATE TABLE ctp_market.partition (
  key text PRIMARY KEY CHECK (octet_length(key) BETWEEN 1 AND 512),
  owner uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  lease_until timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (octet_length(state) <= 524288),
  state_hash bytea NOT NULL CHECK (state_hash = sha256(convert_to(state,'UTF8')))
);
CREATE TABLE ctp_market.bar (
  key text NOT NULL REFERENCES ctp_market.partition(key),
  timeframe integer NOT NULL CHECK (timeframe IN (30000,60000,180000,300000,900000,1800000,3600000)),
  open_time bigint NOT NULL CHECK (open_time >= 0 AND mod(open_time,timeframe)=0),
  revision bigint NOT NULL CHECK (revision >= 0),
  payload text NOT NULL CHECK (octet_length(payload) <= 8192),
  PRIMARY KEY (key,timeframe,open_time)
);
-- At-least-once public events. Acknowledgement deletes only delivered IDs.
CREATE TABLE ctp_market.event (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY,
  key text NOT NULL REFERENCES ctp_market.partition(key),
  payload text NOT NULL CHECK (octet_length(payload) <= 8192)
);
CREATE INDEX market_event_partition ON ctp_market.event(key,sequence);
REVOKE ALL ON ALL TABLES IN SCHEMA ctp_market FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ctp_market FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ctp_market TO ctp_ingest;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA ctp_market TO ctp_ingest;
GRANT SELECT ON ctp_market.bar TO ctp_api;
COMMIT;
