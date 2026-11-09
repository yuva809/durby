// Public API of platform/auth: route markers, the current user, the authenticator used by the
// global guard, revocation and the user directory (ADR 0007). Everything else is internal.
export { ACTIVE_ACCESS_LOOKUP, type ActiveAccess, type ActiveAccessLookup } from './active-access';
export { AuthContext, type AuthContextValue } from './auth-context';
export { authErrors } from './auth-errors';
export { AuthRateLimits } from './auth-rate-limits';
export { AuthModule } from './auth.module';
export { Authenticator } from './authenticator';
export { Authenticated, IS_AUTHENTICATED_KEY } from '../markers';
export { Clock } from './clock';
export { emailKey, generateToken, hashToken, normalizeEmail } from './crypto';
export { IS_PUBLIC_KEY, Public } from '../markers';
export { LockoutService, LockoutUnavailableError } from './lockout.service';
export { RequireOrigin } from './origin.guard';
export { PasswordHasher } from './password-hasher';
export { RevocationService } from './revocation.service';
export { SecurityLog } from './security-log';
export { SessionStatus } from './session-status';
export { type UserProfile, UserDirectory } from './user-directory';

// Bootstrap commands (src/cli) only.
export { PasswordService } from './password.service';
