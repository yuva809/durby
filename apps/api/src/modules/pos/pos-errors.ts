import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../../platform/http';

/** Error codes of the pos module (docs/modules/pos.md → Errors). */
export const posErrors = {
  tableNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.table_not_found', 'Table not found.'),
  locationNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.location_not_found', 'Location not found.'),
  tableNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.table_name_taken',
      'This location already has a table with this name.',
    ),
};

/** Prisma's unique violation (here: the partial name index of the migration). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
