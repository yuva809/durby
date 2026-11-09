import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../database';
import type { RefreshToken, RefreshTokenRevokeReason } from '../database/generated/client';
import { Clock } from './clock';
import { generateToken, hashToken } from './crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A used token presented again this soon, while no token issued from it was used, is a lost response, not theft
 * (ADR 0006, amendment 2026-11-09): the client never received the answer (reload, app stopped, network dropped).
 */
export const LOST_RESPONSE_GRACE_MS = 60_000;

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export interface IssuedRefreshToken {
  token: string;
  familyId: string;
  expiresAt: Date;
  /** The session's absolute end (REFRESH_FAMILY_MAX_DAYS after sign-in): signing in again is the only way past it. */
  familyExpiresAt: Date;
}

export interface RefreshSession {
  userId: string;
  familyId: string;
  familyExpiresAt: Date;
  organizationId: string | null;
}

export type RotationResult =
  /** `recovered`: issued again from an already used token whose answer was lost. */
  | { kind: 'rotated'; session: RefreshSession; next: IssuedRefreshToken; recovered: boolean }
  | { kind: 'reused'; session: RefreshSession }
  | { kind: 'invalid' };

/**
 * Rotating refresh tokens, stored as sha256 (ADR 0006). A family is one login session with an
 * absolute lifetime; every use consumes the token and issues the next one of the same family.
 */
@Injectable()
export class RefreshTokenStore {
  constructor(
    private readonly db: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Starts a new family (login). */
  async startFamily(userId: string, organizationId: string | null): Promise<IssuedRefreshToken> {
    const now = this.clock.now();
    const session: RefreshSession = {
      userId,
      familyId: uuidv7(),
      familyExpiresAt: new Date(now.getTime() + this.config.REFRESH_FAMILY_MAX_DAYS * DAY_MS),
      organizationId,
    };
    return this.issue(this.db, session, now, null);
  }

  /**
   * Consumes `token` and issues the next one of its family, atomically. `nextOrganizationId`
   * decides the next token's organization from the current session (refresh: re-checked
   * membership; switch: the new org). `expectFamily` binds the cookie to the caller's session.
   * Presenting an already used token is reuse (the caller must revoke the family), unless it is a
   * lost response: then another token is issued from it.
   */
  async rotate(
    token: string,
    nextOrganizationId: (session: RefreshSession) => Promise<string | null>,
    expectFamily?: { userId: string; familyId: string },
    retried = false,
  ): Promise<RotationResult> {
    const now = this.clock.now();
    const tokenHash = hashToken(token);
    const row = await this.db.refreshToken.findUnique({ where: { tokenHash } });
    if (!row) return { kind: 'invalid' };
    const session: RefreshSession = {
      userId: row.userId,
      familyId: row.familyId,
      familyExpiresAt: row.familyExpiresAt,
      organizationId: row.organizationId,
    };
    if (
      expectFamily &&
      (expectFamily.userId !== row.userId || expectFamily.familyId !== row.familyId)
    ) {
      return { kind: 'invalid' };
    }
    // A sibling of this token was used: whoever holds this one is the second to come back.
    if (row.revokedReason === 'superseded') return { kind: 'reused', session };
    if (row.usedAt !== null) {
      if (!this.mayBeLostResponse(row, row.usedAt, now)) return { kind: 'reused', session };
      return this.recover(row, session, nextOrganizationId, now);
    }
    if (row.revokedAt !== null || row.expiresAt <= now || row.familyExpiresAt <= now) {
      return { kind: 'invalid' };
    }

    const organizationId = await nextOrganizationId(session);
    const rotated = await this.db.$transaction(async (tx) => {
      // Serialized with a recovery of the parent, so no sibling is issued while this one is used.
      if (row.parentId) await lockToken(tx, row.parentId);
      // Only one concurrent caller wins.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: row.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });
      if (count !== 1) return null;
      if (row.parentId) {
        await tx.refreshToken.updateMany({
          where: { parentId: row.parentId, id: { not: row.id }, usedAt: null, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'superseded' },
        });
      }
      const next = await this.issue(tx, { ...session, organizationId }, now, row.id);
      return {
        kind: 'rotated',
        session: { ...session, organizationId },
        next,
        recovered: false,
      } as const;
    });
    if (rotated) return rotated;
    // A concurrent request with the same token won: read it again, now as used (a lost response or reuse).
    return retried
      ? { kind: 'reused', session }
      : this.rotate(token, nextOrganizationId, expectFamily, true);
  }

  private mayBeLostResponse(row: RefreshToken, usedAt: Date, now: Date): boolean {
    return (
      row.revokedAt === null &&
      row.familyExpiresAt > now &&
      now.getTime() - usedAt.getTime() <= LOST_RESPONSE_GRACE_MS
    );
  }

  /** Issues another token from a used one, unless a token issued from it was used meanwhile. */
  private async recover(
    row: RefreshToken,
    session: RefreshSession,
    nextOrganizationId: (session: RefreshSession) => Promise<string | null>,
    now: Date,
  ): Promise<RotationResult> {
    const organizationId = await nextOrganizationId(session);
    return this.db.$transaction(async (tx) => {
      await lockToken(tx, row.id);
      const current = await tx.refreshToken.findUniqueOrThrow({ where: { id: row.id } });
      const childUsed = await tx.refreshToken.count({
        where: { parentId: row.id, usedAt: { not: null } },
      });
      if (childUsed > 0 || current.revokedAt !== null) return { kind: 'reused', session } as const;
      const next = await this.issue(tx, { ...session, organizationId }, now, row.id);
      return {
        kind: 'rotated',
        session: { ...session, organizationId },
        next,
        recovered: true,
      } as const;
    });
  }

  /** The family of a token, used or not (logout). */
  async familyOf(token: string): Promise<{ userId: string; familyId: string } | null> {
    return this.db.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { userId: true, familyId: true },
    });
  }

  async revokeFamily(familyId: string, reason: RefreshTokenRevokeReason): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  private async issue(
    db: Pick<PrismaService, 'refreshToken'>,
    session: RefreshSession,
    now: Date,
    parentId: string | null,
  ): Promise<IssuedRefreshToken> {
    const token = generateToken();
    const expiresAt = new Date(
      Math.min(
        now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
        session.familyExpiresAt.getTime(),
      ),
    );
    await db.refreshToken.create({
      data: {
        userId: session.userId,
        familyId: session.familyId,
        familyExpiresAt: session.familyExpiresAt,
        organizationId: session.organizationId,
        parentId,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });
    return {
      token,
      familyId: session.familyId,
      expiresAt,
      familyExpiresAt: session.familyExpiresAt,
    };
  }
}

/** Locks one token row until the transaction ends. */
async function lockToken(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM refresh_tokens WHERE id = ${id}::uuid FOR UPDATE`;
}
