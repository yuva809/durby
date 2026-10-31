import type { INestApplicationContext } from '@nestjs/common';
import { CatalogService } from '../modules/catalog';
import { AreasService, TablesService } from '../modules/pos';
import { auditActor, AuditService, snapshot } from '../platform/audit';
import { ProvisioningService } from '../platform/provisioning';
import { APP_CONFIG, type AppConfig } from '../platform/config';
import { SystemRoles } from '../platform/rbac';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../platform/tenancy';
import type { SystemRole } from '@durby/shared';
import { DEFAULT_PARTNER } from './create-admin';
import { runCommand } from './run-command';

/**
 * Local development data: organizations on the default partner and on the demo partner (the
 * two-domain demo, docs/platform/web-shell.md), and users with a known password. LOCAL ONLY:
 * refuses to run with NODE_ENV=production. Idempotent.
 */
export const DEV_PASSWORD = 'durby-dev-password';

/** The demo partner comes from the partner_theming migration (ADR 0015 §6). */
export const DEMO_PARTNER_SLUG = 'demo';

export const DEV_SEED = {
  organizations: [
    { name: 'Demo Bistro', partner: DEFAULT_PARTNER.slug, plan: 'full' },
    { name: 'Demo Café', partner: DEFAULT_PARTNER.slug, plan: 'full' },
    { name: 'Demo Trattoria', partner: DEMO_PARTNER_SLUG, plan: 'inventory' },
  ],
  users: [
    { email: 'owner@durby.local', role: 'owner', organizations: ['Demo Bistro', 'Demo Café'] },
    { email: 'staff@durby.local', role: 'staff', organizations: ['Demo Bistro'] },
    { email: 'waiter@durby.local', role: 'waiter', organizations: ['Demo Bistro'] },
    { email: 'cashier@durby.local', role: 'cashier', organizations: ['Demo Bistro'] },
    { email: 'owner@partner-demo.local', role: 'owner', organizations: ['Demo Trattoria'] },
  ],
} as const;

/**
 * Table service demo data (docs/modules/pos.md) for the organizations on `full`: a location (there
 * is no location management yet, so the seed creates it like the test fixtures do), a menu and
 * tables. Prices are gross; 7 % food and 19 % drinks (Germany, dine-in, 2026).
 */
export const DEV_TABLE_SERVICE = {
  location: 'Main street',
  menu: [
    {
      category: 'Starters',
      products: [
        ['Tomato soup', '6.90', '7'],
        ['Bruschetta', '7.50', '7'],
      ],
    },
    {
      category: 'Mains',
      products: [
        ['Wiener Schnitzel', '18.90', '7'],
        ['Mushroom risotto', '15.50', '7'],
        ['Grilled salmon', '21.00', '7'],
      ],
    },
    {
      category: 'Drinks',
      products: [
        ['Sparkling water 0.5 l', '3.90', '19'],
        ['Cola 0.33 l', '3.80', '19'],
        ['House wine 0.2 l', '6.50', '19'],
        ['Espresso', '2.60', '19'],
      ],
    },
  ],
  tables: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'Terrace 1', 'Terrace 2'],
} as const;

export async function seedDev(app: INestApplicationContext): Promise<void> {
  if (app.get<AppConfig>(APP_CONFIG).NODE_ENV === 'production') {
    throw new Error('seed-dev refuses to run with NODE_ENV=production');
  }
  const provisioning = app.get(ProvisioningService);
  const partners = new Map<string, string>([
    [
      DEFAULT_PARTNER.slug,
      (await provisioning.ensurePartner(DEFAULT_PARTNER.slug, DEFAULT_PARTNER.name)).id,
    ],
  ]);
  const demo = await provisioning.findPartner(DEMO_PARTNER_SLUG);
  if (!demo) throw new Error(`Partner "${DEMO_PARTNER_SLUG}" missing: run the migrations first`);
  partners.set(DEMO_PARTNER_SLUG, demo.id);
  const orgIds = new Map<string, string>();
  for (const org of DEV_SEED.organizations) {
    const partnerId = partners.get(org.partner) ?? '';
    orgIds.set(
      org.name,
      (await provisioning.ensureOrganization(partnerId, org.name, 'cli.seed_dev', org.plan)).id,
    );
  }
  for (const seed of DEV_SEED.users) {
    const user = await provisioning.ensureUser(seed.email, {
      password: DEV_PASSWORD,
      verified: true,
    });
    for (const org of seed.organizations) {
      const orgId = orgIds.get(org) ?? '';
      const membership = await provisioning.ensureMembership(
        orgId,
        user.id,
        seed.role,
        'cli.seed_dev',
      );
      if (!membership.created) await alignRole(app, orgId, user.id, seed.role);
    }
  }
  const owner = await provisioning.ensureUser(DEV_SEED.users[0].email, {
    password: DEV_PASSWORD,
    verified: true,
  });
  for (const org of DEV_SEED.organizations) {
    if (org.plan !== 'full') continue;
    await seedTableService(app, orgIds.get(org.name) ?? '', owner.id);
  }
}

