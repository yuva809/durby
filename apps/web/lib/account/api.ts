import { type MeResponse, meResponseSchema, type UpdateMeRequest } from '@durby/shared';
import { type Api, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Your own profile (docs/platform/auth.md → Endpoints): today only the language. */
export const updateMe = (
  store: Api,
  action: ActionKey,
  body: UpdateMeRequest,
): Promise<Result<MeResponse | null>> =>
  write(store, action, '/api/v1/auth/me', 'PATCH', body, meResponseSchema);
