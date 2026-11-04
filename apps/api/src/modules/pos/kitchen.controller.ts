import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type Order,
  type StationBoardQuery,
  stationBoardQuerySchema,
  type StationBoardResponse,
  type StationTicket,
  type TicketStatusRequest,
  ticketStatusRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { KitchenService } from './kitchen.service';
import { posErrors } from './pos-errors';

const ticketId = new ParseUUIDPipe({ exceptionFactory: posErrors.ticketNotFound });

/**
 * The kitchen and bar screens (docs/modules/pos.md → Kitchen and bar screens, ADR 0026): one route
 * per station, so each declares its own key. Moves append a status change, so they complete their
 * idempotency key in the business transaction (rule 8). Waiters serve ready tickets from the till.
 */
@RequireFeature('pos')
@Controller('pos')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @RequirePermission('pos.kitchen.use')
  @Get('stations/kitchen/tickets')
  async kitchenBoard(
    @Query(new ZodQuery(stationBoardQuerySchema)) query: StationBoardQuery,
  ): Promise<StationBoardResponse> {
    return { data: await this.kitchen.board('kitchen', query.locationId) };
  }

  @RequirePermission('pos.bar.use')
  @Get('stations/bar/tickets')
  async barBoard(
    @Query(new ZodQuery(stationBoardQuerySchema)) query: StationBoardQuery,
  ): Promise<StationBoardResponse> {
    return { data: await this.kitchen.board('bar', query.locationId) };
  }

  @RequirePermission('pos.kitchen.use')
  @Idempotent({ completion: 'transaction' })
  @Post('stations/kitchen/tickets/:id/status')
  moveKitchen(
    @Param('id', ticketId) id: string,
    @Body(new ZodBody(ticketStatusRequestSchema)) body: TicketStatusRequest,
  ): Promise<StationTicket> {
    return this.kitchen.move('kitchen', id, body);
  }

  @RequirePermission('pos.bar.use')
  @Idempotent({ completion: 'transaction' })
  @Post('stations/bar/tickets/:id/status')
  moveBar(
    @Param('id', ticketId) id: string,
    @Body(new ZodBody(ticketStatusRequestSchema)) body: TicketStatusRequest,
  ): Promise<StationTicket> {
    return this.kitchen.move('bar', id, body);
  }

  @RequirePermission('pos.orders.take')
  @Idempotent({ completion: 'transaction' })
  @Post('orders/:orderId/tickets/:id/served')
  serve(
    @Param('orderId', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound }))
    orderId: string,
    @Param('id', ticketId) id: string,
  ): Promise<Order> {
    return this.kitchen.serve(orderId, id);
  }
}
