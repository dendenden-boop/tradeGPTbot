BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_funding') THEN
 CREATE ROLE ctp_paper_funding NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_funding;

-- One initial epoch only. No reset, top-up, order, hold or transport authority.
CREATE TABLE ctp_paper.initial_funding (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, account_id uuid NOT NULL UNIQUE,
 mode public."TradingMode" NOT NULL DEFAULT 'PAPER' CHECK(mode='PAPER'),
 configuration_id uuid NOT NULL REFERENCES ctp_paper.configuration(id) ON DELETE RESTRICT,
 ledger_id uuid NOT NULL UNIQUE,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=8192),
 receipt_text text NOT NULL CHECK(octet_length(receipt_text)<=8192),
 FOREIGN KEY(tenant_id,account_id,mode) REFERENCES public.exchange_account("tenantId",id,mode) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,ledger_id,account_id,mode) REFERENCES public.ledger_transaction("tenantId",id,"accountId",mode) ON DELETE RESTRICT
);
CREATE TABLE ctp_paper.funding_seal (
 id uuid PRIMARY KEY REFERENCES ctp_paper.initial_funding(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL, account_id uuid NOT NULL,
 receipt_hash bytea NOT NULL CHECK(octet_length(receipt_hash)=32)
);
ALTER TABLE ctp_paper.initial_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.initial_funding FORCE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.funding_seal ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.funding_seal FORCE ROW LEVEL SECURITY;
CREATE POLICY paper_funding_tenant ON ctp_paper.initial_funding
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY paper_funding_seal_tenant ON ctp_paper.funding_seal
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER paper_funding_immutable BEFORE UPDATE OR DELETE ON ctp_paper.initial_funding FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER paper_funding_no_truncate BEFORE TRUNCATE ON ctp_paper.initial_funding FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER paper_funding_seal_immutable BEFORE UPDATE OR DELETE ON ctp_paper.funding_seal FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER paper_funding_seal_no_truncate BEFORE TRUNCATE ON ctp_paper.funding_seal FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.valid_funding(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE b jsonb; last_asset text:=''; k text; BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['id','owner','configurationId','balances']),false)
 OR NOT coalesce(ctp_paper.valid_owner(p->'owner'),false) THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['id','configurationId'] LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(p->'balances') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p->'balances') NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(p->'balances') LOOP
  IF NOT coalesce(ctp_market.snapshot_keys(b,ARRAY['asset','amount']),false)
  OR jsonb_typeof(b->'asset') IS DISTINCT FROM 'string' OR b->>'asset' !~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'
  OR (b->>'asset') COLLATE "C" <= last_asset COLLATE "C"
  OR jsonb_typeof(b->'amount') IS DISTINCT FROM 'string' OR b->>'amount' !~ '^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$'
  THEN RETURN false; END IF;
  IF (b->>'amount')::numeric<=0 THEN RETURN false; END IF;
  last_asset:=b->>'asset';
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION ctp_paper.funding_configuration(o jsonb,c uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r ctp_paper.configuration%ROWTYPE; w jsonb; ident jsonb; BEGIN
 IF NOT coalesce(ctp_paper.valid_owner(o),false) OR o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true)
 THEN RAISE EXCEPTION 'PAPER_FUNDING_OWNERSHIP'; END IF;
 SELECT * INTO r FROM ctp_paper.configuration WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_FUNDING_MISSING'; END IF;
 IF r.id<>c THEN RAISE EXCEPTION 'PAPER_FUNDING_CONFLICT'; END IF;
 BEGIN
  ident:=ctp_paper.account_identity(o,r.request->'source');
 EXCEPTION WHEN raise_exception THEN RAISE EXCEPTION 'PAPER_FUNDING_OWNERSHIP'; END;
 BEGIN
  w:=ctp_paper.wire_receipt(r.receipt_text);
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'PAPER_FUNDING_CORRUPT'; END;
 IF r.receipt_text::jsonb->'accountIdentity' IS DISTINCT FROM ident THEN RAISE EXCEPTION 'PAPER_FUNDING_OWNERSHIP'; END IF;
 RETURN jsonb_build_object('configurationHash',w->'hash','accountIdentity',ident);
END $$;

