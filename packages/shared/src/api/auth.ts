import { z } from 'zod';
import { roleRefSchema } from './rbac';

/** Request and response bodies of /api/v1/auth (docs/platform/auth.md → Endpoints). */

export const PASSWORD_MIN_LENGTH = 12;
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
   * hint only (ADR 0009 §6): the api checks @RequireFeature per request.
   */
  activeFeatures: z.array(z.string()),
});

export const sessionResponseSchema = meResponseSchema.extend({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
});

/** Stable error codes of the auth endpoints; the web app shows the matching label. */
export const AUTH_ERROR_CODES = [
  'auth.unauthenticated',
  'auth.invalid_credentials',
  'auth.email_not_verified',
  'auth.too_many_attempts',
  'auth.rate_limited',
  'auth.refresh_invalid',
  'auth.refresh_reused',
  'auth.not_a_member',
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
export type AuthUser = z.infer<typeof authUserSchema>;
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
