import { Inject, Injectable } from '@nestjs/common';
import type { PublicMenu, SettingKey, SettingValue } from '@durby/shared';
import { AuthRateLimits } from '../../platform/auth';
import { type ResolvedSettings, SettingsService } from '../../platform/config/settings';
import { EntitlementService } from '../../platform/config/entitlements';
import { OrganizationService } from '../../platform/organization';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { CatalogService } from '../catalog';
import { posErrors } from './pos-errors';

/** No user reads the public menu; audit and RLS only need an id. */
const ANONYMOUS = '00000000-0000-0000-0000-000000000000';

/** `<organizationId>.<menuToken>` (docs/modules/pos.md → QR menu), else null. */
export function parseMenuToken(
  token: string,
): { organizationId: string; menuToken: string } | null {
  const match =
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.([A-Za-z0-9_-]{24})$/.exec(
      token,
    );
  return match ? { organizationId: match[1]!.toLowerCase(), menuToken: match[2]! } : null;
}

/**
 * The menu a guest sees after scanning a table's QR code (ADR 0026). Reads in the organization the
 * token names (RLS), so a token never reaches another tenant's rows; an unknown token, an archived
 * table or an organization without `pos` are all "not found". No ids, VAT or staff data.
 */
@Injectable()
export class PublicMenuService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly limits: AuthRateLimits,
    private readonly entitlements: EntitlementService,
    private readonly settings: SettingsService,
    private readonly organization: OrganizationService,
    private readonly catalog: CatalogService,
  ) {}

  async menu(token: string, ip: string): Promise<PublicMenu> {
    await this.limits.enforce([this.limits.rules.publicMenuIp, ip]);
    const parsed = parseMenuToken(token);
    if (!parsed) throw posErrors.menuNotFound();
    return this.tenantContext.run(
      { tenantId: parsed.organizationId, userId: ANONYMOUS },
      async () => {
        const table = await this.db.diningTable.findFirst({
          where: { menuToken: parsed.menuToken, archivedAt: null },
          select: { name: true, locationId: true },
        });
        if (!table || !(await this.entitlements.isEnabled('pos'))) throw posErrors.menuNotFound();
        const [resolved, organizationName, categories, products] = await Promise.all([
          this.settings.all({ locationId: table.locationId }),
          this.organization.name(),
          this.catalog.listCategories({ includeArchived: false }),
          this.catalog.listProducts({ includeArchived: false }),
        ]);
        const header = setting(resolved, 'pos.billHeader');
        return {
          name: header.name ?? organizationName,
          logo: header.logo,
          tableName: table.name,
          currency: setting(resolved, 'currency'),
          locale: setting(resolved, 'locale'),
          categories: categories
            .map((category) => ({
              name: category.name,
              products: products
                .filter((p) => p.categoryId === category.id)
                .map((p) => ({ name: p.name, description: p.description, price: p.price })),
            }))
            .filter((category) => category.products.length > 0),
        };
      },
    );
  }
}

/** A resolved value; every registered key resolves (code default at the latest). */
function setting<K extends SettingKey>(resolved: ResolvedSettings, key: K): SettingValue<K> {
  return resolved.get(key)?.value as SettingValue<K>;
}
