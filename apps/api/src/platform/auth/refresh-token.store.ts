import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../database';
import type { RefreshTokenRevokeReason } from '../database/generated/client';
import { Clock } from './clock';
import { generateToken, hashToken } from './crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IssuedRefreshToken {
  token: string;
  familyId: string;
  expiresAt: Date;
}

export interface RefreshSession {
  userId: string;
  familyId: string;
  familyExpiresAt: Date;
  organizationId: string | null;
}

export type RotationResult =
  | { kind: 'rotated'; session: RefreshSession; next: IssuedRefreshToken }
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
    return this.issue(this.db, session, now);
  }

  /**
   * Consumes `token` and issues the next one of its family, atomically. `nextOrganizationId`
   * decides the next token's organization from the current session (refresh: re-checked
   * membership; switch: the new org). `expectFamily` binds the cookie to the caller's session.
   * Presenting an already used token is reuse: the caller must revoke the family.
   */
  async rotate(
    token: string,
    nextOrganizationId: (session: RefreshSession) => Promise<string | null>,
    expectFamily?: { userId: string; familyId: string },
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
    if (row.usedAt !== null) return { kind: 'reused', session };
    if (row.revokedAt !== null || row.expiresAt <= now || row.familyExpiresAt <= now) {
      return { kind: 'invalid' };
    }

    const organizationId = await nextOrganizationId(session);
    return this.db.$transaction(async (tx) => {
      // Only one concurrent caller wins; the others see a used token, i.e. reuse.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: row.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });
      if (count !== 1) return { kind: 'reused', session } as const;
      const next = await this.issue(tx, { ...session, organizationId }, now);
      return { kind: 'rotated', session: { ...session, organizationId }, next } as const;
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
        tokenHash: hashToken(token),
        expiresAt,
      },
    });
    return { token, familyId: session.familyId, expiresAt };
  }
}
