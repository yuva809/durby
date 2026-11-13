import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { type AddDiscountRequest, type Discount } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService } from '../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { billedByLine, remainingOf, unbilledOf } from './billing';
import { allocateDiscount, type DiscountTarget } from './discounts';
import { posErrors } from './pos-errors';

/**
 * Discounts and comps (docs/modules/pos.md → Step 4b, ADR 0036 §5). A discount is fixed when given, from the items
 * still to bill; one per line, or one for the whole order that takes the lines without one. Removing a discount
 * writes a row that points at it, and only while nothing of its line is billed.
 */
@Injectable()
export class DiscountsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async add(orderId: string, body: AddDiscountRequest): Promise<Discount> {
    const { tenantId, userId } = this.tenantContext.require();
    const locationId = await this.locationOf(orderId);
    await this.access.assert('pos.orders.discount', { locationId });
    return this.db.$transaction(async (tx) => {
      if ((await lockOrder(tx, orderId)) !== 'open') throw posErrors.orderClosed();
      const lines = await tx.posOrderLine.findMany({
        where: { orderId },
        select: { id: true, quantity: true, voidsLineId: true, unitPrice: true, taxRate: true },
      });
      const sent = new Map(lines.filter((l) => l.quantity > 0).map((l) => [l.id, l]));
      const active = await activeDiscounts(tx, orderId);
      const billed = billedByLine(
        await tx.posBillItem.findMany({
          where: { orderId, bill: { cancellation: null } },
          select: { orderLineId: true, quantity: true },
        }),
      );
      const unbilled = unbilledOf(remainingOf(lines), billed);
      if (body.orderLineId && !sent.has(body.orderLineId)) throw posErrors.lineNotFound();
      if (body.orderLineId && active.lineIds.has(body.orderLineId))
        throw posErrors.discountExists();
      if (!body.orderLineId && active.lineIds.size > 0) throw posErrors.discountExists();
      const targets: DiscountTarget[] = [];
      for (const [lineId, line] of sent) {
        if (body.orderLineId && lineId !== body.orderLineId) continue;
        if (active.lineIds.has(lineId)) continue;
        const quantity = unbilled.get(lineId) ?? 0;
        if (quantity === 0) continue;
        targets.push({
          orderLineId: lineId,
          taxRate: line.taxRate.toFixed(2),
          gross: new Decimal(line.unitPrice.toFixed(2)).times(quantity).toFixed(2),
        });
      }
      const parts = allocateDiscount(targets, body.kind, body.value, !body.orderLineId);
      if (!parts) throw posErrors.discountInvalid();
      const discount = await tx.posOrderDiscount.create({
        data: {
          tenantId,
          orderId,
          orderLineId: body.orderLineId ?? null,
          kind: body.kind,
          value: body.value,
          reason: body.reason,
          createdByUserId: userId,
        },
        select: { id: true, createdAt: true },
      });
      await tx.posOrderDiscountLine.createMany({
        data: parts.map((p) => ({
          tenantId,
          discountId: discount.id,
          orderId,
          orderLineId: p.orderLineId,
          taxRate: p.taxRate,
          amount: p.amount,
        })),
      });
      const amount = parts.reduce((sum, p) => sum.plus(p.amount), new Decimal(0)).toFixed(2);
      const response: Discount = {
        id: discount.id,
        orderLineId: body.orderLineId ?? null,
        kind: body.kind,
        value: body.value,
        amount,
        reason: body.reason,
        voided: false,
        createdAt: discount.createdAt.toISOString(),
      };
      await this.audit.record(tx, {
        action: 'pos.discount.added',
        actor: auditActor.user(userId),
        entityId: discount.id,
        after: discountSnapshot(response, orderId),
      });
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  /** Removes a discount: a row that points at it. Refused once any of its lines is billed. */
  async remove(orderId: string, discountId: string): Promise<Discount> {
    const { tenantId, userId } = this.tenantContext.require();
    const locationId = await this.locationOf(orderId);
    await this.access.assert('pos.orders.discount', { locationId });
    return this.db.$transaction(async (tx) => {
      if ((await lockOrder(tx, orderId)) !== 'open') throw posErrors.orderClosed();
      const active = await activeDiscounts(tx, orderId);
      const target = active.rows.find((d) => d.id === discountId);
      if (!target) throw posErrors.discountNotFound();
      const billed = await tx.posBillItem.count({
        where: { orderId, orderLineId: { in: target.lineIds }, bill: { cancellation: null } },
      });
      if (billed > 0) throw posErrors.lineBilled(target.lineIds[0] ?? '');
      const row = await tx.posOrderDiscount.create({
        data: {
          tenantId,
          orderId,
          orderLineId: target.orderLineId,
          kind: target.kind,
          value: target.value,
          reason: target.reason,
          voidsDiscountId: discountId,
          createdByUserId: userId,
        },
        select: { createdAt: true },
      });
      const response: Discount = {
        id: discountId,
        orderLineId: target.orderLineId,
        kind: target.kind,
        value: target.value,
        amount: '0.00',
        reason: target.reason,
        voided: true,
        createdAt: row.createdAt.toISOString(),
      };
      await this.audit.record(tx, {
        action: 'pos.discount.voided',
        actor: auditActor.user(userId),
        entityId: discountId,
        before: discountSnapshot({ ...response, voided: false, amount: target.amount }, orderId),
        after: discountSnapshot(response, orderId),
      });
      await this.idempotency.completeInTransaction(tx, response);
      return response;
    });
  }

  private async locationOf(orderId: string): Promise<string> {
    const order = await asTenantDb(this.db).posOrder.findUnique({
      where: { id: orderId },
      select: { locationId: true },
    });
    if (!order || !(await this.access.can('pos.orders.read', { locationId: order.locationId }))) {
      throw posErrors.orderNotFound();
    }
    return order.locationId;
  }
}

export interface ActiveDiscount {
  id: string;
  orderLineId: string | null;
  kind: 'percent' | 'amount';
  value: string;
  reason: string;
  /** Negative, two decimals: what the discount takes off. */
  amount: string;
  lineIds: string[];
  createdAt: Date;
}

/**
 * The discounts of an order that no later row removed: their rows, the lines they cover (`lineIds`), and per line
 * the discount's amount (`lineAmount`, negative).
 */
export async function activeDiscounts(
  tx: TenantTransactionClient,
  orderId: string,
): Promise<{ rows: ActiveDiscount[]; lineIds: Set<string>; lineAmount: Map<string, Decimal> }> {
  const all = await tx.posOrderDiscount.findMany({
    where: { orderId },
    select: {
      id: true,
      orderLineId: true,
      kind: true,
      value: true,
      reason: true,
      createdAt: true,
      voidsDiscountId: true,
      lines: { select: { orderLineId: true, amount: true } },
    },
    orderBy: { id: 'asc' },
  });
  const removed = new Set(all.map((d) => d.voidsDiscountId).filter((x): x is string => !!x));
  const rows: ActiveDiscount[] = [];
  const lineAmount = new Map<string, Decimal>();
  for (const d of all) {
    if (d.voidsDiscountId || removed.has(d.id)) continue;
    let amount = new Decimal(0);
    for (const l of d.lines) {
      const part = new Decimal(l.amount.toFixed(2));
      lineAmount.set(l.orderLineId, part);
      amount = amount.plus(part);
    }
    rows.push({
      id: d.id,
      orderLineId: d.orderLineId,
      kind: d.kind,
      value: d.value.toFixed(2),
      reason: d.reason,
      amount: amount.toFixed(2),
      lineIds: d.lines.map((l) => l.orderLineId),
      createdAt: d.createdAt,
    });
  }
  return { rows, lineIds: new Set(lineAmount.keys()), lineAmount };
}

async function lockOrder(
  tx: TenantTransactionClient,
  orderId: string,
): Promise<string | undefined> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM pos_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  return rows[0]?.status;
}

function discountSnapshot(d: Discount, orderId: string) {
  return snapshot('pos_discount', {
    id: d.id,
    orderId,
    orderLineId: d.orderLineId,
    kind: d.kind,
    value: d.value,
    amount: d.amount,
    voidsDiscountId: d.voided ? d.id : null,
  });
}
