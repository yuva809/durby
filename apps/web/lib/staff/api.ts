import {
  apiErrorBodySchema,
  type CustomerDetail,
  customerDetailSchema,
  type CustomerListResponse,
  customerListResponseSchema,
  type CustomerEntitlements,
  customerEntitlementsSchema,
  type FeatureCatalogResponse,
  featureCatalogResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type InviteStaffRequest,
  type OnboardCustomerRequest,
  type OnboardingOptionsResponse,
  onboardingOptionsResponseSchema,
  type PlanKey,
  type PlatformAuditResponse,
  type SetFeatureRequest,
  platformAuditResponseSchema,
  type StaffListResponse,
  staffListResponseSchema,
  type StaffMeResponse,
  staffMeResponseSchema,
  type StaffMember,
  staffMemberSchema,
  type StaffRole,
} from '@durby/shared';
import { type Schema, WRITE_TIMEOUT_MS } from '../api-call';
import type { ApiErrorCode } from '../auth/errors';

/**
 * Calls of the staff portal (docs/platform/admin-portal.md → API). Authenticated by the staff
 * session cookie (HttpOnly, path /api/v1/platform), never by the customer access token: plain
 * same-origin fetches, parsed with the shared schemas. A failure keeps the error's `details` (e.g.
 * what a duplicate warning is about); the UI shows the code's label.
 */
export type StaffResult<T> =
  { ok: true; data: T } | { ok: false; code: ApiErrorCode | 'unknown'; details?: unknown };

const BASE = '/api/v1/platform';

async function call<T>(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
  schema?: Schema<T>,
): Promise<StaffResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      // Writes only; a timed-out write may still have been applied (see WRITE_TIMEOUT_MS).
      ...(init.method &&
        init.method !== 'GET' && { signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) }),
      headers: {
        ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
    if (!res.ok) {
      const body = apiErrorBodySchema.safeParse(await res.json().catch(() => null));
      return body.success
        ? { ok: false, code: body.data.code as ApiErrorCode, details: body.data.details }
        : { ok: false, code: 'unknown' };
    }
    if (!schema) return { ok: true, data: null as T };
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, code: 'unknown' };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

/** One call to /api/v1/platform (pages with a single call of their own use it directly). */
export const staffCall = call;

export const staffApi = {
  me: (): Promise<StaffResult<StaffMeResponse>> => call('/auth/me', {}, staffMeResponseSchema),
  login: (email: string, password: string): Promise<StaffResult<null>> =>
    call('/auth/login', { method: 'POST', body: { email, password } }),
  accept: (token: string, password: string): Promise<StaffResult<null>> =>
    call('/auth/accept', { method: 'POST', body: { token, password } }),
  reauth: (password: string): Promise<StaffResult<null>> =>
    call('/auth/reauth', { method: 'POST', body: { password } }),
  logout: (): Promise<StaffResult<null>> => call('/auth/logout', { method: 'POST' }),

  listStaff: (): Promise<StaffResult<StaffListResponse>> =>
    call('/staff', {}, staffListResponseSchema),
  invite: (body: InviteStaffRequest): Promise<StaffResult<StaffMember>> =>
    call('/staff/invitations', { method: 'POST', body }, staffMemberSchema),
  changeRole: (id: string, role: StaffRole): Promise<StaffResult<StaffMember>> =>
    call(`/staff/${id}`, { method: 'PATCH', body: { role } }, staffMemberSchema),
  deactivate: (id: string): Promise<StaffResult<StaffMember>> =>
    call(`/staff/${id}/deactivate`, { method: 'POST' }, staffMemberSchema),

  customers: (query = ''): Promise<StaffResult<CustomerListResponse>> =>
    call(
      `/customers${query ? `?query=${encodeURIComponent(query)}` : ''}`,
      {},
      customerListResponseSchema,
    ),
  customer: (id: string): Promise<StaffResult<CustomerDetail>> =>
    call(`/customers/${id}`, {}, customerDetailSchema),
  onboardingOptions: (): Promise<StaffResult<OnboardingOptionsResponse>> =>
    call('/onboarding-options', {}, onboardingOptionsResponseSchema),
  /** `key`: one per submit, kept when the same request is retried (after a re-confirmation). */
  onboard: (body: OnboardCustomerRequest, key: string): Promise<StaffResult<CustomerDetail>> =>
    call(
      '/customers',
      { method: 'POST', body, headers: { [IDEMPOTENCY_KEY_HEADER]: key } },
      customerDetailSchema,
    ),
  resendOwnerInvite: (id: string): Promise<StaffResult<CustomerDetail>> =>
    call(`/customers/${id}/owner-invite`, { method: 'POST' }, customerDetailSchema),

  /** Modules (step 1d): the registry as the portal renders it, and one customer's switches. */
  featureCatalog: (): Promise<StaffResult<FeatureCatalogResponse>> =>
    call('/feature-catalog', {}, featureCatalogResponseSchema),
  entitlements: (id: string): Promise<StaffResult<CustomerEntitlements>> =>
    call(`/customers/${id}/entitlements`, {}, customerEntitlementsSchema),
  setPlan: (
    id: string,
    plan: PlanKey,
    reason: string,
  ): Promise<StaffResult<CustomerEntitlements>> =>
    call(
      `/customers/${id}/plan`,
      { method: 'PUT', body: { plan, reason } },
      customerEntitlementsSchema,
    ),
  setFeature: (
    id: string,
    key: string,
    body: SetFeatureRequest,
  ): Promise<StaffResult<CustomerEntitlements>> =>
    call(
      `/customers/${id}/features/${encodeURIComponent(key)}`,
      { method: 'PUT', body },
      customerEntitlementsSchema,
    ),
  /** POST with the reason in the body (not DELETE: proxies may drop a DELETE body). */
  resetFeature: (
    id: string,
    key: string,
    reason: string,
  ): Promise<StaffResult<CustomerEntitlements>> =>
    call(
      `/customers/${id}/features/${encodeURIComponent(key)}/reset`,
      { method: 'POST', body: { reason } },
      customerEntitlementsSchema,
    ),

  audit: (cursor?: string): Promise<StaffResult<PlatformAuditResponse>> =>
    call(`/audit?limit=50${cursor ? `&cursor=${cursor}` : ''}`, {}, platformAuditResponseSchema),
};
