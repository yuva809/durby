import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  type CreateCombinationRequest,
  createCombinationRequestSchema,
  type PutTableRuleRequest,
  putTableRuleRequestSchema,
  type ReservationCombination,
  type ReservationCombinationsQuery,
  reservationCombinationsQuerySchema,
  type ReservationCombinationsResponse,
  type ReservationTable,
  type ReservationTablesQuery,
  reservationTablesQuerySchema,
  type ReservationTablesResponse,
  type UpdateCombinationRequest,
  updateCombinationRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../../platform/http';
import { Idempotent } from '../../../platform/idempotency';
import { RequirePermission } from '../../../platform/rbac';
import { reservationErrors } from '../reservations-errors';
import { CombinationsService } from './combinations.service';
import { TableRulesService } from './table-rules.service';

/**
 * Reservation setup (docs/modules/reservations.md → R1.5 setup API). The guard checks the key at
 * any location; the services check it at the table's or combination's location.
 */
@RequireFeature('reservations')
@Controller('reservations')
export class SetupController {
  constructor(
    private readonly rules: TableRulesService,
    private readonly combinations: CombinationsService,
  ) {}

  @RequirePermission('reservations.bookings.read')
  @Get('tables')
  async tables(
    @Query(new ZodQuery(reservationTablesQuerySchema)) query: ReservationTablesQuery,
  ): Promise<ReservationTablesResponse> {
    return { data: await this.rules.list(query.locationId) };
  }

  @RequirePermission('reservations.setup.edit')
  @Idempotent()
  @Put('tables/:tableId/rule')
  putRule(
    @Param('tableId', new ParseUUIDPipe({ exceptionFactory: reservationErrors.tableNotFound }))
    tableId: string,
    @Body(new ZodBody(putTableRuleRequestSchema)) body: PutTableRuleRequest,
  ): Promise<ReservationTable> {
    return this.rules.put(tableId, body);
  }

  @RequirePermission('reservations.bookings.read')
  @Get('combinations')
  async listCombinations(
    @Query(new ZodQuery(reservationCombinationsQuerySchema)) query: ReservationCombinationsQuery,
  ): Promise<ReservationCombinationsResponse> {
    return { data: await this.combinations.list(query.locationId, query.includeArchived) };
  }

  @RequirePermission('reservations.setup.create')
  @Idempotent({ completion: 'transaction' })
  @Post('combinations')
  createCombination(
    @Body(new ZodBody(createCombinationRequestSchema)) body: CreateCombinationRequest,
  ): Promise<ReservationCombination> {
    return this.combinations.create(body);
  }

  @RequirePermission('reservations.setup.edit')
  @Idempotent()
  @Patch('combinations/:id')
  updateCombination(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: reservationErrors.combinationNotFound }))
    id: string,
    @Body(new ZodBody(updateCombinationRequestSchema)) body: UpdateCombinationRequest,
  ): Promise<ReservationCombination> {
    return this.combinations.update(id, body);
  }
}
