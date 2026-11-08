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
  areaNotFound: () => new ApiError(HttpStatus.NOT_FOUND, 'pos.area_not_found', 'Area not found.'),
  areaNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.area_name_taken',
      'This location already has an area with this name.',
    ),
  areaNotEmpty: () =>
    new ApiError(HttpStatus.CONFLICT, 'pos.area_not_empty', 'The area still has tables.'),
  menuNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.menu_not_found', 'This menu link is not valid.'),
  ticketNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.ticket_not_found', 'Ticket not found.'),
  ticketStatusInvalid: (status: string) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.ticket_status_invalid',
      'The ticket cannot move to this status from where it is.',
      { status },
    ),
  printerCommandNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'pos.printer_command_not_found',
      'Printer command not found.',
    ),
  printerCommandExpired: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.printer_command_expired',
      'The printer command expired.',
    ),
  printerCommandNotClaimed: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.printer_command_not_claimed',
      'This till is not running the printer command.',
    ),
  printerNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.printer_not_found', 'Printer not found.'),
  printerNameTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.printer_name_taken',
      'This location already has a printer with this name.',
    ),
  printerRequired: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'pos.printer_required',
      'A test print needs the printer it is for.',
    ),
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
