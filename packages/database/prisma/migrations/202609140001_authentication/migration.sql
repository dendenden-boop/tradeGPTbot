-- PHASE 3: a narrow pre-tenant authentication boundary, PostgreSQL 17.
BEGIN;

CREATE TYPE public."UserRole" AS ENUM ('USER','ADMIN');
ALTER TABLE public."user" ADD COLUMN role public."UserRole" NOT NULL DEFAULT 'USER';
GRANT SELECT (role) ON public."user" TO ctp_api;

DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['ctp_auth','ctp_auth_owner'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
      IF role_name='ctp_auth_owner' THEN
        EXECUTE format('GRANT ctp_auth_owner TO %I',current_user);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin OR rolreplication)) THEN
      RAISE EXCEPTION 'Existing authentication role has unsafe privileges';
    END IF;
    -- These are dedicated capability groups, never members of other roles.
    -- A function owner inheriting e.g. a signer role would bypass the intended column grants.
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=role_name) THEN
      RAISE EXCEPTION 'Authentication role must not inherit another role';
    END IF;
  END LOOP;
  IF NOT pg_has_role(current_user,'ctp_auth_owner','SET') THEN
    RAISE EXCEPTION 'Migration owner requires SET membership in ctp_auth_owner';
  END IF;
  IF pg_has_role('ctp_auth','ctp_auth_owner','MEMBER') OR pg_has_role('ctp_api','ctp_auth_owner','MEMBER') THEN
    RAISE EXCEPTION 'Runtime role must not inherit authentication function ownership';
  END IF;
END $$;

CREATE SCHEMA ctp_auth;
REVOKE ALL ON SCHEMA ctp_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA ctp_auth TO ctp_auth,ctp_auth_owner;
-- CREATE is needed for ownership transfer; revoked before commit.
GRANT CREATE ON SCHEMA ctp_auth TO ctp_auth_owner;
GRANT USAGE ON SCHEMA public TO ctp_auth_owner;
GRANT SELECT,INSERT,UPDATE ON public."user",public.user_session,public.email_verification_token,public.password_reset_token TO ctp_auth_owner;
GRANT SELECT ("tenantId","enabledAt","revokedAt") ON public.two_factor_config TO ctp_auth_owner;
GRANT SELECT ("tenantId","revokedAt","createdAt"), UPDATE ("revokedAt") ON public.live_grant TO ctp_auth_owner;

CREATE POLICY authentication_boundary ON public."user" TO ctp_auth_owner USING (true) WITH CHECK (true);
CREATE POLICY authentication_boundary ON public.user_session TO ctp_auth_owner USING (true) WITH CHECK (true);
CREATE POLICY authentication_boundary ON public.email_verification_token TO ctp_auth_owner USING (true) WITH CHECK (true);
CREATE POLICY authentication_boundary ON public.password_reset_token TO ctp_auth_owner USING (true) WITH CHECK (true);
CREATE POLICY authentication_boundary ON public.two_factor_config TO ctp_auth_owner USING (true);
CREATE POLICY authentication_boundary ON public.live_grant TO ctp_auth_owner USING (true) WITH CHECK (true);

CREATE TYPE ctp_auth.principal AS (
  "userId" uuid,"emailNormalized" text,role text,"sessionId" uuid,
  "createdAt" timestamptz,"lastSeenAt" timestamptz,"idleExpiresAt" timestamptz,"expiresAt" timestamptz
);
CREATE TYPE ctp_auth.session_summary AS (
  "sessionId" uuid,"createdAt" timestamptz,"lastSeenAt" timestamptz,"idleExpiresAt" timestamptz,"expiresAt" timestamptz
);

CREATE FUNCTION ctp_auth._hash_valid(p_hash bytea) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT coalesce(octet_length(p_hash)=32,false) $$;
CREATE FUNCTION ctp_auth._password_valid(p_hash text) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(length(p_hash) BETWEEN 32 AND 512 AND p_hash LIKE '$argon2id$v=19$%',false)
$$;
CREATE FUNCTION ctp_auth._requires_mfa(p_user uuid,p_role public."UserRole") RETURNS boolean
 -- A fresh snapshot is required after waiting for the User lock held by an MFA writer.
 LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT p_role='ADMIN' OR EXISTS (SELECT 1 FROM public.two_factor_config f WHERE f."tenantId"=p_user AND f."enabledAt" IS NOT NULL AND f."revokedAt" IS NULL)
$$;
CREATE FUNCTION ctp_auth._principal(p_session public.user_session) RETURNS ctp_auth.principal
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ROW(u.id,u."emailNormalized"::text,u.role::text,(p_session).id,(p_session)."createdAt",(p_session)."lastSeenAt",(p_session)."idleExpiresAt",(p_session)."expiresAt")::ctp_auth.principal
 FROM public."user" u WHERE u.id=(p_session)."tenantId"