/**
 * Puts an existing membership of a seeded user back on its declared role, audited. Local data can
 * drift: the RBAC migration (2026-10-22) made every membership of that time an Owner. Only here, not
 * in ProvisioningService.ensureMembership: create-admin and onboarding must never change a role.
 * Memberships the seed doesn't declare are left alone.
 */
async function alignRole(
  app: INestApplicationContext,
  tenantId: string,
  userId: string,
  role: SystemRole,
): Promise<void> {
  const db = app.get<TenantPrismaClient>(TENANT_PRISMA);
  await app.get(TenantContext).run({ tenantId, userId }, () =>
    db.$transaction(async (tx) => {
      const roleId = (await app.get(SystemRoles).ids(tx))[role];
      const where = { tenantId_userId: { tenantId, userId } };
      const select = {
        id: true,
        roleId: true,
        allLocations: true,
        locations: { select: { locationId: true } },
      } as const;
      const before = await tx.membership.findUniqueOrThrow({ where, select });
      if (before.roleId === roleId) return;
      const after = await tx.membership.update({ where, data: { roleId }, select });
      const view = (m: typeof before) =>
        snapshot('membership', {
          id: m.id,
          userId,
          roleId: m.roleId,
          allLocations: m.allLocations,
          locationIds: m.locations.map((l) => l.locationId).sort(),
        });
      // The last-Owner trigger (deferred) still refuses to demote an organization's only Owner.
      await app.get(AuditService).record(tx, {
        action: 'platform.membership.updated',
        actor: auditActor.system('cli.seed_dev'),
        entityId: after.id,
        before: view(before),
        after: view(after),
      });
    }),
  );
}

/** Idempotent: an organization that already has categories is left as it is. */
async function seedTableService(
  app: INestApplicationContext,
  tenantId: string,
  ownerId: string,
): Promise<void> {
  const db = app.get<TenantPrismaClient>(TENANT_PRISMA);
  const catalog = app.get(CatalogService);
  const tables = app.get(TablesService);
  const areas = app.get(AreasService);
  const actor = auditActor.system('cli.seed_dev');
  // As the owner, so the per-location access checks of TablesService pass; audited as the seed.
  await app.get(TenantContext).run({ tenantId, userId: ownerId }, async () => {
    if ((await db.productCategory.count()) > 0) return;
    let location = await db.location.findFirst({ select: { id: true } });
    if (!location) {
      const brand = await db.brand.create({ data: { tenantId, name: 'Demo' } });
      location = await db.location.create({
        data: { tenantId, brandId: brand.id, name: DEV_TABLE_SERVICE.location },
        select: { id: true },
      });
    }
    for (const [index, entry] of DEV_TABLE_SERVICE.menu.entries()) {
      const category = await catalog.createCategory(
        { name: entry.category, sortOrder: index },
        actor,
      );
      for (const [name, price, taxRate] of entry.products) {
        await catalog.createProduct({ categoryId: category.id, name, price, taxRate }, actor);
      }
    }
    const dining = await areas.create(
      { locationId: location.id, name: 'Dining room', sortOrder: 0 },
      actor,
    );
    const terrace = await areas.create(
      { locationId: location.id, name: 'Terrace', sortOrder: 1 },
      actor,
    );
    for (const [index, name] of DEV_TABLE_SERVICE.tables.entries()) {
      const outside = name.startsWith('Terrace');
      await tables.create(
        {
          locationId: location.id,
          name,
          seats: outside ? 2 : 4,
          sortOrder: index,
          areaId: outside ? terrace.id : dining.id,
        },
        actor,
      );
    }
  });
}

// Entry point when run with node (CJS build); skipped when imported (tests).
if (typeof require !== 'undefined' && require.main === module) {
  void runCommand('seed-dev', async (app) => {
    await seedDev(app);
    for (const user of DEV_SEED.users) {
      console.log(
        `${user.email} / ${DEV_PASSWORD}  ${user.role} (${user.organizations.join(', ')})`,
      );
    }
  });
}
