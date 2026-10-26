import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  INVITATION_TTL_DAYS,
  type Invitation,
  type InvitationPreview,
} from '@durby/shared';
import { DEFAULT_LOCALE, LOCALES } from '@durby/i18n';
import { auditActor, AuditService, snapshot } from '../audit';
import {
  AuthContext,
  authErrors,
  AuthRateLimits,
  Clock,
  normalizeEmail,
  UserDirectory,
} from '../auth';
import type { Prisma } from '../database/generated/client';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../tenancy';
import { canGrantRole } from './granting';
import { InvitationMailer } from './invitation-mailer';
import { INVITATION_SETTINGS, type InvitationSettings } from './invitation-ports';
import { issueInvitationToken, parseInvitationToken } from './invitation-token';
import { existingLocations } from './locations';
import { isUniqueViolation, rbacErrors } from './rbac-errors';
import { ROLE_SELECT, RolesService } from './roles.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tenant-context actor for the public accept, before the new user exists. */
const ANONYMOUS_ACTOR = '00000000-0000-0000-0000-000000000000';
/** Never a user id: keeps the "already a member?" lookup the same for unknown emails. */
const NO_USER = '00000000-0000-0000-0000-000000000000';

const INVITATION_SELECT = {
  id: true,
  email: true,
  roleId: true,
  allLocations: true,
  expiresAt: true,
  createdAt: true,
  role: { select: ROLE_SELECT },
  locations: { select: { locationId: true } },
} as const;

type InvitationRow = Prisma.InvitationGetPayload<{ select: typeof INVITATION_SELECT }>;

const openAt = (now: Date) => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: now } });

