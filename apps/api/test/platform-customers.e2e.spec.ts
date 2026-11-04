import {
  customerDetailSchema,
  customerListResponseSchema,
  onboardingOptionsResponseSchema,
  platformAuditResponseSchema,
  sessionResponseSchema,
} from '@durby/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthTestKit, PASSWORD, startAuthApp } from './support/auth-app';
import { RbacSeed } from './support/rbac';
import { mailedToken, signedInStaff, type StaffBrowser } from './support/staff';

/** docs/platform/admin-portal.md → Customers, Onboarding (step 1c). */
describe('/api/v1/platform/customers', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
  });

  afterAll(async () => {
    await kit.close();
  });

  const ownerEmail = () => `owner-${uuidv7()}@example.test`;
  const orgName = () => `Cafe ${uuidv7().slice(-8)}`;

  const onboard = (browser: StaffBrowser, body: object, key = uuidv7(), status = 201) =>
    browser
      .send('post', '/customers', body, { headers: { 'Idempotency-Key': key } })
      .expect(status);

  /** Customer sign-in at /api/v1/auth/login: the organizations the user belongs to. */
  async function customerOrganizations(email: string, password = PASSWORD) {
    const res = await kit.client().post('/login').send({ email, password }).expect(200);
    return sessionResponseSchema.parse(res.body).organizations.map((o) => o.id);
  }

  it('onboards a customer: organization, roles, number series, Owner, invitation; the Owner sets a password and signs in', async () => {
    const { browser } = await signedInStaff(kit);
    const email = ownerEmail();
    const name = orgName();
    const created = customerDetailSchema.parse(
      (await onboard(browser, { name: ` ${name} `, ownerEmail: email, plan: 'inventory' })).body,
    );
    expect(created).toMatchObject({
      name,
      plan: 'inventory',
      partner: { slug: 'durby' },
      owner: { email, status: 'invited' },
    });

    const inTenant = await seed.as(created.id, async (db) => ({
      roles: (await db.role.findMany({ select: { systemKey: true } })).map((r) => r.systemKey),
      series: await db.numberSeries.count(),
      owners: await db.membership.count({ where: { role: { systemKey: 'owner' } } }),
    }));
    expect(inTenant.roles).toEqual(expect.arrayContaining(['owner', 'admin', 'manager', 'staff']));
    expect(inTenant.series).toBeGreaterThan(0);
    expect(inTenant.owners).toBe(1);

    const mail = kit.mailer.to(email).at(-1);
    expect(mail?.subject).toContain(name);
    expect(mail?.text).toMatch(/\/reset-password#token=/);
    await kit
      .client()
      .post('/password/reset')
      .send({ token: mailedToken(kit, email), password: PASSWORD })
      .expect(204);
    expect(await customerOrganizations(email)).toEqual([created.id]);

    const detail = customerDetailSchema.parse(
      (await browser.send('get', `/customers/${created.id}`).expect(200)).body,
    );
    expect(detail.owner).toEqual({ email, status: 'active' });
    const list = customerListResponseSchema.parse(
      (await browser.send('get', `/customers?query=${encodeURIComponent(name)}`).expect(200)).body,
    );
    expect(list.data.map((c) => c.id)).toEqual([created.id]);
  });

  it('warns about a known name or owner account, and adds an existing user as Owner without touching the password', async () => {
    const { browser } = await signedInStaff(kit);
    const existing = await kit.createUser();
    const name = orgName();
    const warned = await onboard(browser, { name, ownerEmail: existing.email }, uuidv7(), 409);
    expect(warned.body).toMatchObject({
      code: 'staff.customer_duplicate',
      details: { nameTaken: false, ownerHasAccount: true },
    });
    const created = customerDetailSchema.parse(
      (await onboard(browser, { name, ownerEmail: existing.email, confirmDuplicates: true })).body,
    );
    expect(created.owner).toEqual({ email: existing.email, status: 'active' });
    expect(kit.mailer.to(existing.email).at(-1)?.text).toMatch(/\/login/);
    expect(await customerOrganizations(existing.email)).toContain(created.id);

    const again = await onboard(
      browser,
      { name: name.toUpperCase(), ownerEmail: ownerEmail() },
      uuidv7(),
      409,
    );
    expect(again.body).toMatchObject({ details: { nameTaken: true, ownerHasAccount: false } });
  });

  it('replays a repeated request instead of creating twice', async () => {
    const { browser } = await signedInStaff(kit);
    const key = uuidv7();
    const body = { name: orgName(), ownerEmail: ownerEmail() };
    const first = await onboard(browser, body, key);
    const second = await onboard(browser, body, key);
    expect(second.body).toEqual(first.body);
    const orgs = await kit.raw.organization.count({ where: { name: body.name } });
    expect(orgs).toBe(1);
    const reused = await onboard(browser, { ...body, plan: 'inventory' }, key, 422);
    expect(reused.body).toMatchObject({ code: 'idempotency.key_reused' });
    const missing = await browser.send('post', '/customers', body).expect(400);
    expect(missing.body).toMatchObject({ code: 'idempotency.key_required' });
  });

  it('resends the invitation only while the Owner has no password', async () => {
    const { browser } = await signedInStaff(kit, 'support');
    const { browser: creator } = await signedInStaff(kit, 'onboarding');
    const email = ownerEmail();
    const created = customerDetailSchema.parse(
      (await onboard(creator, { name: orgName(), ownerEmail: email })).body,
    );
    const first = mailedToken(kit, email);
    await browser.send('post', `/customers/${created.id}/owner-invite`).expect(200);
    const second = mailedToken(kit, email);
    expect(second).not.toBe(first);
    await kit
      .client()
      .post('/password/reset')
      .send({ token: first, password: PASSWORD })
      .expect(400);
    await kit
      .client()
      .post('/password/reset')
      .send({ token: second, password: PASSWORD })
      .expect(204);
    const done = await browser.send('post', `/customers/${created.id}/owner-invite`).expect(409);
    expect(done.body).toMatchObject({ code: 'staff.owner_active' });
  });

  it('lets onboarding staff create, support only read and resend', async () => {
    const { browser: support } = await signedInStaff(kit, 'support');
    await support.send('get', '/customers').expect(200);
    const denied = await onboard(
      support,
      { name: orgName(), ownerEmail: ownerEmail() },
      uuidv7(),
      403,
    );
    expect(denied.body).toMatchObject({
      code: 'staff.permission_denied',
      details: { permission: 'staff.customers.create' },
    });
    await support.send('get', '/onboarding-options').expect(403);

    const { browser: onboarding } = await signedInStaff(kit, 'onboarding');
    const options = onboardingOptionsResponseSchema.parse(
      (await onboarding.send('get', '/onboarding-options').expect(200)).body,
    );
    expect(options.plans).toEqual(['inventory', 'inventory_billing', 'full']);
    expect(options.partners.find((p) => p.id === options.defaultPartnerId)?.slug).toBe('durby');
    await onboard(onboarding, { name: orgName(), ownerEmail: ownerEmail() });
  });

  it('validates, refuses unknown partners and customers, and needs a fresh sign-in', async () => {
    const { browser } = await signedInStaff(kit);
    await onboard(browser, { name: ' ', ownerEmail: ownerEmail() }, uuidv7(), 400);
    await onboard(browser, { name: 'X', ownerEmail: 'nope' }, uuidv7(), 400);
    const partner = await onboard(
      browser,
      { name: orgName(), ownerEmail: ownerEmail(), partnerId: uuidv7() },
      uuidv7(),
      404,
    );
    expect(partner.body).toMatchObject({ code: 'staff.partner_not_found' });
    await browser.send('get', `/customers/${uuidv7()}`).expect(404);
    await browser.send('get', '/customers/not-a-uuid').expect(404);

    kit.clock.advance(16 * 60_000);
    const stale = await onboard(
      browser,
      { name: orgName(), ownerEmail: ownerEmail() },
      uuidv7(),
      401,
    );
    expect(stale.body).toMatchObject({ code: 'staff.reauth_required' });
  });

  it('audits in both logs: the staff member in the platform log, the portal in the customer log', async () => {
    const { browser, email: staffAddress } = await signedInStaff(kit);
    const created = customerDetailSchema.parse(
      (await onboard(browser, { name: orgName(), ownerEmail: ownerEmail() })).body,
    );
    // The platform log is shared with test files running in parallel: find this onboarding's entry.
    const platform = platformAuditResponseSchema.parse(
      (await browser.send('get', '/audit?limit=50').expect(200)).body,
    );
    expect(platform.data.find((e) => e.entityId === created.id)).toMatchObject({
      action: 'staff.customer.onboarded',
      actor: { type: 'staff', name: staffAddress },
      entityId: created.id,
      organizationId: created.id,
    });
    const customerLog = await seed.as(created.id, (db) =>
      db.auditLog.findMany({ select: { action: true, actorSystem: true }, orderBy: { id: 'asc' } }),
    );
    expect(customerLog).toEqual(
      expect.arrayContaining([
        { action: 'platform.organization.created', actorSystem: 'staff.admin_portal' },
        { action: 'platform.membership.created', actorSystem: 'staff.admin_portal' },
      ]),
    );
  });

  it("keeps a new customer's data invisible to other customers", async () => {
    const { browser } = await signedInStaff(kit);
    const created = customerDetailSchema.parse(
      (await onboard(browser, { name: orgName(), ownerEmail: ownerEmail() })).body,
    );
    const other = await seed.org('Other');
    const seen = await seed.as(other.id, async (db) => ({
      roles: await db.role.count({ where: { tenantId: created.id } }),
      members: await db.membership.count({ where: { tenantId: created.id } }),
      audit: await db.auditLog.count({ where: { tenantId: created.id } }),
    }));
    expect(seen).toEqual({ roles: 0, members: 0, audit: 0 });
  });
});
