import { IdempotencyExempt, Idempotent } from '../idempotency/idempotent.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  acceptInvitationRequestSchema,
  type AcceptInvitationRequest,
  type AcceptInvitationResponse,
  createInvitationRequestSchema,
  type CreateInvitationRequest,
  type Invitation,
  type InvitationListResponse,
  type InvitationPreview,
  invitationTokenRequestSchema,
  type InvitationTokenRequest,
} from '@durby/shared';
import type { Request } from 'express';
import { Authenticated, Public } from '../auth';
import { ZodBody } from '../http';
import { InvitationsService } from './invitations.service';
import { rbacErrors } from './rbac-errors';
import { RequirePermission } from './require-permission.decorator';

const invitationId = new ParseUUIDPipe({ exceptionFactory: () => rbacErrors.invitationNotFound() });

/**
 * /api/v1/invitations (docs/platform/rbac.md → Invitations). Idempotency-Key for create and revoke
 * comes with platform/idempotency (step 1.9); the accept endpoints consume a single-use token.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @RequirePermission('platform.users.read')
  @Get()
  async list(): Promise<InvitationListResponse> {
    return { data: await this.invitations.list() };
  }

  @RequirePermission('platform.users.invite')
  @Idempotent()
  @Post()
  create(
    @Body(new ZodBody(createInvitationRequestSchema)) body: CreateInvitationRequest,
  ): Promise<Invitation> {
    return this.invitations.create(body);
  }

  @RequirePermission('platform.users.invite')
  @Idempotent()
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@Param('id', invitationId) id: string): Promise<void> {
    return this.invitations.revoke(id);
  }

  /** Authenticated by the token itself (ADR 0007). */
  @Public()
  @IdempotencyExempt('reads only; authenticated by the single-use invitation token')
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  preview(
    @Body(new ZodBody(invitationTokenRequestSchema)) body: InvitationTokenRequest,
    @Req() req: Request,
  ): Promise<InvitationPreview> {
    return this.invitations.preview(body.token, clientIp(req));
  }

  /** New users only: an existing account must sign in and use accept-signed-in. */
  @Public()
  @IdempotencyExempt('consumes a single-use token; the response starts a session (ADR 0007)')
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  accept(
    @Body(new ZodBody(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
    @Req() req: Request,
  ): Promise<AcceptInvitationResponse> {
    return this.invitations.accept(body, clientIp(req));
  }

  /**
   * User-level: adds the caller to the organization of the token, which needn't be the token's
   * active one. Writes only the caller's own membership, in the tenant the invitation proves.
   */
  @Authenticated()
  @IdempotencyExempt('consumes a single-use token (ADR 0007)')
  @Post('accept-signed-in')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  acceptSignedIn(
    @Body(new ZodBody(invitationTokenRequestSchema)) body: InvitationTokenRequest,
    @Req() req: Request,
  ): Promise<AcceptInvitationResponse> {
    return this.invitations.acceptSignedIn(body.token, clientIp(req));
  }
}

/** Client address as Express resolves it with `trust proxy` (TRUST_PROXY hops). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
