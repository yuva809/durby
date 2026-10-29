import { Inject, Injectable } from '@nestjs/common';
import type { StaffMember, StaffRole } from '@durby/shared';
import { Clock, generateToken, hashToken, normalizeEmail } from '../auth';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../database';
import type { Prisma } from '../database/generated/client';
import {
  type PlatformAuditActor,
  PlatformAuditService,
  platformSnapshot,
} from './platform-audit.service';
import { staffErrors } from './staff-errors';
import { StaffMailer } from './staff-mailer';

/** Invitation links stay valid this long. */
const INVITATION_TTL_MS = 48 * 60 * 60_000;
/** The portal can never lock Durby out (business rules: "at least 2 active super admins"). */
export const MIN_SUPER_ADMINS = 2;

const MEMBER_SELECT = {
  id: true,
  email: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

type Tx = Prisma.TransactionClient;
type AccountRow = { id: string; role: StaffRole; status: string };

/**
 * Staff accounts (docs/platform/admin-portal.md → Staff management). Every change and its platform
 * audit row commit together; changes that touch super admins run under one lock, so two concurrent
 * demotions can't both pass the "at least 2" check. Writes are replay-safe (ADR 0017 §8).
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly db: PrismaService,
    private readonly clock: Clock,
    private readonly audit: PlatformAuditService,
    private readonly mailer: StaffMailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(): Promise<StaffMember[]> {
    const rows = await this.db.staffAccount.findMany({
      select: MEMBER_SELECT,
      orderBy: [{ email: 'asc' }],
    });
    return rows.map(toMember);
  }

  /**
   * Invites a company address, or sends a fresh link to one still invited (older links stop
   * working). A deactivated account is invited again from scratch: its password is cleared.
   */
  async invite(actor: PlatformAuditActor, rawEmail: string, role: StaffRole): Promise<StaffMember> {
    const email = normalizeEmail(rawEmail);
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!this.config.STAFF_EMAIL_DOMAINS.includes(domain)) throw staffErrors.emailDomain();
    const now = this.clock.now();
    const token = generateToken();
    const member = await this.db.$transaction(async (tx) => {
      await lockStaff(tx);
      const before = await tx.staffAccount.findUnique({ where: { email } });
      if (before?.status === 'active') throw staffErrors.alreadyActive();
      if ('staffId' in actor && before?.id === actor.staffId) throw staffErrors.cannotChangeSelf();
      const fresh = {
        role,
        status: 'invited' as const,
        passwordHash: null,
        deactivatedAt: null,
      };
      const after = before
        ? await tx.staffAccount.update({ where: { id: before.id }, data: fresh })
        : await tx.staffAccount.create({ data: { email, ...fresh } });
      await tx.staffToken.updateMany({
        where: { staffId: after.id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.staffToken.create({
        data: {
          staffId: after.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        },
      });
      await tx.staffSession.updateMany({
        where: { staffId: after.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record(tx, {
        action: 'staff.account.invited',
        actor,
        entityId: after.id,
        before: before && platformSnapshot('staff_account', before),
        after: platformSnapshot('staff_account', after),
      });
      return toMember(after);
    });
    // After the commit: a failed send leaves a valid account; inviting again sends a new link.
    await this.mailer.sendInvitation(email, token);
    return member;
  }

  async changeRole(actorId: string, id: string, role: StaffRole): Promise<StaffMember> {
    return this.change(actorId, id, async (tx, before) => {
      if (before.role === role) return null;
      if (before.role === 'super_admin') await assertSuperAdminsRemain(tx, before);
      const after = await tx.staffAccount.update({ where: { id }, data: { role } });
      return { action: 'staff.account.role_changed', after };
    });
  }

  /** Signs the account out everywhere at once. */
  async deactivate(actorId: string, id: string): Promise<StaffMember> {
    const now = this.clock.now();
    return this.change(actorId, id, async (tx, before) => {
      if (before.status === 'deactivated') return null;
      if (before.role === 'super_admin') await assertSuperAdminsRemain(tx, before);
      const after = await tx.staffAccount.update({
        where: { id },
        data: { status: 'deactivated', deactivatedAt: now },
      });
      await revokeSessions(tx, id, now);
      await tx.staffToken.updateMany({
        where: { staffId: id, usedAt: null },
        data: { usedAt: now },
      });
      return { action: 'staff.account.deactivated', after };
    });
  }

  /** Shared frame: lock, load, never yourself, record. `fn` returns null when nothing changes. */
  private async change(
    actorId: string,
    id: string,
    fn: (
      tx: Tx,
      before: AccountRow,
    ) => Promise<{
      action: 'staff.account.role_changed' | 'staff.account.deactivated';
      after: AccountRow;
    } | null>,
  ): Promise<StaffMember> {
    if (actorId === id) throw staffErrors.cannotChangeSelf();
    await this.db.$transaction(async (tx) => {
      await lockStaff(tx);
      const before = await tx.staffAccount.findUnique({ where: { id } });
      if (!before) throw staffErrors.notFound();
      const result = await fn(tx, before);
      if (!result) return;
      await this.audit.record(tx, {
        action: result.action,
        actor: { staffId: actorId },
        entityId: id,
        before: platformSnapshot('staff_account', before),
        after: platformSnapshot('staff_account', result.after),
      });
    });
    return toMember(
      await this.db.staffAccount.findUniqueOrThrow({ where: { id }, select: MEMBER_SELECT }),
    );
  }
}

/** One lock for every staff change (rare writes; keeps the super-admin count consistent). */
async function lockStaff(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('staff_accounts', 0))`;
}

/** Refuses a change that would leave fewer than 2 active super admins besides `target`. */
async function assertSuperAdminsRemain(tx: Tx, target: AccountRow): Promise<void> {
  if (target.status !== 'active') return;
  const others = await tx.staffAccount.count({
    where: { role: 'super_admin', status: 'active', id: { not: target.id } },
  });
  if (others < MIN_SUPER_ADMINS) throw staffErrors.lastSuperAdmins();
}

async function revokeSessions(tx: Tx, staffId: string, now: Date): Promise<void> {
  await tx.staffSession.updateMany({
    where: { staffId, revokedAt: null },
    data: { revokedAt: now },
  });
}

function toMember(row: {
  id: string;
  email: string;
  role: StaffRole;
  status: 'invited' | 'active' | 'deactivated';
  lastLoginAt: Date | null;
  createdAt: Date;
}): StaffMember {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
