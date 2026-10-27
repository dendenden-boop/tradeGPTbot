BEGIN;
-- Pristine execution-input capture only. No table/role/sequence, mutation RPC,
-- financial cause, permission or dispatch is created. Published1-57 immutable.
CREATE FUNCTION ctp_paper.capture_execution_candidates(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE r jsonb:=p->'admission'; auth jsonb:=p->'authorization'; t uuid; a uuid; inv jsonb; b jsonb; cfg jsonb; model jsonb;
 market jsonb; candidates jsonb:='[]'; i ctp_paper.admission_issuance%ROWTYPE; c ctp_execution.command%ROWTYPE;
 now_ms bigint; age integer; valid_until bigint; n integer:=0; previous bigint:=0; priority bigint; row jsonb; trade_hash text;
 platform ctp_risk.policy_revision%ROWTYPE; usr ctp_risk.policy_revision%ROWTYPE; result jsonb; found_target boolean:=false;
BEGIN
 IF NOT coalesce(ctp_market.snapshot_keys(p,ARRAY['kind','admission','authorization']),false)
  OR p->>'kind' IS DISTINCT FROM 'PAPER_EXECUTION_CAPTURE'
  OR NOT coalesce(ctp_market.snapshot_keys(auth,ARRAY['permissionEpoch','userSessionEpoch']),false)
  OR octet_length(p::text)>16384 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 FOR row IN SELECT value FROM jsonb_each(auth) LOOP
  IF jsonb_typeof(row)<>'string' OR row#>>'{}' !~ '^(0|[1-9][0-9]{0,18})$'
   OR (row#>>'{}')::numeric>9223372036854775807 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 END LOOP;
 IF (auth->>'userSessionEpoch')::numeric>2147483647 THEN RAISE EXCEPTION 'PAPER_ADMISSION_INPUT'; END IF;
 t:=ctp_paper.admission_lock(r); a:=(r->'binding'->>'accountId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public."user" WHERE id=t AND "sessionEpoch"=(auth->>'userSessionEpoch')::integer)
  OR NOT EXISTS(SELECT 1 FROM public.exchange_account WHERE "tenantId"=t AND id=a AND "permissionEpoch"=(auth->>'permissionEpoch')::bigint)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_SCOPE'; END IF;
 -- admission_inventory authenticates all accounts, histories, holds and common
 -- rows. Its published book helper can adopt a pristine book. Prohibit that
 -- branch before invoking it: a read must never initialize even another account.
 IF EXISTS(SELECT 1 FROM public.exchange_account x
  LEFT JOIN ctp_paper.book_origin o ON o.tenant_id=x."tenantId" AND o.account_id=x.id
  LEFT JOIN ctp_paper.admission_book_head h ON h.tenant_id=o.tenant_id AND h.book_id=o.book
  WHERE x."tenantId"=t AND x.mode='PAPER' AND (o.book IS NULL OR h.book_id IS NULL))
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 inv:=ctp_paper.admission_inventory(r,now_ms); b:=inv->'target';cfg:=b->'configuration'->'configuration';model:=cfg->'model';
 IF r->'binding'->'profile' IS DISTINCT FROM cfg->'source'||jsonb_build_object('accountMode','SIMULATED',
   'profileVersion',model->>'version','endpointProfileId','paper-spot-v1')
  OR NOT EXISTS(SELECT 1 FROM ctp_paper.admission_issuance x WHERE x.tenant_id=t AND x.account_id=a
   AND x.order_id=(r->>'orderId')::uuid AND x.intent_id=(r->>'intentId')::uuid AND x.request=r)
  OR EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier WHERE tenant_id=t AND order_id=(r->>'orderId')::uuid)
 THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT v.* INTO platform FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision v USING(scope,target,mode,version,id)
  WHERE h.scope='PLATFORM' AND h.target='00000000-0000-0000-0000-000000000000' AND h.mode='PAPER';
 IF NOT FOUND OR ctp_risk.valid_limits(platform."limitsText"::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 SELECT v.* INTO usr FROM ctp_risk.policy_head h JOIN ctp_risk.policy_revision v USING(scope,target,mode,version,id)
  WHERE h.scope='USER' AND h.target=t AND h.mode='PAPER';
 IF NOT FOUND OR ctp_risk.valid_limits(usr."limitsText"::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 age:=least((platform."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(usr."limitsText"::jsonb->>'maxEvidenceAgeMs')::integer,(model->>'maxEvidenceAgeMs')::integer);
 market:=ctp_paper.admission_market(r,cfg,age);
 SELECT encode(hash,'hex') INTO trade_hash FROM ctp_market.trade_event WHERE id=(market->>'tradeId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 FOR i IN SELECT x.* FROM ctp_paper.admission_issuance x WHERE x.tenant_id=t AND x.account_id=a
  AND x.instrument=market->'record'->'instrument'->>'id'
  -- Only the actual immutable private NOT_SENT cause may exclude a contender.
  -- Its hold remains in the complete Portfolio until an authenticated release.
  AND NOT EXISTS(SELECT 1 FROM ctp_paper.withdrawal_barrier w WHERE w.tenant_id=x.tenant_id AND w.reservation_id=x.reservation_id)
  ORDER BY (x.response->'certificate'->>'revision')::bigint LIMIT 301 LOOP
  n:=n+1;IF n>300 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
  SELECT * INTO c FROM ctp_execution.command WHERE "tenantId"=t AND "intentId"=i.intent_id;
  IF NOT FOUND OR c."orderId"<>i.order_id OR c.operation<>'PLACE' OR c.binding::jsonb IS DISTINCT FROM r->'binding'
   OR i.rule_id::text IS DISTINCT FROM market->>'dbRuleId' OR c.draft::jsonb->>'dbInstrumentId' IS DISTINCT FROM market->>'dbInstrumentId'
   OR c.command::jsonb->>'ruleVersion' IS DISTINCT FROM market->'record'->'rules'->>'version'
   OR c.command::jsonb->>'instrumentId' IS DISTINCT FROM i.instrument
   OR i.response->'budget'->'model' IS DISTINCT FROM model
   OR i.response->'certificate'->>'id' IS DISTINCT FROM i.certificate_id::text
   OR i.response->'certificate'->>'sourceHash' IS DISTINCT FROM encode(i.source_hash,'hex')
   OR (i.response->'certificate'->>'createdAt')::bigint<>i.created_ms
   OR i.response->'certificate'->>'revision' IS DISTINCT FROM i.response->'policy'->'snapshot'->>'revision'
  THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
  priority:=(i.response->'certificate'->>'revision')::bigint;
  IF priority<=previous THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;previous:=priority;
  candidates:=candidates||jsonb_build_array(jsonb_build_object(
   'orderId',i.order_id::text,'intentId',i.intent_id::text,'reservationId',i.reservation_id::text,'decisionId',i.decision_id::text,
   'commandHash',encode(c."commandHash",'hex'),'command',c.command::jsonb,
   'dbInstrumentId',market->'dbInstrumentId','dbRuleId',market->'dbRuleId',
   'admissionSequence',priority::text,'admittedAt',i.created_ms,
   'original',jsonb_build_object('certificateId',i.certificate_id::text,'sourceHash',encode(i.source_hash,'hex'),
    'expiresAt',i.response->'receipt'->'expiresAt','executionBounds',jsonb_build_object(
     'minimum',i.response->'policy'->'snapshot'->'market'->'lowerExecutionPrice',
     'maximum',i.response->'policy'->'snapshot'->'market'->'upperExecutionPrice',
     'feeRate',model->'takerFeeRate')),
   'debits',i.response->'debits'));
  IF i.order_id=(r->>'orderId')::uuid THEN found_target:=true; END IF;
 END LOOP;
 IF n=0 OR NOT found_target THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 valid_until:=least((market->>'snapshotAt')::bigint+age+1,(market->>'tradeAt')::bigint+age+1,
  (market->'book'->>'receivedAt')::bigint+age+1,(market->'book'->>'exchangeTime')::bigint+age+1,
  (market->'trade'->>'receivedAt')::bigint+age+1,(market->'trade'->>'exchangeTime')::bigint+age+1,
  (market->'record'->'rules'->>'expiresAt')::bigint,(market->'record'->'instrument'->>'expiryAt')::bigint);
 IF valid_until<=now_ms THEN RAISE EXCEPTION 'PAPER_ADMISSION_EXPIRED'; END IF;
 result:=jsonb_build_object('kind','PAPER_EXECUTION_CAPTURE','request',p,'asOf',now_ms,'validUntil',valid_until,'maxEvidenceAgeMs',age,
  'configurationId',cfg->'id','fundingId',b->'funding'->'funding'->'id','model',model,
  'portfolio',jsonb_build_object('bookId',b->'bookId','revision',b->'revision','hash',b->'hash','stateText',ctp_admission.canonical(b->'state')),
  'market',jsonb_build_object('record',market->'record','book',market->'book','trade',market->'trade',
   'snapshotAt',market->'snapshotAt','tradeAt',market->'tradeAt','dbInstrumentId',market->'dbInstrumentId','dbRuleId',market->'dbRuleId',
   'snapshot',jsonb_build_object('id',market->'snapshotId','revision',market->'snapshotRevision','hash',market->'snapshotHash'),
   'tradeReference',jsonb_build_object('id',market->'tradeId','revision',market->'tradeRevision','hash',trade_hash)),
  'candidates',candidates);
 IF octet_length(result::text)>4194304 THEN RAISE EXCEPTION 'PAPER_ADMISSION_LIMIT'; END IF;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE';
END $$;
ALTER FUNCTION ctp_paper.reconcile_admission(jsonb) RENAME TO reconcile_admission_v57;
CREATE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT coalesce(ctp_paper.valid_admission_runtime(),false) THEN RAISE EXCEPTION 'PAPER_ADMISSION_ROLE_UNSAFE'; END IF;
 IF p->>'kind'='PAPER_EXECUTION_CAPTURE' THEN RETURN ctp_paper.capture_execution_candidates(p); END IF;
 RETURN ctp_paper.reconcile_admission_v57(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.capture_execution_candidates(jsonb),ctp_paper.reconcile_admission_v57(jsonb),
 ctp_paper.reconcile_admission(jsonb) FROM PUBLIC,ctp_paper_risk_admission;
GRANT EXECUTE ON FUNCTION ctp_paper.reconcile_admission(jsonb) TO ctp_paper_risk_admission;
COMMIT;
