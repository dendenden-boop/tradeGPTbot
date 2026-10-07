/** Additional SQL admission checks, not SQL/mutation authority. Factory-owned
 * constants only; every identity retains its existing public-table/column checks. */
export function postgresRoleBoundary(
  group: string,
  functions: readonly string[],
  tables: readonly string[] = [],
): string {
  if (
    !/^ctp_[a-z_]+$/.test(group) ||
    functions.some((f) => !/^ctp_[a-z_]+\.[a-z_]+\([a-z ,]*\)$/.test(f)) ||
    tables.some((t) => !/^ctp_[a-z_]+\.[a-z_]+$/.test(t))
  )
    throw new Error('POSTGRES_ROLE_BOUNDARY_INPUT');
  const signatures = functions.map((f) => `'${f}'::regprocedure::oid`).join(',');
  const names = tables.map((t) => `'${t}'`).join(',');
  return `
    EXISTS(SELECT 1 FROM pg_roles g WHERE g.rolname='${group}'
      AND NOT(g.rolcanlogin OR g.rolsuper OR g.rolbypassrls OR g.rolcreatedb OR g.rolcreaterole OR g.rolreplication))
    AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname<>current_user AND x.rolname<>'${group}'
      AND pg_has_role(current_user,x.oid,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_')
      AND (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER')))
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE (n.nspname='public' OR left(n.nspname,4)='ctp_') AND t.relkind IN('r','p','v','m','f')
      AND pg_has_role(current_user,t.relowner,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE left(n.nspname,4)='ctp_' ${names ? `AND (n.nspname||'.'||t.relname) NOT IN(${names})` : ''}
      AND t.relkind IN('r','p','v','m','f')
      AND (has_table_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(current_user,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
      WHERE left(n.nspname,4)='ctp_' AND has_function_privilege(current_user,f.oid,'EXECUTE')
      ${signatures ? `AND f.oid NOT IN(${signatures})` : ''})`;
}
