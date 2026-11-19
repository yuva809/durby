import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUDIT_ACTIONS,
  AUDIT_SNAPSHOT_FIELDS,
  isAuditAction,
  PERMISSIONS,
  SYSTEM_ROLE_GRANTS,
  systemRolePermissions,
} from '@durby/shared';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0060: "See prices and values". Every built-in role that reads stock holds it but the Branch manager, and the
 * migration gives it to every custom role. Needs no database: the migration is read as text.
 */
const KEY = 'inventory.prices.read';
const MIGRATION = join(
  __dirname,
  '../../../prisma/migrations/20261119220000_inventory_prices_read/migration.sql',
);

describe('inventory.prices.read (ADR 0060)', () => {
  it('is held by every built-in role that reads stock but the Branch manager', () => {
    expect(Object.hasOwn(PERMISSIONS, KEY)).toBe(true);
    const readers = Object.entries(SYSTEM_ROLE_GRANTS)
      .filter(([, grants]) => grants['inventory.stock.read'] === 'grant')
      .map(([role]) => role);
    const holders = Object.entries(SYSTEM_ROLE_GRANTS)
      .filter(([, grants]) => grants[KEY] === 'grant')
      .map(([role]) => role);
    expect(readers).toContain('branch');
    expect(holders).toEqual(readers.filter((role) => role !== 'branch'));
    expect(systemRolePermissions('owner').has(KEY)).toBe(true);
  });

  it('is added to every custom role by its migration, with a registered audit row', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain(`'${KEY}'`);
    expect(sql).toContain(`r."system_key" IS NULL`);
    const action = /'(platform\.permission_keys\.[a-z_]+)'/.exec(sql)?.[1] ?? '';
    expect(isAuditAction(action)).toBe(true);
    expect(AUDIT_ACTIONS[action as keyof typeof AUDIT_ACTIONS].entityType).toBe('organization');
    // Only allow-listed fields reach the audit row.
    const fields = [...sql.matchAll(/jsonb_build_object\(([^)]*)\)/g)].flatMap((m) =>
      [...m[1]!.matchAll(/'([a-zA-Z]+)'/g)].map((f) => f[1]!),
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(AUDIT_SNAPSHOT_FIELDS.organization as readonly string[]).toContain(field);
    }
  });
});
