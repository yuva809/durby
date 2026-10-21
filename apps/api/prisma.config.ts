import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';
import { migrationEnvSchema } from './src/platform/config/env.schema';
import { parseEnv } from './src/platform/config/load-config';

const envFile = join(__dirname, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// `prisma generate` needs no database, so a clean clone (or CI typecheck) works
// without env vars. Commands that do need one fail on the missing datasource.
const datasource =
  process.env.MIGRATION_DATABASE_URL === undefined
    ? undefined
    : { url: parseEnv(migrationEnvSchema, process.env).MIGRATION_DATABASE_URL };

export default defineConfig({
  schema: join(__dirname, 'prisma', 'schema.prisma'),
  migrations: { path: join(__dirname, 'prisma', 'migrations') },
  ...(datasource && { datasource }),
});