$$;

-- Every session operation locks User first. Future MFA/status writers must use this same order.
CREATE FUNCTION ctp_auth._resolve_session(p_hash bytea,p_touch boolean) RETURNS public.user_session
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
 IF p_touch THEN
   UPDATE public.user_session SET "lastSeenAt"=v_now,"idleExpiresAt"=least("expiresAt",v_now+interval '30 minutes')
     WHERE id=v_session.id RETURNING * INTO v_session;
 END IF;
 RETURN v_session;
END $$;

CREATE FUNCTION ctp_auth.signup(p_email text,p_password text,p_verification bytea) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid; v_now timestamptz:=clock_timestamp();
BEGIN
 IF NOT ctp_auth._hash_valid(p_verification) OR NOT ctp_auth._password_valid(p_password)
   OR p_email IS NULL OR length(p_email) NOT BETWEEN 4 AND 254 OR p_email<>lower(btrim(p_email))
   OR p_email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' THEN
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

CREATE FUNCTION ctp_auth.issue_verification(p_email text,p_hash bytea) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user public."user"; v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023'; END IF;
 SELECT u.* INTO v_user FROM public."user" u WHERE u."emailNormalized"=p_email FOR UPDATE;
 IF v_user.id IS NULL OR v_user.status<>'PENDING_VERIFICATION' THEN RETURN false; END IF;
 v_now:=clock_timestamp();
 UPDATE public.email_verification_token SET "consumedAt"=v_now WHERE "tenantId"=v_user.id AND "consumedAt" IS NULL;
 INSERT INTO public.email_verification_token ("tenantId","tokenHash","emailNormalized","expiresAt","createdAt")
   VALUES (v_user.id,p_hash,v_user."emailNormalized",v_now+interval '30 minutes',v_now);
 RETURN true;
END $$;

CREATE FUNCTION ctp_auth.verify_email(p_hash bytea) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_tenant uuid; v_user public."user"; v_token public.email_verification_token; v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RETURN false; END IF;
 SELECT t."tenantId" INTO v_tenant FROM public.email_verification_token t WHERE t."tokenHash"=p_hash;
 IF v_tenant IS NULL THEN RETURN false; END IF;
 SELECT u.* INTO v_user FROM public."user" u WHERE u.id=v_tenant FOR UPDATE;
 SELECT t.* INTO v_token FROM public.email_verification_token t WHERE t."tokenHash"=p_hash FOR UPDATE;
 v_now:=clock_timestamp();
 IF v_user.status<>'PENDING_VERIFICATION' OR v_token.id IS NULL OR v_token."consumedAt" IS NOT NULL
   OR v_token."expiresAt"<=v_now OR v_token."emailNormalized"<>v_user."emailNormalized" THEN RETURN false; END IF;
 UPDATE public.email_verification_token SET "consumedAt"=v_now WHERE "tenantId"=v_tenant AND "consumedAt" IS NULL;
 UPDATE public."user" SET status='ACTIVE',"emailVerifiedAt"=v_now,"updatedAt"=v_now WHERE id=v_tenant;
 RETURN true;
END $$;

CREATE FUNCTION ctp_auth.credentials(p_email text)
 RETURNS TABLE ("userId" uuid,"passwordHash" text,"sessionEpoch" integer,"requiresMfa" boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u."passwordHash"::text,u."sessionEpoch",ctp_auth._requires_mfa(u.id,u.role)
 FROM public."user" u WHERE u."emailNormalized"=p_email AND u.status='ACTIVE'
   AND u."emailVerifiedAt" IS NOT NULL AND u."passwordHash" IS NOT NULL
$$;

CREATE FUNCTION ctp_auth.create_session(p_user uuid,p_password text,p_epoch integer,p_hash bytea,p_previous bytea DEFAULT NULL)
 RETURNS SETOF ctp_auth.principal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user public."user"; v_session public.user_session; v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) OR (p_previous IS NOT NULL AND NOT ctp_auth._hash_valid(p_previous)) THEN
   RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023';
 END IF;
 SELECT u.* INTO v_user FROM public."user" u WHERE u.id=p_user FOR UPDATE;
 IF v_user.id IS NULL OR v_user.status<>'ACTIVE' OR v_user."emailVerifiedAt" IS NULL
   OR v_user."passwordHash" IS DISTINCT FROM p_password OR v_user."sessionEpoch" IS DISTINCT FROM p_epoch
   OR ctp_auth._requires_mfa(v_user.id,v_user.role) THEN RETURN; END IF;
 v_now:=clock_timestamp();
 -- Login replaces only a prior session of this user; another user's token cannot revoke it.
 UPDATE public.user_session SET "revokedAt"=v_now WHERE "tenantId"=p_user AND "tokenHash"=p_previous AND "revokedAt" IS NULL;
 INSERT INTO public.user_session ("tenantId","tokenHash","sessionEpoch","createdAt","lastSeenAt","expiresAt","idleExpiresAt")
   VALUES (p_user,p_hash,p_epoch,v_now,v_now,v_now+interval '12 hours',v_now+interval '30 minutes') RETURNING * INTO v_session;
 RETURN NEXT ctp_auth._principal(v_session);
