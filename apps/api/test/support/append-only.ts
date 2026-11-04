import type { Client } from 'pg';

/** Tables whose rows are never updated or deleted (ADR 0002 §4, ADR 0008 §6). Ledgers join later. */
export const APPEND_ONLY_TABLES = [
  'audit_logs',
  'platform_audit_logs',
  'pos_kitchen_tickets',
  'pos_order_lines',
  'pos_ticket_status_changes',
  'reservation_status_changes',
] as const;

export interface AppendOnlyGap {
  table: string;
  problems: string[];
}

// pg_trigger.tgtype bits.
const ROW = 1;
const BEFORE = 2;
const DELETE = 8;
const UPDATE = 16;
const TRUNCATE = 32;

/**
 * For each table: an enabled `<table>_append_only` trigger that fires BEFORE UPDATE, DELETE and
 * TRUNCATE per statement, and no UPDATE, DELETE or TRUNCATE privilege for durby_app. Catches the
 * owner dropping or disabling the trigger, and a grant that gives the privileges back.
 */
export async function findAppendOnlyGaps(
  client: Client,
  tables: readonly string[] = APPEND_ONLY_TABLES,
): Promise<AppendOnlyGap[]> {
  const gaps: AppendOnlyGap[] = [];
  for (const table of tables) {
    const problems: string[] = [];
    const { rows: triggers } = await client.query<{ tgtype: number; tgenabled: string }>(
      `SELECT t.tgtype, t.tgenabled FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`,
      [table, `${table}_append_only`],
    );
    const trigger = triggers[0];
    if (!trigger) {
      problems.push('append-only trigger missing');
    } else {
      if (trigger.tgenabled === 'D') problems.push('append-only trigger disabled');
      const type = trigger.tgtype;
      const covers = (bit: number) => (type & bit) === bit;
      if (covers(ROW) || !covers(BEFORE))
        problems.push('trigger is not BEFORE … FOR EACH STATEMENT');
      for (const [bit, op] of [
        [UPDATE, 'UPDATE'],
        [DELETE, 'DELETE'],
        [TRUNCATE, 'TRUNCATE'],
      ] as const) {
        if (!covers(bit)) problems.push(`trigger does not cover ${op}`);
      }
    }
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const { rows } = await client.query<{ has: boolean }>(
        `SELECT has_table_privilege('durby_app', format('public.%I', $1::text), $2) AS has`,
        [table, privilege],
      );
      if (rows[0]?.has) problems.push(`durby_app has ${privilege}`);
    }
    if (problems.length > 0) gaps.push({ table, problems });
  }
  return gaps;
}
