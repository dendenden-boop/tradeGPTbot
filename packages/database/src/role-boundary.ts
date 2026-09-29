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
