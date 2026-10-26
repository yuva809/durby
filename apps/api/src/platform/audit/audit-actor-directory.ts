/**
 * Emails of users who appear as actors, for display in the audit log (docs/platform/audit.md →
 * Endpoint). platform/audit depends only on tenancy; platform/auth owns users and provides this.
 * Emails are looked up when a page is read and never stored in audit rows (ADR 0008 §5).
 */
export const AUDIT_ACTOR_DIRECTORY = Symbol('AUDIT_ACTOR_DIRECTORY');

export interface AuditActorDirectory {
  /** userId → email, for the users that exist; missing ids are simply absent. */
  emails(userIds: readonly string[]): Promise<Map<string, string>>;
}
