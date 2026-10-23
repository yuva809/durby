import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { SettingKey } from '@durby/shared';
import type { TenantTransactionClient } from '../../tenancy';

/** The exact scope of a stored value. */
export type SettingScopeRef =
  | { type: 'organization' }
  | { type: 'brand'; brandId: string }
  | { type: 'location'; locationId: string };

/**
 * Reports whether a module has data depending on a data-bound setting at a scope
 * (docs/platform/settings.md → Data-bound settings). Runs inside the write's transaction.
 */
export interface SettingInUseCheck {
  key: SettingKey;
  inUse(tx: TenantTransactionClient, scope: SettingScopeRef): Promise<boolean>;
}

/**
 * Registry of in-use checks. Modules register theirs in `onModuleInit` (platform never imports
 * modules, rule 5); writes of a data-bound key run every check for it. Registration closes at
 * application bootstrap, before the app serves requests, so no write ever runs with a check missing.
 */
@Injectable()
export class SettingInUseChecks implements OnApplicationBootstrap {
  private readonly checks: SettingInUseCheck[] = [];
  private closed = false;

  /** Call from `onModuleInit`; throws after bootstrap. */
  register(check: SettingInUseCheck): void {
    if (this.closed) {
      throw new Error(
        `In-use check for ${check.key} registered after bootstrap: register it in onModuleInit.`,
      );
    }
    this.checks.push(check);
  }

  onApplicationBootstrap(): void {
    this.closed = true;
  }

  async anyInUse(
    tx: TenantTransactionClient,
    key: SettingKey,
    scope: SettingScopeRef,
  ): Promise<boolean> {
    for (const check of this.checks) {
      if (check.key === key && (await check.inUse(tx, scope))) return true;
    }
    return false;
  }
}
