import { z } from 'zod';

/**
 * The body of every api error (CLAUDE.md → API: `{ code, message, details? }`). The web app reads
 * only `code` (it shows the code's label, never `message`), so `message` is optional here: a body
 * from a proxy or an older api still yields its code, and anything else is no error body at all.
 */
export const apiErrorBodySchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().optional(),
  details: z.unknown().optional(),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
