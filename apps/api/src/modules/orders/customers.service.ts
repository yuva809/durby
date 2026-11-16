import { Inject, Injectable } from '@nestjs/common';
import {
  checkCustomerRows,
  type CreateOrderCustomerRequest,
  type DataImportResult,
  type ImportCustomersRequest,
  type ListOrderCustomersQuery,
  type OrderCustomer,
  type UpdateOrderCustomerRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
import { AccessService } from '../../platform/rbac';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../../platform/tenancy';
import { isUniqueViolation, ordersErrors } from './orders-errors';

const CUSTOMER_SELECT = {
  id: true,
  name: true,
  code: true,
  phone: true,
  email: true,
  address: true,
  note: true,
  archivedAt: true,
} as const;

type CustomerRow = Omit<OrderCustomer, 'archivedAt'> & { archivedAt: Date | null };

/**
 * Customers of sales orders (docs/modules/orders.md → Customers, ADR 0044): organization-wide, archived, never
 * deleted. Snapshots hold only id, code and archive time: contact details are personal data (ADR 0008).
 */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: AccessService,
  ) {}

  async list(query: ListOrderCustomersQuery): Promise<OrderCustomer[]> {
    const rows = await this.db.orderCustomer.findMany({
      where: query.includeArchived ? {} : { archivedAt: null },
      select: CUSTOMER_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(customerResponse);
  }

  async create(body: CreateOrderCustomerRequest): Promise<OrderCustomer> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const row = await tx.orderCustomer.create({
          data: {
            tenantId,
            name: body.name,
            code: body.code ?? null,
            phone: body.phone ?? null,
            email: body.email ?? null,
            address: body.address ?? null,
            note: body.note ?? null,
          },
          select: CUSTOMER_SELECT,
        });
        const response = customerResponse(row);
        await this.audit.record(tx, {
          action: 'orders.customer.created',
          actor: auditActor.user(userId),
          entityId: row.id,
          after: snapshot('customer', response),
        });
        await this.idempotency.completeInTransaction(tx, response);
        return response;
      }),
    );
  }

  async update(id: string, body: UpdateOrderCustomerRequest): Promise<OrderCustomer> {
    const { userId } = this.tenantContext.require();
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const current = await tx.orderCustomer.findUnique({
          where: { id },
          select: CUSTOMER_SELECT,
        });
        if (!current) throw ordersErrors.customerNotFound();
        const before = customerResponse(current);
        const keep = <K extends keyof OrderCustomer>(
          key: K,
          value: OrderCustomer[K] | undefined,
        ) => (value === undefined ? before[key] : value);
        const archivedAt =
          body.archived === undefined
            ? current.archivedAt
            : body.archived
              ? (current.archivedAt ?? new Date())
              : null;
        const next: OrderCustomer = {
          ...before,
          name: keep('name', body.name),
          code: keep('code', body.code),
          phone: keep('phone', body.phone),
          email: keep('email', body.email),
          address: keep('address', body.address),
          note: keep('note', body.note),
          archivedAt: archivedAt?.toISOString() ?? null,
        };
        // Every field counts here, not only the snapshot's: a new phone number is a change to save.
        if (JSON.stringify(before) === JSON.stringify(next)) return before;
        const row = await tx.orderCustomer.update({
          where: { id },
          data: {
            name: next.name,
            code: next.code,
            phone: next.phone,
            email: next.email,
            address: next.address,
            note: next.note,
            archivedAt,
          },
          select: CUSTOMER_SELECT,
        });
        const after = customerResponse(row);
        await this.audit.record(tx, {
          action: 'orders.customer.updated',
          actor: auditActor.user(userId),
          entityId: id,
          before: snapshot('customer', before),
          after: snapshot('customer', after),
        });
        return after;
      }),
    );
  }

  /**
   * Import Data → customers (docs/platform/import.md, ADR 0044 step 4): a row meets an active customer by code when it
   * has one, else by name (case-insensitive); created when there is none, updated when something differs (empty
   * cells keep what is there). Updating needs `orders.customers.edit` as well. One transaction.
   */
  async importCustomers(body: ImportCustomersRequest): Promise<DataImportResult> {
    const problems = checkCustomerRows(body.rows);
    if (problems.length > 0) throw ordersErrors.importInvalid(problems);
    const { tenantId, userId } = this.tenantContext.require();
    const canEdit = await this.access.can('orders.customers.edit');
    return this.unique(() =>
      this.db.$transaction(async (tx) => {
        const customers = await tx.orderCustomer.findMany({
          where: { archivedAt: null },
          select: CUSTOMER_SELECT,
        });
        const byCode = new Map(
          customers.filter((c) => c.code).map((c) => [c.code!.toLowerCase(), c]),
        );
        const byName = new Map(customers.map((c) => [c.name.toLowerCase(), c]));
        const result: DataImportResult = { created: 0, updated: 0, unchanged: 0, documents: [] };
        const value = (cell: string | undefined) => cell?.trim() || null;
        for (const row of body.rows) {
          const code = value(row.code);
          const current = code
            ? byCode.get(code.toLowerCase())
            : byName.get(row.name.trim().toLowerCase());
          if (!current) {
            const created = await tx.orderCustomer.create({
              data: {
                tenantId,
                name: row.name.trim(),
                code,
                phone: value(row.phone),
                email: value(row.email),
                address: value(row.address),
                note: value(row.note),
              },
              select: CUSTOMER_SELECT,
            });
            await this.audit.record(tx, {
              action: 'orders.customer.created',
              actor: auditActor.user(userId),
              entityId: created.id,
              after: snapshot('customer', customerResponse(created)),
            });
            result.created += 1;
            continue;
          }
          const before = customerResponse(current);
          const next: OrderCustomer = {
            ...before,
            name: row.name.trim(),
            code: code ?? before.code,
            phone: value(row.phone) ?? before.phone,
            email: value(row.email) ?? before.email,
            address: value(row.address) ?? before.address,
            note: value(row.note) ?? before.note,
          };
          if (JSON.stringify(before) === JSON.stringify(next)) {
            result.unchanged += 1;
            continue;
          }
          if (!canEdit) await this.access.assert('orders.customers.edit');
          const updated = await tx.orderCustomer.update({
            where: { id: current.id },
            data: {
              name: next.name,
              code: next.code,
              phone: next.phone,
              email: next.email,
              address: next.address,
              note: next.note,
            },
            select: CUSTOMER_SELECT,
          });
          await this.audit.record(tx, {
            action: 'orders.customer.updated',
            actor: auditActor.user(userId),
            entityId: current.id,
            before: snapshot('customer', before),
            after: snapshot('customer', customerResponse(updated)),
          });
          result.updated += 1;
        }
        await this.idempotency.completeInTransaction(tx, result);
        return result;
      }),
    );
  }

  private async unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw ordersErrors.customerCodeTaken();
      throw error;
    }
  }
}

function customerResponse(row: CustomerRow): OrderCustomer {
  return { ...row, archivedAt: row.archivedAt?.toISOString() ?? null };
}
