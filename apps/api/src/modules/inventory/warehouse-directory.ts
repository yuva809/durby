import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { WAREHOUSE_DIRECTORY, type WarehouseDirectory } from '../../platform/rbac';
import {
  TENANT_PRISMA,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';

/** The warehouses Manage Staff may limit a member to (ADR 0057): active, not the transit one. */
@Injectable()
export class InventoryWarehouseDirectory implements WarehouseDirectory {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient) {}

  async usable(
    ids: readonly string[],
    tx?: TenantTransactionClient,
  ): Promise<{ id: string; locationId: string }[]> {
    if (ids.length === 0) return [];
    const where = { id: { in: [...ids] }, archivedAt: null, isTransit: false };
    const select = { id: true, locationId: true } as const;
    return tx
      ? tx.warehouse.findMany({ where, select })
      : this.db.warehouse.findMany({ where, select });
  }
}

/** Offers the directory to platform/rbac, which can't import this module (ADR 0007). */
@Global()
@Module({
  providers: [
    InventoryWarehouseDirectory,
    { provide: WAREHOUSE_DIRECTORY, useExisting: InventoryWarehouseDirectory },
  ],
  exports: [WAREHOUSE_DIRECTORY],
})
export class InventoryWarehouseDirectoryModule {}
