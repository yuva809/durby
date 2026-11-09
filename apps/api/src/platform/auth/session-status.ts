import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database';
import { Clock } from './clock';

/**
 * Whether a sign-in (a refresh family, the access token's `sid`) can still refresh. A UI hint only, for example
 * "Till signed out" in the print warnings (ADR 0033 §12): it reads nothing but the one session's own state.
 */
@Injectable()
export class SessionStatus {
  constructor(
    private readonly db: PrismaService,
    private readonly clock: Clock,
  ) {}

  async isActive(sessionId: string): Promise<boolean> {
    const now = this.clock.now();
    const live = await this.db.refreshToken.count({
      where: {
        familyId: sessionId,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
        familyExpiresAt: { gt: now },
      },
    });
    return live > 0;
  }
}
