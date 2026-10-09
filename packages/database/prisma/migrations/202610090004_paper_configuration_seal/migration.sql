BEGIN;
LOCK TABLE ctp_paper.configuration IN ACCESS EXCLUSIVE MODE;
CREATE TABLE ctp_paper.configuration_seal (
 id uuid PRIMARY KEY REFERENCES ctp_paper.configuration(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL, account_id uuid NOT NULL,
 receipt_hash bytea NOT NULL CHECK(octet_length(receipt_hash)=32)
);
ALTER TABLE ctp_paper.configuration_seal ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.configuration_seal FORCE ROW LEVEL SECURITY;
CREATE POLICY paper_seal_tenant ON ctp_paper.configuration_seal
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER paper_seal_immutable BEFORE UPDATE OR DELETE ON ctp_paper.configuration_seal
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER paper_seal_no_truncate BEFORE TRUNCATE ON ctp_paper.configuration_seal
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.valid_receipt(r ctp_paper.configuration) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE p jsonb:=r.receipt_text::jsonb; i jsonb:=p->'accountIdentity'; BEGIN
 RETURN coalesce(ctp_paper.valid_configuration(r.request),false)
 AND (r.request->>'id')::uuid=r.id AND (r.request->'owner'->>'tenantId')::uuid=r.tenant_id
 AND (r.request->'owner'->>'accountId')::uuid=r.account_id AND r.mode='PAPER'
 AND coalesce(ctp_market.snapshot_keys(p,ARRAY['configuration','accountIdentity','createdAt']),false)
 AND p->'configuration'=r.request
 AND coalesce(ctp_market.snapshot_keys(i,ARRAY['externalAccountId','clientIdEpoch']),false)
 AND jsonb_typeof(i->'externalAccountId')='string' AND length(i->>'externalAccountId') BETWEEN 1 AND 128
 AND i->>'externalAccountId' !~ '[[:space:][:cntrl:]]'
 AND jsonb_typeof(i->'clientIdEpoch')='string' AND length(i->>'clientIdEpoch') BETWEEN 1 AND 64
 AND i->>'clientIdEpoch' !~ '[[:space:][:cntrl:]]'
 AND jsonb_typeof(p->'createdAt')='number' AND p->>'createdAt' ~ '^(0|[1-9][0-9]{0,15})$'
 AND (p->>'createdAt')::numeric<=8640000000000000;
END $$;

-- Transaction-private owner policies permit a non-BYPASSRLS DDL owner to read
-- every legacy receipt and backfill its seal. No such policy survives COMMIT.
DO $$ BEGIN
 EXECUTE format('CREATE POLICY paper_seal_upgrade_read ON ctp_paper.configuration FOR SELECT TO %I USING(true)',current_user);
 EXECUTE format('CREATE POLICY paper_seal_upgrade_write ON ctp_paper.configuration_seal FOR INSERT TO %I WITH CHECK(true)',current_user);
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ctp_paper.configuration r WHERE NOT coalesce(ctp_paper.valid_receipt(r),false))
 THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_CORRUPT'; END IF;
 INSERT INTO ctp_paper.configuration_seal(id,tenant_id,account_id,receipt_hash)
 SELECT id,tenant_id,account_id,sha256(convert_to(receipt_text,'UTF8')) FROM ctp_paper.configuration;
END $$;
DROP POLICY paper_seal_upgrade_read ON ctp_paper.configuration;
DROP POLICY paper_seal_upgrade_write ON ctp_paper.configuration_seal;

CREATE FUNCTION ctp_paper.seal_configuration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_receipt(NEW),false) THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_CORRUPT'; END IF;
 INSERT INTO ctp_paper.configuration_seal(id,tenant_id,account_id,receipt_hash)
 VALUES(NEW.id,NEW.tenant_id,NEW.account_id,sha256(convert_to(NEW.receipt_text,'UTF8')));
 RETURN NEW;
END $$;
CREATE TRIGGER paper_configuration_seal AFTER INSERT ON ctp_paper.configuration
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.seal_configuration();

CREATE OR REPLACE FUNCTION ctp_paper.wire_receipt(t text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE r ctp_paper.configuration%ROWTYPE; seal ctp_paper.configuration_seal%ROWTYPE; BEGIN
 SELECT * INTO r FROM ctp_paper.configuration WHERE id=(t::jsonb->'configuration'->>'id')::uuid;
 IF NOT FOUND OR r.receipt_text IS DISTINCT FROM t OR NOT coalesce(ctp_paper.valid_receipt(r),false)
 THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_CORRUPT'; END IF;
 SELECT * INTO seal FROM ctp_paper.configuration_seal WHERE id=r.id;
 IF NOT FOUND OR seal.tenant_id<>r.tenant_id OR seal.account_id<>r.account_id
 OR seal.receipt_hash<>sha256(convert_to(t,'UTF8')) THEN RAISE EXCEPTION 'PAPER_CONFIGURATION_CORRUPT'; END IF;
 RETURN jsonb_build_object('receiptText',t,'hash',encode(seal.receipt_hash,'hex'));
END $$;
REVOKE ALL ON TABLE ctp_paper.configuration_seal FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_paper.valid_receipt(ctp_paper.configuration),ctp_paper.seal_configuration(),ctp_paper.wire_receipt(text) FROM PUBLIC;
COMMIT;
