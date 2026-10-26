import type { ClientBase } from 'pg';

/** The only SECURITY DEFINER functions allowed in `public` (ADR 0006). Adding one needs an ADR. */
export const SECURITY_DEFINER_ALLOW_LIST: readonly string[] = [
  'auth_user_organization_ids',
  'outbox_backlog',
  'outbox_due_tenants',
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
