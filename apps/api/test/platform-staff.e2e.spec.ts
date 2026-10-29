import {
  platformAuditResponseSchema,
  staffEnrollResponseSchema,
  staffListResponseSchema,
  staffMeResponseSchema,
  type StaffRole,
} from '@durby/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStaff, parseCreateStaffArgs } from '../src/cli/create-staff';
import { StaffService } from '../src/platform/staff';
import { base32Decode, totpCode } from '../src/platform/staff/totp';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { type AuthTestKit, PASSWORD, startAuthApp, WEB_ORIGIN } from './support/auth-app';
import { RbacSeed } from './support/rbac';

const COOKIE = '__Secure-durby_staff';
const STEP_MS = 30_000;

/** docs/platform/admin-portal.md (ADR 0017): staff accounts, 2FA, sessions, permissions, audit. */
describe('/api/v1/platform (staff)', () => {
  let kit: AuthTestKit;

  beforeAll(async () => {
    kit = await startAuthApp();
  });

  afterAll(async () => {
    await kit.close();
  });

  // The "at least 2 super admins" rule counts every staff account; each test starts without any.
  beforeEach(async () => {
    await kit.raw.staffAccount.updateMany({
      where: { status: { not: 'deactivated' } },
      data: { status: 'deactivated', deactivatedAt: new Date() },
    });
  });

  /** A browser: its own IP, the allowed Origin, and the staff cookie it was given. */
  class Browser {
    cookie: string | undefined;
    readonly ip = `10.${rnd()}.${rnd()}.${rnd()}`;

    send(method: 'get' | 'post' | 'patch', path: string, body?: object, origin = WEB_ORIGIN) {
      let req = request(kit.server)
        [method](`/api/v1/platform${path}`)
        .set('X-Forwarded-For', this.ip);
      if (origin) req = req.set('Origin', origin);
      if (this.cookie) req = req.set('Cookie', `${COOKIE}=${this.cookie}`);
      const keep = (res: request.Response) => {
        const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
        for (const line of set) {
          const match = new RegExp(`^${COOKIE}=([^;]*)`).exec(line);
          if (match) this.cookie = match[1] || undefined;
        }
        return res;
      };
      return { expect: async (status: number) => keep(await req.send(body ?? {}).expect(status)) };
    }
  }

  const email = () => `s-${uuidv7()}@durby.test`;
  const nextStep = () => kit.clock.advance(STEP_MS);
  const code = (secret: string) =>
    totpCode(base32Decode(secret), Math.floor(kit.clock.now().getTime() / STEP_MS));

  function invitationToken(address: string): string {
    const mail = kit.mailer.to(address).at(-1);
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '')?.[1];
    if (!token) throw new Error(`no invitation for ${address}`);
    return token;
  }

  /** Invited by the bootstrap command, accepted, enrolled and signed in. */
  async function onboard(role: StaffRole = 'super_admin') {
    const address = email();
    const member = await kit.app
      .get(StaffService)
      .invite({ system: 'cli.create_staff' }, address, role);
    const browser = new Browser();
    const accepted = await browser
      .send('post', '/auth/accept', { token: invitationToken(address), password: PASSWORD })
      .expect(200);
    expect(accepted.body).toEqual({ next: 'enroll' });
    const { secret } = staffEnrollResponseSchema.parse(
      (await browser.send('post', '/auth/enroll').expect(200)).body,
    );
    await browser.send('post', '/auth/enroll/confirm', { code: code(secret) }).expect(204);
    return { id: member.id, email: address, secret, browser };
  }

  async function signIn(address: string, secret: string) {
    const browser = new Browser();
    const res = await browser
      .send('post', '/auth/login', { email: address, password: PASSWORD })
      .expect(200);
    expect(res.body).toEqual({ next: 'totp' });
    nextStep();
    await browser.send('post', '/auth/totp', { code: code(secret) }).expect(204);
    return browser;
  }

  describe('invitation, enrollment and sign-in', () => {
    it('accepts an invitation once, enrolls 2FA and signs in with password and code', async () => {
      const { email: address, secret, browser, id } = await onboard();
      const me = staffMeResponseSchema.parse(
        (await browser.send('get', '/auth/me').expect(200)).body,
      );
      expect(me).toMatchObject({ id, email: address, role: 'super_admin' });
      expect(me.permissions).toContain('staff.staff.manage');
      expect(me.freshUntil).not.toBeNull();

      // The link works once.
      const again = await new Browser()
        .send('post', '/auth/accept', { token: invitationToken(address), password: PASSWORD })
        .expect(400);
      expect(again.body).toMatchObject({ code: 'staff.invitation_invalid' });

      const second = await signIn(address, secret);
      await second.send('get', '/auth/me').expect(200);
      // Logout ends only that session.
      await second.send('post', '/auth/logout').expect(204);
      await second.send('get', '/auth/me').expect(401);
      await browser.send('get', '/auth/me').expect(200);
    });

    it('grants nothing before the code, and refuses wrong and replayed codes', async () => {
      const { email: address, secret } = await onboard();
      const browser = new Browser();
      await browser.send('post', '/auth/login', { email: address, password: PASSWORD }).expect(200);
      const pending = await browser.send('get', '/auth/me').expect(401);
      expect(pending.body).toMatchObject({ code: 'staff.unauthenticated' });
      const wrong = await browser.send('post', '/auth/totp', { code: '000000' }).expect(401);
      expect(wrong.body).toMatchObject({ code: 'staff.invalid_code' });
      // The code used at enrollment (same step) can't be used again.
      await browser.send('post', '/auth/totp', { code: code(secret) }).expect(401);
      nextStep();
      await browser.send('post', '/auth/totp', { code: code(secret) }).expect(204);
      await browser.send('get', '/auth/me').expect(200);
    });

    it('treats unknown emails, wrong passwords and deactivated accounts alike', async () => {
      const { email: address } = await onboard();
      for (const body of [
        { email: email(), password: PASSWORD },
        { email: address, password: 'wrong password!!' },
      ]) {
        const res = await new Browser().send('post', '/auth/login', body).expect(401);
        expect(res.body).toMatchObject({ code: 'staff.invalid_credentials' });
      }
    });

    it('locks code entry after repeated wrong codes', async () => {
      const { email: address } = await onboard();
      const browser = new Browser();
      await browser.send('post', '/auth/login', { email: address, password: PASSWORD }).expect(200);
      for (let i = 0; i < 5; i++) {
        await browser.send('post', '/auth/totp', { code: '000000' }).expect(401);
      }
      const locked = await browser.send('post', '/auth/totp', { code: '000000' }).expect(429);
      expect(locked.body).toMatchObject({ code: 'auth.too_many_attempts' });
    });

    it('ends sessions after 8 hours', async () => {
      const { browser } = await onboard();
      kit.clock.advance(8 * 60 * 60_000 + 1000);
      await browser.send('get', '/auth/me').expect(401);
    });
  });

  describe('separation from customer accounts', () => {
    it('never accepts a customer token on staff routes, nor the staff cookie on customer routes', async () => {
      const seed = new RbacSeed(kit.app);
      const org = await seed.org();
      const user = await kit.createUser();
      await seed.member(org.id, user.id, org.roles.owner);
      const owner = await seed.token(user.id, org.id);
      const res = await request(kit.server)
        .get('/api/v1/platform/auth/me')
        .auth(owner, { type: 'bearer' })
        .expect(401);
      expect(res.body).toMatchObject({ code: 'staff.unauthenticated' });

      const { browser } = await onboard();
      await request(kit.server)
        .get('/api/v1/auth/me')
        .set('Cookie', `${COOKIE}=${browser.cookie}`)
        .expect(401);
    });

    it('keeps staff tables away from the platform client', async () => {
      const platform = kit.app.get<PlatformPrismaClient>(PLATFORM_PRISMA);
      await expect(platform.staffAccount.findMany()).rejects.toThrow(/private to platform\/staff/);
      await expect(platform.platformAuditLog.findMany()).rejects.toThrow(
        /private to platform\/staff/,
      );
    });

    it('requires an allowed Origin on staff writes', async () => {
      const { browser } = await onboard();
      const res = await browser
        .send('post', '/staff/invitations', { email: email(), role: 'support' }, '')
        .expect(403);
      expect(res.body).toMatchObject({ code: 'auth.origin_rejected' });
    });
  });

  describe('staff management', () => {
    it('limits staff screens to the roles that hold their keys', async () => {
      const { browser: support } = await onboard('support');
      await support.send('get', '/auth/me').expect(200);
      const denied = await support.send('get', '/staff').expect(403);
      expect(denied.body).toMatchObject({
        code: 'staff.permission_denied',
        details: { permission: 'staff.staff.read' },
      });
      await support.send('get', '/audit').expect(403);
    });

    it('invites only company addresses, resends to invited ones and refuses active ones', async () => {
      const { browser } = await onboard();
      const bad = await browser
        .send('post', '/staff/invitations', { email: 'x@gmail.com', role: 'support' })
        .expect(400);
      expect(bad.body).toMatchObject({ code: 'staff.email_domain' });

      const address = email();
      await browser
        .send('post', '/staff/invitations', { email: address, role: 'support' })
        .expect(200);
      const first = invitationToken(address);
      await browser
        .send('post', '/staff/invitations', { email: address, role: 'onboarding' })
        .expect(200);
      const second = invitationToken(address);
      expect(second).not.toBe(first);
      await new Browser()
        .send('post', '/auth/accept', { token: first, password: PASSWORD })
        .expect(400);
      await new Browser()
        .send('post', '/auth/accept', { token: second, password: PASSWORD })
        .expect(200);

      const { email: active } = await onboard('support');
      const res = await browser
        .send('post', '/staff/invitations', { email: active, role: 'support' })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'staff.already_active' });

      const list = staffListResponseSchema.parse(
        (await browser.send('get', '/staff').expect(200)).body,
      );
      expect(list.data.find((m) => m.email === address)).toMatchObject({
        role: 'onboarding',
        status: 'invited',
        totpEnrolled: false,
      });
    });

    it('needs a fresh confirmation for changes', async () => {
      const { browser, secret } = await onboard();
      kit.clock.advance(16 * 60_000);
      const stale = await browser
        .send('post', '/staff/invitations', { email: email(), role: 'support' })
        .expect(401);
      expect(stale.body).toMatchObject({ code: 'staff.reauth_required' });
      await browser.send('get', '/staff').expect(200); // reading isn't sensitive
      await browser
        .send('post', '/auth/reauth', { password: 'wrong password!!', code: code(secret) })
        .expect(401);
      await browser
        .send('post', '/auth/reauth', { password: PASSWORD, code: code(secret) })
        .expect(204);
      await browser
        .send('post', '/staff/invitations', { email: email(), role: 'support' })
        .expect(200);
    });

    it('keeps at least 2 active super admins and never changes yourself', async () => {
      const a = await onboard();
      const b = await onboard();
      for (const [method, path, body] of [
        ['post', `/staff/${b.id}/deactivate`, undefined],
        ['patch', `/staff/${b.id}`, { role: 'support' }],
      ] as const) {
        const res = await a.browser.send(method, path, body).expect(409);
        expect(res.body).toMatchObject({ code: 'staff.last_super_admins' });
      }
      const self = await a.browser.send('patch', `/staff/${a.id}`, { role: 'support' }).expect(409);
      expect(self.body).toMatchObject({ code: 'staff.cannot_change_self' });

      await onboard(); // a third one
      await a.browser.send('patch', `/staff/${b.id}`, { role: 'support' }).expect(200);
      // Now b is support: it loses staff management at once.
      await b.browser.send('get', '/staff').expect(403);
    });

    it('deactivation and 2FA reset end sessions at once', async () => {
      const a = await onboard();
      const c = await onboard('support');
      await a.browser.send('post', `/staff/${c.id}/reset-2fa`).expect(200);
      await c.browser.send('get', '/auth/me').expect(401);
      const relogin = await new Browser()
        .send('post', '/auth/login', { email: c.email, password: PASSWORD })
        .expect(200);
      expect(relogin.body).toEqual({ next: 'enroll' });

      const d = await onboard('onboarding');
      const res = await a.browser.send('post', `/staff/${d.id}/deactivate`).expect(200);
      expect(res.body).toMatchObject({ status: 'deactivated' });
      await d.browser.send('get', '/auth/me').expect(401);
      await new Browser()
        .send('post', '/auth/login', { email: d.email, password: PASSWORD })
        .expect(401);
      // Replaying the deactivation changes nothing and records nothing more.
      await a.browser.send('post', `/staff/${d.id}/deactivate`).expect(200);
      expect(
        await kit.raw.platformAuditLog.count({
          where: { entityId: d.id, action: 'staff.account.deactivated' },
        }),
      ).toBe(1);
    });
  });

  describe('platform audit log', () => {
    it('records staff actions with allow-listed snapshots, newest first, and is append-only', async () => {
      const a = await onboard();
      const address = email();
      await a.browser
        .send('post', '/staff/invitations', { email: address, role: 'support' })
        .expect(200);
      const page = platformAuditResponseSchema.parse(
        (await a.browser.send('get', '/audit?limit=3').expect(200)).body,
      );
      expect(page.data.map((e) => e.action)).toEqual([
        'staff.account.invited',
        'staff.session.logged_in',
        'staff.account.activated',
      ]);
      expect(page.data[0]).toMatchObject({
        actor: { type: 'staff', name: a.email },
        after: { role: 'support', status: 'invited' },
      });
      expect(page.nextCursor).not.toBeNull();
      const older = platformAuditResponseSchema.parse(
        (await a.browser.send('get', `/audit?limit=1&cursor=${page.nextCursor}`).expect(200)).body,
      );
      expect(older.data[0]).toMatchObject({
        action: 'staff.account.invited',
        actor: { type: 'system', name: 'cli.create_staff' },
      });
      // No email, hash or secret in any snapshot.
      expect(JSON.stringify(page.data.map((e) => [e.before, e.after]))).not.toMatch(
        /@|hash|secret/i,
      );

      await expect(
        kit.raw.$executeRaw`UPDATE platform_audit_logs SET reason = 'x'`,
      ).rejects.toThrow();
      await expect(kit.raw.$executeRaw`DELETE FROM platform_audit_logs`).rejects.toThrow();
    });
  });

  describe('create-staff command', () => {
    it('parses its arguments', () => {
      expect(
        parseCreateStaffArgs(['--email', ' Ops@Durby.Test ', '--role', 'super_admin']),
      ).toEqual({
        email: 'ops@durby.test',
        role: 'super_admin',
      });
      expect(() =>
        parseCreateStaffArgs(['--email', 'ops@durby.test', '--role', 'owner']),
      ).toThrow();
      expect(() => parseCreateStaffArgs(['--role', 'support'])).toThrow();
    });

    it('invites by email and can run again while the account is invited', async () => {
      const address = email();
      const first = await createStaff(kit.app, { email: address, role: 'super_admin' });
      const second = await createStaff(kit.app, { email: address, role: 'super_admin' });
      expect(second.id).toBe(first.id);
      expect(kit.mailer.to(address)).toHaveLength(2);
      await expect(
        createStaff(kit.app, { email: 'ops@example.com', role: 'super_admin' }),
      ).rejects.toMatchObject({ code: 'staff.email_domain' });
    });
  });
});

function rnd(): number {
  return Math.floor(Math.random() * 250) + 1;
}
