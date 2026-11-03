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
} from '@nestjs/common';
import {
  createTeamMemberRequestSchema,
  type CreateTeamMemberRequest,
  type CreateTeamMemberResponse,
  type InvitationLinkResponse,
  type TeamListResponse,
  type TeamMember,
  updateTeamMemberRequestSchema,
  type UpdateTeamMemberRequest,
} from '@durby/shared';
import { ZodBody } from '../http';
import { IdempotencyExempt, Idempotent, RequirePermission } from '../markers';
import { InvitationsService } from './invitations.service';
import { rbacErrors } from './rbac-errors';
import { TeamService } from './team.service';

const memberId = new ParseUUIDPipe({ exceptionFactory: () => rbacErrors.memberNotFound() });

/** /api/v1/staff: Manage Staff (docs/platform/rbac.md → Manage Staff, ADR 0023). */
@Controller('staff')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @RequirePermission('platform.users.read')
  @Get()
  list(): Promise<TeamListResponse> {
    return this.team.list();
  }

  /** Creates an account with a temporary password or an invitation; answers no token (ADR 0023 §5). */
  @RequirePermission('platform.users.invite')
  @Idempotent()
  @Post()
  create(
    @Body(new ZodBody(createTeamMemberRequestSchema)) body: CreateTeamMemberRequest,
  ): Promise<CreateTeamMemberResponse> {
    return this.team.create(body);
  }

  @RequirePermission('platform.users.manage')
  @Idempotent()
  @Patch(':id')
  update(
    @Param('id', memberId) id: string,
    @Body(new ZodBody(updateTeamMemberRequestSchema)) body: UpdateTeamMemberRequest,
  ): Promise<TeamMember> {
    return this.team.update(id, body);
  }

  @RequirePermission('platform.users.manage')
  @Idempotent()
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(@Param('id', memberId) id: string): Promise<TeamMember> {
    return this.team.deactivate(id);
  }

  @RequirePermission('platform.users.manage')
  @Idempotent()
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(@Param('id', memberId) id: string): Promise<TeamMember> {
    return this.team.reactivate(id);
  }
}

/** POST /api/v1/invitations/:id/link: a new shareable link (ADR 0023 §5). */
@Controller('invitations')
export class InvitationLinkController {
  constructor(private readonly invitations: InvitationsService) {}

  @RequirePermission('platform.users.invite')
  @IdempotencyExempt(
    'returns a secret link that must not be stored; a replay only issues another link (ADR 0023 §5)',
  )
  @Post(':id/link')
  @HttpCode(HttpStatus.OK)
  async renew(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => rbacErrors.invitationNotFound() }))
    id: string,
  ): Promise<InvitationLinkResponse> {
    return { link: await this.invitations.renewLink(id) };
  }
}
