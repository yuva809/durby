// Public API of platform/auth: route markers, the current user, the authenticator used by the
// global guard, revocation and the user directory (ADR 0007). Everything else is internal.
export { AuthContext, type AuthContextValue } from './auth-context';
export { AuthModule } from './auth.module';
export { Authenticator } from './authenticator';
export { Authenticated, IS_AUTHENTICATED_KEY } from './authenticated.decorator';
export { IS_PUBLIC_KEY, Public } from './public.decorator';
export { RevocationService } from './revocation.service';
export { type UserProfile, UserDirectory } from './user-directory';

// Bootstrap commands (src/cli) only.
export { PasswordService } from './password.service';
