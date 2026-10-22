import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  createRoleRequestSchema,
  type CreateRoleRequest,
  type Role,
  type RoleListResponse,
  updateRoleRequestSchema,
  type UpdateRoleRequest,
} from '@durby/shared';
import { ZodBody } from '../http';
import { rbacErrors } from './rbac-errors';
import { RequirePermission } from './require-permission.decorator';
import { RolesService } from './roles.service';

const roleId = new ParseUUIDPipe({ exceptionFactory: () => rbacErrors.roleNotFound() });

/**
 * /api/v1/roles (docs/platform/rbac.md). Idempotency-Key for the writes comes with
 * platform/idempotency (step 1.9, ADR 0007).
 */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermission('platform.roles.read')
  @Get()
  async list(): Promise<RoleListResponse> {
    return { data: await this.roles.list() };
  }

  @RequirePermission('platform.roles.manage')
  @Post()
  create(@Body(new ZodBody(createRoleRequestSchema)) body: CreateRoleRequest): Promise<Role> {
    return this.roles.create(body);
  }

  @RequirePermission('platform.roles.manage')
  @Patch(':id')
  update(
    @Param('id', roleId) id: string,
    @Body(new ZodBody(updateRoleRequestSchema)) body: UpdateRoleRequest,
  ): Promise<Role> {
    return this.roles.update(id, body);
  }

  @RequirePermission('platform.roles.manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', roleId) id: string): Promise<void> {
    return this.roles.remove(id);
  }
}
