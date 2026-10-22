import type { ClientBase } from 'pg';

export interface RlsGap {
  table: string;
  problems: string[];
}

/**
 * Lists every table in `public` with a `tenant_id` column that is not fully protected by RLS
 * (ADR 0005): RLS enabled and forced, a policy for all commands whose USING and WITH CHECK both
 * reference app.tenant_id, and no permissive policy without it (permissive policies are OR'ed,
 * so one loose policy would open the table). Empty result = every tenant table is covered.
 */
export async function findTenantTablesWithoutRls(client: ClientBase): Promise<RlsGap[]> {
  const { rows } = await client.query<{
    table: string;
    enabled: boolean;
    forced: boolean;
    has_tenant_policy: boolean;
    loose_policies: number;
  }>(`
    SELECT c.relname AS table,
           c.relrowsecurity AS enabled,
           c.relforcerowsecurity AS forced,
           EXISTS (
             SELECT 1 FROM pg_policy p
             WHERE p.polrelid = c.oid AND p.polcmd = '*' AND p.polpermissive
               AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.tenant_id%'
               AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app.tenant_id%'
           ) AS has_tenant_policy,
           (
             SELECT count(*)::int FROM pg_policy p
             WHERE p.polrelid = c.oid AND p.polpermissive
               AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') NOT LIKE '%app.tenant_id%'
                 OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') NOT LIKE '%app.tenant_id%')
           ) AS loose_policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`);

  return rows
    .map((row) => ({
      table: row.table,
      problems: [
        ...(row.enabled ? [] : ['RLS not enabled']),
        ...(row.forced ? [] : ['RLS not forced']),
        ...(row.has_tenant_policy ? [] : ['no tenant_isolation policy on app.tenant_id']),
        ...(row.loose_policies > 0
          ? [`${row.loose_policies} permissive policy without app.tenant_id`]
          : []),
      ],
    }))
    .filter((gap) => gap.problems.length > 0);
}
