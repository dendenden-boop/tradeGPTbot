// Static SQL only. These are the exact migration-005 grants, not request input.
// Checking effective privileges also catches grants through otherwise harmless roles.
export const unsafeAuthOwnerPrivileges = `
  has_database_privilege('ctp_auth_owner',current_database(),'TEMP,CREATE')
  OR has_schema_privilege('ctp_auth_owner','public','CREATE')
  OR has_schema_privilege('ctp_auth_owner','ctp_auth','CREATE')
  OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN (VALUES
      ('user',
        ARRAY['id','emailNormalized','passwordHash','status','role','emailVerifiedAt','passwordChangedAt','sessionEpoch','deletionRequestedAt','pseudonymizedAt','updatedAt','createdAt'],
        ARRAY['emailNormalized','passwordHash','status','role','updatedAt','createdAt'],
        ARRAY['status','emailVerifiedAt','updatedAt','passwordHash','passwordChangedAt','sessionEpoch']),
      ('user_session',
        ARRAY['id','tenantId','tokenHash','expiresAt','idleExpiresAt','lastSeenAt','revokedAt','stepUpAt','sessionEpoch','userAgentHash','ipPrefixHash','createdAt'],
        ARRAY['tenantId','tokenHash','sessionEpoch','createdAt','lastSeenAt','expiresAt','idleExpiresAt'],
        ARRAY['lastSeenAt','idleExpiresAt','revokedAt']),
      ('email_verification_token',
        ARRAY['id','tenantId','tokenHash','emailNormalized','expiresAt','consumedAt','createdAt'],
        ARRAY['tenantId','tokenHash','emailNormalized','expiresAt','createdAt'],
        ARRAY['consumedAt']),
      ('password_reset_token',
        ARRAY['id','tenantId','tokenHash','sessionEpoch','expiresAt','consumedAt','createdAt'],
        ARRAY['tenantId','tokenHash','sessionEpoch','expiresAt','createdAt'],
        ARRAY['consumedAt']),
      ('two_factor_config', ARRAY['tenantId','enabledAt','revokedAt'], ARRAY[]::text[], ARRAY[]::text[]),
      ('live_grant', ARRAY['tenantId','revokedAt','createdAt'], ARRAY[]::text[], ARRAY['revokedAt'])
    ) expected(table_name,read_columns,insert_columns,update_columns) ON expected.table_name=c.relname
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (
      has_table_privilege('ctp_auth_owner',c.oid,'DELETE,TRUNCATE,TRIGGER')
      OR has_column_privilege('ctp_auth_owner',c.oid,a.attnum,'REFERENCES')
      OR (has_column_privilege('ctp_auth_owner',c.oid,a.attnum,'SELECT')
        AND NOT coalesce(a.attname=ANY(expected.read_columns),false))
      OR (has_column_privilege('ctp_auth_owner',c.oid,a.attnum,'INSERT')
        AND NOT coalesce(a.attname=ANY(expected.insert_columns),false))
      OR (has_column_privilege('ctp_auth_owner',c.oid,a.attnum,'UPDATE')
        AND NOT coalesce(a.attname=ANY(expected.update_columns),false))
    )
  )
  OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_roles owner_role ON owner_role.oid=p.proowner
    WHERE n.nspname='ctp_auth' AND (
      owner_role.rolname<>'ctp_auth_owner'
      OR NOT coalesce(p.proconfig @> ARRAY['search_path=pg_catalog'],false)
      OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
      OR (left(p.proname,1)='_' AND has_function_privilege(current_user,p.oid,'EXECUTE'))
    )
  )`;
