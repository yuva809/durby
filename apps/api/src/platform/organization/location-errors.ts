import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../http';

/** Error codes of the location endpoints (docs/platform/web-shell.md → Locations). */
export const locationErrors = {
  /** Unknown id, another tenant's id (RLS) or a bad UUID: the same code rbac uses. */
  notFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'rbac.location_not_found', 'Location not found.'),
  nameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'locations.name_taken',
      'The organization already has a location with this name.',
    ),
  inUse: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'locations.in_use',
      'The location is still used (members, settings, tables, areas or orders).',
    ),
};

/**
 * A foreign key still points at the row (`RESTRICT`): Prisma's P2003, or Postgres' 23503 when the
 * driver adapter passes it through.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, meta, cause } = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
    cause?: { originalCode?: unknown; code?: unknown };
  };
  return (
    code === 'P2003' ||
    code === '23503' ||
    meta?.driverAdapterError?.cause?.originalCode === '23503' ||
    cause?.originalCode === '23503' ||
    cause?.code === '23503'
  );
}
