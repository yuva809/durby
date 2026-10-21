import { z } from 'zod';

/** Response body of GET /api/v1/health. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  time: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
