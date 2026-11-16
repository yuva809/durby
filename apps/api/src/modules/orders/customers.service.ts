import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateOrderCustomerRequest,
  ListOrderCustomersQuery,
  OrderCustomer,
  UpdateOrderCustomerRequest,
} from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../../platform/audit';
import { IdempotencyService } from '../../platform/idempotency';
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
