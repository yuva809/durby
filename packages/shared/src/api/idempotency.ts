import { z } from 'zod';

/** Request header carrying the client's key (docs/platform/idempotency.md, ADR 0014). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Response header set on a replayed result. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** 1–255 visible ASCII characters; same shape as the `idempotency_keys_shape_check`. */
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7E]{1,255}$/);

/** Keys expire this long after creation; an expired key is treated as new. */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;

/** Stable error codes of idempotent routes; the web app shows the matching label. */
export const IDEMPOTENCY_ERROR_CODES = [
  'idempotency.key_required',
  'idempotency.key_invalid',
  'idempotency.key_reused',
  'idempotency.request_in_progress',
] as const;

export type IdempotencyErrorCode = (typeof IDEMPOTENCY_ERROR_CODES)[number];

/** `idempotency.key_reused` → `platform.errors.idempotencyKeyReused`. */
export function idempotencyErrorLabel(code: IdempotencyErrorCode): string {
  return `platform.errors.${code.replace(/[._]([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
