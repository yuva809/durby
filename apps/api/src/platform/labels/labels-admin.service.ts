import { Inject, Injectable } from '@nestjs/common';
import {
  dictionaries,
  isLabelKey,
  isLocale,
  isOrgOverridable,
  type Locale,
  validateOverride,
} from '@durby/i18n';
import type { LabelOverride } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../audit';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';
import { labelsErrors } from './labels-errors';
import { LabelService } from './labels.service';
import { skipReason } from './resolve';

interface StoredRow {
  id: string;
  locale: string;
  key: string;
  value: string;
}

const ROW_SELECT = { id: true, locale: true, key: true, value: true } as const;

/**
 * The organization's label overrides (docs/platform/labels.md → API). Each change and its audit
 * row are written in one tenant transaction; no-ops write nothing.
 */
@Injectable()
export class LabelsAdmin {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly labels: LabelService,
    private readonly audit: AuditService,
  ) {}

  /** Stored overrides (all locales or one), sorted by key then locale. */
  async list(locale?: Locale): Promise<LabelOverride[]> {
    const rows = await this.db.labelOverride.findMany({
      where: locale === undefined ? {} : { locale },
      select: ROW_SELECT,
      orderBy: [{ key: 'asc' }, { locale: 'asc' }],
    });
    return rows.map(toResponse);
  }

  /** Sets the organization's text for `key` in `locale`; returns the stored override. */
  async set(locale: string, key: string, value: string): Promise<LabelOverride> {
    if (!isLocale(locale)) throw labelsErrors.unknownLocale(locale);
    if (!isLabelKey(key)) throw labelsErrors.unknownKey(key);
    if (!isOrgOverridable(key)) throw labelsErrors.notOverridable(key);
    const check = validateOverride(key, locale, value, 'organization');
    if (!check.ok) throw labelsErrors.invalidValue(key, locale, check);

    const { tenantId, userId } = this.tenantContext.require();
    const write = () =>
      this.db.$transaction(async (tx) => {
        const existing = await tx.labelOverride.findFirst({
          where: { tenantId, locale, key },
          select: ROW_SELECT,
        });
        if (existing?.value === value) return existing;
        const row = existing
          ? await tx.labelOverride.update({
              where: { id: existing.id },
              data: { value },
              select: ROW_SELECT,
            })
          : await tx.labelOverride.create({
              data: { tenantId, locale, key, value },
              select: ROW_SELECT,
            });
        await this.audit.record(tx, {
          action: existing ? 'platform.label_override.updated' : 'platform.label_override.created',
          actor: auditActor.user(userId),
          entityId: row.id,
          before: existing ? overrideSnapshot(existing) : null,
          after: overrideSnapshot(row),
        });
        return row;
      });
    let row: StoredRow;
    try {
      row = await write();
    } catch (error) {
      // A concurrent first write created the row: run again, which updates it (or is a no-op).
      if (!isUniqueViolation(error)) throw error;
      row = await write();
    }
    this.labels.forget();
    return toResponse(row);
  }

  /**
   * Removes the organization's text, so the partner's or the default applies again. No registry
   * checks: a row left behind by a removed key or locale can still be cleaned up. No row: nothing
   * happens.
   */
  async remove(locale: string, key: string): Promise<void> {
    const { tenantId, userId } = this.tenantContext.require();
    await this.db.$transaction(async (tx) => {
      const existing = await tx.labelOverride.findFirst({
        where: { tenantId, locale, key },
        select: ROW_SELECT,
      });
      if (!existing) return;
      await tx.labelOverride.delete({ where: { id: existing.id } });
      await this.audit.record(tx, {
        action: 'platform.label_override.deleted',
        actor: auditActor.user(userId),
        entityId: existing.id,
        before: overrideSnapshot(existing),
      });
    });
    this.labels.forget();
  }
}

function toResponse(row: StoredRow): LabelOverride {
  const defaultValue =
    isLocale(row.locale) && isLabelKey(row.key) ? dictionaries[row.locale][row.key] : null;
  return {
    locale: row.locale,
    key: row.key,
    value: row.value,
    defaultValue,
    active: skipReason(row, 'organization') === null,
  };
}

function overrideSnapshot(row: StoredRow) {
  return snapshot('label_override', {
    id: row.id,
    locale: row.locale,
    key: row.key,
    value: row.value,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