END $$;

CREATE FUNCTION ctp_auth.authenticate(p_hash bytea) RETURNS SETOF ctp_auth.principal
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_session public.user_session;
BEGIN
 v_session:=ctp_auth._resolve_session(p_hash,true);
 IF v_session.id IS NOT NULL THEN RETURN NEXT ctp_auth._principal(v_session); END IF;
END $$;

CREATE FUNCTION ctp_auth.rotate_session(p_hash bytea,p_new_hash bytea) RETURNS SETOF ctp_auth.principal
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_session public.user_session; v_new public.user_session; v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_new_hash) OR p_hash=p_new_hash THEN RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023'; END IF;
 v_session:=ctp_auth._resolve_session(p_hash,false);
 IF v_session.id IS NULL THEN RETURN; END IF;
 v_now:=clock_timestamp();
 UPDATE public.user_session SET "revokedAt"=v_now WHERE id=v_session.id;
 INSERT INTO public.user_session ("tenantId","tokenHash","sessionEpoch","createdAt","lastSeenAt","expiresAt","idleExpiresAt")
   VALUES (v_session."tenantId",p_new_hash,v_session."sessionEpoch",v_now,v_now,v_session."expiresAt",least(v_session."expiresAt",v_now+interval '30 minutes')) RETURNING * INTO v_new;
 RETURN NEXT ctp_auth._principal(v_new);
END $$;

CREATE FUNCTION ctp_auth.logout(p_hash bytea) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_tenant uuid;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RETURN; END IF;
 SELECT s."tenantId" INTO v_tenant FROM public.user_session s WHERE s."tokenHash"=p_hash;
 PERFORM 1 FROM public."user" WHERE id=v_tenant FOR UPDATE;
 UPDATE public.user_session SET "revokedAt"=clock_timestamp() WHERE "tokenHash"=p_hash AND "revokedAt" IS NULL;
END $$;

CREATE FUNCTION ctp_auth.list_sessions(p_hash bytea) RETURNS SETOF ctp_auth.session_summary
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_session public.user_session;
BEGIN
 v_session:=ctp_auth._resolve_session(p_hash,false);
 IF v_session.id IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT s.id,s."createdAt",s."lastSeenAt",s."idleExpiresAt",s."expiresAt"
   FROM public.user_session s WHERE s."tenantId"=v_session."tenantId" AND s."revokedAt" IS NULL
   AND s."sessionEpoch"=v_session."sessionEpoch" AND s."expiresAt">clock_timestamp() AND s."idleExpiresAt">clock_timestamp()
   ORDER BY s."createdAt" DESC,s.id LIMIT 100;
END $$;

CREATE FUNCTION ctp_auth.revoke_session(p_hash bytea,p_session uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_session public.user_session;
BEGIN
 v_session:=ctp_auth._resolve_session(p_hash,false);
 IF v_session.id IS NULL THEN RETURN false; END IF;
 UPDATE public.user_session SET "revokedAt"=clock_timestamp() WHERE id=p_session AND "tenantId"=v_session."tenantId" AND "revokedAt" IS NULL;
 RETURN FOUND;
END $$;

CREATE FUNCTION ctp_auth.revoke_all_sessions(p_hash bytea) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_session public.user_session; v_now timestamptz;
BEGIN
 v_session:=ctp_auth._resolve_session(p_hash,false);
 IF v_session.id IS NULL THEN RETURN; END IF;
 v_now:=clock_timestamp();
 UPDATE public."user" SET "sessionEpoch"="sessionEpoch"+1,"updatedAt"=v_now WHERE id=v_session."tenantId";
 UPDATE public.user_session SET "revokedAt"=v_now WHERE "tenantId"=v_session."tenantId" AND "revokedAt" IS NULL;
END $$;

CREATE FUNCTION ctp_auth.issue_password_reset(p_email text,p_hash bytea) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user public."user"; v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) THEN RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023'; END IF;
 SELECT u.* INTO v_user FROM public."user" u WHERE u."emailNormalized"=p_email FOR UPDATE;
 IF v_user.id IS NULL OR v_user.status<>'ACTIVE' OR v_user."emailVerifiedAt" IS NULL THEN RETURN false; END IF;
 v_now:=clock_timestamp();
 UPDATE public.password_reset_token SET "consumedAt"=v_now WHERE "tenantId"=v_user.id AND "consumedAt" IS NULL;
 INSERT INTO public.password_reset_token ("tenantId","tokenHash","sessionEpoch","expiresAt","createdAt")
   VALUES (v_user.id,p_hash,v_user."sessionEpoch",v_now+interval '15 minutes',v_now);
 RETURN true;
