// Public API of platform/auth: route markers and the current user. Everything else is internal.
export { AuthContext, type AuthContextValue } from './auth-context';
export { AuthModule } from './auth.module';
export { Authenticator } from './authenticator';
export { Authenticated, IS_AUTHENTICATED_KEY } from './authenticated.decorator';
export { IS_PUBLIC_KEY, Public } from './public.decorator';

// Bootstrap commands (src/cli) only.
export { PasswordService } from './password.service';
export { type Ensured, ProvisioningService } from './provisioning.service';
