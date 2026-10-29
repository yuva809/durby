import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  type InviteStaffRequest,
  inviteStaffRequestSchema,
  type PlatformAuditQuery,
  platformAuditQuerySchema,
  type PlatformAuditResponse,
  type StaffListResponse,
  type StaffMember,
  type UpdateStaffRequest,
  updateStaffRequestSchema,
} from '@durby/shared';
import { ZodBody, ZodQuery } from '../http';
import { IdempotencyExempt, PlatformOnly } from '../markers';
import { PlatformAuditReader } from './platform-audit.reader';
import { StaffContext } from './staff-context';
import { staffErrors } from './staff-errors';
import { StaffService } from './staff.service';

/**
 * The tenant idempotency store belongs to customer users, so staff writes are exempt and
 * replay-safe by design: invites upsert and resend, the others set a state (ADR 0017 §8).
 */
const STAFF_EXEMPT = 'staff write: replay-safe set-state (ADR 0017 §8)';
const idPipe = new ParseUUIDPipe({ exceptionFactory: staffErrors.notFound });

/** /api/v1/platform/staff (docs/platform/admin-portal.md → API). Changes need a fresh sign-in. */
@Controller('platform/staff')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly context: StaffContext,
  ) {}

  @PlatformOnly('staff.staff.read')
  @Get()
  async list(): Promise<StaffListResponse> {
    return { data: await this.staff.list() };
  }

  @PlatformOnly('staff.staff.manage', { fresh: true })
  @IdempotencyExempt(STAFF_EXEMPT)
  @Post('invitations')
  @HttpCode(HttpStatus.OK)
  invite(
    @Body(new ZodBody(inviteStaffRequestSchema)) body: InviteStaffRequest,
  ): Promise<StaffMember> {
    return this.staff.invite({ staffId: this.context.require().staffId }, body.email, body.role);
  }

  @PlatformOnly('staff.staff.manage', { fresh: true })
  @IdempotencyExempt(STAFF_EXEMPT)
  @Patch(':id')
  changeRole(
    @Param('id', idPipe) id: string,
    @Body(new ZodBody(updateStaffRequestSchema)) body: UpdateStaffRequest,
  ): Promise<StaffMember> {
    return this.staff.changeRole(this.context.require().staffId, id, body.role);
  }

  @PlatformOnly('staff.staff.manage', { fresh: true })
  @IdempotencyExempt(STAFF_EXEMPT)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(@Param('id', idPipe) id: string): Promise<StaffMember> {
    return this.staff.deactivate(this.context.require().staffId, id);
  }
}

/** /api/v1/platform/audit: every staff action, newest first. */
@Controller('platform/audit')
export class PlatformAuditController {
  constructor(private readonly reader: PlatformAuditReader) {}

  @PlatformOnly('staff.audit.read')
  @Get()
  list(
    @Query(new ZodQuery(platformAuditQuerySchema)) query: PlatformAuditQuery,
  ): Promise<PlatformAuditResponse> {
    return this.reader.page(query);
  }
}
