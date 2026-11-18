import type { TenantTransactionClient } from '../tenancy';

/**
 * The warehouses a member may be limited to (ADR 0057), as the inventory module knows them. Manage Staff checks a
 * member's warehouses through this port; platform code never reads module tables itself.
 */
export const WAREHOUSE_DIRECTORY = Symbol('WAREHOUSE_DIRECTORY');

export interface WarehouseDirectory {
  /** Of `ids`, the active warehouses other than the transit one, with their locations. */
  usable(
    ids: readonly string[],
    tx?: TenantTransactionClient,
  ): Promise<{ id: string; locationId: string }[]>;
}
