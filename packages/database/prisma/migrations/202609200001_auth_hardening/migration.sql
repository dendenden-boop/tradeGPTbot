-- PHASE 3 hardening. Published migrations 001-004 remain immutable.
BEGIN;

-- Runtime roles do not need temporary objects. PUBLIC's database-level default
-- otherwise grants TEMP even when every application schema rejects CREATE.
DO $$
BEGIN
 EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC',current_database());
END $$;

GRANT CREATE ON SCHEMA ctp_auth TO ctp_auth_owner;

CREATE FUNCTION ctp_auth._require_read_committed() RETURNS void
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN
   RAISE EXCEPTION 'Authentication requires read committed isolation' USING ERRCODE='25001';
 END IF;
END $$;

-- Every token-driven entrypoint already calls this private helper before accepting
-- input or looking up state. The transaction guard is deliberately VOLATILE:
-- authentication must never reuse a caller's historical transaction snapshot.
-- credentials(), the only non-token authentication entrypoint, checks explicitly.
CREATE OR REPLACE FUNCTION ctp_auth._hash_valid(p_hash bytea) RETURNS boolean
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
BEGIN
 PERFORM ctp_auth._require_read_committed();
 RETURN coalesce(octet_length(p_hash)=32,false);
END $$;

CREATE OR REPLACE FUNCTION ctp_auth.credentials(p_email text)
 RETURNS TABLE ("userId" uuid,"passwordHash" text,"sessionEpoch" integer,"requiresMfa" boolean)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM ctp_auth._require_read_committed();
 RETURN QUERY SELECT u.id,u."passwordHash"::text,u."sessionEpoch",ctp_auth._requires_mfa(u.id,u.role)
 FROM public."user" u WHERE u."emailNormalized"=p_email AND u.status='ACTIVE'
   AND u."emailVerifiedAt" IS NOT NULL AND u."passwordHash" IS NOT NULL;
END $$;

-- Security-changing operations retain the same User -> session lock order.
-- Concurrent touches recheck lastSeenAt after both locks, so only one writes.
CREATE OR REPLACE FUNCTION ctp_auth._resolve_session(p_hash bytea,p_touch boolean) RETURNS public.user_session
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE v_user public."user"; v_session public.user_session; v_tenant uuid; v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RETURN NULL; END IF;
 SELECT s."tenantId" INTO v_tenant FROM public.user_session s WHERE s."tokenHash"=p_hash;
 IF v_tenant IS NULL THEN RETURN NULL; END IF;
 SELECT u.* INTO v_user FROM public."user" u WHERE u.id=v_tenant FOR UPDATE;
 SELECT s.* INTO v_session FROM public.user_session s WHERE s."tokenHash"=p_hash FOR UPDATE;
 v_now:=clock_timestamp();
 IF v_session.id IS NULL OR v_user.status<>'ACTIVE' OR v_user."emailVerifiedAt" IS NULL
   OR ctp_auth._requires_mfa(v_user.id,v_user.role) OR v_session."revokedAt" IS NOT NULL
   OR v_session."sessionEpoch"<>v_user."sessionEpoch" OR v_session."expiresAt"<=v_now
   OR v_session."idleExpiresAt"<=v_now THEN RETURN NULL; END IF;
 IF p_touch AND v_session."lastSeenAt" <= v_now-interval '5 minutes' THEN
   UPDATE public.user_session SET "lastSeenAt"=v_now,"idleExpiresAt"=least("expiresAt",v_now+interval '30 minutes')
     WHERE id=v_session.id RETURNING * INTO v_session;
 END IF;
 RETURN v_session;
END $$;

