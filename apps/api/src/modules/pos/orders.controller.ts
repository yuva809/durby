import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  type FloorQuery,
  floorQuerySchema,
  type FloorResponse,
  listOrdersQuerySchema,
  type ListOrdersQuery,
  type Order,
  type OrderListResponse,
  type SendTicketRequest,
  mergeOrderRequestSchema,
  type MergeOrderRequest,
  moveOrderRequestSchema,
  type MoveOrderRequest,
  sendTicketRequestSchema,
  type SendTicketResponse,
  type TableOrderResponse,
  type UpdateOrderRequest,
  updateOrderRequestSchema,
  type VoidLinesRequest,
  voidLinesRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { OrdersService } from './orders.service';
import { posErrors } from './pos-errors';

/**
 * Table orders and kitchen tickets (docs/modules/pos.md → Step 3). The guard checks each key for
 * some location; the service checks it at the table's or order's location. Sends and voids append
 * rows, so they complete their idempotency key in the business transaction (rule 8); closing is
 * naturally idempotent.
 */
@RequireFeature('pos')
@Controller('pos')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePermission('pos.orders.read')
  @Get('floor')
  async floor(@Query(new ZodQuery(floorQuerySchema)) query: FloorQuery): Promise<FloorResponse> {
    return { data: await this.orders.floor(query) };
  }

  @RequirePermission('pos.orders.read')
  @Get('tables/:tableId/order')
  tableOrder(
    @Param('tableId', new ParseUUIDPipe({ exceptionFactory: posErrors.tableNotFound }))
    tableId: string,
  ): Promise<TableOrderResponse> {
    return this.orders.tableOrder(tableId);
  }

  @RequirePermission('pos.orders.take')
  @Idempotent({ completion: 'transaction' })
  @Post('tables/:tableId/tickets')
  send(
    @Param('tableId', new ParseUUIDPipe({ exceptionFactory: posErrors.tableNotFound }))
    tableId: string,
    @Body(new ZodBody(sendTicketRequestSchema)) body: SendTicketRequest,
  ): Promise<SendTicketResponse> {
    return this.orders.send(tableId, body);
  }

  @RequirePermission('pos.orders.read')
  @Get('orders')
  async list(
    @Query(new ZodQuery(listOrdersQuerySchema)) query: ListOrdersQuery,
  ): Promise<OrderListResponse> {
    return { data: await this.orders.list(query) };
  }

  @RequirePermission('pos.orders.read')
  @Get('orders/:id')
  get(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound })) id: string,
  ): Promise<Order> {
    return this.orders.get(id);
  }

  @RequirePermission('pos.orders.take')
  @Idempotent()
  @Patch('orders/:id')
  update(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound })) id: string,
    @Body(new ZodBody(updateOrderRequestSchema)) body: UpdateOrderRequest,
  ): Promise<Order> {
    return this.orders.update(id, body);
  }

  @RequirePermission('pos.orders.void')
  @Idempotent({ completion: 'transaction' })
  @Post('orders/:id/voids')
  voidLines(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound })) id: string,
    @Body(new ZodBody(voidLinesRequestSchema)) body: VoidLinesRequest,
  ): Promise<SendTicketResponse> {
    return this.orders.voidLines(id, body);
  }

  @RequirePermission('pos.orders.take')
  @Idempotent()
  @Post('orders/:id/move')
  move(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound })) id: string,
    @Body(new ZodBody(moveOrderRequestSchema)) body: MoveOrderRequest,
  ): Promise<Order> {
    return this.orders.move(id, body);
  }

  @RequirePermission('pos.orders.take')
  @Idempotent({ completion: 'transaction' })
  @Post('orders/:id/merge')
  merge(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound })) id: string,
    @Body(new ZodBody(mergeOrderRequestSchema)) body: MergeOrderRequest,
  ): Promise<Order> {
    return this.orders.merge(id, body);
  }

  @RequirePermission('pos.orders.close')
  @Idempotent()
  @Post('orders/:id/close')
  close(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound })) id: string,
  ): Promise<Order> {
    return this.orders.close(id);
  }
}
