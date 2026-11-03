import { generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import { AccessTokenService, InvalidAccessTokenError } from './access-token.service';

const secret = 'unit-test-secret-0123456789abcdef0123';
const config = {
  JWT_ACCESS_SECRET: secret,
  JWT_ACCESS_TTL_SECONDS: 600,
  JWT_ISSUER: 'durby-api',
  JWT_AUDIENCE: 'durby-web',
} as AppConfig;

const service = new AccessTokenService(config);
const key = new TextEncoder().encode(secret);
const subject = { userId: uuidv7(), organizationId: uuidv7(), sessionId: uuidv7() };

/** A token like ours, with one thing changed. */
function forged(opts: { alg?: string; typ?: string; iss?: string; aud?: string; claims?: object }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ org: subject.organizationId, sid: subject.sessionId, ...opts.claims })
    .setProtectedHeader({ alg: opts.alg ?? 'HS256', typ: opts.typ ?? 'at+jwt' })
    .setSubject(subject.userId)
    .setIssuer(opts.iss ?? 'durby-api')
    .setAudience(opts.aud ?? 'durby-web')
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(key);
}

const rejects = (token: string | Promise<string>) =>
  expect(Promise.resolve(token).then((t) => service.verify(t))).rejects.toThrow(
    InvalidAccessTokenError,
  );

describe('AccessTokenService', () => {
  it('round-trips the subject with iat and exp', async () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const token = await service.sign(subject, now);
    const claims = await service.verify(token, now);
    expect(claims).toEqual({
      ...subject,
      passwordChangeRequired: false,
      issuedAt: now.getTime() / 1000,
      expiresAt: now.getTime() / 1000 + 600,
    });
  });

  it('carries a null organization', async () => {
    const token = await service.sign({ ...subject, organizationId: null });
    expect((await service.verify(token)).organizationId).toBeNull();
  });

  it('pins HS256 and at+jwt in the header', async () => {
    const [header] = (await service.sign(subject)).split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'at+jwt',
    });
  });

  it('rejects alg: none', async () => {
    const unsecured = new UnsecuredJWT({ org: subject.organizationId, sid: subject.sessionId })
      .setSubject(subject.userId)
      .setIssuer('durby-api')
      .setAudience('durby-web')
      .setIssuedAt()
      .setExpirationTime('10m')
      .encode();
    await rejects(unsecured);
  });

  it('rejects other HMAC algorithms with the same secret', async () => {
    await rejects(forged({ alg: 'HS512' }));
    await rejects(forged({ alg: 'HS384' }));
  });

  it('rejects asymmetric tokens', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    await rejects(
      new SignJWT({ org: subject.organizationId, sid: subject.sessionId })
        .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' })
        .setSubject(subject.userId)
        .setIssuer('durby-api')
        .setAudience('durby-web')
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(privateKey),
    );
  });

  it('rejects the wrong issuer, audience or type', async () => {
    await rejects(forged({ iss: 'someone-else' }));
    await rejects(forged({ aud: 'pos-device' }));
    await rejects(forged({ typ: 'JWT' }));
  });

  it('rejects an expired token', async () => {
    const issued = new Date('2026-10-22T12:00:00Z');
    const token = await service.sign(subject, issued);
    await expect(
      service.verify(token, new Date(issued.getTime() + 601_000 + 5_000)),
    ).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects a token signed with another secret', async () => {
    const other = new AccessTokenService({ ...config, JWT_ACCESS_SECRET: 'x'.repeat(40) });
    await rejects(other.sign(subject));
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await service.sign(subject)).split('.');
    const payload = Buffer.from(
      JSON.stringify({ sub: subject.userId, org: uuidv7(), sid: subject.sessionId }),
    ).toString('base64url');
    await rejects(`${header}.${payload}.${signature}`);
  });

  it('rejects malformed claims (non-UUID ids)', async () => {
    await rejects(forged({ claims: { org: 'tenant-b' } }));
    await rejects(forged({ claims: { sid: 42 } }));
  });

  it('rejects garbage', async () => {
    await rejects('not.a.jwt');
    await rejects('');
  });
});