CREATE OR REPLACE FUNCTION ctp_auth.authenticate(p_hash bytea) RETURNS SETOF ctp_auth.principal
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_principal ctp_auth.principal; v_session public.user_session; v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RETURN; END IF;
 v_now:=clock_timestamp();
 -- One fresh READ COMMITTED snapshot contains the session, User, epoch and MFA.
 -- Reads overlapping an uncommitted transition may finish at this snapshot;
 -- any later authentication observes its commit. No state changes on this path.
 SELECT u.id,u."emailNormalized"::text,u.role::text,s.id,s."createdAt",s."lastSeenAt",s."idleExpiresAt",s."expiresAt"
 INTO v_principal
 FROM public.user_session s JOIN public."user" u ON u.id=s."tenantId"
 WHERE s."tokenHash"=p_hash AND u.status='ACTIVE' AND u."emailVerifiedAt" IS NOT NULL
   AND u.role='USER' AND s."revokedAt" IS NULL AND s."sessionEpoch"=u."sessionEpoch"
   AND s."expiresAt">v_now AND s."idleExpiresAt">v_now
   AND NOT EXISTS (SELECT 1 FROM public.two_factor_config f WHERE f."tenantId"=u.id AND f."enabledAt" IS NOT NULL AND f."revokedAt" IS NULL);
 v_now:=clock_timestamp();
 IF v_principal."sessionId" IS NULL OR v_principal."expiresAt"<=v_now OR v_principal."idleExpiresAt"<=v_now THEN RETURN; END IF;
 IF v_principal."lastSeenAt">v_now-interval '5 minutes' THEN
   RETURN NEXT v_principal;
 ELSE
   -- A touch must serialize with reset, logout-all, revoke and MFA/status writers.
   v_session:=ctp_auth._resolve_session(p_hash,true);
   IF v_session.id IS NOT NULL THEN RETURN NEXT ctp_auth._principal(v_session); END IF;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION ctp_auth.list_sessions(p_hash bytea) RETURNS SETOF ctp_auth.session_summary
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RETURN; END IF;
 v_now:=clock_timestamp();
 -- Authorizing session and the listed sessions are checked in the same snapshot.
 RETURN QUERY SELECT s.id,s."createdAt",s."lastSeenAt",s."idleExpiresAt",s."expiresAt"
 FROM public.user_session current_session
 JOIN public."user" u ON u.id=current_session."tenantId"
 JOIN public.user_session s ON s."tenantId"=u.id
 WHERE current_session."tokenHash"=p_hash AND current_session."revokedAt" IS NULL
   AND current_session."expiresAt">v_now AND current_session."idleExpiresAt">v_now
   AND current_session."sessionEpoch"=u."sessionEpoch"
   AND u.status='ACTIVE' AND u."emailVerifiedAt" IS NOT NULL AND u.role='USER'
   AND NOT EXISTS (SELECT 1 FROM public.two_factor_config f WHERE f."tenantId"=u.id AND f."enabledAt" IS NOT NULL AND f."revokedAt" IS NULL)
   AND s."revokedAt" IS NULL AND s."sessionEpoch"=u."sessionEpoch"
   AND s."expiresAt">v_now AND s."idleExpiresAt">v_now
 ORDER BY s."createdAt" DESC,s.id LIMIT 100;
END $$;

CREATE OR REPLACE FUNCTION ctp_auth.signup(p_email text,p_password text,p_verification bytea) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid; v_now timestamptz:=clock_timestamp();
BEGIN
 IF NOT ctp_auth._hash_valid(p_verification) OR NOT ctp_auth._password_valid(p_password)
   OR p_email IS NULL OR length(p_email) NOT BETWEEN 4 AND 254 OR p_email<>lower(btrim(p_email))
   OR p_email ~ '[[:cntrl:]]'
   OR length(split_part(p_email,'@',1))>64
   OR p_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
   RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023';
 END IF;
 INSERT INTO public."user" ("emailNormalized","passwordHash",status,role,"updatedAt","createdAt")
   VALUES (p_email,p_password,'PENDING_VERIFICATION','USER',v_now,v_now)
   ON CONFLICT ("emailNormalized") DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN RETURN false; END IF;
 INSERT INTO public.email_verification_token ("tenantId","tokenHash","emailNormalized","expiresAt","createdAt")
   VALUES (v_id,p_verification,p_email,v_now+interval '30 minutes',v_now);
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION ctp_auth.issue_verification(p_email text,p_hash bytea) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user public."user"; v_now timestamptz; v_count bigint; v_latest timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023'; END IF;
 SELECT u.* INTO v_user FROM public."user" u WHERE u."emailNormalized"=p_email FOR UPDATE;
 IF v_user.id IS NULL OR v_user.status<>'PENDING_VERIFICATION' THEN RETURN false; END IF;
 v_now:=clock_timestamp();
 SELECT count(*),max(t."createdAt") INTO v_count,v_latest
 FROM public.email_verification_token t WHERE t."tenantId"=v_user.id AND t."consumedAt" IS NULL
   AND t."expiresAt">v_now AND t."emailNormalized"=v_user."emailNormalized";
 -- Never revoke or evict a still-valid delivered link on an unauthenticated resend.
 IF v_count>=3 OR v_latest>v_now-interval '60 seconds' THEN RETURN false; END IF;
 INSERT INTO public.email_verification_token ("tenantId","tokenHash","emailNormalized","expiresAt","createdAt")
   VALUES (v_user.id,p_hash,v_user."emailNormalized",v_now+interval '30 minutes',v_now);
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION ctp_auth.issue_password_reset(p_email text,p_hash bytea) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user public."user"; v_now timestamptz; v_count bigint; v_latest timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023'; END IF;
 SELECT u.* INTO v_user FROM public."user" u WHERE u."emailNormalized"=p_email FOR UPDATE;
 IF v_user.id IS NULL OR v_user.status<>'ACTIVE' OR v_user."emailVerifiedAt" IS NULL THEN RETURN false; END IF;
 v_now:=clock_timestamp();
 SELECT count(*),max(t."createdAt") INTO v_count,v_latest
 FROM public.password_reset_token t WHERE t."tenantId"=v_user.id AND t."consumedAt" IS NULL
   AND t."expiresAt">v_now AND t."sessionEpoch"=v_user."sessionEpoch";
 IF v_count>=3 OR v_latest>v_now-interval '60 seconds' THEN RETURN false; END IF;
 INSERT INTO public.password_reset_token ("tenantId","tokenHash","sessionEpoch","expiresAt","createdAt")
   VALUES (v_user.id,p_hash,v_user."sessionEpoch",v_now+interval '15 minutes',v_now);
 RETURN true;
