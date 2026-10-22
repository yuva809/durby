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
} from '@nestjs/common';
import {
  type Member,
  type MemberListResponse,
  updateMemberRequestSchema,
  type UpdateMemberRequest,
} from '@durby/shared';
import { ZodBody } from '../http';
import { MembersService } from './members.service';
import { rbacErrors } from './rbac-errors';
import { RequirePermission } from './require-permission.decorator';

const memberId = new ParseUUIDPipe({ exceptionFactory: () => rbacErrors.memberNotFound() });

/**
 * /api/v1/members (docs/platform/rbac.md). Idempotency-Key for the writes comes with
 * platform/idempotency (step 1.9, ADR 0007).
 */
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @RequirePermission('platform.users.read')
  @Get()
  async list(): Promise<MemberListResponse> {
    return { data: await this.members.list() };
  }

  @RequirePermission('platform.users.manage')
  @Patch(':id')
  update(
    @Param('id', memberId) id: string,
    @Body(new ZodBody(updateMemberRequestSchema)) body: UpdateMemberRequest,
  ): Promise<Member> {
    return this.members.update(id, body);
  }

  @RequirePermission('platform.users.manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', memberId) id: string): Promise<void> {
    return this.members.remove(id);
  }
}
