import { z } from 'zod';

export const dependencyStatusSchema = z.enum(['up', 'down']);

/**
 * Response body of GET /api/v1/health (readiness: database + Redis).
 * Sent with HTTP 200 when `status` is `ok`, 503 when `degraded`.
 */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  time: z.iso.datetime(),
  checks: z.object({
    database: dependencyStatusSchema,
    redis: dependencyStatusSchema,
  }),
});

/** Response body of GET /api/v1/health/live (liveness: the process answers, no dependencies). */
export const liveResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  time: z.iso.datetime(),
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type LiveResponse = z.infer<typeof liveResponseSchema>;
