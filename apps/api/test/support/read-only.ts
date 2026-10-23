import type { Client } from 'pg';

/** Platform reference tables the app only reads; contents change through migrations (ADR 0009 §2). */
export const APP_READ_ONLY_TABLES = ['plans', 'plan_features'] as const;

export interface ReadOnlyGap {
  table: string;
  problems: string[];
}

/**
 * For each table: durby_app has SELECT and none of INSERT, UPDATE, DELETE, TRUNCATE. Catches a
 * grant that gives write access back (or a new table left with the default privileges).
 */
export async function findReadOnlyGaps(
  client: Client,
  tables: readonly string[] = APP_READ_ONLY_TABLES,
): Promise<ReadOnlyGap[]> {
  const gaps: ReadOnlyGap[] = [];
  for (const table of tables) {
    const problems: string[] = [];
    const has = async (privilege: string) =>
      (
        await client.query<{ has: boolean }>(
          `SELECT has_table_privilege('durby_app', format('public.%I', $1::text), $2) AS has`,
          [table, privilege],
        )
      ).rows[0]?.has === true;
    if (!(await has('SELECT'))) problems.push('durby_app lacks SELECT');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      if (await has(privilege)) problems.push(`durby_app has ${privilege}`);
    }
    if (problems.length > 0) gaps.push({ table, problems });
  }
  return gaps;
}
