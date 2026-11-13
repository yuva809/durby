/**
 * Base URL of invitation links (docs/platform/web-shell.md → Invitation links, ADR 0015 §12). The rule lives in
 * platform/auth since ADR 0041, which uses it for password and onboarding links too.
 */
export { inviteLinkBase } from '../auth';
