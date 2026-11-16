import {
  feedbackListResponseSchema,
  feedbackSchema,
  platformAuditResponseSchema,
  staffFeedbackListResponseSchema,
  staffFeedbackSchema,
  type SystemRole,
} from '@durby/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthTestKit, startAuthApp } from './support/auth-app';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { signedInStaff } from './support/staff';

/**
 * docs/platform/feedback.md (ADR 0044 step 5): every member sends feedback and sees their organization's; Durby staff
 * read all of it and mark it seen or done (platform audit log); one organization never sees another's.
 */
describe('feedback (ADR 0044 step 5)', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
  });

  afterAll(async () => {
    await kit.close();
  });

  async function member(org: SeededOrg, role: SystemRole) {
    const userId = await seed.user();
    await seed.member(org.id, userId, org.roles[role]);
    return seed.token(userId, org.id);
  }

  const send = (token: string, body: object) =>
    withIdempotencyKey(
      request(kit.server).post('/api/v1/feedback').auth(token, { type: 'bearer' }),
      uuidv7(),
    ).send(body);
  const own = async (token: string) =>
    feedbackListResponseSchema.parse(
      (
        await request(kit.server)
          .get('/api/v1/feedback')
          .auth(token, { type: 'bearer' })
          .expect(200)
      ).body,
    ).data;

  it('lets every role send feedback and see only their organization’s', async () => {
    const a = await seed.org();
    const b = await seed.org();
    const waiter = await member(a, 'waiter');
    const sent = feedbackSchema.parse(
      (
        await send(waiter, {
          category: 'bug',
          message: 'The bill printer stops after two bills.',
          pagePath: '/checkout',
        }).expect(201)
      ).body,
    );
    expect(sent).toMatchObject({ category: 'bug', status: 'new', pagePath: '/checkout' });
    expect((await own(await member(a, 'owner'))).map((f) => f.id)).toEqual([sent.id]);
    expect(await own(await member(b, 'owner'))).toEqual([]);
    await send(waiter, { category: 'bug', message: '   ' }).expect(400);
    await send(waiter, { category: 'other', message: 'x' }).expect(400);
  });

  it('shows staff all feedback with the sender, and records status changes', async () => {
    const org = await seed.org();
    const owner = await member(org, 'owner');
    const sent = feedbackSchema.parse(
      (await send(owner, { category: 'idea', message: 'Print picking lists.' }).expect(201)).body,
    );
    const support = await signedInStaff(kit, 'support');
    const list = staffFeedbackListResponseSchema.parse(
      (await support.browser.send('get', '/feedback?status=new').expect(200)).body,
    );
    const item = list.data.find((f) => f.id === sent.id);
    expect(item).toMatchObject({ organizationId: org.id, status: 'new' });
    expect(item?.userEmail).toMatch(/@/);

    const done = staffFeedbackSchema.parse(
      (await support.browser.send('patch', `/feedback/${sent.id}`, { status: 'done' }).expect(200))
        .body,
    );
    expect(done.status).toBe('done');
    // The same status again changes nothing.
    await support.browser.send('patch', `/feedback/${sent.id}`, { status: 'done' }).expect(200);
    expect((await own(owner)).find((f) => f.id === sent.id)?.status).toBe('done');
    // One platform audit row: the second request changed nothing.
    const admin = await signedInStaff(kit, 'super_admin');
    const audit = platformAuditResponseSchema.parse(
      (await admin.browser.send('get', '/audit?limit=50').expect(200)).body,
    );
    expect(
      audit.data.filter(
        (e) => e.action === 'staff.feedback.status_changed' && e.entityId === sent.id,
      ),
    ).toHaveLength(1);

    const onboarding = await signedInStaff(kit, 'onboarding');
    await onboarding.browser.send('get', '/feedback').expect(200);
    await onboarding.browser.send('patch', `/feedback/${sent.id}`, { status: 'seen' }).expect(403);
  });
});
