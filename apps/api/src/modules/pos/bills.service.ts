import { Inject, Injectable } from '@nestjs/common';
import {
  type Bill,
  type CancelBillRequest,
  CHECKS_PAGE_SIZE,
  type CheckLine,
  type CheckListResponse,
  type CreateBillRequest,
  type GuestCheck,
  type ListChecksQuery,
  RECENT_CHECKS_HOURS,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { Clock } from '../../platform/auth';
import { IdempotencyService } from '../../platform/idempotency';
import { NumberingService } from '../../platform/numbering';
import { AccessService, MemberNames } from '../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantDb,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import Decimal from 'decimal.js';
import { billedByLine, remainingOf, unbilledOf } from './billing';
import { activeDiscounts } from './discounts.service';
import { orderTotals } from './order-totals';
import { currentOrderByTicket } from './ticket-placements';
import { posErrors } from './pos-errors';

/** Prisma returns `numeric` columns as Decimal objects; only their exact text is used here. */
type DecimalValue = { toFixed(digits: number): string };

const BILL_SELECT = {
  id: true,
  locationId: true,
  kind: true,
  shareCount: true,
  createdAt: true,
  cancellation: { select: { createdAt: true } },
  orders: { select: { orderId: true }, orderBy: { orderId: 'asc' } },
  checks: {
    select: { id: true, number: true, shareIndex: true, gross: true },
    orderBy: { shareIndex: 'asc' },
  },
} as const;

interface BillRow {
  id: string;
  locationId: string;
  kind: 'single' | 'equal';
  shareCount: number | null;
  createdAt: Date;
  cancellation: { createdAt: Date } | null;
  orders: { orderId: string }[];
  checks: { id: string; number: string; shareIndex: number; gross: DecimalValue }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bills and guest checks (docs/modules/pos.md → Step 4, ADR 0036). A bill takes items of open orders of one
 * location and prints a numbered guest check; everything is append-only, a cancellation is a row of its own. Keys
 * are location-scoped and checked at the bill's location: what the caller can't read doesn't exist for them (404).
 * Billing locks the orders (in id order), so bills, voids and other bills of the same orders run one at a time.
 */
@Injectable()
export class BillsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly numbering: NumberingService,
    private readonly memberNames: MemberNames,
    private readonly clock: Clock,
  ) {}

  /** Bills the chosen portions, or everything unbilled, of open orders of one location. */
  async create(body: CreateBillRequest): Promise<Bill> {
    const { tenantId, userId } = this.tenantContext.require();
    const locationId = await this.billableLocation(body.orderIds);
    const orderIds = [...body.orderIds].sort();
    return this.db.$transaction(async (tx) => {
      for (const orderId of orderIds) {
        if ((await lockOrder(tx, orderId)) !== 'open') throw posErrors.orderClosed();
      }
      const byTicket = await currentOrderByTicket(tx, orderIds);
      const [rawLines, billedItems] = await Promise.all([
        tx.posOrderLine.findMany({
          where: { ticketId: { in: [...byTicket.keys()] } },
          select: {
            id: true,
            ticketId: true,
            productName: true,
            unitPrice: true,
            taxRate: true,
            quantity: true,
            voidsLineId: true,
          },
          orderBy: { id: 'asc' },
        }),
        tx.posBillItem.findMany({
          where: { orderId: { in: orderIds }, bill: { cancellation: null } },
          select: { orderLineId: true, quantity: true },
        }),
      ]);
      // A line bills under the order its ticket is in now (ADR 0069).
      const lines = rawLines.map((l) => ({ ...l, orderId: byTicket.get(l.ticketId) ?? '' }));
      const unbilled = unbilledOf(remainingOf(lines), billedByLine(billedItems));
      const sent = new Map(lines.filter((l) => l.quantity > 0).map((l) => [l.id, l]));
      const picks: { line: (typeof lines)[number]; quantity: number }[] = [];
      if (body.items) {
        for (const { orderLineId, quantity } of body.items) {
          const line = sent.get(orderLineId);
          if (!line) throw posErrors.lineNotFound();
          if (quantity > (unbilled.get(orderLineId) ?? 0)) throw posErrors.lineBilled(orderLineId);
          picks.push({ line, quantity });
        }
      } else {
        for (const line of sent.values()) {
          const quantity = unbilled.get(line.id) ?? 0;
          if (quantity > 0) picks.push({ line, quantity });
        }
      }
      if (picks.length === 0) throw posErrors.nothingToBill();
      // A discounted line is billed whole, all of it at once (ADR 0036 §5).
      const discounts = new Map<string, Decimal>();
      for (const orderId of orderIds) {
        for (const [lineId, amount] of (await activeDiscounts(tx, orderId)).lineAmount) {
          discounts.set(lineId, amount);
        }
      }
      for (const { line, quantity } of picks) {
        if (discounts.has(line.id) && quantity !== (unbilled.get(line.id) ?? 0)) {
          throw posErrors.discountLineWhole();
        }
      }

      const bill = await tx.posBill.create({
        data: {
          tenantId,
          locationId,
          kind: body.shares ? 'equal' : 'single',
          shareCount: body.shares ?? null,
          createdByUserId: userId,
        },
        select: { id: true },
      });
      await tx.posBillOrder.createMany({
        data: orderIds.map((orderId) => ({ tenantId, billId: bill.id, orderId, locationId })),
      });
      await tx.posBillItem.createMany({
        data: picks.map(({ line, quantity }) => ({
          tenantId,
          billId: bill.id,
          orderId: line.orderId,
          orderLineId: line.id,
          productName: line.productName,
          unitPrice: line.unitPrice.toFixed(2),
          taxRate: line.taxRate.toFixed(2),
          quantity,
          discountAmount: (discounts.get(line.id) ?? new Decimal(0)).toFixed(2),
        })),
      });
      const priced = picks.map(({ line, quantity }) => ({
        unitPrice: line.unitPrice.toFixed(2),
        taxRate: line.taxRate.toFixed(2),
        quantity,
      }));
      const discountLines = picks
        .filter(({ line }) => discounts.has(line.id))
        .map(({ line }) => ({
          unitPrice: discounts.get(line.id)!.toFixed(2),
          taxRate: line.taxRate.toFixed(2),
          quantity: 1,
        }));
      const computed = orderTotals([...priced, ...discountLines]);
      const totals = {
        ...computed,
        itemCount: picks.reduce((n, p) => n + p.quantity, 0),
      };
      // The number last: the counter row stays locked until commit (ADR 0012).
      if (body.shares) {
        // An equal split: each rate's gross in cents, divided by the shares; the cents left over go to the first
        // shares, so the shares add up exactly (ADR 0036 §4). Each share is a check of its own.
        const rates = totals.byTaxRate.map((r) => ({
          taxRate: r.taxRate,
          cents: new Decimal(r.gross).times(100).toNumber(),
        }));
        for (let index = 1; index <= body.shares; index++) {
          const { number } = await this.numbering.next('pos.guestCheck', tx);
          const parts = rates.map((r) => ({
            taxRate: r.taxRate,
            cents: Math.floor(r.cents / body.shares!) + (index <= r.cents % body.shares! ? 1 : 0),
          }));
          const check = await tx.posGuestCheck.create({
            data: {
              tenantId,
              billId: bill.id,
              number,
              shareIndex: index,
              gross: (parts.reduce((n, p) => n + p.cents, 0) / 100).toFixed(2),
            },
            select: { id: true },
          });
          await tx.posGuestCheckShare.createMany({
            data: parts.map((p) => ({
              tenantId,
              checkId: check.id,
              taxRate: p.taxRate,
              gross: (p.cents / 100).toFixed(2),
            })),
          });
        }
      } else {
        // The number last: the counter row stays locked until commit (ADR 0012).
        const { number } = await this.numbering.next('pos.guestCheck', tx);
        await tx.posGuestCheck.create({
          data: { tenantId, billId: bill.id, number, shareIndex: 0, gross: totals.gross },
        });
      }
      const response = await this.loadBill(tx, bill.id);
      await this.audit.record(tx, {
        action: 'pos.bill.created',
        actor: auditActor.user(userId),
        entityId: bill.id,
        after: billSnapshot(response),
      });
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  async get(billId: string): Promise<Bill> {
    await this.readableBill(billId);
    return this.loadBill(asTenantDb(this.db), billId);
  }

  /** Cancels a bill: its checks print "CANCELLED" and its items can be billed again. A repeat changes nothing. */
  async cancel(billId: string, body: CancelBillRequest): Promise<Bill> {
    const { tenantId, userId } = this.tenantContext.require();
    const { locationId } = await this.readableBill(billId);
    await this.access.assert('pos.bills.cancel', { locationId });
    return this.db.$transaction(async (tx) => {
      const before = await this.loadBill(tx, billId);
      // The orders' lock: a cancel and a new bill of the same items run one after the other.
      for (const orderId of before.orderIds) await lockOrder(tx, orderId);
      const cancelled = await tx.posBillCancellation.findUnique({
        where: { tenantId_billId: { tenantId, billId } },
        select: { billId: true },
      });
      let response = before;
      if (!cancelled) {
        await tx.posBillCancellation.create({
          data: { tenantId, billId, reason: body.reason, cancelledByUserId: userId },
        });
        response = await this.loadBill(tx, billId);
        await this.audit.record(tx, {
          action: 'pos.bill.cancelled',
          actor: auditActor.user(userId),
          entityId: billId,
          before: billSnapshot(before),
          after: billSnapshot(response),
        });
      }
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** Checks of the last 24 hours, or the history by days and number; newest first, 50 per page. */
  async listChecks(query: ListChecksQuery): Promise<CheckListResponse> {
    const scope = await this.access.locationIdsFor('pos.bills.print');
    const locations =
      scope === 'all'
        ? query.locationId
          ? [query.locationId]
          : null
        : query.locationId
          ? scope.filter((id) => id === query.locationId)
          : scope;
    if (locations && locations.length === 0) return { data: [], nextCursor: null };
    const createdAt: { gte?: Date; lt?: Date } = {};
    if (query.view === 'recent') {
      createdAt.gte = new Date(this.clock.now().getTime() - RECENT_CHECKS_HOURS * 60 * 60 * 1000);
    } else {
      if (query.from) createdAt.gte = new Date(`${query.from}T00:00:00.000Z`);
      if (query.to)
        createdAt.lt = new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + DAY_MS);
    }
    const rows = await this.db.posGuestCheck.findMany({
      where: {
        createdAt,
        ...(locations ? { bill: { locationId: { in: locations } } } : {}),
        ...(query.view === 'history' && query.q
          ? { number: { contains: query.q, mode: 'insensitive' as const } }
          : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      // uuidv7 ids grow with time: newest first, and the cursor is the last id seen.
      orderBy: { id: 'desc' },
      take: CHECKS_PAGE_SIZE + 1,
      select: {
        id: true,
        number: true,
        shareIndex: true,
        gross: true,
        createdAt: true,
        bill: {
          select: {
            id: true,
            locationId: true,
            shareCount: true,
            cancellation: { select: { createdAt: true } },
            orders: {
              select: { order: { select: { number: true, table: { select: { name: true } } } } },
              orderBy: { orderId: 'asc' },
            },
          },
        },
      },
    });
    const page = rows.slice(0, CHECKS_PAGE_SIZE);
    return {
      data: page.map((row) => ({
        id: row.id,
        number: row.number,
        billId: row.bill.id,
        locationId: row.bill.locationId,
        shareIndex: row.shareIndex === 0 ? null : row.shareIndex,
        shareCount: row.bill.shareCount,
        gross: row.gross.toFixed(2),
        createdAt: row.createdAt.toISOString(),
        cancelled: row.bill.cancellation !== null,
        tableNames: row.bill.orders.map((o) => o.order.table.name),
        orderNumbers: row.bill.orders.map((o) => o.order.number),
      })),
      nextCursor: rows.length > CHECKS_PAGE_SIZE ? page[page.length - 1]!.id : null,
    };
  }

  /** The printable check: its orders, its lines (items or shares) and totals. */
  async getCheck(checkId: string): Promise<GuestCheck> {
    const check = await this.db.posGuestCheck.findUnique({
      where: { id: checkId },
      select: {
        id: true,
        number: true,
        shareIndex: true,
        createdAt: true,
        shares: { select: { taxRate: true, gross: true }, orderBy: { taxRate: 'asc' } },
        bill: {
          select: {
            id: true,
            locationId: true,
            shareCount: true,
            cancellation: { select: { createdAt: true } },
            items: {
              select: {
                productName: true,
                unitPrice: true,
                taxRate: true,
                quantity: true,
                discountAmount: true,
              },
              orderBy: { id: 'asc' },
            },
            orders: {
              select: {
                order: {
                  select: {
                    id: true,
                    number: true,
                    tableId: true,
                    covers: true,
                    openedByUserId: true,
                    table: { select: { name: true } },
                  },
                },
              },
              orderBy: { orderId: 'asc' },
            },
          },
        },
      },
    });
    if (
      !check ||
      !(await this.access.can('pos.bills.print', { locationId: check.bill.locationId }))
    ) {
      throw posErrors.checkNotFound();
    }
    const orders = check.bill.orders.map((o) => o.order);
    const names = await this.memberNames.forUsers(
      asTenantDb(this.db),
      orders.map((o) => o.openedByUserId),
    );
    const share = check.shareIndex > 0;
    const lines: CheckLine[] = share
      ? check.shares.map((s) => ({
          kind: 'share',
          name: null,
          quantity: null,
          unitPrice: null,
          taxRate: s.taxRate.toFixed(2),
          total: s.gross.toFixed(2),
        }))
      : check.bill.items.flatMap((item): CheckLine[] => {
          const unitPrice = item.unitPrice.toFixed(2);
          const line: CheckLine = {
            kind: 'item',
            name: item.productName,
            quantity: item.quantity,
            unitPrice,
            taxRate: item.taxRate.toFixed(2),
            total: orderTotals([{ unitPrice, taxRate: '0', quantity: item.quantity }]).gross,
          };
          if (item.discountAmount.isZero()) return [line];
          return [
            line,
            {
              kind: 'discount',
              name: null,
              quantity: null,
              unitPrice: null,
              taxRate: item.taxRate.toFixed(2),
              total: item.discountAmount.toFixed(2),
            },
          ];
        });
    const computed = orderTotals(
      lines.map((line) =>
        line.kind === 'item'
          ? { unitPrice: line.unitPrice!, taxRate: line.taxRate, quantity: line.quantity! }
          : { unitPrice: line.total, taxRate: line.taxRate, quantity: 1 },
      ),
    );
    const totals = {
      ...computed,
      itemCount: lines.reduce(
        (n, line) => (line.kind === 'item' ? n + (line.quantity ?? 0) : n),
        0,
      ),
    };
    return {
      id: check.id,
      number: check.number,
      billId: check.bill.id,
      locationId: check.bill.locationId,
      shareIndex: share ? check.shareIndex : null,
      shareCount: check.bill.shareCount,
      createdAt: check.createdAt.toISOString(),
      cancelled: check.bill.cancellation !== null,
      cancelledAt: check.bill.cancellation?.createdAt.toISOString() ?? null,
      orders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        tableId: o.tableId,
        tableName: o.table.name,
        covers: o.covers,
        waiterName: names.get(o.openedByUserId) ?? null,
      })),
      lines,
      totals: share ? { ...totals, itemCount: 0 } : totals,
    };
  }

  /**
   * The location of orders that can be billed together: each must exist and be readable (else 404), all at one
   * location (else 409), where the caller prints bills (else 403).
   */
  private async billableLocation(orderIds: readonly string[]): Promise<string> {
    const orders = await this.db.posOrder.findMany({
      where: { id: { in: [...orderIds] } },
      select: { id: true, locationId: true },
    });
    if (orders.length !== orderIds.length) throw posErrors.orderNotFound();
    for (const order of orders) {
      if (!(await this.access.can('pos.orders.read', { locationId: order.locationId }))) {
        throw posErrors.orderNotFound();
      }
    }
    const locationId = orders[0]!.locationId;
    if (orders.some((o) => o.locationId !== locationId)) throw posErrors.ordersNotSameLocation();
    await this.access.assert('pos.bills.print', { locationId });
    return locationId;
  }

  /** The bill, if it exists here and the caller prints bills at its location. */
  private async readableBill(billId: string) {
    const bill = await this.db.posBill.findUnique({
      where: { id: billId },
      select: { id: true, locationId: true },
    });
    if (!bill || !(await this.access.can('pos.bills.print', { locationId: bill.locationId }))) {
      throw posErrors.billNotFound();
    }
    return bill;
  }

  private async loadBill(db: TenantDb, billId: string): Promise<Bill> {
    const bill: BillRow = await db.posBill.findUniqueOrThrow({
      where: { id: billId },
      select: BILL_SELECT,
    });
    return billResponse(bill);
  }
}

/** Locks an order row and returns its status (the lock orders, voids and bills share). */
async function lockOrder(
  tx: TenantTransactionClient,
  orderId: string,
): Promise<string | undefined> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM pos_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  return rows[0]?.status;
}

function billResponse(bill: BillRow): Bill {
  const checks = bill.checks.map((c) => ({
    id: c.id,
    number: c.number,
    shareIndex: c.shareIndex === 0 ? null : c.shareIndex,
    gross: c.gross.toFixed(2),
  }));
  return {
    id: bill.id,
    kind: bill.kind,
    shareCount: bill.shareCount,
    createdAt: bill.createdAt.toISOString(),
    cancelled: bill.cancellation !== null,
    checks,
    locationId: bill.locationId,
    orderIds: bill.orders.map((o) => o.orderId),
    gross: orderTotals(checks.map((c) => ({ unitPrice: c.gross, taxRate: '0', quantity: 1 })))
      .gross,
  };
}

function billSnapshot(bill: Bill) {
  return snapshot('pos_bill', {
    id: bill.id,
    locationId: bill.locationId,
    kind: bill.kind,
    shareCount: bill.shareCount,
    orderIds: bill.orderIds,
    checkNumbers: bill.checks.map((c) => c.number),
    gross: bill.gross,
    cancelled: bill.cancelled,
  });
}
