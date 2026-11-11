/**
 * seed-dev writes known passwords (customer users and a Durby staff super admin), so it runs only
 * where someone opted in: DURBY_ALLOW_DEV_SEED=1, set in apps/api/.env.example (local) and in CI,
 * never on staging or production. NODE_ENV=production refuses whatever the flag says. A database
 * host check is not enough: staging's DATABASE_URL host is `postgres` too.
 */
export const DEV_SEED_FLAG = 'DURBY_ALLOW_DEV_SEED';

/** Why seed-dev must not run in `env`, or null when it may. */
export function devSeedRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.NODE_ENV === 'production') return 'seed-dev refuses to run with NODE_ENV=production';
  if (env[DEV_SEED_FLAG] !== '1') {
    return `seed-dev refuses to run without ${DEV_SEED_FLAG}=1 (local and CI only)`;
  }
  return null;
}

export function assertDevSeedAllowed(env: Readonly<Record<string, string | undefined>>): void {
  const refusal = devSeedRefusal(env);
  if (refusal) throw new Error(refusal);
}
