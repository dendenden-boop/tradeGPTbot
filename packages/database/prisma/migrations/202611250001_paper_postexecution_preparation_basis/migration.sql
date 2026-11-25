BEGIN;

-- Recover the historical preparation basis. Use the restricted replay
-- selector and its GLOBAL/tenant lock before walking the saved successor.
CREATE FUNCTION ctp_paper.postexecution_basis(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE replay jsonb; facts jsonb; captured jsonb; evidence jsonb; t uuid;
BEGIN
 replay:=ctp_paper.postexecution_reserve(
  p||jsonb_build_object('kind','PAPER_POSTEXECUTION_READ'),true);
 IF replay->>'kind'='MISSING' THEN RETURN replay; END IF;
 IF replay->>'kind' IS DISTINCT FROM 'REPLAYED' THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;
 t:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;

 SELECT jsonb_build_object(
  'kind','CAPTURED',
  'request',jsonb_build_object('kind','PAPER_CURRENT_ORDER_RISK_CAPTURE','source',p->'source','target',p->'target'),
  'capturedAt',s.applied_ms,
  'target',jsonb_build_object('owner',jsonb_build_object('tenantId',t,'accountId',s.account_id,'mode','PAPER'),
   'orderId',o.id,'intentId',i.intent_id,'dbInstrumentId',o."instrumentId",'dbRuleId',i.rule_id,
   'command',cmd.command::jsonb,'commandHash',encode(cmd."commandHash",'hex'),
   'createdAt',floor(extract(epoch FROM intent."createdAt")*1000)::bigint,
   'status',o.status,'orderVersion',o.version),
  'certificate',jsonb_build_object('text',c.document_text,'hash',encode(c.document_hash,'hex'))),
  jsonb_build_object('kind','PAPER_POSTEXECUTION_BASIS','receipt',replay->'receipt',
   'event',v.payload::jsonb,'eventHash',encode(v.fingerprint,'hex'),'ledger',v.ledger,
   'book',jsonb_build_object('previousHash',encode(e.previous_hash,'hex'),'state',e.state_text,'stateHash',encode(e.state_hash,'hex')),
   'watermark',jsonb_build_object('timestamp',w.timestamp,'fingerprint',encode(w.fingerprint,'hex'),'released',w.released,'unknown',w.unknown))
 INTO captured,facts
 FROM ctp_paper.postexecution_commitment s
 JOIN ctp_paper.admission_issuance i ON i.tenant_id=s.tenant_id AND i.intent_id=s.intent_id
 JOIN ctp_paper.current_risk_certificate c ON c.tenant_id=s.tenant_id AND c.id=s.certificate_id
 JOIN ctp_paper.admission_book_event e ON e.tenant_id=s.tenant_id AND e.book_id=s.book_id AND e.revision=s.revision
 JOIN ctp_portfolio.evidence v ON v."tenantId"=s.tenant_id AND v.book=s.book_id AND v.id=s.event_id::text
 JOIN ctp_portfolio.hold_watermark w ON w."tenantId"=s.tenant_id AND w.book=s.book_id
  AND w."holdId"=replay #>> '{receipt,debits,0,holdId}'
 JOIN ctp_execution.command cmd ON cmd."tenantId"=s.tenant_id AND cmd."intentId"=s.intent_id AND cmd."orderId"=i.order_id
 JOIN public.order_intent intent ON intent."tenantId"=s.tenant_id AND intent.id=s.intent_id
 JOIN public."order" o ON o."tenantId"=s.tenant_id AND o.id=i.order_id AND o."intentId"=s.intent_id
 JOIN ctp_execution.progress progress ON progress."tenantId"=s.tenant_id AND progress."orderId"=o.id
 WHERE s.tenant_id=t AND s.idempotency_key=p->>'key' AND o."accountId"=s.account_id
  AND o.mode='PAPER' AND o.status='CREATED' AND o.version=0 AND o."filledQuantity"=0
  AND o."reconciliationState"='REQUIRED' AND o."exchangeOrderId" IS NULL AND o."terminalAt" IS NULL
  AND o."averageFillPrice"=0 AND o."lastExchangeAt" IS NULL AND o."updatedAt"=o."createdAt"
  AND progress."nativeAt" IS NULL AND progress."nativeHash" IS NULL AND progress."nativeStatus" IS NULL
  AND c.document_text::jsonb #> '{source,request,authorization}' IS NOT DISTINCT FROM p #> '{source,authorization}'
  AND NOT EXISTS(SELECT 1 FROM ctp_paper.attempt_preparation a WHERE a.tenant_id=t AND a.intent_id=s.intent_id)
  AND NOT EXISTS(SELECT 1 FROM ctp_paper.attempt_start a WHERE a.tenant_id=t AND a.intent_id=s.intent_id)
  AND NOT EXISTS(SELECT 1 FROM public.submission_attempt a WHERE a."tenantId"=t AND a."orderId"=o.id)
  AND NOT EXISTS(SELECT 1 FROM ctp_execution.evidence a WHERE a."tenantId"=t AND a."orderId"=o.id)
  AND NOT EXISTS(SELECT 1 FROM ctp_execution.authoritative_event a WHERE a."tenantId"=t AND a."orderId"=o.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_ADMISSION_EVIDENCE'; END IF;

 SELECT to_jsonb(q) INTO STRICT evidence FROM ctp_paper.derive_postexecution_risk(captured) q;
 RETURN facts||jsonb_build_object('evidence',evidence);
END $$;

CREATE OR REPLACE FUNCTION ctp_paper.reconcile_admission(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p->>'kind'='PAPER_POSTEXECUTION_BASIS_READ' THEN RETURN ctp_paper.postexecution_basis(p); END IF;
 IF p->>'kind'='PAPER_POSTEXECUTION_READ' THEN RETURN ctp_paper.postexecution_reserve(p,true); END IF;
 RETURN ctp_paper.reconcile_admission_before_postexecution(p);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.postexecution_basis(jsonb) FROM PUBLIC,ctp_paper_risk_admission;

COMMIT;
