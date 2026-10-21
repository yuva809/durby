import type { z } from 'zod';
import { appEnvSchema, type AppConfig } from './env.schema';

type Env = Record<string, string | undefined>;

/**
 * Parses env vars against a schema. Throws one error naming every invalid var.
 * Only var names and rule messages are reported, never the values (they hold secrets).
 */
export function parseEnv<S extends z.ZodType>(schema: S, env: Env): z.infer<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
}

export function loadConfig(env: Env = process.env): AppConfig {
  return parseEnv(appEnvSchema, env);
}
