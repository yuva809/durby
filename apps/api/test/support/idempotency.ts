import { IDEMPOTENCY_KEY_HEADER } from '@durby/shared';
import type { Test } from 'supertest';
import { v7 as uuidv7 } from 'uuid';

/** Sends a fresh Idempotency-Key, as the web app does for each user action (ADR 0014). */
export function withIdempotencyKey<T extends Test>(req: T, key: string = uuidv7()): T {
  return req.set(IDEMPOTENCY_KEY_HEADER, key);
}
