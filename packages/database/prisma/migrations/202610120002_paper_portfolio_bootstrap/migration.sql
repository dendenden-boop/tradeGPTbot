BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ctp_paper_book_initializer') THEN
 CREATE ROLE ctp_paper_book_initializer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END IF; END $$;
GRANT USAGE ON SCHEMA ctp_paper TO ctp_paper_book_initializer;

-- Immutable origin only. Common book/evidence/outbox are projections of the
-- existing conserved seed. No second monetary posting or financial grant.
CREATE TABLE ctp_paper.book_origin (
 book uuid PRIMARY KEY,
 tenant_id uuid NOT NULL, account_id uuid NOT NULL UNIQUE,
 mode public."TradingMode" NOT NULL DEFAULT 'PAPER' CHECK(mode='PAPER'),
 funding_id uuid NOT NULL UNIQUE REFERENCES ctp_paper.initial_funding(id) ON DELETE RESTRICT,
 receipt_text text NOT NULL CHECK(octet_length(receipt_text)<=65536),
 CHECK(book=funding_id),
 FOREIGN KEY(tenant_id,book,account_id,mode) REFERENCES ctp_portfolio.book("tenantId",id,"accountId",mode) ON DELETE RESTRICT
);
CREATE TABLE ctp_paper.book_origin_seal (
 book uuid PRIMARY KEY REFERENCES ctp_paper.book_origin(book) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL, account_id uuid NOT NULL,
 receipt_hash bytea NOT NULL CHECK(octet_length(receipt_hash)=32)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['book_origin','book_origin_seal'] LOOP
 EXECUTE format('ALTER TABLE ctp_paper.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE ctp_paper.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY paper_book_tenant ON ctp_paper.%I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('REVOKE ALL ON ctp_paper.%I FROM PUBLIC',t);
 EXECUTE format('CREATE TRIGGER paper_book_immutable BEFORE UPDATE OR DELETE ON ctp_paper.%I FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row()',t);
 EXECUTE format('CREATE TRIGGER paper_book_no_truncate BEFORE TRUNCATE ON ctp_paper.%I FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row()',t);
END LOOP; END $$;

CREATE FUNCTION ctp_paper.valid_book_runtime() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user
  AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication))
 AND EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='ctp_paper_book_initializer'
  AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
 AND pg_has_role(session_user,'ctp_paper_book_initializer','MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname<>session_user AND r.rolname<>'ctp_paper_book_initializer' AND pg_has_role(session_user,r.oid,'MEMBER'))
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
   NOT IN('ctp_paper.initialize_book(jsonb)','ctp_paper.read_book_origin(jsonb)'))
$$;

