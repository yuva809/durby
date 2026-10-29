import {
  apiErrorBodySchema,
  type InviteStaffRequest,
  type PlatformAuditResponse,
  platformAuditResponseSchema,
  type StaffEnrollResponse,
  staffEnrollResponseSchema,
  type StaffListResponse,
  staffListResponseSchema,
  type StaffLoginResponse,
  staffLoginResponseSchema,
  type StaffMeResponse,
  staffMeResponseSchema,
  type StaffMember,
  staffMemberSchema,
  type StaffRole,
} from '@durby/shared';
import type { Result, Schema } from '../api-call';
import type { ApiErrorCode } from '../auth/errors';

/**
 * Calls of the staff portal (docs/platform/admin-portal.md → API). Authenticated by the staff
 * session cookie (HttpOnly, path /api/v1/platform), never by the customer access token: plain
 * same-origin fetches, parsed with the shared schemas.
 */

export type StaffResult<T> = Result<T>;

const BASE = '/api/v1/platform';

async function call<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {},
  schema?: Schema<T>,
): Promise<StaffResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(init.body !== undefined && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(init.body),
      }),
    });
    if (!res.ok) {
      const body = apiErrorBodySchema.safeParse(await res.json().catch(() => null));
      return {
        ok: false,
        code: body.success ? (body.data.code as ApiErrorCode) : 'unknown',
      };
    }
    if (!schema) return { ok: true, data: null as T };
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, code: 'unknown' };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

export const staffApi = {
  me: (): Promise<StaffResult<StaffMeResponse>> => call('/auth/me', {}, staffMeResponseSchema),
  login: (email: string, password: string): Promise<StaffResult<StaffLoginResponse>> =>
    call('/auth/login', { method: 'POST', body: { email, password } }, staffLoginResponseSchema),
  accept: (token: string, password: string): Promise<StaffResult<StaffLoginResponse>> =>
    call('/auth/accept', { method: 'POST', body: { token, password } }, staffLoginResponseSchema),
  enroll: (): Promise<StaffResult<StaffEnrollResponse>> =>
    call('/auth/enroll', { method: 'POST' }, staffEnrollResponseSchema),
  confirmEnrollment: (code: string): Promise<StaffResult<null>> =>
    call('/auth/enroll/confirm', { method: 'POST', body: { code } }),
  verifyCode: (code: string): Promise<StaffResult<null>> =>
    call('/auth/totp', { method: 'POST', body: { code } }),
  reauth: (password: string, code: string): Promise<StaffResult<null>> =>
    call('/auth/reauth', { method: 'POST', body: { password, code } }),
  logout: (): Promise<StaffResult<null>> => call('/auth/logout', { method: 'POST' }),

  listStaff: (): Promise<StaffResult<StaffListResponse>> =>
    call('/staff', {}, staffListResponseSchema),
  invite: (body: InviteStaffRequest): Promise<StaffResult<StaffMember>> =>
    call('/staff/invitations', { method: 'POST', body }, staffMemberSchema),
  changeRole: (id: string, role: StaffRole): Promise<StaffResult<StaffMember>> =>
    call(`/staff/${id}`, { method: 'PATCH', body: { role } }, staffMemberSchema),
  deactivate: (id: string): Promise<StaffResult<StaffMember>> =>
    call(`/staff/${id}/deactivate`, { method: 'POST' }, staffMemberSchema),
  resetTwoFactor: (id: string): Promise<StaffResult<StaffMember>> =>
    call(`/staff/${id}/reset-2fa`, { method: 'POST' }, staffMemberSchema),

  audit: (cursor?: string): Promise<StaffResult<PlatformAuditResponse>> =>
    call(`/audit?limit=50${cursor ? `&cursor=${cursor}` : ''}`, {}, platformAuditResponseSchema),
};
