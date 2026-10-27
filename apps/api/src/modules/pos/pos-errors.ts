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
  orderNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.order_not_found', 'Order not found.'),
  orderClosed: () => new ApiError(HttpStatus.CONFLICT, 'pos.order_closed', 'The order is closed.'),
  productUnavailable: (productIds: string[]) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.product_unavailable',
      'Some products are unknown or archived.',
      { productIds },
    ),
  lineNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.line_not_found', 'Not a sent item of this order.'),
  voidExceeds: (lineId: string) =>
    new ApiError(HttpStatus.CONFLICT, 'pos.void_exceeds', 'More than is left of the item.', {
      lineId,
    }),
};

/** Prisma's unique violation (here: the partial name index of the migration). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
