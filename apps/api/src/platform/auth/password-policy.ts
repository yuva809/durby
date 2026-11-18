import { Inject, Injectable } from '@nestjs/common';
import { TenantContext } from '../tenancy';

/** The settings this policy reads, provided by the settings module (auth does not import it). */
export const PASSWORD_POLICY_SETTINGS = Symbol('PASSWORD_POLICY_SETTINGS');

export interface PasswordPolicySettings {
  get(key: 'team.adminsManageSignIn'): Promise<boolean>;
}

/**
 * Passwords set by owners and admins (ADR 0052): with `team.adminsManageSignIn` on in the organization that
 * created an account, that account's password is managed there. It is never temporary (no "choose your own
 * password" step), and the person can neither change nor reset it themselves. Accounts that signed up or joined
 * by invitation are never managed.
 */
@Injectable()
export class PasswordPolicy {
  constructor(
    @Inject(PASSWORD_POLICY_SETTINGS) private readonly settings: PasswordPolicySettings,
    private readonly tenantContext: TenantContext,
  ) {}

  async managed(user: { id: string; vouchedByOrganizationId: string | null }): Promise<boolean> {
    const organizationId = user.vouchedByOrganizationId;
    if (organizationId === null) return false;
    return this.tenantContext.run({ tenantId: organizationId, userId: user.id }, () =>
      this.settings.get('team.adminsManageSignIn'),
    );
  }

  /** Whether the person still has to replace a temporary password: never where passwords are managed. */
  async changeRequired(user: {
    id: string;
    mustChangePassword: boolean;
    vouchedByOrganizationId: string | null;
  }): Promise<boolean> {
    return user.mustChangePassword && !(await this.managed(user));
  }
}
