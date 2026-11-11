import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CustomerDetail,
  customerDetailSchema,
  type CustomerSummary,
  type OnboardCustomerBody,
  type OnboardingOptionsResponse,
  PLAN_KEYS,
  type PlanKey,
} from '@durby/shared';
import { v7 as uuidv7 } from 'uuid';
import { auditActor, AuditService, canonicalJson, snapshot } from '../audit';
import { PasswordService, UserDirectory } from '../auth';
import { planIdOf } from '../config/entitlements';
import { PrismaService } from '../database';
import { idempotencyErrors } from '../idempotency';
import { MailDispatcher } from '../mail';
import { NumberingService } from '../numbering';
import { DEFAULT_PARTNER, ProvisioningService } from '../provisioning';
import { SystemRoles } from '../rbac';
import {
  PLATFORM_PRISMA,
  TENANT_PRISMA,
  TenantContext,
  type PlatformPrismaClient,
  type TenantPrismaClient,
} from '../tenancy';
import { CustomerEntitlementsService } from './customer-entitlements.service';
import { PlatformAuditService, platformSnapshot } from './platform-audit.service';
import { staffErrors } from './staff-errors';

/** Tenant-context user for work done in a customer's tenant by staff (no customer user acts). */
const STAFF_TENANT_ACTOR = '00000000-0000-0000-0000-000000000000';
const ONBOARD_ROUTE = 'POST /api/v1/platform/customers';
const LIST_LIMIT = 200;

const ORG_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  partner: { select: { id: true, slug: true, name: true } },
  plan: { select: { key: true } },
} as const;

type OrgRow = {
  id: string;
  name: string;
  createdAt: Date;
  partner: { id: string; slug: string; name: string };
  plan: { key: string };
};