CREATE FUNCTION ctp_paper.book_context(o jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE f ctp_paper.initial_funding%ROWTYPE; c ctp_paper.configuration%ROWTYPE; ci jsonb; cw jsonb; fw jsonb; BEGIN
 IF o IS NULL OR octet_length(o::text)>512 OR NOT coalesce(ctp_paper.valid_owner(o),false)
 THEN RAISE EXCEPTION 'PAPER_BOOK_INPUT'; END IF;
 IF o->>'tenantId' IS DISTINCT FROM current_setting('app.tenant_id',true) THEN RAISE EXCEPTION 'PAPER_BOOK_OWNERSHIP'; END IF;
 PERFORM pg_advisory_xact_lock_shared(1129599058,12);
 PERFORM pg_advisory_xact_lock(hashtextextended('ctp:risk:'||(o->>'tenantId'),0));
 SELECT * INTO f FROM ctp_paper.initial_funding WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_BOOK_MISSING'; END IF;
 BEGIN
  ci:=ctp_paper.funding_configuration(o,f.configuration_id);
  SELECT * INTO c FROM ctp_paper.configuration WHERE id=f.configuration_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_FUNDING_CORRUPT'; END IF;
  cw:=ctp_paper.wire_receipt(c.receipt_text); fw:=ctp_paper.funding_wire(f,ci);
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM IN('PAPER_CONFIGURATION_OWNERSHIP','PAPER_FUNDING_OWNERSHIP') THEN RAISE EXCEPTION 'PAPER_BOOK_OWNERSHIP';
  ELSE RAISE EXCEPTION 'PAPER_BOOK_CORRUPT'; END IF;
 END;
 RETURN jsonb_build_object('configuration',cw,'funding',fw);
END $$;

CREATE FUNCTION ctp_paper.initial_book_state(c jsonb,f jsonb,ts bigint) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'binding',jsonb_build_object('tenantId',f->'funding'->'owner'->'tenantId','accountId',f->'funding'->'owner'->'accountId',
   'mode','PAPER','connectionId',NULL,'externalAccountId',f->'accountIdentity'->'externalAccountId',
   'walletId','paper-initial:'||(f->'funding'->>'id'),'scope',c->'configuration'->'source'),
  'balances',(SELECT jsonb_agg(jsonb_build_object('asset',b->'asset','total',b->'amount','free',b->'amount','available',b->'amount','locked','0') ORDER BY ord)
   FROM jsonb_array_elements(f->'funding'->'balances') WITH ORDINALITY x(b,ord)),
  'positions','[]'::jsonb,'holds','[]'::jsonb,'pending','[]'::jsonb,'differences','[]'::jsonb,
  'status','RECONCILED','snapshotId','paper-bootstrap:'||(f->'funding'->>'id'),'snapshotAt',ts,'lastEconomicAt',NULL)
$$;

