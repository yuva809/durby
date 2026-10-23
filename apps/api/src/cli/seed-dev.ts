import type { INestApplicationContext } from '@nestjs/common';
import { ProvisioningService } from '../platform/provisioning';
import { APP_CONFIG, type AppConfig } from '../platform/config';
import { DEFAULT_PARTNER } from './create-admin';
import { runCommand } from './run-command';

/**
 * Local development data: two organizations and two users with a known password. LOCAL ONLY:
 * refuses to run with NODE_ENV=production. Idempotent.
 */
export const DEV_PASSWORD = 'durby-dev-password';

export const DEV_SEED = {
  organizations: ['Demo Bistro', 'Demo Café'],
  users: [
    { email: 'owner@durby.local', role: 'owner', organizations: ['Demo Bistro', 'Demo Café'] },
    { email: 'staff@durby.local', role: 'staff', organizations: ['Demo Bistro'] },
  ],
} as const;

export async function seedDev(app: INestApplicationContext): Promise<void> {
  if (app.get<AppConfig>(APP_CONFIG).NODE_ENV === 'production') {
    throw new Error('seed-dev refuses to run with NODE_ENV=production');
  }
  const provisioning = app.get(ProvisioningService);
  const partner = await provisioning.ensurePartner(DEFAULT_PARTNER.slug, DEFAULT_PARTNER.name);
  const orgIds = new Map<string, string>();
  for (const name of DEV_SEED.organizations) {
    orgIds.set(
      name,
      (await provisioning.ensureOrganization(partner.id, name, 'cli.seed_dev', 'full')).id,
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
