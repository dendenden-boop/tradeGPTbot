BEGIN;
-- Conservative content history only. No role gains publication/read authority.
-- Original allocations and the shared parent remain immutable; no inferred state
-- is backfilled. This is not a financial writer or a source certification.
CREATE TABLE ctp_paper.reservation_state_event (
 tenant_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 intent_id uuid NOT NULL,
 account_id uuid NOT NULL,
 mode public."TradingMode" NOT NULL CHECK(mode='PAPER'),
 event_id uuid NOT NULL,
 revision smallint NOT NULL,
 status text NOT NULL,
 observed_ms bigint NOT NULL CHECK(observed_ms BETWEEN 0 AND 8640000000000000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,reservation_id,revision),
 UNIQUE(tenant_id,event_id),
 CHECK((revision=1 AND status='ACTIVE') OR (revision=2 AND status='UNKNOWN')),
 FOREIGN KEY(tenant_id,reservation_id,intent_id,account_id,mode)
  REFERENCES public.risk_reservation("tenantId",id,"intentId","accountId",mode)
  ON UPDATE RESTRICT ON DELETE RESTRICT
);
ALTER TABLE ctp_paper.reservation_state_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctp_paper.reservation_state_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ctp_paper.reservation_state_event
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON ctp_paper.reservation_state_event FROM PUBLIC;
CREATE TRIGGER reservation_state_immutable BEFORE UPDATE OR DELETE ON ctp_paper.reservation_state_event
 FOR EACH ROW EXECUTE FUNCTION public.ctp_immutable_row();
CREATE TRIGGER reservation_state_no_truncate BEFORE TRUNCATE ON ctp_paper.reservation_state_event
 FOR EACH STATEMENT EXECUTE FUNCTION public.ctp_immutable_row();

CREATE FUNCTION ctp_paper.check_reservation_state() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.risk_reservation%ROWTYPE;
 previous ctp_paper.reservation_state_event%ROWTYPE;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_SCOPE' USING ERRCODE='23514';
 END IF;
 -- This is storage serialization, not the GLOBAL/tenant/account Risk lock set.
 -- A future certified writer must acquire the full shared lock order first.
 SELECT * INTO r FROM public.risk_reservation
  WHERE "tenantId"=NEW.tenant_id AND id=NEW.reservation_id FOR UPDATE;
 IF NOT FOUND OR r.mode<>'PAPER' OR r."paperLegacy" OR r."vectorSize" IS NULL
  OR ROW(NEW.intent_id,NEW.account_id,NEW.mode) IS DISTINCT FROM ROW(r."intentId",r."accountId",r.mode)
  OR (SELECT count(*) FROM ctp_paper.reservation_debit WHERE tenant_id=r."tenantId" AND reservation_id=r.id)<>r."vectorSize" THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_SCOPE' USING ERRCODE='23514';
 END IF;
 IF NEW.observed_ms IS NULL OR NEW.observed_ms<0 OR NEW.observed_ms>8640000000000000
  OR NEW.observed_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_INPUT' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM ctp_paper.reservation_state_event
  WHERE tenant_id=NEW.tenant_id AND reservation_id=NEW.reservation_id ORDER BY revision DESC LIMIT 1;
 IF FOUND THEN
  IF previous.revision<>1 OR NEW.revision IS DISTINCT FROM 2::smallint
   OR NEW.status IS DISTINCT FROM 'UNKNOWN' OR NEW.observed_ms<=previous.observed_ms THEN
   RAISE EXCEPTION 'PAPER_RESERVATION_STATE_ORDERING' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.revision IS DISTINCT FROM 1::smallint OR NEW.status IS DISTINCT FROM 'ACTIVE'
   OR NEW.observed_ms<floor(extract(epoch FROM r."createdAt")*1000)::bigint THEN
   RAISE EXCEPTION 'PAPER_RESERVATION_STATE_ORDERING' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reservation_state_ordering BEFORE INSERT ON ctp_paper.reservation_state_event
 FOR EACH ROW EXECUTE FUNCTION ctp_paper.check_reservation_state();

-- Private owner-only storage primitive, never an accepted runtime API/grant.
-- The receipt describes that immutable event, not the current state. Exact old
-- replay remains valid after a newer UNKNOWN and never overwrites its watermark.
CREATE FUNCTION ctp_paper.append_reservation_state(
 p_tenant uuid,p_reservation uuid,p_event uuid,p_expected bigint,p_status text,p_observed bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE event ctp_paper.reservation_state_event%ROWTYPE;
 parent public.risk_reservation%ROWTYPE;
BEGIN
 IF p_tenant IS NULL OR p_reservation IS NULL OR p_event IS NULL OR p_expected IS NULL
  OR p_expected<0 OR p_expected>2 OR p_status IS NULL OR p_status NOT IN('ACTIVE','UNKNOWN')
  OR p_observed IS NULL OR p_observed<0 OR p_observed>8640000000000000 THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_INPUT' USING ERRCODE='23514';
 END IF;
 IF p_tenant IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_SCOPE' USING ERRCODE='23514';
 END IF;
 SELECT * INTO event FROM ctp_paper.reservation_state_event WHERE tenant_id=p_tenant AND event_id=p_event;
 IF NOT FOUND THEN
  SELECT * INTO parent FROM public.risk_reservation WHERE "tenantId"=p_tenant AND id=p_reservation FOR UPDATE;
  IF NOT FOUND OR parent.mode<>'PAPER' OR parent."paperLegacy" OR parent."vectorSize" IS NULL THEN
   RAISE EXCEPTION 'PAPER_RESERVATION_STATE_SCOPE' USING ERRCODE='23514';
  END IF;
  -- Reread after the parent lock: an exact concurrent replay may now exist.
  SELECT * INTO event FROM ctp_paper.reservation_state_event WHERE tenant_id=p_tenant AND event_id=p_event;
  IF NOT FOUND THEN
   INSERT INTO ctp_paper.reservation_state_event(tenant_id,reservation_id,intent_id,account_id,mode,event_id,revision,status,observed_ms)
    VALUES(p_tenant,p_reservation,parent."intentId",parent."accountId",'PAPER',p_event,(p_expected+1)::smallint,p_status,p_observed)
    ON CONFLICT(tenant_id,event_id) DO NOTHING RETURNING * INTO event;
   IF NOT FOUND THEN
    -- A different parent can race the same permanent tenant/event key. Do not
    -- retry publication; reconcile its immutable row in this transaction.
    SELECT * INTO event FROM ctp_paper.reservation_state_event WHERE tenant_id=p_tenant AND event_id=p_event;
   END IF;
  END IF;
 END IF;
 IF event.event_id IS NULL OR ROW(event.reservation_id,event.revision::bigint,event.status,event.observed_ms)
  IS DISTINCT FROM ROW(p_reservation,p_expected+1,p_status,p_observed) THEN
  RAISE EXCEPTION 'PAPER_RESERVATION_STATE_CONFLICT' USING ERRCODE='23514';
 END IF;
 RETURN jsonb_build_object('kind','PAPER_RESERVATION_STATE_RECORD','tenantId',event.tenant_id,
  'reservationId',event.reservation_id,'intentId',event.intent_id,'accountId',event.account_id,
  'mode',event.mode,'eventId',event.event_id,'revision',event.revision::text,'status',event.status,'observedAt',event.observed_ms::text);
END $$;
REVOKE ALL ON FUNCTION ctp_paper.check_reservation_state(),ctp_paper.append_reservation_state(uuid,uuid,uuid,bigint,text,bigint) FROM PUBLIC;
COMMIT;
