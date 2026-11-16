import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  type CancelSalesOrderRequest,
  cancelSalesOrderRequestSchema,
  type CreateOrderCustomerRequest,
  createOrderCustomerRequestSchema,
  type CreateSalesOrderRequest,
  createSalesOrderRequestSchema,
  type ListOrderCustomersQuery,
  listOrderCustomersQuerySchema,
  type ListSalesOrdersQuery,
  listSalesOrdersQuerySchema,
  type OrderCustomer,
  type SalesOrder,
  type SalesOrderListResponse,
  type UpdateOrderCustomerRequest,
  updateOrderCustomerRequestSchema,
  type UpdateSalesOrderRequest,
  updateSalesOrderRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { CustomersService } from './customers.service';
import { ordersErrors } from './orders-errors';
import { SalesOrdersService } from './sales-orders.service';

const id = (notFound: () => Error) => new ParseUUIDPipe({ exceptionFactory: notFound });

/**
 * /api/v1/orders (docs/modules/orders.md, ADR 0044): customers and sales orders. Order keys are checked at the
 * order's branch by the service; creates complete their idempotency key in the business transaction (rule 8).
 */
@RequireFeature('orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly orders: SalesOrdersService,
  ) {}

  @RequirePermission('orders.customers.read')
  @Get('customers')
  async listCustomers(
    @Query(new ZodQuery(listOrderCustomersQuerySchema)) query: ListOrderCustomersQuery,
  ): Promise<{ data: OrderCustomer[] }> {
    return { data: await this.customers.list(query) };
  }

  @RequirePermission('orders.customers.create')
  @Idempotent({ completion: 'transaction' })
  @Post('customers')
  createCustomer(
    @Body(new ZodBody(createOrderCustomerRequestSchema)) body: CreateOrderCustomerRequest,
  ): Promise<OrderCustomer> {
    return this.customers.create(body);
  }

  @RequirePermission('orders.customers.edit')
  @Idempotent()
  @Patch('customers/:id')
  updateCustomer(
    @Param('id', id(() => ordersErrors.customerNotFound())) customerId: string,
    @Body(new ZodBody(updateOrderCustomerRequestSchema)) body: UpdateOrderCustomerRequest,
  ): Promise<OrderCustomer> {
    return this.customers.update(customerId, body);
  }

  @RequirePermission('orders.orders.read')
  @Get()
  list(
    @Query(new ZodQuery(listSalesOrdersQuerySchema)) query: ListSalesOrdersQuery,
  ): Promise<SalesOrderListResponse> {
    return this.orders.list(query);
  }

  @RequirePermission('orders.orders.read')
  @Get(':id')
  get(@Param('id', id(() => ordersErrors.orderNotFound())) orderId: string): Promise<SalesOrder> {
    return this.orders.get(orderId);
  }

  @RequirePermission('orders.orders.create')
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(createSalesOrderRequestSchema)) body: CreateSalesOrderRequest,
  ): Promise<SalesOrder> {
    return this.orders.create(body);
  }

  @RequirePermission('orders.orders.edit')
  @Idempotent()
  @Patch(':id')
  update(
    @Param('id', id(() => ordersErrors.orderNotFound())) orderId: string,
    @Body(new ZodBody(updateSalesOrderRequestSchema)) body: UpdateSalesOrderRequest,
  ): Promise<SalesOrder> {
    return this.orders.update(orderId, body);
  }

  @RequirePermission('orders.orders.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/confirm')
  confirm(
    @Param('id', id(() => ordersErrors.orderNotFound())) orderId: string,
  ): Promise<SalesOrder> {
    return this.orders.confirm(orderId);
  }

  @RequirePermission('orders.orders.edit')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/cancel')
  cancel(
    @Param('id', id(() => ordersErrors.orderNotFound())) orderId: string,
    @Body(new ZodBody(cancelSalesOrderRequestSchema)) body: CancelSalesOrderRequest,
  ): Promise<SalesOrder> {
    return this.orders.cancel(orderId, body);
  }
}
