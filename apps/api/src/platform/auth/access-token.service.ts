import { Inject, Injectable } from '@nestjs/common';
import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config';

/** The only accepted algorithm, on sign and verify (ADR 0006). */
export const ACCESS_TOKEN_ALGORITHM = 'HS256';
export const ACCESS_TOKEN_TYPE = 'at+jwt';

export interface AccessTokenSubject {
  userId: string;
  /** Active organization (= tenant), or null when the user has none. */
  organizationId: string | null;
  /** Refresh token family = login session. */
  sessionId: string;
  /** The password is temporary and must be changed first (ADR 0023 §3); claim `pcr`. */
  passwordChangeRequired?: boolean;
}

export interface AccessTokenClaims extends AccessTokenSubject {
  issuedAt: number;
  expiresAt: number;
}

const claimsSchema = z.object({
  sub: z.uuid(),
  org: z.uuid().nullable(),
  sid: z.uuid(),
  pcr: z.literal(true).optional(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export class InvalidAccessTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid access token: ${reason}`);
    this.name = 'InvalidAccessTokenError';
  }
}

@Injectable()
export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.key = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
  }

  get ttlSeconds(): number {
    return this.config.JWT_ACCESS_TTL_SECONDS;
  }

  async sign(subject: AccessTokenSubject, now: Date = new Date()): Promise<string> {
    const iat = Math.floor(now.getTime() / 1000);
    return new SignJWT({
      org: subject.organizationId,
      sid: subject.sessionId,
      ...(subject.passwordChangeRequired === true && { pcr: true }),
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: ACCESS_TOKEN_TYPE })
      .setSubject(subject.userId)
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(this.config.JWT_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.config.JWT_ACCESS_TTL_SECONDS)
      .sign(this.key);
  }

  /** Throws InvalidAccessTokenError for anything but a well-formed, unexpired HS256 token of ours. */
  async verify(token: string, now: Date = new Date()): Promise<AccessTokenClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        typ: ACCESS_TOKEN_TYPE,
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
        requiredClaims: ['sub', 'sid', 'iat', 'exp'],
        currentDate: now,
        clockTolerance: 5,
      }));
    } catch (error) {
      throw new InvalidAccessTokenError(
        error instanceof errors.JOSEError ? error.code : 'malformed',
      );
    }
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) throw new InvalidAccessTokenError('claims');
    const { sub, org, sid, pcr, iat, exp } = claims.data;
    return {
      userId: sub,
      organizationId: org,
      sessionId: sid,
      passwordChangeRequired: pcr === true,
      issuedAt: iat,
      expiresAt: exp,
    };
  }
}
