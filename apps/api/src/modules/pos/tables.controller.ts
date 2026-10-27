import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  createDiningTableRequestSchema,
  type CreateDiningTableRequest,
  type DiningTable,
  type DiningTableListResponse,
  listDiningTablesQuerySchema,
  type ListDiningTablesQuery,
  updateDiningTableRequestSchema,
  type UpdateDiningTableRequest,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { posErrors } from './pos-errors';
import { TablesService } from './tables.service';

/**
 * /api/v1/pos/tables (docs/modules/pos.md → Step 1). The guard checks the key for some location;
 * the service checks it at the table's location. Creates complete their idempotency key in the
 * business transaction (rule 8).
 */
@RequireFeature('pos')
@Controller('pos/tables')
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @RequirePermission('pos.tables.read')
  @Get()
  async list(
    @Query(new ZodQuery(listDiningTablesQuerySchema)) query: ListDiningTablesQuery,
  ): Promise<DiningTableListResponse> {
    return { data: await this.tables.list(query) };
  }

  @RequirePermission('pos.tables.manage')
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(createDiningTableRequestSchema)) body: CreateDiningTableRequest,
  ): Promise<DiningTable> {
    return this.tables.create(body);
  }

  @RequirePermission('pos.tables.manage')
  @Idempotent()
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.tableNotFound })) id: string,
    @Body(new ZodBody(updateDiningTableRequestSchema)) body: UpdateDiningTableRequest,
  ): Promise<DiningTable> {
    return this.tables.update(id, body);
  }
}
