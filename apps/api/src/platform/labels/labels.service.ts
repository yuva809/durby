import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createTranslator,
  type Dictionary,
  type Locale,
  type Translator,
  type TranslatorOptions,
} from '@durby/i18n';
import { ClsService } from 'nestjs-cls';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../tenancy';
import {
  type LabelRows,
  resolveDictionary,
  resolveOverrides,
  type SkippedOverride,
} from './resolve';

const CLS_KEY = 'durby:labels';

interface Cached {
  tenantId: string;
  rows: Promise<LabelRows>;
}

/**
 * Labels of the current tenant (docs/platform/labels.md → Resolution). The tenant's overrides and
 * its partner's are loaded once per request (cached in the request's CLS scope), so a change
 * applies to the next request. Needs only a tenant context, so jobs and mailers use it inside
 * TenantContext.run(); without an active CLS scope nothing is cached.
 */
@Injectable()
export class LabelService {
  private readonly logger = new Logger(LabelService.name);

  constructor(
    private readonly cls: ClsService,
    private readonly tenantContext: TenantContext,
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
  ) {}

  /** Every label key resolved for `locale`. */
  async dictionary(locale: Locale): Promise<Dictionary> {
    return resolveDictionary(await this.rows(), locale, this.onSkipped());
  }

  /** t(key, params) for `locale` with the tenant's labels; `html` escapes template and params. */
  async translator(locale: Locale, options: TranslatorOptions = {}): Promise<Translator> {
    const overrides = resolveOverrides(await this.rows(), locale, this.onSkipped());
    return createTranslator(locale, overrides, options);
  }

  /** Drops the cached overrides (after changing them). */
  forget(): void {
    if (this.cls.isActive()) this.cls.set(CLS_KEY, undefined);
  }

  /** Never logs the value: it is the tenant's text. */
  private onSkipped(): (skipped: SkippedOverride) => void {
    const { tenantId } = this.tenantContext.require();
    return (skipped) => this.logger.warn({ tenantId, ...skipped }, 'Ignored stored label override');
  }

  private rows(): Promise<LabelRows> {
    const { tenantId } = this.tenantContext.require();
    const active = this.cls.isActive();
    const cached = active ? this.cls.get<Cached | undefined>(CLS_KEY) : undefined;
    if (cached && cached.tenantId === tenantId) return cached.rows;
    const rows = this.load(tenantId);
    if (active) this.cls.set<Cached>(CLS_KEY, { tenantId, rows });
    return rows;
  }

  private load(tenantId: string): Promise<LabelRows> {
    const select = { locale: true, key: true, value: true } as const;
    return this.db.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: tenantId },
        select: { partnerId: true },
      });
      const partner = organization
        ? await tx.partnerLabelOverride.findMany({
            where: { partnerId: organization.partnerId },
            select,
          })
        : [];
      const own = await tx.labelOverride.findMany({ where: { tenantId }, select });
      return { partner, organization: own };
    });
  }
}
