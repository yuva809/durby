import type { ClientBase } from 'pg';

/** The only SECURITY DEFINER functions allowed in `public` (ADR 0006). Adding one needs an ADR. */
export const SECURITY_DEFINER_ALLOW_LIST: readonly string[] = [
  'auth_user_organization_ids',
  'outbox_backlog',
  'outbox_due_tenants',
  // ADR 0079: deletes one stock item of the caller's organization with its history (owner-only route).
  'purge_stock_item',
];

export const DEFINER_ROLE = 'durby_rls_definer';

export interface DefinerGap {
  name: string;
  problems: string[];
}

/**
 * Lists every SECURITY DEFINER function in `public` that breaks the ADR 0006 rules: on the
 * allow-list, owned by durby_rls_definer, a pinned search_path (otherwise a caller could shadow
 * objects the function uses), and not executable by PUBLIC. Empty result = all functions comply.
 */
export async function findSecurityDefinerGaps(client: ClientBase): Promise<DefinerGap[]> {
  const { rows } = await client.query<{
    name: string;
    owner: string;
    pinned_search_path: boolean;
    public_execute: boolean;
  }>(`
    SELECT p.proname AS name,
           pg_get_userbyid(p.proowner) AS owner,
           EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
             AS pinned_search_path,
           EXISTS (
             SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           ) AS public_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
    ORDER BY p.proname`);

  return rows
    .map((row) => ({
      name: row.name,
      problems: [
        ...(SECURITY_DEFINER_ALLOW_LIST.includes(row.name) ? [] : ['not on the allow-list']),
        ...(row.owner === DEFINER_ROLE ? [] : [`owned by ${row.owner}, not ${DEFINER_ROLE}`]),
        ...(row.pinned_search_path ? [] : ['search_path not pinned']),
        ...(row.public_execute ? ['executable by PUBLIC'] : []),
      ],
    }))
    .filter((gap) => gap.problems.length > 0);
}

/** Problems with the definer role itself: it must not log in, create objects or be a superuser. */
export async function findDefinerRoleProblems(client: ClientBase): Promise<string[]> {
  const { rows } = await client.query<{
    exists: boolean;
    can_login: boolean;
    superuser: boolean;
    can_create: boolean;
  }>(
    `SELECT true AS exists, r.rolcanlogin AS can_login, r.rolsuper AS superuser,
            has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create
     FROM pg_roles r WHERE r.rolname = $1`,
    [DEFINER_ROLE],
  );
  const role = rows[0];
  if (!role) return [`role ${DEFINER_ROLE} missing`];
  return [
    ...(role.can_login ? ['can log in'] : []),
    ...(role.superuser ? ['is superuser'] : []),
    ...(role.can_create ? ['has CREATE on schema public'] : []),
  ];
}

/**
 * Everything durby_rls_definer may read or change (ADR 0006 §2, ADR 0013 §3): exactly the columns
 * its functions need. A wider grant would let every allow-listed function, or a future one, read
 * more across tenants than reviewed.
 */
// purge_stock_item (ADR 0079): DELETE on the item's history tables, SELECT on the columns it filters by.
export const DEFINER_PRIVILEGES: readonly string[] = [
  'column bom_lines.item_id SELECT',
  'column bom_lines.tenant_id SELECT',
  'column boms.item_id SELECT',
  'column boms.tenant_id SELECT',
  'column memberships.tenant_id SELECT',
  'column memberships.user_id SELECT',
  'column outbox_events.available_at SELECT',
  'column outbox_events.dead_lettered_at SELECT',
  'column outbox_events.occurred_at SELECT',
  'column outbox_events.published_at SELECT',
  'column outbox_events.tenant_id SELECT',
  'column outbox_events.type SELECT',
  'column recipe_lines.item_id SELECT',
  'column recipe_lines.tenant_id SELECT',
  'column sales_order_lines.item_id SELECT',
  'column sales_order_lines.tenant_id SELECT',
  'column stock_documents.id SELECT',
  'column stock_documents.tenant_id SELECT',
  'column stock_items.id SELECT',
  'column stock_items.parent_item_id SELECT',
  'column stock_items.tenant_id SELECT',
  'column stock_levels.item_id SELECT',
  'column stock_levels.tenant_id SELECT',
  'column stock_movements.document_id SELECT',
  'column stock_movements.item_id SELECT',
  'column stock_movements.tenant_id SELECT',
  'column stock_request_lines.item_id SELECT',
  'column stock_request_lines.tenant_id SELECT',
  'column vendor_invoice_line_corrections.line_id SELECT',
  'column vendor_invoice_line_corrections.tenant_id SELECT',
  'column vendor_invoice_lines.id SELECT',
  'column vendor_invoice_lines.item_id SELECT',
  'column vendor_invoice_lines.tenant_id SELECT',
  'column vendor_invoices.document_id SELECT',
  'column vendor_invoices.tenant_id SELECT',
  'schema public USAGE',
  'table stock_documents DELETE',
  'table stock_items DELETE',
  'table stock_levels DELETE',
  'table stock_movements DELETE',
  'table stock_request_lines DELETE',
  'table vendor_invoice_line_corrections DELETE',
  'table vendor_invoice_lines DELETE',
];

/**
 * The definer role's privileges from the catalog ACLs (not information_schema, which only shows
 * grants of roles the caller is a member of): on schemas, on any relation in `public`, and on
 * their columns. Sorted, as `kind object PRIVILEGE`.
 */
export async function definerPrivileges(client: ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ entry: string }>(
    `SELECT 'schema ' || n.nspname || ' ' || a.privilege_type AS entry
       FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE a.grantee = $1::regrole
     UNION ALL
     SELECT 'table ' || c.relname || ' ' || a.privilege_type
       FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = $1::regrole
     UNION ALL
     SELECT 'column ' || c.relname || '.' || at.attname || ' ' || a.privilege_type
       FROM pg_attribute at
       JOIN pg_class c ON c.oid = at.attrelid, aclexplode(at.attacl) a
      WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = $1::regrole
     ORDER BY 1`,
    [DEFINER_ROLE],
  );
  return rows.map((r) => r.entry);
}
