import { LOCALES } from '@durby/i18n';
import { z } from 'zod';
import { roleRefSchema } from './rbac';

/** Request and response bodies of /api/v1/auth (docs/platform/auth.md → Endpoints). */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Trimmed and lower-cased before validation, matching how the api stores emails. */
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
/** 32 random bytes, base64url (43 characters). */
const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const loginRequestSchema = z.object({
  email,
  // Only the upper bound here: existing passwords are checked as they are, policy applies on set.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const switchOrganizationRequestSchema = z.object({ organizationId: z.uuid() });

export const emailRequestSchema = z.object({ email });

export const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const resetPasswordRequestSchema = z.object({
  token: opaqueToken,
  password: newPasswordSchema,
});

export const verifyEmailRequestSchema = z.object({ token: opaqueToken });

/** Changing your own password (and the forced change of a temporary one, ADR 0023 §3). */
export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
});

/** PATCH /auth/me: the caller's own settings; today only the UI and mail language. */
export const updateMeRequestSchema = z.strictObject({ locale: z.enum(LOCALES) });

export const authUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  locale: z.string(),
});

export const organizationSummarySchema = z.object({ id: z.uuid(), name: z.string() });

export const meResponseSchema = z.object({
  user: authUserSchema,
  organizations: z.array(organizationSummarySchema),
  activeOrganizationId: z.uuid().nullable(),
  /**
   * The caller's role and effective permission keys in the active organization (null / [] without
   * one). UI hints only (ADR 0007, amendment): they can be stale until the next refresh, and the
   * api checks every permission per request.
   */
  activeRole: roleRefSchema.nullable(),
  activePermissions: z.array(z.string()),
  /**
   * Enabled feature keys of the active organization ([] without one or without a membership). UI
   * hint only (ADR 0009 §6): the api checks @RequireFeature per request. Defaults to [] so a web
   * build can talk to an api from before 1.5 (rollback, ADR 0004).
   */
  activeFeatures: z.array(z.string()).default([]),
  /**
   * The account has a temporary password set by an organization (ADR 0023 §3): until it is changed,
   * the api answers only the password change, /auth/me and logout. Defaults to false for an api from
   * before it (rollback, ADR 0004).
   */
  passwordChangeRequired: z.boolean().default(false),
});

export const sessionResponseSchema = meResponseSchema.extend({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
  /**
   * When this sign-in ends whatever happens (the 30-day cap, ADR 0006): the web asks the user to sign in again
   * beforehand. Optional for answers from an api without it (expand/contract).
   */
  sessionExpiresAt: z.iso.datetime().optional(),
});

/** Stable error codes of the auth endpoints; the web app shows the matching label. */
/**
 * Several accounts signed in on one browser (ADR 0047): each has its own refresh cookie, picked by this header on the
 * auth calls (0 … MAX_SIGNED_IN_ACCOUNTS - 1; none = 0, the cookie as before). The access token says who the caller is;
 * the slot only says which cookie to read or set.
 */
export const ACCOUNT_SLOT_HEADER = 'X-Durby-Account';
export const MAX_SIGNED_IN_ACCOUNTS = 5;

export const AUTH_ERROR_CODES = [
  'auth.unauthenticated',
  'auth.invalid_credentials',
  'auth.email_not_verified',
  'auth.too_many_attempts',
  'auth.rate_limited',
  'auth.refresh_invalid',
  'auth.refresh_reused',
  'auth.not_a_member',
  'auth.password_change_required',
  'auth.password_managed',
  'auth.origin_rejected',
  'auth.token_invalid',
  'auth.unavailable',
  'tenancy.context_missing',
  'validation.failed',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type SwitchOrganizationRequest = z.infer<typeof switchOrganizationRequestSchema>;
export type EmailRequest = z.infer<typeof emailRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