CREATE FUNCTION ctp_paper.book_activity(o jsonb,c jsonb,f jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t uuid:=(o->>'tenantId')::uuid; a uuid:=(o->>'accountId')::uuid; b jsonb; BEGIN
 IF (SELECT count(*) FROM (SELECT id FROM public.order_intent WHERE "tenantId"=t AND "accountId"=a LIMIT 1001)q)>1000
 OR (SELECT count(*) FROM (SELECT id FROM public."order" WHERE "tenantId"=t AND "accountId"=a LIMIT 1001)q)>1000
 THEN RAISE EXCEPTION 'PAPER_BOOK_CAPACITY'; END IF;
 b:=o||jsonb_build_object('connectionId',NULL,'externalAccountId',f->'accountIdentity'->'externalAccountId',
  'profile',(c->'configuration'->'source')||jsonb_build_object('accountMode','SIMULATED','endpointProfileId','paper-spot-v1','profileVersion',c->'configuration'->'model'->'version'));
 IF EXISTS(SELECT 1 FROM public.ledger_transaction WHERE "tenantId"=t AND "accountId"=a AND id<>(f->'funding'->>'id')::uuid)
 OR EXISTS(SELECT 1 FROM public.risk_reservation WHERE "tenantId"=t AND "accountId"=a)
 OR EXISTS(SELECT 1 FROM public.risk_decision WHERE "tenantId"=t AND "accountId"=a)
 OR EXISTS(SELECT 1 FROM public.submission_attempt sa JOIN public."order" x ON x."tenantId"=sa."tenantId" AND x.id=sa."orderId" WHERE x."tenantId"=t AND x."accountId"=a)
 OR EXISTS(SELECT 1 FROM public.fill WHERE "tenantId"=t AND "accountId"=a)
 OR EXISTS(SELECT 1 FROM public.position WHERE "tenantId"=t AND "accountId"=a)
 OR EXISTS(SELECT 1 FROM public.algo_order WHERE "tenantId"=t AND "accountId"=a)
 OR EXISTS(SELECT 1 FROM public.paper_account WHERE "tenantId"=t AND "accountId"=a)
 OR EXISTS(SELECT 1 FROM public.paper_order WHERE "tenantId"=t AND "accountId"=a)
 OR EXISTS(SELECT 1 FROM public.paper_position WHERE "tenantId"=t AND "accountId"=a)
 OR EXISTS(SELECT 1 FROM public.order_intent i LEFT JOIN public."order" x ON x."tenantId"=i."tenantId" AND x."intentId"=i.id
  LEFT JOIN ctp_execution.command cmd ON cmd."tenantId"=i."tenantId" AND cmd."intentId"=i.id
  LEFT JOIN ctp_execution.progress prog ON prog."tenantId"=x."tenantId" AND prog."orderId"=x.id
  WHERE i."tenantId"=t AND i."accountId"=a AND
   (i.mode<>'PAPER' OR i."connectionId" IS NOT NULL OR i.destination<>'PAPER_ENGINE' OR i.operation<>'PLACE' OR i."targetOrderId" IS NOT NULL
    OR x.id IS NULL OR x."accountId"<>a OR x.mode<>'PAPER' OR x."connectionId" IS NOT NULL OR x.status<>'CREATED'
    OR x."filledQuantity"<>0 OR x."averageFillPrice"<>0 OR x."exchangeOrderId" IS NOT NULL OR x."lastExchangeAt" IS NOT NULL OR x."terminalAt" IS NOT NULL
    OR x."clientIdNamespace" IS DISTINCT FROM f->'accountIdentity'->>'clientIdEpoch'
    OR cmd."intentId" IS NULL OR cmd."orderId" IS DISTINCT FROM x.id OR cmd.operation<>'PLACE' OR cmd.binding::jsonb IS DISTINCT FROM b
    OR cmd."commandHash" IS DISTINCT FROM i."commandHash" OR cmd.command::jsonb->>'clientOrderId' IS DISTINCT FROM x."clientId"
    OR prog."orderId" IS NULL OR prog."nativeAt" IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public."order" x WHERE x."tenantId"=t AND x."accountId"=a AND NOT EXISTS(SELECT 1 FROM public.order_intent i WHERE i."tenantId"=t AND i.id=x."intentId" AND i."accountId"=a))
 THEN RAISE EXCEPTION 'PAPER_BOOK_INCOMPLETE'; END IF;
END $$;

CREATE FUNCTION ctp_paper.book_origin_wire(r ctp_paper.book_origin,c jsonb,f jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE p jsonb:=r.receipt_text::jsonb; seal ctp_paper.book_origin_seal%ROWTYPE; state jsonb; e jsonb; ts bigint; BEGIN
 SELECT * INTO seal FROM ctp_paper.book_origin_seal WHERE book=r.book;
 IF NOT FOUND OR seal.tenant_id<>r.tenant_id OR seal.account_id<>r.account_id OR seal.receipt_hash<>sha256(convert_to(r.receipt_text,'UTF8'))
 OR NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','bookId','revision','createdAt','configuration','funding','stateText','stateHash']),false)
 OR p->>'kind' IS DISTINCT FROM 'INITIAL_BOOK' OR p->>'bookId' IS DISTINCT FROM r.book::text OR p->>'revision' IS DISTINCT FROM '1'
 OR p->'configuration' IS DISTINCT FROM c OR p->'funding' IS DISTINCT FROM f
 OR jsonb_typeof(p->'createdAt') IS DISTINCT FROM 'number' OR p->>'createdAt' !~ '^(0|[1-9][0-9]{0,15})$'
 OR (p->>'createdAt')::numeric>8640000000000000 OR jsonb_typeof(p->'stateText') IS DISTINCT FROM 'string'
 OR jsonb_typeof(p->'stateHash') IS DISTINCT FROM 'string' OR p->>'stateHash'<>encode(sha256(convert_to(p->>'stateText','UTF8')),'hex')
 THEN RAISE EXCEPTION 'PAPER_BOOK_CORRUPT'; END IF;
 ts:=(p->>'createdAt')::bigint;
 -- Original receipt time is never renewed by read/replay.
 IF ts<((f->>'receiptText')::jsonb->>'createdAt')::bigint OR ts>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 THEN RAISE EXCEPTION 'PAPER_BOOK_CORRUPT'; END IF;
 state:=ctp_paper.initial_book_state((c->>'receiptText')::jsonb,(f->>'receiptText')::jsonb,ts);
 IF r.funding_id<>(((f->>'receiptText')::jsonb)->'funding'->>'id')::uuid OR r.book<>r.funding_id
 OR r.tenant_id<>(((f->>'receiptText')::jsonb)->'funding'->'owner'->>'tenantId')::uuid
 OR r.account_id<>(((f->>'receiptText')::jsonb)->'funding'->'owner'->>'accountId')::uuid
 OR (p->>'stateText')::jsonb IS DISTINCT FROM state
 OR (SELECT count(*) FROM ctp_portfolio.book WHERE "tenantId"=r.tenant_id AND "accountId"=r.account_id)<>1
 OR NOT EXISTS(SELECT 1 FROM ctp_portfolio.book b WHERE b.id=r.book AND b."tenantId"=r.tenant_id AND b."accountId"=r.account_id AND b.mode='PAPER'
  AND b.wallet='paper-initial:'||r.funding_id::text AND b.revision=1 AND b.state=p->>'stateText' AND b.state_hash=sha256(convert_to(b.state,'UTF8')))
 OR EXISTS(SELECT 1 FROM ctp_portfolio.hold_watermark WHERE "tenantId"=r.tenant_id AND book=r.book)
 THEN RAISE EXCEPTION 'PAPER_BOOK_CORRUPT'; END IF;
 e:=jsonb_build_object('id',state->'snapshotId','timestamp',ts,'type','SNAPSHOT','proof','RECONCILED_HISTORY','covered','[]'::jsonb,'balances',state->'balances','positions','[]'::jsonb);
 IF (SELECT count(*) FROM ctp_portfolio.evidence WHERE "tenantId"=r.tenant_id AND book=r.book)<>1
 OR NOT EXISTS(SELECT 1 FROM ctp_portfolio.evidence x WHERE x."tenantId"=r.tenant_id AND x.book=r.book AND x.id=state->>'snapshotId'
  AND x.ledger=r.funding_id AND x.payload::jsonb=e AND x.fingerprint=sha256(convert_to(x.payload,'UTF8')))
 OR (SELECT count(*) FROM ctp_portfolio.outbox WHERE "tenantId"=r.tenant_id AND book=r.book)<>1
 OR NOT EXISTS(SELECT 1 FROM ctp_portfolio.outbox x WHERE x.id=r.book AND x."tenantId"=r.tenant_id AND x.book=r.book AND x."accountId"=r.account_id
  AND x.mode='PAPER' AND x.revision=1 AND x.type='SNAPSHOT' AND x."eventId"=state->>'snapshotId')
 THEN RAISE EXCEPTION 'PAPER_BOOK_CORRUPT'; END IF;
 RETURN jsonb_build_object('receiptText',r.receipt_text,'hash',encode(seal.receipt_hash,'hex'));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PAPER_BOOK_CORRUPT';
END $$;

CREATE FUNCTION ctp_paper.initialize_book(o jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; c jsonb; f jsonb; origin ctp_paper.book_origin%ROWTYPE; book_id uuid; ts bigint; state jsonb; event jsonb; text_state text; receipt text; BEGIN
 IF NOT coalesce(ctp_paper.valid_book_runtime(),false) THEN RAISE EXCEPTION 'PAPER_BOOK_ROLE_UNSAFE'; END IF;
 ctx:=ctp_paper.book_context(o); c:=(ctx->'configuration'->>'receiptText')::jsonb; f:=(ctx->'funding'->>'receiptText')::jsonb;
 PERFORM ctp_paper.book_activity(o,c,f);
 SELECT * INTO origin FROM ctp_paper.book_origin WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF FOUND THEN RETURN ctp_paper.book_origin_wire(origin,ctx->'configuration',ctx->'funding'); END IF;
 book_id:=(f->'funding'->>'id')::uuid;
 IF EXISTS(SELECT 1 FROM ctp_portfolio.book WHERE "accountId"=(o->>'accountId')::uuid OR id=book_id)
 OR EXISTS(SELECT 1 FROM ctp_portfolio.outbox WHERE id=book_id)
 THEN RAISE EXCEPTION 'PAPER_BOOK_INCOMPLETE'; END IF;
 ts:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 state:=ctp_paper.initial_book_state(c,f,ts); text_state:=state::text;
 event:=jsonb_build_object('id',state->'snapshotId','timestamp',ts,'type','SNAPSHOT','proof','RECONCILED_HISTORY','covered','[]'::jsonb,'balances',state->'balances','positions','[]'::jsonb);
 INSERT INTO ctp_portfolio.book(id,"tenantId","accountId",mode,wallet,revision,state,state_hash)
 VALUES(book_id,(o->>'tenantId')::uuid,(o->>'accountId')::uuid,'PAPER',state->'binding'->>'walletId',1,text_state,sha256(convert_to(text_state,'UTF8')));
 INSERT INTO ctp_portfolio.evidence("tenantId",book,"accountId",mode,id,fingerprint,payload,ledger)
 VALUES((o->>'tenantId')::uuid,book_id,(o->>'accountId')::uuid,'PAPER',state->>'snapshotId',sha256(convert_to(event::text,'UTF8')),event::text,book_id);
 INSERT INTO ctp_portfolio.outbox(id,"tenantId",book,"accountId",mode,revision,"eventId",type)
 VALUES(book_id,(o->>'tenantId')::uuid,book_id,(o->>'accountId')::uuid,'PAPER',1,state->>'snapshotId','SNAPSHOT');
 receipt:=jsonb_build_object('kind','INITIAL_BOOK','bookId',book_id::text,'revision','1','createdAt',ts,'configuration',ctx->'configuration','funding',ctx->'funding',
  'stateText',text_state,'stateHash',encode(sha256(convert_to(text_state,'UTF8')),'hex'))::text;
 INSERT INTO ctp_paper.book_origin(book,tenant_id,account_id,funding_id,receipt_text)
 VALUES(book_id,(o->>'tenantId')::uuid,(o->>'accountId')::uuid,book_id,receipt) RETURNING * INTO origin;
 INSERT INTO ctp_paper.book_origin_seal(book,tenant_id,account_id,receipt_hash) VALUES(book_id,origin.tenant_id,origin.account_id,sha256(convert_to(receipt,'UTF8')));
 RETURN ctp_paper.book_origin_wire(origin,ctx->'configuration',ctx->'funding');
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'PAPER_BOOK_INCOMPLETE';
END $$;

CREATE FUNCTION ctp_paper.read_book_origin(o jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb; origin ctp_paper.book_origin%ROWTYPE; BEGIN
 IF NOT coalesce(ctp_paper.valid_book_runtime(),false) THEN RAISE EXCEPTION 'PAPER_BOOK_ROLE_UNSAFE'; END IF;
 ctx:=ctp_paper.book_context(o);
 PERFORM ctp_paper.book_activity(o,(ctx->'configuration'->>'receiptText')::jsonb,(ctx->'funding'->>'receiptText')::jsonb);
 SELECT * INTO origin FROM ctp_paper.book_origin WHERE tenant_id=(o->>'tenantId')::uuid AND account_id=(o->>'accountId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_BOOK_MISSING'; END IF;
 RETURN ctp_paper.book_origin_wire(origin,ctx->'configuration',ctx->'funding');
END $$;
REVOKE ALL ON FUNCTION ctp_paper.valid_book_runtime(),ctp_paper.book_context(jsonb),ctp_paper.initial_book_state(jsonb,jsonb,bigint),ctp_paper.book_activity(jsonb,jsonb,jsonb),ctp_paper.book_origin_wire(ctp_paper.book_origin,jsonb,jsonb),ctp_paper.initialize_book(jsonb),ctp_paper.read_book_origin(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_paper.initialize_book(jsonb),ctp_paper.read_book_origin(jsonb) TO ctp_paper_book_initializer;
COMMIT;
