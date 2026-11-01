import { Inject, Injectable } from '@nestjs/common';
import {
  isSettingKey,
  type NewEvent,
  type PermissionKey,
  SETTINGS,
  type SettingKey,
  settingAllowsScope,
  type TenantSettingScope,
} from '@durby/shared';
import { auditActor, AuditService, canonicalJson, snapshot } from '../../audit';
import type { Prisma } from '../../database/generated/client';
import { issuesOf } from '../../http';
import { OutboxService } from '../../outbox';
import { AccessService } from '../../rbac';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../tenancy';
import { SettingInUseChecks, type SettingScopeRef } from './in-use';
import type { ResolvedSettingValue } from './resolve';
import { settingsErrors } from './settings-errors';
import { type SettingsAt, SettingsService, targetOf } from './settings.service';

const MANAGE = 'platform.settings.manage';

/**
 * A module's own permission key that may stand in for platform.settings.manage (ADR 0020): only for
 * that module's own `module.*` keys, and only at a location.
 */
export interface DelegatedSettingsWrite {
  permission: PermissionKey;
}

interface StoredRow {
  id: string;
  key: string;
  scopeType: TenantSettingScope;
  brandId: string | null;
  locationId: string | null;
  value: unknown;
}

/**
 * Sets and removes setting values at one scope (docs/platform/settings.md → API). Each change and
 * its audit row are written in one tenant transaction; no-ops write nothing. Data-bound keys run
 * the registered in-use checks first.
 */
@Injectable()
export class SettingsAdmin {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly inUse: SettingInUseChecks,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Sets `value` at exactly `at`; returns the key resolved there. */
  async set(
    rawKey: string,
    at: SettingsAt,
    value: unknown,
    delegated?: DelegatedSettingsWrite,
  ): Promise<ResolvedSettingValue> {
    const key = requireKey(rawKey);
    const scope = scopeOf(at);
    if (!settingAllowsScope(key, scope.type)) {
      throw settingsErrors.scopeNotAllowed(key, scope.type, SETTINGS[key].scopes);
    }
    const parsed = SETTINGS[key].schema.safeParse(value);
    if (!parsed.success) throw settingsErrors.invalidValue(key, issuesOf(parsed.error));
    await this.assertMayManage(key, at, delegated);

    const { tenantId, userId } = this.tenantContext.require();
    const write = () =>
      this.db.$transaction(async (tx) => {
        await targetOf(tx, at);
        const existing = await findStored(tx, tenantId, key, scope);
        const stored = parsed.data as Prisma.InputJsonValue;
        if (existing && canonicalJson(existing.value) === canonicalJson(stored)) return;
        await this.assertNotInUse(tx, key, scope);
        const row = existing
          ? await tx.settingValue.update({
              where: { id: existing.id },
              data: { value: stored },
              select: ROW_SELECT,
            })
          : await tx.settingValue.create({
              data: { tenantId, key, value: stored, ...columnsOf(scope) },
              select: ROW_SELECT,
            });
        await this.audit.record(tx, {
          action: existing ? 'platform.setting_value.updated' : 'platform.setting_value.created',
          actor: auditActor.user(userId),
          entityId: row.id,
          before: existing ? valueSnapshot(existing) : null,
          after: valueSnapshot(row),
        });
        await this.outbox.add(tx, changedEvent(tenantId, key, scope));
      });
    try {
      await write();
    } catch (error) {
      // A concurrent first write created the row: run again, which updates it (or is a no-op).
      if (!isUniqueViolation(error)) throw error;
      await write();
    }
    this.settings.forget();
    return (await this.settings.all(at)).get(key) as ResolvedSettingValue;
  }

  /** Removes the value at exactly `at`, so the scope inherits again. No value: nothing happens. */
  async remove(rawKey: string, at: SettingsAt, delegated?: DelegatedSettingsWrite): Promise<void> {
    const key = requireKey(rawKey);
    const scope = scopeOf(at);
    // No scope check: a value left at a scope the key no longer allows can still be cleaned up.
    await this.assertMayManage(key, at, delegated);
    const { tenantId, userId } = this.tenantContext.require();
    await this.db.$transaction(async (tx) => {
      await targetOf(tx, at);
      const existing = await findStored(tx, tenantId, key, scope);
      if (!existing) return;
      await this.assertNotInUse(tx, key, scope);
      await tx.settingValue.delete({ where: { id: existing.id } });
      await this.audit.record(tx, {
        action: 'platform.setting_value.deleted',
        actor: auditActor.user(userId),
        entityId: existing.id,
        before: valueSnapshot(existing),
      });
      await this.outbox.add(tx, changedEvent(tenantId, key, scope));
    });
    this.settings.forget();
  }

  /**
   * Location values: the key at that location. Organization and brand: for all locations. A
   * delegated write checks the module's key at the location instead (ADR 0020); asking for anything
   * else is a programming error.
   */
  private assertMayManage(
    key: SettingKey,
    at: SettingsAt,
    delegated?: DelegatedSettingsWrite,
  ): Promise<void> {
    if (delegated) {
      const module = delegated.permission.split('.')[0];
      if (at.locationId === undefined || !key.startsWith(`${module}.`)) {
        throw new Error(`${delegated.permission} can't write ${key} at this scope (ADR 0020)`);
      }
      return this.access.assert(delegated.permission, { locationId: at.locationId });
    }
    return at.locationId !== undefined
      ? this.access.assert(MANAGE, { locationId: at.locationId })
      : this.access.assert(MANAGE);
  }

  private async assertNotInUse(
    tx: TenantTransactionClient,
    key: SettingKey,
    scope: SettingScopeRef,
  ): Promise<void> {
    if (SETTINGS[key].dataBound && (await this.inUse.anyInUse(tx, key, scope))) {
      throw settingsErrors.inUse(key);
    }
  }
}

const ROW_SELECT = {
  id: true,
  key: true,
  scopeType: true,
  brandId: true,
  locationId: true,
  value: true,
} as const;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

function requireKey(key: string): SettingKey {
  if (!isSettingKey(key)) throw settingsErrors.unknownKey(key);
  return key;
}

/** `config.settings.changed` for a change at `scope` (docs/platform/outbox.md). */
function changedEvent(tenantId: string, key: SettingKey, scope: SettingScopeRef): NewEvent {
  const scopeId =
    scope.type === 'location'
      ? scope.locationId
      : scope.type === 'brand'
        ? scope.brandId
        : tenantId;
  return { type: 'config.settings.changed', payload: { scope: scope.type, scopeId, key } };
}

export function scopeOf(at: SettingsAt): SettingScopeRef {
  if (at.locationId !== undefined) return { type: 'location', locationId: at.locationId };
  if (at.brandId !== undefined) return { type: 'brand', brandId: at.brandId };
  return { type: 'organization' };
}

function columnsOf(scope: SettingScopeRef) {
  return {
    scopeType: scope.type,
    brandId: scope.type === 'brand' ? scope.brandId : null,
    locationId: scope.type === 'location' ? scope.locationId : null,
  };
}

function findStored(
  tx: TenantTransactionClient,
  tenantId: string,
  key: SettingKey,
  scope: SettingScopeRef,
): Promise<StoredRow | null> {
  return tx.settingValue.findFirst({
    where: { tenantId, key, ...columnsOf(scope) },
    select: ROW_SELECT,
  });
}

function valueSnapshot(row: StoredRow) {
  return snapshot('setting_value', {
    id: row.id,
    key: row.key,
    scopeType: row.scopeType,
    brandId: row.brandId,
    locationId: row.locationId,
    value: canonicalJson(row.value),
  });
}