/**
 * Customers in the admin portal (docs/platform/admin-portal.md → Customers, Onboarding). Lists
 * read `organizations` (no RLS, platform fields only); anything inside a customer runs in that
 * customer's tenant context, like provisioning. Onboarding creates the organization, its system
 * roles and number series, and the Owner membership in one transaction (all or nothing), then
 * mails the Owner.
 */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(PLATFORM_PRISMA) private readonly platformDb: PlatformPrismaClient,
    @Inject(TENANT_PRISMA) private readonly tenantDb: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly db: PrismaService,
    private readonly users: UserDirectory,
    private readonly passwords: PasswordService,
    private readonly provisioning: ProvisioningService,
    private readonly systemRoles: SystemRoles,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditService,
    private readonly dispatcher: MailDispatcher,
    private readonly entitlements: CustomerEntitlementsService,
  ) {}

  async list(query?: string): Promise<CustomerSummary[]> {
    const rows = await this.platformDb.organization.findMany({
      where: query ? { name: { contains: query, mode: 'insensitive' } } : {},
      select: ORG_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
    });
    return rows.map(toSummary);
  }

  async detail(id: string): Promise<CustomerDetail> {
    const org = await this.platformDb.organization.findUnique({
      where: { id },
      select: ORG_SELECT,
    });
    if (!org) throw staffErrors.customerNotFound();
    return { ...toSummary(org), owner: await this.owner(id) };
  }

  async options(): Promise<OnboardingOptionsResponse> {
    const partners = await this.platformDb.partner.findMany({
      select: { id: true, slug: true, name: true },
      orderBy: { name: 'asc' },
    });
    return {
      partners,
      defaultPartnerId: partners.find((p) => p.slug === DEFAULT_PARTNER.slug)?.id ?? null,
      plans: [...PLAN_KEYS],
    };
  }

  /**
   * Replay-safe through `key` (the request's Idempotency-Key, ADR 0017 §8): the same key and body
   * return the stored customer, the same key with another body is refused.
   */
  async onboard(staffId: string, key: string, body: OnboardCustomerBody): Promise<CustomerDetail> {
    const requestHash = createHash('sha256')
      .update(canonicalJson(body) ?? '')
      .digest('hex');
    const replayed = await this.replay(staffId, key, requestHash);
    if (replayed) return replayed;

    const partnerId = await this.partnerFor(body.partnerId);
    if (!body.confirmDuplicates) {
      const [sameName, account] = await Promise.all([
        this.platformDb.organization.findFirst({
          where: { name: { equals: body.name, mode: 'insensitive' } },
          select: { id: true },
        }),
        this.users.findByEmail(body.ownerEmail),
      ]);
      if (sameName || account) {
        throw staffErrors.customerDuplicate({
          nameTaken: sameName !== null,
          ownerHasAccount: account !== null,
        });
      }
    }

    // Modules (admin portal 1d): checked before anything is created; 409 on a missing dependency.
    const overrides = await this.entitlements.onboardingOverrides(body.plan, body.features);

    const owner = await this.users.ensure(body.ownerEmail, { locale: body.ownerLocale });
    const hasPassword = (await this.users.withPassword([owner.id])).has(owner.id);
    const id = uuidv7();
    let detail: CustomerDetail;
    try {
      detail = await this.inTenant(id, () =>
        this.tenantDb.$transaction(async (tx) => {
          const org = await tx.organization.create({
            data: { id, partnerId, name: body.name, planId: await planIdOf(tx, body.plan) },
            select: { ...ORG_SELECT, partnerId: true, planId: true },
          });
          await this.audit.record(tx, {
            action: 'platform.organization.created',
            actor: auditActor.system('staff.admin_portal'),
            entityId: id,
            after: snapshot('organization', org),
          });
          const roles = await this.systemRoles.ensure(tx);
          await this.numbering.ensureAll(tx);
          const membership = await tx.membership.create({
            data: { tenantId: id, userId: owner.id, roleId: roles.owner },
          });
          await this.audit.record(tx, {
            action: 'platform.membership.created',
            actor: auditActor.system('staff.admin_portal'),
            entityId: membership.id,
            after: snapshot('membership', {
              id: membership.id,
              userId: owner.id,
              roleId: roles.owner,
              allLocations: membership.allLocations,
              locationIds: [],
            }),
          });
          await this.entitlements.applyOnboardingOverrides(tx, staffId, id, overrides);
          await this.platformAudit.record(tx, {
            action: 'staff.customer.onboarded',
            actor: { staffId },
            entityId: id,
            organizationId: id,
            after: platformSnapshot('organization', org),
          });
          const result: CustomerDetail = {
            ...toSummary(org),
            owner: {
              email: body.ownerEmail,
              status: hasPassword ? 'active' : 'invited',
            },
          };
          await tx.staffIdempotencyKey.create({
            data: { staffId, key, route: ONBOARD_ROUTE, requestHash, response: result },
          });
          return result;
        }),
      );
    } catch (error) {
      // A concurrent request with the same key won: its transaction committed, ours rolled back.
      if (isUniqueViolation(error)) {
        const winner = await this.replay(staffId, key, requestHash);
        if (winner) return winner;
      }
      throw error;
    }

    // After the commit: a failed send leaves a complete customer; staff can resend the invitation.
    await this.mailOwner(owner.id, body.name, hasPassword);
    return detail;
  }

  /** A new set-password link while the Owner has none; 409 once they have a password. */
  async resendOwnerInvite(staffId: string, id: string): Promise<CustomerDetail> {
    const customer = await this.detail(id);
    const ownerId = await this.ownerId(id);
    if (!customer.owner || ownerId === null) throw staffErrors.customerNotFound();
    if (customer.owner.status === 'active') throw staffErrors.ownerActive();
    await this.db.$transaction((tx) =>
      this.platformAudit.record(tx, {
        action: 'staff.customer.owner_invited',
        actor: { staffId },
        entityId: id,
        organizationId: id,
      }),
    );
    await this.dispatcher.dispatch('staff.customer.owner_mail_failed', () =>
      this.passwords.sendOwnerWelcomeMail(ownerId, customer.name),
    );
    return customer;
  }

  private async replay(
    staffId: string,
    key: string,
    requestHash: string,
  ): Promise<CustomerDetail | null> {
    const prior = await this.db.staffIdempotencyKey.findUnique({
      where: { staffId_key: { staffId, key } },
    });
    if (!prior) return null;
    if (prior.route !== ONBOARD_ROUTE || prior.requestHash !== requestHash) {
      throw idempotencyErrors.keyReused();
    }
    return customerDetailSchema.parse(prior.response);
  }

  private async partnerFor(partnerId: string | undefined): Promise<string> {
    if (partnerId === undefined) {
      return (await this.provisioning.ensurePartner(DEFAULT_PARTNER.slug, DEFAULT_PARTNER.name)).id;
    }
    const partner = await this.platformDb.partner.findUnique({
      where: { id: partnerId },
      select: { id: true },
    });
    if (!partner) throw staffErrors.partnerNotFound();
    return partner.id;
  }

  /** Never throws: a failed send is logged by the dispatcher and the invitation can be resent. */
  private async mailOwner(userId: string, organization: string, hasPassword: boolean) {
    await this.dispatcher.dispatch('staff.customer.owner_mail_failed', () =>
      hasPassword
        ? this.passwords.sendOwnerAddedMail(userId, organization)
        : this.passwords.sendOwnerWelcomeMail(userId, organization),
    );
  }

  /** The first Owner of the customer, read inside its tenant (RLS applies). */
  private ownerId(organizationId: string): Promise<string | null> {
    return this.inTenant(organizationId, async () => {
      const membership = await this.tenantDb.membership.findFirst({
        where: { role: { systemKey: 'owner' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { userId: true },
      });
      return membership?.userId ?? null;
    });
  }

  private async owner(organizationId: string): Promise<CustomerDetail['owner']> {
    const userId = await this.ownerId(organizationId);
    if (userId === null) return null;
    const [profile, withPassword] = await Promise.all([
      this.users.findById(userId),
      this.users.withPassword([userId]),
    ]);
    if (!profile) return null;
    return { email: profile.email, status: withPassword.has(userId) ? 'active' : 'invited' };
  }

  private inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.tenantContext.run({ tenantId, userId: STAFF_TENANT_ACTOR }, fn);
  }
}

function toSummary(org: OrgRow): CustomerSummary {
  return {
    id: org.id,
    name: org.name,
    partner: org.partner,
    plan: org.plan.key as PlanKey,
    createdAt: org.createdAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
