import type { PlanKey } from '@durby/shared';
import { Client } from 'pg';
import { inject } from 'vitest';
import type { PlatformPrismaClient } from '../../src/platform/tenancy';

/**
 * The id of a seeded plan (the plans migration creates them). `organizations.plan_id` is NOT NULL
 * since step 1.11, so test organizations need one; `full` is what provisioning uses by default.
 */
export async function planIdOf(
  db: Pick<PlatformPrismaClient, 'plan'>,
  key: PlanKey = 'full',
): Promise<string> {
  return (await db.plan.findUniqueOrThrow({ where: { key }, select: { id: true } })).id;
}

/** Key of a test-only plan that enables nothing (see emptyPlanFor). */
export const EMPTY_TEST_PLAN = 'test_empty';

/**
 * Puts `organizationId` on a plan with no features: what "an organization without a plan" meant
 * before plan_id became NOT NULL. Plans are read-only for the app (ADR 0009), so the plan is
 * created and the organization moved as the migrator; the plan row is shared and idempotent.
 */
export async function emptyPlanFor(organizationId: string): Promise<void> {
  const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });
  await migrator.connect();
  try {
    await migrator.query(
      `INSERT INTO plans (key, name, updated_at) VALUES ($1, 'Test: nothing enabled', now())
       ON CONFLICT (key) DO NOTHING`,
      [EMPTY_TEST_PLAN],
    );
    await migrator.query(
      `UPDATE organizations SET plan_id = (SELECT id FROM plans WHERE key = $1) WHERE id = $2`,
      [EMPTY_TEST_PLAN, organizationId],
    );
  } finally {
    await migrator.end();
  }
}
