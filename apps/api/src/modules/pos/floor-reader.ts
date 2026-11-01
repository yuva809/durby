import { Inject, Injectable } from '@nestjs/common';
import type { TableColor, TableShape } from '@durby/shared';
import { z } from 'zod';
import {
  TENANT_PRISMA,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';

/** A dining table as other modules see it (docs/modules/reservations.md → R0.3). */
export interface FloorTable {
  id: string;
  locationId: string;
  name: string;
  seats: number;
  areaId: string | null;
  /** The area's name, or null without an area. */
  area: string | null;
  shape: TableShape;
  color: TableColor;
  sortOrder: number;
  archivedAt: Date | null;
}

/** An open order holding a table. */
export interface OpenOrderRef {
  tableId: string;
  orderId: string;
  openedAt: Date;
  /** Guests at the table, or null when not recorded. */
  covers: number | null;
}

const TABLE_SELECT = {
  id: true,
  locationId: true,
  name: true,
  seats: true,
  areaId: true,
  // The area record, not the expand-phase text column `area` (dropped by a contract migration).
  diningArea: { select: { name: true } },
  shape: true,
  color: true,
  sortOrder: true,
  archivedAt: true,
} as const;

const FLOOR_ORDER = [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }] as const;

const uuid = z.uuid();

/**
 * pos's read port for other modules (reservations, ADR 0019 §7): tables and which of them an open
 * order holds. Reads only, in the current tenant (RLS); it checks no permission keys, so callers
 * check their own at the location before calling. pos never imports its consumers.
 */
@Injectable()
export class PosFloorReader {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient) {}

  /**
   * The location's tables in service (not archived), in floor order. Pass the caller's `tx` to read
   * in its transaction (one snapshot with the caller's other reads).
   */
  async tablesAt(locationId: string, tx?: TenantTransactionClient): Promise<FloorTable[]> {
    if (!uuid.safeParse(locationId).success) return [];
    const rows = await (tx ?? this.db).diningTable.findMany({
      where: { locationId, archivedAt: null },
      select: TABLE_SELECT,
      orderBy: [...FLOOR_ORDER],
    });
    return rows.map(toFloorTable);
  }

  /** One table, archived or not; null if it doesn't exist in this tenant. */
  async table(id: string): Promise<FloorTable | null> {
    if (!uuid.safeParse(id).success) return null;
    const row = await this.db.diningTable.findUnique({ where: { id }, select: TABLE_SELECT });
    return row ? toFloorTable(row) : null;
  }

  /** The location's open orders, one per table at most, in floor order of their tables; `tx` as above. */
  async openOrders(locationId: string, tx?: TenantTransactionClient): Promise<OpenOrderRef[]> {
    if (!uuid.safeParse(locationId).success) return [];
    const rows = await (tx ?? this.db).posOrder.findMany({
      where: { locationId, status: 'open' },
      select: { id: true, tableId: true, openedAt: true, covers: true },
      orderBy: [{ table: { sortOrder: 'asc' } }, { table: { name: 'asc' } }, { tableId: 'asc' }],
    });
    return rows.map((r) => ({
      tableId: r.tableId,
      orderId: r.id,
      openedAt: r.openedAt,
      covers: r.covers,
    }));
  }
}

function toFloorTable(row: {
  id: string;
  locationId: string;
  name: string;
  seats: number;
  areaId: string | null;
  diningArea: { name: string } | null;
  shape: TableShape;
  color: TableColor;
  sortOrder: number;
  archivedAt: Date | null;
}): FloorTable {
  const { diningArea, ...table } = row;
  return { ...table, area: diningArea?.name ?? null };
}