END $$;

-- Existing row projections use all current columns; enumerate these explicitly
-- so future columns receive no implicit access. Writes grant only fields used by
-- the current functions, never promotion, account deletion, step-up or secret data.
REVOKE SELECT,INSERT,UPDATE ON public."user",public.user_session,public.email_verification_token,public.password_reset_token FROM ctp_auth_owner;
GRANT SELECT (id,"emailNormalized","passwordHash",status,role,"emailVerifiedAt","passwordChangedAt","sessionEpoch","deletionRequestedAt","pseudonymizedAt","updatedAt","createdAt"),
 INSERT ("emailNormalized","passwordHash",status,role,"updatedAt","createdAt"),
 UPDATE (status,"emailVerifiedAt","updatedAt","passwordHash","passwordChangedAt","sessionEpoch") ON public."user" TO ctp_auth_owner;
GRANT SELECT (id,"tenantId","tokenHash","expiresAt","idleExpiresAt","lastSeenAt","revokedAt","stepUpAt","sessionEpoch","userAgentHash","ipPrefixHash","createdAt"),
 INSERT ("tenantId","tokenHash","sessionEpoch","createdAt","lastSeenAt","expiresAt","idleExpiresAt"),
 UPDATE ("lastSeenAt","idleExpiresAt","revokedAt") ON public.user_session TO ctp_auth_owner;
GRANT SELECT (id,"tenantId","tokenHash","emailNormalized","expiresAt","consumedAt","createdAt"),
 INSERT ("tenantId","tokenHash","emailNormalized","expiresAt","createdAt"),
 UPDATE ("consumedAt") ON public.email_verification_token TO ctp_auth_owner;
GRANT SELECT (id,"tenantId","tokenHash","sessionEpoch","expiresAt","consumedAt","createdAt"),
 INSERT ("tenantId","tokenHash","sessionEpoch","expiresAt","createdAt"),
 UPDATE ("consumedAt") ON public.password_reset_token TO ctp_auth_owner;

CREATE OR REPLACE FUNCTION ctp_auth.schema_version() RETURNS integer
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN to_regprocedure('ctp_auth._require_read_committed()') IS NOT NULL
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.user'::regclass AND attname='role' AND NOT attisdropped)
   AND (SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN ('public.user'::regclass,'public.user_session'::regclass,'public.email_verification_token'::regclass,'public.password_reset_token'::regclass,'public.two_factor_config'::regclass,'public.live_grant'::regclass) AND relrowsecurity AND relforcerowsecurity)=6
   THEN 5 ELSE 0 END
$$;

ALTER FUNCTION ctp_auth._require_read_committed() OWNER TO ctp_auth_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ctp_auth FROM PUBLIC;
REVOKE CREATE ON SCHEMA ctp_auth FROM ctp_auth_owner;
COMMIT;
