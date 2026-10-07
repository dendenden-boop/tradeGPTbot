// Static SQL shared by both application pools. MEMBER also follows indirect
// and INHERIT FALSE grants: SET ROLE must not bypass the startup/readiness gate.
// PostgreSQL's pg_* roles include file/program access, monitoring and maintenance
// capabilities without the usual superuser attributes. None belongs to a
// request-serving login; custom grouping roles remain subject to the other
// effective privilege checks.
export const unsafeInheritedRolePrivileges = `EXISTS (
  SELECT 1 FROM pg_roles inherited
  WHERE (inherited.rolsuper OR inherited.rolbypassrls OR inherited.rolcreaterole
    OR inherited.rolcreatedb OR inherited.rolreplication OR left(inherited.rolname,3)='pg_')
    AND pg_has_role(current_user,inherited.oid,'MEMBER')
)`;

// API/Auth retain their existing exact public-column/owner checks. No new
// dependency from the foundational database package to Exchange Core is added.
export function unsafePrivateRuntimePrivileges(group: 'ctp_api' | 'ctp_auth'): string {
  const functions =
    group === 'ctp_auth'
      ? [
          'ctp_auth.signup(text,text,bytea)',
          'ctp_auth.issue_verification(text,bytea)',
          'ctp_auth.verify_email(bytea)',
          'ctp_auth.credentials(text)',
          'ctp_auth.create_session(uuid,text,integer,bytea,bytea)',
          'ctp_auth.authenticate(bytea)',
          'ctp_auth.rotate_session(bytea,bytea)',
          'ctp_auth.logout(bytea)',
          'ctp_auth.list_sessions(bytea)',
          'ctp_auth.revoke_session(bytea,uuid)',
          'ctp_auth.revoke_all_sessions(bytea)',
          'ctp_auth.issue_password_reset(text,bytea)',
          'ctp_auth.reset_password(bytea,text)',
          'ctp_auth.change_password(bytea,text,text)',
          'ctp_auth.schema_version()',
        ]
      : [];
  const tables =
    group === 'ctp_api'
      ? [
          'ctp_market.bar',
          'ctp_portfolio.book',
          'ctp_portfolio.evidence',
          'ctp_portfolio.outbox',
          'ctp_portfolio.hold_watermark',
        ]
      : [];
  // Catalog identity comparison works even for a rejected caller that has no
  // USAGE on the expected function schema; regprocedure input casts can throw
  // before returning the required role-denial result.
  const signatures = functions.map((f) => `'${f}'`).join(',');
  const names = tables.map((t) => `'${t}'`).join(',');
  return `
    NOT EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='${group}'
      AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
    OR EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname<>current_user AND x.rolname<>'${group}'
      AND pg_has_role(current_user,x.oid,'MEMBER')
      AND (x.rolcanlogin OR x.rolsuper OR x.rolbypassrls OR x.rolcreatedb OR x.rolcreaterole OR x.rolreplication
        OR NOT pg_has_role(current_user,x.oid,'USAGE')
        OR x.rolname IN('ctp_api','ctp_auth','ctp_auth_owner','ctp_signer','ctp_ingest','ctp_portfolio','ctp_execution',
          'ctp_risk_operator','ctp_risk_control','ctp_risk_policy_operator','ctp_risk_policy_controller',
          'ctp_risk_evidence_collector','ctp_market_snapshot','ctp_risk_snapshot_reader','ctp_instrument_registry')))
    OR EXISTS(SELECT 1 FROM pg_namespace n WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_')
      AND (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER')))
    OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p','v','m','f')
      AND pg_has_role(current_user,t.relowner,'MEMBER'))
    OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE left(n.nspname,4)='ctp_' ${names ? `AND (n.nspname||'.'||t.relname) NOT IN(${names})` : ''}
      AND t.relkind IN('r','p','v','m','f')
      AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
      WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(current_user,f.oid,'EXECUTE')
      ${signatures ? `AND (n.nspname||'.'||f.proname||'('||replace(oidvectortypes(f.proargtypes),' ','')||')') NOT IN(${signatures})` : ''})`;
}
