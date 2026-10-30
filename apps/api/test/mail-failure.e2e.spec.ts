import { staffMemberSchema } from '@durby/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/platform/database';
import { type AuthTestKit, startAuthApp } from './support/auth-app';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { signedInStaff, staffEmail } from './support/staff';

/** What nodemailer throws when the relay can't be reached (the staging incident). */
const timeout = () =>
  Object.assign(new Error('Connection timeout while mailing to person@example.test'), {
    code: 'ETIMEDOUT',
    command: 'CONN',
  });

describe('a failing or unreachable mail server never fails or stalls the request', () => {
  const logs: string[] = [];
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let org: SeededOrg;
  let ownerToken: string;

  beforeAll(async () => {
    kit = await startAuthApp({ logs });
    seed = new RbacSeed(kit.app);
    org = await seed.org('Bistro Mail');
    const owner = await kit.createUser();
    await seed.member(org.id, owner.id, org.roles.owner);
    ownerToken = await seed.token(owner.id, org.id);
  });

  afterAll(async () => {
    await kit.close();
  });

  afterEach(() => {
    kit.mailer.failWith = null;
    kit.mailer.hangs = false;
  });

  /** The JSON log lines about `event`. */
  const logged = (event: string) =>
    logs
      .join('')
      .split('\n')
      .filter((line) => line.includes(event))
      .map((line) => JSON.parse(line) as { err?: Record<string, unknown> });

  const address = () => `m-${uuidv7()}@example.test`;

  describe('staff invitation', () => {
    it('keeps the invited account, answers 200 and logs only safe fields when the send fails', async () => {
      const { browser } = await signedInStaff(kit);
      const invitee = staffEmail();
      kit.mailer.failWith = timeout();

      const res = await browser
        .send('post', '/staff/invitations', { email: invitee, role: 'support' })
        .expect(200);

      expect(staffMemberSchema.parse(res.body)).toMatchObject({
        email: invitee,
        status: 'invited',
      });
      const stored = await kit.app
        .get(PrismaService)
        .staffAccount.findUnique({ where: { email: invitee } });
      expect(stored?.status).toBe('invited');
      await kit.settle();
      const [line] = logged('staff.invitation_mail_failed');
      expect(line?.err).toEqual({ type: 'Error', code: 'ETIMEDOUT', command: 'CONN' });
      expect(logs.join('')).not.toContain(invitee);
      expect(logs.join('')).not.toContain('person@example.test');

      // Inviting again, once the relay works, sends the new link.
      kit.mailer.failWith = null;
      await browser
        .send('post', '/staff/invitations', { email: invitee, role: 'support' })
        .expect(200);
      expect(kit.mailer.to(invitee)).toHaveLength(1);
    });

    it('answers within the wait budget while the relay hangs', async () => {
      const { browser } = await signedInStaff(kit);
      kit.mailer.hangs = true;
      const started = Date.now();
      await browser
        .send('post', '/staff/invitations', { email: staffEmail(), role: 'support' })
        .expect(200);
      expect(Date.now() - started).toBeLessThan(8_000);
    });
  });

  describe('owner welcome mail', () => {
    const onboard = (
      browser: Awaited<ReturnType<typeof signedInStaff>>['browser'],
      owner: string,
    ) =>
      browser
        .send(
          'post',
          '/customers',
          { name: `Cafe ${uuidv7().slice(-8)}`, ownerEmail: owner, plan: 'inventory' },
          { headers: { 'Idempotency-Key': uuidv7() } },
        )
        .expect(201);

    it('creates the customer, answers 201 and logs safe fields when the send fails; resend works later', async () => {
      const { browser } = await signedInStaff(kit);
      const owner = address();
      kit.mailer.failWith = timeout();

      const created = await onboard(browser, owner);

      expect(created.body).toMatchObject({ owner: { email: owner, status: 'invited' } });
      await kit.settle();
      const [line] = logged('staff.customer.owner_mail_failed');
      expect(line?.err).toEqual({ type: 'Error', code: 'ETIMEDOUT', command: 'CONN' });
      expect(logs.join('')).not.toContain(owner);
      expect(kit.mailer.to(owner)).toHaveLength(0);

      // The resend also survives a failing relay, then delivers once it works.
      const customerId = (created.body as { id: string }).id;
      const before = logged('staff.customer.owner_mail_failed').length;
      await browser.send('post', `/customers/${customerId}/owner-invite`).expect(200);
      expect(logged('staff.customer.owner_mail_failed').length).toBe(before + 1);
      kit.mailer.failWith = null;
      await browser.send('post', `/customers/${customerId}/owner-invite`).expect(200);
      expect(kit.mailer.to(owner)).toHaveLength(1);
    });

    it('answers within the wait budget while the relay hangs', async () => {
      const { browser } = await signedInStaff(kit);
      kit.mailer.hangs = true;
      const started = Date.now();
      await onboard(browser, address());
      expect(Date.now() - started).toBeLessThan(8_000);
    });
  });

  describe('customer invitation', () => {
    it('answers 201, keeps the invitation and logs safe fields, never the link or address', async () => {
      const invitee = address();
      kit.mailer.failWith = timeout();

      await withIdempotencyKey(
        request(kit.server).post('/api/v1/invitations').auth(ownerToken, { type: 'bearer' }),
      )
        .send({ email: invitee, roleId: org.roles.staff })
        .expect(201);

      await kit.settle();
      const failures = logged('invitation mail failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.err).toEqual({ type: 'Error', code: 'ETIMEDOUT', command: 'CONN' });
      const all = logs.join('');
      expect(all).not.toContain(invitee);
      expect(all).not.toContain('accept-invite#');

      const open = await request(kit.server)
        .get('/api/v1/invitations')
        .auth(ownerToken, { type: 'bearer' })
        .expect(200);
      expect((open.body as { data: { email: string }[] }).data.map((i) => i.email)).toContain(
        invitee,
      );
    });
  });
});
