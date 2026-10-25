import { IDEMPOTENCY_KEY_HEADER } from '@durby/shared';
import type { SessionStore } from './auth/session';

/**
 * Idempotency-Key for writes (docs/platform/idempotency.md → Web, ADR 0014). One key per user
 * action: every retry of that action sends the same key, so the api applies it once; a new action
 * gets a new key.
 */

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * The key of one user action (a form submit, a button press). Kept while the action may still be
 * retried; renewed when the input changes (a different request needs a different key, or the api
 * answers 422 `idempotency.key_reused`) and after the action is done.
 */
export class ActionKey {
  private key: string | undefined;
  private input: string | undefined;

  constructor(private readonly generate: () => string = newIdempotencyKey) {}

  /** The key for submitting `input` (anything JSON): the same as last time if the input is. */
  for(input: unknown): string {
    const serialized = JSON.stringify(input ?? null);
    if (this.key === undefined || serialized !== this.input) {
      this.key = this.generate();
      this.input = serialized;
    }
    return this.key;
  }

  /** The action got its answer: the next submit is a new action. */
  done(): void {
    this.key = undefined;
    this.input = undefined;
  }
}

/** `init` with the Idempotency-Key header set. */
export function withIdempotencyKey(init: RequestInit, key: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(IDEMPOTENCY_KEY_HEADER, key);
  return { ...init, headers };
}

/**
 * Whether the answer leaves the action open for a retry with the same key: 5xx (not stored by the
 * api) and 409 `idempotency.request_in_progress`. Other 409s (`rbac.last_owner`, …) are final
 * answers the api stores; keeping their key would replay them even after the cause is fixed. A
 * 409 whose body can't be read counts as unknown, so the key stays.
 */
async function retryable(res: Response): Promise<boolean> {
  if (res.status >= 500) return true;
  if (res.status !== 409) return false;
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    return body.code === 'idempotency.request_in_progress';
  } catch {
    return true;
  }
}

/**
 * Sends a write as part of `action`. The key stays for a retry when the outcome is unknown or
 * transient (network error, 409 still running, 5xx); any other answer ends the action. apiFetch's
 * own resend after a token refresh reuses the same headers, so the same key.
 */
export async function sendAction(
  store: Pick<SessionStore, 'apiFetch'>,
  action: ActionKey,
  input: string,
  init: RequestInit & { body?: string },
): Promise<Response> {
  const key = action.for({ input, method: init.method ?? 'GET', body: init.body ?? null });
  const res = await store.apiFetch(input, withIdempotencyKey(init, key));
  if (!(await retryable(res))) action.done();
  return res;
}
