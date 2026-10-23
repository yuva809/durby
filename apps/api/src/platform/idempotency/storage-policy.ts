import { createHash } from 'node:crypto';
import { canonicalJson } from '../audit';

/**
 * SHA-256 hex of the request (ADR 0014 §3): method, path with query, and canonical JSON of the
 * body, so key order in the body doesn't matter but any value does.
 */
export function requestHash(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ method: method.toUpperCase(), url, body: body ?? null }) ?? '')
    .digest('hex');
}

/** Statuses that depend on access, time or limits and never changed state (ADR 0014 §5). */
const NOT_STORED_4XX: ReadonlySet<number> = new Set([401, 403, 408, 429]);

/** Whether a result with `status` is stored for replay; otherwise the key is released. */
export function isStoredStatus(status: number): boolean {
  if (status >= 200 && status < 300) return true;
  return status >= 400 && status < 500 && !NOT_STORED_4XX.has(status);
}

const SECRET_KEY = /token|secret|password|passwd|credential/i;

/**
 * The first object key in `body` that looks like a token or secret (nested too), or null.
 * Such a body is never stored (ADR 0014 §7).
 */
export function findSecretKey(body: unknown): string | null {
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = findSecretKey(item);
      if (found) return found;
    }
    return null;
  }
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (SECRET_KEY.test(key)) return key;
      const found = findSecretKey(value);
      if (found) return found;
    }
  }
  return null;
}

/** The JSON a client receives for `value`: what is stored and replayed. */
export function asJson(value: unknown): unknown {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
}
