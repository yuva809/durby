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

/**
 * Codes any route may answer. `platform.busy` (503, Retry-After): the database was overloaded
 * (ADR 0021); the same request may be retried with the same Idempotency-Key.
 * `platform.payload_too_large` (413): the body is over the route's size limit (e.g. a tile image
 * over CATEGORY_IMAGE_MAX_BYTES).
 */
export const PLATFORM_ERROR_CODES = ['platform.busy', 'platform.payload_too_large'] as const;

export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];
