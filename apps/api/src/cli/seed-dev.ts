import type { INestApplicationContext } from '@nestjs/common';
import { ProvisioningService } from '../platform/provisioning';
import { APP_CONFIG, type AppConfig } from '../platform/config';
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
    { email: 'owner@partner-demo.local', role: 'owner', organizations: ['Demo Trattoria'] },
  ],
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
      await provisioning.ensureMembership(
        orgIds.get(org) ?? '',
        user.id,
        seed.role,
        'cli.seed_dev',
      );
    }
  }
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
