import { PERMISSIONS, type SystemRole } from '@durby/shared';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { splitEffect } from '../src/platform/rbac/permission-split';
import { createOwnDatabase, migrationNames, migrationSql } from './support/own-database';

const MIGRATION = migrationNames().find((name) => name.endsWith('_split_broad_permission_keys'))!;

type Effect = 'grant' | 'deny';
interface Rows {
  role: string[];
  overrides: { permissionKey: string; effect: Effect }[];
}

/**
 * The ADR 0051 migration on prepared data, as on production: custom roles, members with mixed grants and denies, and
 * open invitations, in two organizations. Every role and member keeps exactly their effective permissions; running it
 * again changes nothing; one audit row per organization that got rows.
 */
describe('split broad permission keys migration', { timeout: 180_000 }, () => {
  let db: Client;
  let migrationUrl: string;
  const orgA = uuidv7();
  const orgB = uuidv7();
  const ids: Record<string, string> = {};
  const id = (name: string) => (ids[name] ??= uuidv7());

  /** Members: name → [organization, role name, overrides]. */
  const MEMBERS: Record<string, [string, string, [string, Effect][]]> = {
    adminDeniedUsers: [orgA, 'admin', [['platform.users.manage', 'deny']]],
    managerGrantedRoles: [
      orgA,
      'manager',
      [
        ['platform.roles.manage', 'grant'],
        ['orders.orders.edit', 'deny'],
      ],
    ],
    staffGrantedCustomers: [orgA, 'staff', [['orders.customers.edit', 'grant']]],
    customUserManager: [orgA, 'User managers', []],
    customDeniedOrders: [orgA, 'Order desk', [['orders.orders.edit', 'deny']]],
    otherOrgManager: [orgB, 'manager', [['platform.users.manage', 'grant']]],
    plainWaiter: [orgB, 'waiter', []],
  };
  const CUSTOM_ROLES: Record<string, [string, string[]]> = {
    'User managers': [
      orgA,
      ['platform.users.read', 'platform.users.manage', 'platform.roles.manage'],
    ],
    'Order desk': [orgA, ['orders.orders.read', 'orders.orders.edit', 'orders.customers.edit']],
    Readers: [orgB, ['platform.users.read']],
  };

  async function storedRows(memberName: string): Promise<{ systemKey: SystemRole | null } & Rows> {
    const membershipId = id(`m:${memberName}`);
    const role = await db.query<{ system_key: SystemRole | null; role_id: string }>(
      `SELECT r.system_key, r.id AS role_id FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.id = $1`,
      [membershipId],
    );
    const { system_key: systemKey, role_id: roleId } = role.rows[0]!;
    const keys = await db.query<{ permission_key: string }>(
      'SELECT permission_key FROM role_permissions WHERE role_id = $1 ORDER BY permission_key',
      [roleId],
    );
    const overrides = await db.query<{ permission_key: string; effect: Effect }>(
      'SELECT permission_key, effect FROM membership_permissions WHERE membership_id = $1 ORDER BY permission_key',
      [membershipId],
    );
    return {
      systemKey,
      role: keys.rows.map((r) => r.permission_key),
      overrides: overrides.rows.map((r) => ({ permissionKey: r.permission_key, effect: r.effect })),
    };
  }

  const before: Record<string, Awaited<ReturnType<typeof storedRows>>> = {};
  const countRows = async () =>
    (
      await db.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM role_permissions) + (SELECT count(*) FROM membership_permissions)
              + (SELECT count(*) FROM invitation_permissions) AS n`,
      )
    ).rows[0]!.n;

  async function migrate(): Promise<void> {
    const migrator = new Client({ connectionString: migrationUrl });
    await migrator.connect();
    try {
      await migrator.query(migrationSql(MIGRATION));
    } finally {
      await migrator.end();
    }
  }

  beforeAll(async () => {
    const own = await createOwnDatabase('permission_split', { before: MIGRATION });
    migrationUrl = own.migrationDatabaseUrl;
    // Superuser on the same database: prepares data and reads across tenants without RLS.
    const superuserUrl = new URL(inject('superuserDatabaseUrl'));
    superuserUrl.pathname = new URL(own.migrationDatabaseUrl).pathname;
    db = new Client({ connectionString: superuserUrl.toString() });
    await db.connect();

    const partner = uuidv7();
    await db.query(
      `INSERT INTO partners (id, slug, name, updated_at) VALUES ($1, 'p', 'P', now())`,
      [partner],
    );
    for (const org of [orgA, orgB]) {
      await db.query(
        `INSERT INTO organizations (id, partner_id, name, plan_id, updated_at)
         VALUES ($1, $2, 'Org', (SELECT id FROM plans WHERE key = 'full'), now())`,
        [org, partner],
      );
      for (const systemKey of ['owner', 'admin', 'manager', 'staff', 'waiter']) {
        await db.query(
          `INSERT INTO roles (id, tenant_id, system_key, updated_at) VALUES ($1, $2, $3, now())`,
          [id(`r:${org}:${systemKey}`), org, systemKey],
        );
      }
    }
    for (const [name, [org, keys]] of Object.entries(CUSTOM_ROLES)) {
      await db.query(
        `INSERT INTO roles (id, tenant_id, name, updated_at) VALUES ($1, $2, $3, now())`,
        [id(`r:${org}:${name}`), org, name],
      );
      for (const key of keys) {
        await db.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)`,
          [org, id(`r:${org}:${name}`), key],
        );
      }
    }
    for (const [name, [org, roleName, overrides]] of Object.entries(MEMBERS)) {
      const userId = id(`u:${name}`);
      await db.query(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [
        userId,
        `${name.toLowerCase()}@example.test`,
      ]);
      await db.query(
        `INSERT INTO memberships (id, tenant_id, user_id, role_id, updated_at) VALUES ($1, $2, $3, $4, now())`,
        [id(`m:${name}`), org, userId, id(`r:${org}:${roleName}`)],
      );
      for (const [key, effect] of overrides) {
        await db.query(
          `INSERT INTO membership_permissions (tenant_id, membership_id, permission_key, effect)
           VALUES ($1, $2, $3, $4)`,
          [org, id(`m:${name}`), key, effect],
        );
      }
    }
    // An open invitation with an override: it must carry the split too.
    await db.query(
      `INSERT INTO invitations (id, tenant_id, email, role_id, invited_by_user_id, token_hash, expires_at, updated_at)
       VALUES ($1, $2, 'new@example.test', $3, $4, 'hash-split', now() + interval '7 days', now())`,
      [id('invite'), orgA, id(`r:${orgA}:staff`), id('u:plainWaiter')],
    );
    await db.query(
      `INSERT INTO invitation_permissions (tenant_id, invitation_id, permission_key, effect)
       VALUES ($1, $2, 'platform.users.manage', 'grant')`,
      [orgA, id('invite')],
    );
    for (const name of Object.keys(MEMBERS)) before[name] = await storedRows(name);

    await migrate();
  });

  afterAll(async () => {
    await db?.end();
  });

  it.each(Object.keys(MEMBERS))('keeps %s’s effective permissions', async (name) => {
    const old = before[name]!;
    const now = await storedRows(name);
    // Before: the stored rows read with their pre-split meaning. After: the migrated rows, read without aliases.
    const expected = splitEffect(PERMISSIONS, old.systemKey, old.role, old.overrides).before;
    const { after } = splitEffect(PERMISSIONS, now.systemKey, now.role, now.overrides);
    expect(after).toEqual(expected);
    // And nothing more for the migrated rows to add.
    expect(splitEffect(PERMISSIONS, now.systemKey, now.role, now.overrides).after).toEqual(after);
  });

  it('copies grants and denies onto every new key and keeps the old rows (expand only)', async () => {
    expect((await storedRows('adminDeniedUsers')).overrides).toEqual([
      { permissionKey: 'platform.users.delete', effect: 'deny' },
      { permissionKey: 'platform.users.edit', effect: 'deny' },
      { permissionKey: 'platform.users.manage', effect: 'deny' },
    ]);
    expect((await storedRows('customUserManager')).role).toEqual([
      'platform.org.read',
      'platform.roles.create',
      'platform.roles.delete',
      'platform.roles.edit',
      'platform.roles.manage',
      'platform.users.delete',
      'platform.users.edit',
      'platform.users.manage',
      'platform.users.read',
    ]);
    const invitation = await db.query<{ permission_key: string; effect: Effect }>(
      'SELECT permission_key, effect FROM invitation_permissions WHERE invitation_id = $1 ORDER BY permission_key',
      [id('invite')],
    );
    expect(invitation.rows).toEqual([
      { permission_key: 'platform.users.delete', effect: 'grant' },
      { permission_key: 'platform.users.edit', effect: 'grant' },
      { permission_key: 'platform.users.manage', effect: 'grant' },
    ]);
    // Built-in roles have no stored keys: they get nothing.
    const system = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.system_key IS NOT NULL`,
    );
    expect(system.rows[0]!.n).toBe('0');
  });

  it('writes one audit row per organization that got rows, with the count only', async () => {
    const audit = await db.query<{
      tenant_id: string;
      actor_system: string;
      after: { rowsAdded: number };
    }>(
      `SELECT tenant_id, actor_system, after FROM audit_logs WHERE action = 'platform.permission_keys.split'
       ORDER BY tenant_id`,
    );
    expect(audit.rows.map((r) => r.tenant_id)).toEqual([orgA, orgB].sort());
    expect(audit.rows.every((r) => r.actor_system === 'migration' && r.after.rowsAdded > 0)).toBe(
      true,
    );
  });

  it('changes nothing when run again', async () => {
    const rows = await countRows();
    const audits = await db.query(`SELECT count(*) FROM audit_logs`);
    await migrate();
    expect(await countRows()).toBe(rows);
    expect((await db.query(`SELECT count(*) FROM audit_logs`)).rows).toEqual(audits.rows);
  });
});