/** Invitations by email (docs/platform/rbac.md → Invitations, ADR 0007). */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(PLATFORM_PRISMA) private readonly platformDb: PlatformPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly auth: AuthContext,
    private readonly roles: RolesService,
    private readonly users: UserDirectory,
    private readonly limits: AuthRateLimits,
    private readonly mailer: InvitationMailer,
    @Inject(INVITATION_SETTINGS) private readonly settings: InvitationSettings,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Open invitations of the active organization, newest first. */
  async list(): Promise<Invitation[]> {
    const rows = await this.db.invitation.findMany({
      where: openAt(this.clock.now()),
      select: INVITATION_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toInvitation);
  }

  /**
   * Same response and the same mail whether or not the email has an account. An open invitation
   * for the same email is revoked. The mail goes out after the response.
   */
  async create(body: CreateInvitationRequest): Promise<Invitation> {
    const actor = await this.roles.actor();
    const { tenantId } = this.tenantContext.require();
    const now = this.clock.now();
    const email = normalizeEmail(body.email);
    const allLocations = body.locationIds == null;
    const { token, hash } = issueInvitationToken(tenantId);

    const row = await this.db.$transaction(async (tx) => {
      const role = await tx.role.findUnique({
        where: { tenantId_id: { tenantId, id: body.roleId } },
        select: ROLE_SELECT,
      });
      if (!role) throw rbacErrors.roleNotFound();
      if (!canGrantRole(actor, this.roles.viewOf(role))) throw rbacErrors.notGrantable();
      if (role.systemKey === 'owner' && !allLocations) throw rbacErrors.ownerAllLocations();
      const locationIds = body.locationIds ? await existingLocations(tx, body.locationIds) : [];

      const user = await this.users.findByEmail(email);
      const member = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: user?.id ?? NO_USER } },
        select: { id: true },
      });
      if (member) throw rbacErrors.alreadyMember();

      // Any earlier open invitation for the email is replaced: revoked and audited one by one.
      const replaced = await tx.invitation.findMany({
        where: { email, acceptedAt: null, revokedAt: null },
        select: INVITATION_SELECT,
      });
      for (const old of replaced) {
        await tx.invitation.update({ where: { id: old.id }, data: { revokedAt: now } });
        await this.audit.record(tx, {
          action: 'platform.invitation.revoked',
          actor: auditActor.user(actor.userId),
          entityId: old.id,
          before: snapshotOf(old),
          after: snapshotOf(old, { revokedAt: now }),
        });
      }
      const created = await tx.invitation.create({
        data: {
          tenantId,
          email,
          roleId: role.id,
          allLocations,
          invitedByUserId: actor.userId,
          tokenHash: hash,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS),
        },
        select: { id: true },
      });
      await tx.invitationLocation.createMany({
        data: locationIds.map((locationId) => ({
          tenantId,
          invitationId: created.id,
          locationId,
        })),
      });
      const row = await tx.invitation.findUniqueOrThrow({
        where: { id: created.id },
        select: INVITATION_SELECT,
      });
      await this.audit.record(tx, {
        action: 'platform.invitation.created',
        actor: auditActor.user(actor.userId),
        entityId: row.id,
        after: snapshotOf(row),
      });
      return row;
    });

    // In the organization's tenant context: its labels and its `locale` setting. The invitee's own
    // locale if they have an account (ADR 0011 §9).
    this.inBackground('invitation mail', () =>
      this.tenantContext.run({ tenantId, userId: actor.userId }, async () => {
        const [invitee, org, orgLocale] = await Promise.all([
          this.users.findByEmail(email),
          this.platformDb.organization.findUniqueOrThrow({
            where: { id: tenantId },
            select: {
              name: true,
              partner: { select: { domains: { select: { hostname: true } } } },
            },
          }),
          this.settings.get('locale'),
        ]);
        await this.mailer.send({
          to: email,
          locale: invitee?.locale ?? orgLocale,
          organizationName: org.name,
          token,
          // The link opens on the partner's domain (web-shell.md → Invitation links).
          partnerHostnames: org.partner.domains.map((d) => d.hostname),
        });
      }),
    );
    return toInvitation(row);
  }

  /** Revokes an open invitation, if the actor could have granted its role. */
  async revoke(id: string): Promise<void> {
    const actor = await this.roles.actor();
    const now = this.clock.now();
    await this.db.$transaction(async (tx) => {
      const invitation = await tx.invitation.findFirst({
        where: { id, ...openAt(now) },
        select: INVITATION_SELECT,
      });
      if (!invitation) throw rbacErrors.invitationNotFound();
      if (!canGrantRole(actor, this.roles.viewOf(invitation.role))) throw rbacErrors.notGrantable();
      await tx.invitation.update({ where: { id }, data: { revokedAt: now } });
      await this.audit.record(tx, {
        action: 'platform.invitation.revoked',
        actor: auditActor.user(actor.userId),
        entityId: id,
        before: snapshotOf(invitation),
        after: snapshotOf(invitation, { revokedAt: now }),
      });
    });
  }

  /** For the accept page. Only the token holder (proven inbox access) learns accountExists. */
  async preview(token: string, ip: string): Promise<InvitationPreview> {
    await this.limits.enforce([this.limits.rules.invitationTokenIp, ip]);
    const parsed = parseInvitationToken(token);
    if (!parsed) throw authErrors.tokenInvalid();
    const invitation = await this.tenantContext.run(
      { tenantId: parsed.organizationId, userId: ANONYMOUS_ACTOR },
      () =>
        this.db.invitation.findFirst({
          where: { tokenHash: parsed.hash, ...openAt(this.clock.now()) },
          select: INVITATION_SELECT,
        }),
    );
    if (!invitation) throw authErrors.tokenInvalid();
    const [org, user] = await Promise.all([
      this.platformDb.organization.findUniqueOrThrow({ where: { id: parsed.organizationId } }),
      this.users.findByEmail(invitation.email),
    ]);
    return {
      organizationName: org.name,
      email: invitation.email,
      role: roleRef(invitation),
      accountExists: user !== null,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Public accept by a new user: creates the user (password set, email verified), the membership
   * and its locations, and consumes the invitation, in one transaction. Never touches an
   * existing account (409 invitations.sign_in_required).
   */
  async accept(body: AcceptInvitationRequest, ip: string): Promise<{ organizationId: string }> {
    await this.limits.enforce([this.limits.rules.invitationTokenIp, ip]);
    const parsed = parseInvitationToken(body.token);
    if (!parsed) throw authErrors.tokenInvalid();
    const { organizationId, hash } = parsed;
    const locale = (LOCALES as readonly string[]).includes(body.locale ?? '')
      ? (body.locale as string)
      : DEFAULT_LOCALE;

    await this.tenantContext.run(
      { tenantId: organizationId, userId: ANONYMOUS_ACTOR },
      async () => {
        try {
          return await this.db.$transaction(async (tx) => {
            const invitation = await this.openByHash(tx, hash);
            if (await this.users.findByEmail(invitation.email)) {
              throw rbacErrors.signInRequired();
            }
            const user = await this.users.createVerified(tx, {
              email: invitation.email,
              password: body.password,
              locale,
            });
            await this.acceptInto(tx, organizationId, invitation, user.id);
          });
        } catch (error) {
          // The email got an account between the check and the insert.
          if (isUniqueViolation(error)) throw rbacErrors.signInRequired();
          throw error;
        }
      },
    );
    return { organizationId };
  }

  /** Accept by the signed-in user, whose email must be the invited one. */
  async acceptSignedIn(token: string, ip: string): Promise<{ organizationId: string }> {
    await this.limits.enforce([this.limits.rules.invitationTokenIp, ip]);
    const parsed = parseInvitationToken(token);
    if (!parsed) throw authErrors.tokenInvalid();
    const { organizationId, hash } = parsed;
    const { userId } = this.auth.require();
    const profile = await this.users.findById(userId);
    if (!profile) throw authErrors.unauthenticated();

    await this.tenantContext.run({ tenantId: organizationId, userId }, () =>
      this.db.$transaction(async (tx) => {
        const invitation = await this.openByHash(tx, hash);
        if (invitation.email !== profile.email) throw rbacErrors.emailMismatch();
        await this.acceptInto(tx, organizationId, invitation, userId);
      }),
    );
    return { organizationId };
  }

  /** Consumes the invitation, joins the user and audits both, all in the caller's transaction. */
  private async acceptInto(
    tx: TenantTransactionClient,
    tenantId: string,
    invitation: InvitationRow,
    userId: string,
  ): Promise<void> {
    const acceptedAt = await this.consume(tx, invitation, userId);
    const actor = auditActor.user(userId);
    await this.audit.record(tx, {
      action: 'platform.invitation.accepted',
      actor,
      entityId: invitation.id,
      before: snapshotOf(invitation),
      after: snapshotOf(invitation, { acceptedAt, acceptedByUserId: userId }),
    });
    const membershipId = await this.join(tx, tenantId, invitation, userId);
    if (membershipId !== null) {
      await this.audit.record(tx, {
        action: 'platform.membership.created',
        actor,
        entityId: membershipId,
        after: snapshot('membership', {
          id: membershipId,
          userId,
          roleId: invitation.roleId,
          allLocations: invitation.allLocations,
          locationIds: invitation.locations.map((l) => l.locationId),
        }),
      });
    }
  }

  private async openByHash(tx: TenantTransactionClient, hash: string): Promise<InvitationRow> {
    const invitation = await tx.invitation.findFirst({
      where: { tokenHash: hash, ...openAt(this.clock.now()) },
      select: INVITATION_SELECT,
    });
    if (!invitation) throw authErrors.tokenInvalid();
    return invitation;
  }

  /** Single use: only the first of concurrent accepts gets the row. Returns the accept time. */
  private async consume(
    tx: TenantTransactionClient,
    invitation: InvitationRow,
    userId: string,
  ): Promise<Date> {
    const now = this.clock.now();
    const { count } = await tx.invitation.updateMany({
      where: { id: invitation.id, ...openAt(now) },
      data: { acceptedAt: now, acceptedByUserId: userId },
    });
    if (count !== 1) throw authErrors.tokenInvalid();
    return now;
  }

  /** The membership from the invitation; an existing membership is left as it is (null). */
  private async join(
    tx: TenantTransactionClient,
    tenantId: string,
    invitation: InvitationRow,
    userId: string,
  ): Promise<string | null> {
    const existing = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { id: true },
    });
    if (existing) return null;
    const membership = await tx.membership.create({
      data: { tenantId, userId, roleId: invitation.roleId, allLocations: invitation.allLocations },
      select: { id: true },
    });
    await tx.membershipLocation.createMany({
      data: invitation.locations.map((l) => ({
        tenantId,
        membershipId: membership.id,
        locationId: l.locationId,
      })),
    });
    return membership.id;
  }

  /**
   * Runs after the response so its timing reveals nothing. Errors are logged by type only.
   * (Moves to a BullMQ job once queues exist.)
   */
  private inBackground(what: string, fn: () => Promise<void>): void {
    setImmediate(() => {
      fn().catch((error: unknown) => {
        this.logger.error(
          { err: { type: error instanceof Error ? error.name : 'unknown' } },
          `${what} failed`,
        );
      });
    });
  }
}

const roleRef = (row: InvitationRow) => ({
  id: row.role.id,
  systemKey: row.role.systemKey,
  name: row.role.name,
});

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: roleRef(row),
    allLocations: row.allLocations,
    locationIds: row.locations.map((l) => l.locationId).sort(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Audit snapshot of an invitation; INVITATION_SELECT only reads open ones, so the states start null. */
function snapshotOf(
  row: InvitationRow,
  changes: { acceptedAt?: Date; acceptedByUserId?: string; revokedAt?: Date } = {},
) {
  return snapshot('invitation', {
    id: row.id,
    roleId: row.roleId,
    allLocations: row.allLocations,
    locationIds: row.locations.map((l) => l.locationId),
    expiresAt: row.expiresAt,
    acceptedAt: null,
    acceptedByUserId: null,
    revokedAt: null,
    ...changes,
  });
}
