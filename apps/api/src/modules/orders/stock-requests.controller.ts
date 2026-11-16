import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type ApproveStockRequest,
  approveStockRequestSchema,
  type AssignDriver,
  assignDriverSchema,
  type CreateStockRequest,
  createStockRequestSchema,
  type ListStockRequestsQuery,
  listStockRequestsQuerySchema,
  type PackStockRequest,
  packStockRequestSchema,
  type ReceiveStockRequest,
  receiveStockRequestSchema,
  type RequestAvailability,
  type RequestDriver,
  type RequestWarehouse,
  type StockRequest,
  type StockRequestNote,
  stockRequestNoteSchema,
  type StockRequestSummary,
} from '@durby/shared';
import { Authenticated } from '../../platform/auth';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { ordersErrors } from './orders-errors';
import { StockRequestsService } from './stock-requests.service';

const requestId = new ParseUUIDPipe({ exceptionFactory: () => ordersErrors.requestNotFound() });
const warehouseId = new ParseUUIDPipe({ exceptionFactory: () => ordersErrors.warehouseNotFound() });

/**
 * /api/v1/stock-requests (docs/modules/orders.md → Branch requests, ADR 0045). Who may do what depends on the request
 * (its branch, its source warehouse, its driver): the route names the key, the service checks it at the right location
 * (reading is @Authenticated(): the service lists only what the caller may see); every step completes its idempotency key in the business transaction (rule 8).
 */
@RequireFeature('orders')
@Controller('stock-requests')
export class StockRequestsController {
  constructor(private readonly requests: StockRequestsService) {}

  /** What the caller can see: their branch's, their warehouse's, all for approvers, `mine=true` for a driver. */
  @Authenticated()
  @Get()
  async list(
    @Query(new ZodQuery(listStockRequestsQuerySchema)) query: ListStockRequestsQuery,
  ): Promise<{ data: StockRequestSummary[] }> {
    return { data: await this.requests.list(query) };
  }

  @RequirePermission('orders.requests.create')
  @Get('warehouses')
  async warehouses(): Promise<{ data: RequestWarehouse[] }> {
    return { data: await this.requests.warehouses() };
  }

  @RequirePermission('orders.requests.create')
  @Get('availability/:warehouseId')
  async availability(
    @Param('warehouseId', warehouseId) id: string,
  ): Promise<{ data: RequestAvailability[] }> {
    return { data: await this.requests.availability(id) };
  }

  @RequirePermission('orders.delivery.assign')
  @Get('drivers/:warehouseId')
  async drivers(@Param('warehouseId', warehouseId) id: string): Promise<{ data: RequestDriver[] }> {
    return { data: await this.requests.drivers(id) };
  }

  @Authenticated()
  @Get(':id')
  get(@Param('id', requestId) id: string): Promise<StockRequest> {
    return this.requests.get(id);
  }

  @RequirePermission('orders.requests.create')
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(createStockRequestSchema)) body: CreateStockRequest,
  ): Promise<StockRequest> {
    return this.requests.create(body);
  }

  @RequirePermission('orders.requests.create')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/cancel')
  cancel(
    @Param('id', requestId) id: string,
    @Body(new ZodBody(stockRequestNoteSchema)) body: StockRequestNote,
  ): Promise<StockRequest> {
    return this.requests.cancel(id, body);
  }

  @RequirePermission('orders.requests.approve')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/approve')
  approve(
    @Param('id', requestId) id: string,
    @Body(new ZodBody(approveStockRequestSchema)) body: ApproveStockRequest,
  ): Promise<StockRequest> {
    return this.requests.approve(id, body);
  }

  @RequirePermission('orders.requests.approve')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/reject')
  reject(
    @Param('id', requestId) id: string,
    @Body(new ZodBody(stockRequestNoteSchema)) body: StockRequestNote,
  ): Promise<StockRequest> {
    return this.requests.reject(id, body);
  }

  @RequirePermission('orders.picking.use')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/start-picking')
  startPicking(@Param('id', requestId) id: string): Promise<StockRequest> {
    return this.requests.startPicking(id);
  }

  @RequirePermission('orders.picking.use')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/pack')
  pack(
    @Param('id', requestId) id: string,
    @Body(new ZodBody(packStockRequestSchema)) body: PackStockRequest,
  ): Promise<StockRequest> {
    return this.requests.pack(id, body);
  }

  @RequirePermission('orders.delivery.assign')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/driver')
  assignDriver(
    @Param('id', requestId) id: string,
    @Body(new ZodBody(assignDriverSchema)) body: AssignDriver,
  ): Promise<StockRequest> {
    return this.requests.assignDriver(id, body.driverUserId);
  }

  /** The assigned driver, or whoever assigns drivers at the source (the service checks). */
  @RequirePermission('orders.delivery.use')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/pick-up')
  pickUp(@Param('id', requestId) id: string): Promise<StockRequest> {
    return this.requests.pickUp(id);
  }

  @RequirePermission('orders.delivery.use')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/deliver')
  deliver(
    @Param('id', requestId) id: string,
    @Body(new ZodBody(stockRequestNoteSchema)) body: StockRequestNote,
  ): Promise<StockRequest> {
    return this.requests.deliver(id, body);
  }

  @RequirePermission('orders.requests.receive')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/receive')
  receive(
    @Param('id', requestId) id: string,
    @Body(new ZodBody(receiveStockRequestSchema)) body: ReceiveStockRequest,
  ): Promise<StockRequest> {
    return this.requests.receive(id, body);
  }
}