END $$;

CREATE FUNCTION ctp_auth._replace_password(p_user uuid,p_password text,p_now timestamptz) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 UPDATE public."user" SET "passwordHash"=p_password,"passwordChangedAt"=p_now,"sessionEpoch"="sessionEpoch"+1,"updatedAt"=p_now WHERE id=p_user;
 UPDATE public.user_session SET "revokedAt"=p_now WHERE "tenantId"=p_user AND "revokedAt" IS NULL;
 UPDATE public.password_reset_token SET "consumedAt"=p_now WHERE "tenantId"=p_user AND "consumedAt" IS NULL;
 UPDATE public.live_grant SET "revokedAt"=p_now WHERE "tenantId"=p_user AND "revokedAt" IS NULL;
END $$;

CREATE FUNCTION ctp_auth.reset_password(p_hash bytea,p_password text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_tenant uuid; v_user public."user"; v_token public.password_reset_token; v_now timestamptz;
BEGIN
 IF NOT ctp_auth._hash_valid(p_hash) OR NOT ctp_auth._password_valid(p_password) THEN RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023'; END IF;
 SELECT t."tenantId" INTO v_tenant FROM public.password_reset_token t WHERE t."tokenHash"=p_hash;
 IF v_tenant IS NULL THEN RETURN false; END IF;
 SELECT u.* INTO v_user FROM public."user" u WHERE u.id=v_tenant FOR UPDATE;
 SELECT t.* INTO v_token FROM public.password_reset_token t WHERE t."tokenHash"=p_hash FOR UPDATE;
 v_now:=clock_timestamp();
 IF v_token.id IS NULL OR v_user.status<>'ACTIVE' OR v_user."emailVerifiedAt" IS NULL
   OR v_token."consumedAt" IS NOT NULL OR v_token."expiresAt"<=v_now OR v_token."sessionEpoch"<>v_user."sessionEpoch" THEN RETURN false; END IF;
 PERFORM ctp_auth._replace_password(v_tenant,p_password,v_now);
 RETURN true;
END $$;

CREATE FUNCTION ctp_auth.change_password(p_hash bytea,p_expected text,p_password text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_session public.user_session;
BEGIN
 IF NOT ctp_auth._password_valid(p_password) THEN RAISE EXCEPTION 'Invalid authentication input' USING ERRCODE='22023'; END IF;
 v_session:=ctp_auth._resolve_session(p_hash,false);
 IF v_session.id IS NULL OR NOT EXISTS (SELECT 1 FROM public."user" WHERE id=v_session."tenantId" AND "passwordHash"=p_expected) THEN RETURN false; END IF;
 PERFORM ctp_auth._replace_password(v_session."tenantId",p_password,clock_timestamp());
 RETURN true;
END $$;

CREATE FUNCTION ctp_auth.schema_version() RETURNS integer
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.user'::regclass AND attname='role' AND NOT attisdropped)
   AND (SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN ('public.user'::regclass,'public.user_session'::regclass,'public.email_verification_token'::regclass,'public.password_reset_token'::regclass) AND relrowsecurity AND relforcerowsecurity)=4
   THEN 4 ELSE 0 END
$$;

DO $$
DECLARE v_function record;
BEGIN
 FOR v_function IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ctp_auth' LOOP
   EXECUTE format('ALTER FUNCTION %s OWNER TO ctp_auth_owner',v_function.signature);
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ctp_auth FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ctp_auth.signup(text,text,bytea),ctp_auth.issue_verification(text,bytea),ctp_auth.verify_email(bytea),ctp_auth.credentials(text),
 ctp_auth.create_session(uuid,text,integer,bytea,bytea),ctp_auth.authenticate(bytea),ctp_auth.rotate_session(bytea,bytea),ctp_auth.logout(bytea),
 ctp_auth.list_sessions(bytea),ctp_auth.revoke_session(bytea,uuid),ctp_auth.revoke_all_sessions(bytea),ctp_auth.issue_password_reset(text,bytea),
 ctp_auth.reset_password(bytea,text),ctp_auth.change_password(bytea,text,text),ctp_auth.schema_version() TO ctp_auth;
REVOKE CREATE ON SCHEMA ctp_auth FROM ctp_auth_owner;
COMMIT;