-- The retained original seal is independent of the receipt and request. Read
-- validates the actual closed common ledger; it never creates a replacement.
CREATE FUNCTION ctp_paper.funding_wire(r ctp_paper.initial_funding,c jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE p jsonb:=r.receipt_text::jsonb; h public.ledger_transaction%ROWTYPE; s ctp_paper.funding_seal%ROWTYPE; b jsonb; i integer:=0; BEGIN
 IF NOT coalesce(ctp_paper.valid_funding(r.request),false)
 OR (r.request->>'id')::uuid<>r.id OR (r.request->>'configurationId')::uuid<>r.configuration_id
 OR (r.request->'owner'->>'tenantId')::uuid<>r.tenant_id OR (r.request->'owner'->>'accountId')::uuid<>r.account_id
 OR r.mode<>'PAPER' OR r.ledger_id<>r.id
 OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['funding','configurationHash','accountIdentity','ledgerTransactionId','createdAt']),false)
 OR p->'funding' IS DISTINCT FROM r.request OR p->'configurationHash' IS DISTINCT FROM c->'configurationHash'
 OR p->'accountIdentity' IS DISTINCT FROM c->'accountIdentity' OR p->>'ledgerTransactionId' IS DISTINCT FROM r.ledger_id::text
 OR jsonb_typeof(p->'createdAt') IS DISTINCT FROM 'number' OR p->>'createdAt' !~ '^(0|[1-9][0-9]{0,15})$'
 OR (p->>'createdAt')::numeric>8640000000000000 THEN RAISE EXCEPTION 'PAPER_FUNDING_CORRUPT'; END IF;
 SELECT * INTO s FROM ctp_paper.funding_seal WHERE id=r.id;
 IF NOT FOUND OR s.tenant_id<>r.tenant_id OR s.account_id<>r.account_id OR s.receipt_hash<>sha256(convert_to(r.receipt_text,'UTF8'))
 THEN RAISE EXCEPTION 'PAPER_FUNDING_CORRUPT'; END IF;
 SELECT * INTO h FROM public.ledger_transaction WHERE id=r.ledger_id;
 IF NOT FOUND OR h."tenantId"<>r.tenant_id OR h."accountId"<>r.account_id OR h.mode<>'PAPER'
 OR h.cause<>'PAPER_SEED' OR h."causeIdentity"<>('paper-initial:'||r.id::text) OR h."descriptionCode"<>'PAPER_INITIAL_FUNDING'
 OR h."fillId" IS NOT NULL OR h."fundingPaymentId" IS NOT NULL OR h."correctionOfId" IS NOT NULL
 OR floor(extract(epoch FROM h."effectiveAt")*1000)::bigint<>(p->>'createdAt')::bigint
 OR NOT EXISTS(SELECT 1 FROM ctp_internal.ledger_seal WHERE "transactionId"=r.ledger_id AND "tenantId"=r.tenant_id)
 OR (SELECT count(*) FROM public.ledger_entry WHERE "transactionId"=r.ledger_id)<>2*jsonb_array_length(r.request->'balances')
 THEN RAISE EXCEPTION 'PAPER_FUNDING_CORRUPT'; END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(r.request->'balances') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.ledger_entry WHERE "transactionId"=r.ledger_id AND "tenantId"=r.tenant_id AND "accountId"=r.account_id
   AND mode='PAPER' AND "entryIndex"=i AND asset=b->>'asset' AND bucket='AVAILABLE' AND amount=(b->>'amount')::numeric)
  OR NOT EXISTS(SELECT 1 FROM public.ledger_entry WHERE "transactionId"=r.ledger_id AND "tenantId"=r.tenant_id AND "accountId"=r.account_id
   AND mode='PAPER' AND "entryIndex"=i+1 AND asset=b->>'asset' AND bucket='EXTERNAL' AND amount=-(b->>'amount')::numeric)
  THEN RAISE EXCEPTION 'PAPER_FUNDING_CORRUPT'; END IF;
  i:=i+2;
 END LOOP;
 RETURN jsonb_build_object('receiptText',r.receipt_text,'hash',encode(s.receipt_hash,'hex'));
END $$;

