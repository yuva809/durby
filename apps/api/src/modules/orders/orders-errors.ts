import { HttpStatus } from '@nestjs/common';
import type { DataImportProblemRow } from '@durby/shared';
import { ApiError } from '../../platform/http';

/** Error codes of the orders module (docs/modules/orders.md → Errors, ORDERS_ERROR_CODES). */
export const ordersErrors = {
  customerNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'orders.customer_not_found',
      'Customer not found or archived.',
    ),
  customerCodeTaken: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'orders.customer_code_taken',
      'Another active customer has this code.',
    ),
  orderNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'orders.order_not_found', 'Sales order not found.'),
  warehouseNotFound: () =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'orders.warehouse_not_found',
      'Warehouse not found or archived.',
    ),
  itemNotFound: (itemIds: string[]) =>
    new ApiError(
      HttpStatus.NOT_FOUND,
      'orders.item_not_found',
      'Some stock items are unknown, archived or have variants.',
      { itemIds },
    ),
  notEditable: () =>
    new ApiError(HttpStatus.CONFLICT, 'orders.not_editable', 'Only draft orders can be changed.'),
  invalidTransition: (from: string, to: string) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'orders.invalid_transition',
      `An order cannot go from ${from} to ${to}.`,
      { from, to },
    ),
  // Branch stock requests (ADR 0045).
  requestNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'orders.request_not_found', 'Stock request not found.'),
  mainOnly: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'orders.request_main_only',
      'Requests come from the main warehouse.',
    ),
  requestInvalid: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'orders.request_invalid',
      'Give every line once, within its quantity, and at least one above zero.',
    ),
  requestTransition: (from: string, to: string) =>
    new ApiError(
      HttpStatus.CONFLICT,
      'orders.request_transition',
      'The request has moved on meanwhile.',
      { from, to },
    ),
  requestNotYours: () =>
    new ApiError(
      HttpStatus.FORBIDDEN,
      'orders.request_not_yours',
      'This delivery is assigned to another driver.',
    ),
  driverNotFound: () =>
    new ApiError(HttpStatus.NOT_FOUND, 'orders.driver_not_found', 'This person cannot drive here.'),
  /** Import Data (ADR 0044 step 4): the rows' problems, refused as a whole. */
  importInvalid: (rows: DataImportProblemRow[]) =>
    new ApiError(HttpStatus.BAD_REQUEST, 'orders.import_invalid', 'Some import rows are invalid.', {
      rows,
    }),
  pickInvalid: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'orders.pick_invalid',
      'Give every line of the order once, picking at most what was ordered.',
    ),
};

/** Prisma's unique violation (here: the active customer code index). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
