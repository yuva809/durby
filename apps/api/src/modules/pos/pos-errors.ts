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
  tableOccupied: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.table_occupied',
      'That table already has an open order.',
    ),
  tableArchived: () =>
    new ApiError(HttpStatus.CONFLICT, 'pos.table_archived', 'That table is archived.'),
  mergeSameOrder: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.merge_same_order',
      'An order cannot be merged into itself.',
    ),
  orderNotSameLocation: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.order_not_same_location',
      'The order and the table are at different locations.',
    ),
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
  floorPlanNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'pos.floor_plan_not_found',
      'This floor plan version does not exist.',
    ),
  floorPlanChanged: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.floor_plan_changed',
      'The floor plan was saved by someone else in the meantime.',
    ),
  floorPlanTableInvalid: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.floor_plan_table_invalid',
      'A table on the plan is not in this area or out of service.',
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
  printJobNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.print_job_not_found', 'Print job not found.'),
  printJobNotClaimed: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.print_job_not_claimed',
      'This till is not printing the job.',
    ),
  printJobNotReprintable: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.print_job_not_reprintable',
      'Only a job that may have printed or could not print is reprinted.',
    ),
  voidExceeds: (lineId: string) =>
    new ApiError(HttpStatus.CONFLICT, 'pos.void_exceeds', 'More than is left of the item.', {
      lineId,
    }),
  // Bills and guest checks (docs/modules/pos.md → Step 4, ADR 0036).
  billNotFound: () => new ApiError(HttpStatus.NOT_FOUND, 'pos.bill_not_found', 'Bill not found.'),
  checkNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.check_not_found', 'Guest check not found.'),
  nothingToBill: () =>
    new ApiError(HttpStatus.CONFLICT, 'pos.nothing_to_bill', 'Nothing is left to bill.'),
  lineBilled: (lineId: string) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.line_billed',
      'Part of the item is on a bill; cancel the bill first.',
      { lineId },
    ),
  discountNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'pos.discount_not_found', 'Discount not found.'),
  discountInvalid: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.discount_invalid',
      'The discount does not fit the items still to bill.',
    ),
  discountExists: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.discount_exists',
      'The item or order already has a discount.',
    ),
  discountLineWhole: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.discount_line_whole',
      'A discounted item is billed whole, all of it at once.',
    ),
  discountActive: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.discount_active',
      'Remove the discount before voiding a discounted item.',
    ),
  ordersNotSameLocation: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'pos.orders_not_same_location',
      'A bill covers orders of one location only.',
    ),
};

/** Prisma's unique violation (here: the partial name index of the migration). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
