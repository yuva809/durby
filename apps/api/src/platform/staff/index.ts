// Public API of platform/staff (ADR 0017): the authenticator used by the global guard, the staff of
// the current request, and the staff service for the create-staff command. Everything else is
// internal.
export { StaffAuthenticator } from './staff-authenticator';
export { StaffContext, type StaffContextValue } from './staff-context';
export { StaffModule } from './staff.module';
export { MIN_SUPER_ADMINS, StaffService } from './staff.service';
