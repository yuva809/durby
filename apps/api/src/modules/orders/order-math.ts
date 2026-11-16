import Decimal from 'decimal.js';
import { SALES_ORDER_CANCELLABLE, type SalesOrderStatus } from '@durby/shared';

/** quantity × unit price, rounded half up to cents (CLAUDE.md rule 6: exact decimals, never floats). */
export function lineTotal(quantity: string, unitPrice: string): string {
  return new Decimal(quantity)
    .times(unitPrice)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/** The order total: the sum of its rounded line totals. */
export function orderTotal(lineTotals: readonly string[]): string {
  return lineTotals.reduce((sum, t) => sum.plus(t), new Decimal(0)).toFixed(2);
}

/** Where each status may go next (ADR 0044 §3–5); delivered, returned and cancelled are final. */
const NEXT: Readonly<Record<SalesOrderStatus, readonly SalesOrderStatus[]>> = {
  draft: ['confirmed'],
  confirmed: ['picking', 'packed'],
  picking: ['packed'],
  packed: ['dispatched'],
  dispatched: ['delivered', 'returned'],
  delivered: [],
  returned: [],
  cancelled: [],
};

/** Whether an order may move; cancel works up to packed (SALES_ORDER_CANCELLABLE). */
export function canMove(from: SalesOrderStatus, to: SalesOrderStatus): boolean {
  if (to === 'cancelled') return SALES_ORDER_CANCELLABLE.includes(from);
  return NEXT[from].includes(to);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opaque page cursor: base64url of the last order's uuid v7 id (like the audit log's). */
export const encodeCursor = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');

/** The id inside a cursor, or null if it isn't one. */
export function decodeCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  return UUID.test(id) ? id : null;
}