CREATE FUNCTION ctp_paper.valid_funding_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_funding'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_funding','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_funding' AND pg_has_role(session_user,r.oid,'MEMBER'))
 AND NOT has_database_privilege(session_user,current_database(),'CREATE,TEMP')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_')
  AND (has_schema_privilege(session_user,n.oid,'CREATE') OR pg_has_role(session_user,n.nspowner,'MEMBER')))
 AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p','v','m','f')
  AND (pg_has_role(session_user,t.relowner,'MEMBER') OR has_table_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
   OR has_any_column_privilege(session_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
  WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(session_user,f.oid,'EXECUTE')
  AND (n.nspname||'.'||f.proname||'('||replace(oidvectortypes(f.proargtypes),' ','')||')')
   NOT IN('ctp_paper.initialize_funding(text)','ctp_paper.read_funding(jsonb)'))
$$;


CREATE FUNCTION ctp_paper.initialize_funding(t text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; c jsonb; old ctp_paper.initial_funding%ROWTYPE; b jsonb; receipt text; ts bigint; i integer:=0; BEGIN
 IF NOT coalesce(ctp_paper.valid_funding_runtime(),false) THEN RAISE EXCEPTION 'PAPER_FUNDING_ROLE_UNSAFE'; END IF;
 IF t IS NULL OR octet_length(t)>8192 THEN RAISE EXCEPTION 'PAPER_FUNDING_INPUT'; END IF;
 p:=t::jsonb;
 IF NOT coalesce(ctp_paper.valid_funding(p),false) THEN RAISE EXCEPTION 'PAPER_FUNDING_INPUT'; END IF;
 -- Same GLOBAL -> tenant -> account financial lock order as current Risk.
 -- Initial funding is allowed under PAUSE: it grants no admission or dispatch.
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||(p->'owner'->>'tenantId'),0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:paper-funding:'||(p->>'id'),0));
 c:=ctp_paper.funding_configuration(p->'owner',(p->>'configurationId')::uuid);
 SELECT * INTO old FROM ctp_paper.initial_funding WHERE account_id=(p->'owner'->>'accountId')::uuid;
 IF FOUND THEN
  IF old.request IS DISTINCT FROM p THEN RAISE EXCEPTION 'PAPER_FUNDING_CONFLICT'; END IF;
  RETURN ctp_paper.funding_wire(old,c);
 END IF;
 -- Never adopt an arbitrary public posting or fund an already-used account.
 IF EXISTS(SELECT 1 FROM ctp_paper.initial_funding WHERE id=(p->>'id')::uuid)
 OR EXISTS(SELECT 1 FROM public.ledger_transaction WHERE "accountId"=(p->'owner'->>'accountId')::uuid OR id=(p->>'id')::uuid)
 OR EXISTS(SELECT 1 FROM public.order_intent WHERE "accountId"=(p->'owner'->>'accountId')::uuid)
 OR EXISTS(SELECT 1 FROM public.risk_reservation WHERE "accountId"=(p->'owner'->>'accountId')::uuid)
 OR EXISTS(SELECT 1 FROM ctp_portfolio.book WHERE "accountId"=(p->'owner'->>'accountId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_FUNDING_CONFLICT'; END IF;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 INSERT INTO public.ledger_transaction(id,"tenantId","accountId",mode,cause,"causeIdentity","effectiveAt","descriptionCode")
 VALUES((p->>'id')::uuid,(p->'owner'->>'tenantId')::uuid,(p->'owner'->>'accountId')::uuid,'PAPER','PAPER_SEED','paper-initial:'||(p->>'id'),to_timestamp(ts::numeric/1000),'PAPER_INITIAL_FUNDING');
 FOR b IN SELECT value FROM jsonb_array_elements(p->'balances') LOOP
  INSERT INTO public.ledger_entry("tenantId","transactionId","accountId",mode,"entryIndex",asset,bucket,amount) VALUES
   ((p->'owner'->>'tenantId')::uuid,(p->>'id')::uuid,(p->'owner'->>'accountId')::uuid,'PAPER',i,b->>'asset','AVAILABLE',(b->>'amount')::numeric),
   ((p->'owner'->>'tenantId')::uuid,(p->>'id')::uuid,(p->'owner'->>'accountId')::uuid,'PAPER',i+1,b->>'asset','EXTERNAL',-(b->>'amount')::numeric);
  i:=i+2;
 END LOOP;
 SET CONSTRAINTS public.ledger_header_conservation,public.ledger_entry_conservation IMMEDIATE;
 receipt:=jsonb_build_object('funding',p,'configurationHash',c->'configurationHash','accountIdentity',c->'accountIdentity','ledgerTransactionId',p->>'id','createdAt',ts)::text;
 INSERT INTO ctp_paper.initial_funding(id,tenant_id,account_id,configuration_id,ledger_id,request,receipt_text)
 VALUES((p->>'id')::uuid,(p->'owner'->>'tenantId')::uuid,(p->'owner'->>'accountId')::uuid,(p->>'configurationId')::uuid,(p->>'id')::uuid,p,receipt) RETURNING * INTO old;
 INSERT INTO ctp_paper.funding_seal(id,tenant_id,account_id,receipt_hash) VALUES(old.id,old.tenant_id,old.account_id,sha256(convert_to(receipt,'UTF8')));
 RETURN ctp_paper.funding_wire(old,c);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'PAPER_FUNDING_CONFLICT';
END $$;
CREATE FUNCTION ctp_paper.read_funding(o jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r ctp_paper.initial_funding%ROWTYPE; c jsonb; BEGIN
 IF NOT coalesce(ctp_paper.valid_funding_runtime(),false) THEN RAISE EXCEPTION 'PAPER_FUNDING_ROLE_UNSAFE'; END IF;
 IF NOT coalesce(ctp_paper.valid_owner(o),false) OR o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true)
 THEN RAISE EXCEPTION 'PAPER_FUNDING_OWNERSHIP'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||(o->>'tenantId'),0));
 SELECT * INTO r FROM ctp_paper.initial_funding WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_FUNDING_MISSING'; END IF;
 c:=ctp_paper.funding_configuration(o,r.configuration_id);
 RETURN ctp_paper.funding_wire(r,c);
END $$;
REVOKE ALL ON TABLE ctp_paper.initial_funding,ctp_paper.funding_seal FROM PUBLIC;
REVOKE ALL ON FUNCTION ctp_paper.valid_funding_runtime(),ctp_paper.valid_funding(jsonb),ctp_paper.funding_configuration(jsonb,uuid),ctp_paper.funding_wire(ctp_paper.initial_funding,jsonb),ctp_paper.initialize_funding(text),ctp_paper.read_funding(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.initialize_funding(text),ctp_paper.read_funding(jsonb) TO ctp_paper_funding;
COMMIT;
