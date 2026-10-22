import type { TenantTransactionClient } from '../tenancy';
import { rbacErrors } from './rbac-errors';

/**
 * The distinct ids, if every one is a location of the current tenant (RLS); 404
 * rbac.location_not_found otherwise, so another tenant's id is never stored or revealed.
 */
export async function existingLocations(
  tx: TenantTransactionClient,
  ids: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  const found = await tx.location.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw rbacErrors.locationNotFound();
  return unique;
}
