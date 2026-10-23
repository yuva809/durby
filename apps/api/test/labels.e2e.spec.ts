import type { LabelOverride, LabelOverridesResponse, LabelsResponse } from '@durby/shared';
import { Client } from 'pg';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startAuthApp, type AuthTestKit } from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';

const NAV = 'inventory.nav.title';

/** docs/platform/labels.md: resolution, writes, allow-list, validation, audit, isolation, emails. */
describe('/api/v1/labels and /api/v1/label-overrides', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let migrator: Client;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });
    await migrator.connect();
  });

  afterAll(async () => {
    await migrator.end();
    await kit.close();
  });

  async function memberOf(
    org: SeededOrg,
    role: 'owner' | 'admin' | 'manager' | 'staff',
    locale = 'en',
  ): Promise<{ id: string; email: string; token: string }> {
    const user = await kit.createUser({ locale });
    await seed.member(org.id, user.id, org.roles[role]);
    return { id: user.id, email: user.email, token: await seed.token(user.id, org.id) };
  }

  const labels = (token: string, locale?: string) =>
    request(kit.server)
      .get(`/api/v1/labels${locale ? `?locale=${locale}` : ''}`)
      .auth(token, { type: 'bearer' });

  const label = async (token: string, locale: string, key: string = NAV) =>
    ((await labels(token, locale).expect(200)).body as LabelsResponse).data[key];

  const put = (token: string, locale: string, key: string, value: unknown) =>
    request(kit.server)
      .put(`/api/v1/label-overrides/${locale}/${key}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' })
      .send({ value });

  const del = (token: string, locale: string, key: string) =>
    request(kit.server)
      .delete(`/api/v1/label-overrides/${locale}/${key}`)
      .set('Idempotency-Key', uuidv7())
      .auth(token, { type: 'bearer' });

  const list = (token: string, locale?: string) =>
    request(kit.server)
      .get(`/api/v1/label-overrides${locale ? `?locale=${locale}` : ''}`)
      .auth(token, { type: 'bearer' });

  const stored = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.labelOverride.findMany({ select: { locale: true, key: true, value: true } }),
    );

  const auditRows = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.auditLog.findMany({
        where: { entityType: 'label_override' },
        orderBy: { id: 'asc' },
        select: { action: true, actorUserId: true, before: true, after: true },
      }),
    );

  const partnerOf = async (orgId: string) =>
    (
      await migrator.query<{ partner_id: string }>(
        'SELECT partner_id FROM organizations WHERE id = $1',
        [orgId],
      )
    ).rows[0]?.partner_id;

  /** Partner overrides are written by migrations only (ADR 0011 §1): insert as the migrator. */
  async function partnerOverride(orgId: string, locale: string, key: string, value: string) {
    await migrator.query(
      `INSERT INTO partner_label_overrides (partner_id, locale, key, value, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [await partnerOf(orgId), locale, key, value],
    );
  }

  describe('the terminology demo', () => {
    it('org B calls it "Products"; org A still sees "Inventory", in en and de', async () => {
      const [a, b] = await Promise.all([seed.org('A'), seed.org('B')]);
      const [adminA, adminB] = await Promise.all([memberOf(a, 'admin'), memberOf(b, 'admin')]);

      const res = await put(adminB.token, 'en', NAV, 'Products').expect(200);
      expect(res.body as LabelOverride).toEqual({
        locale: 'en',
        key: NAV,
        value: 'Products',
        defaultValue: 'Inventory',
        active: true,
      });

      expect(await label(adminB.token, 'en')).toBe('Products');
      // No de override yet: the de default, never the en override.
      expect(await label(adminB.token, 'de')).toBe('Lager');
      expect(await label(adminA.token, 'en')).toBe('Inventory');
      expect(await label(adminA.token, 'de')).toBe('Lager');

      await put(adminB.token, 'de', NAV, 'Produkte').expect(200);
      expect(await label(adminB.token, 'de')).toBe('Produkte');
      expect(await label(adminA.token, 'de')).toBe('Lager');
      expect(await label(adminA.token, 'en')).toBe('Inventory');

      // Isolation: org A's list and rows hold nothing of org B.
      expect((await list(adminA.token).expect(200)).body).toEqual({ data: [] });
      expect(await stored(a.id)).toEqual([]);
      expect((await list(adminB.token).expect(200)).body as LabelOverridesResponse).toMatchObject({
        data: [
          { locale: 'de', key: NAV, value: 'Produkte' },
          { locale: 'en', key: NAV, value: 'Products' },
        ],
      });

      // Removing org A's (non-existent) override leaves org B's alone.
      await del(adminA.token, 'en', NAV).expect(204);
      expect(await label(adminB.token, 'en')).toBe('Products');
    });
  });

  describe('reading', () => {
    it("defaults to the user's locale and returns every key", async () => {
      const org = await seed.org();
      const user = await memberOf(org, 'staff', 'de');
      const body = (await labels(user.token).expect(200)).body as LabelsResponse;
      expect(body.locale).toBe('de');
      expect(body.data[NAV]).toBe('Lager');
      expect(Object.keys(body.data).length).toBeGreaterThan(100);
    });

    it('is allowed for staff (settings.read); the overrides list is not', async () => {
      const org = await seed.org();
      const staff = await memberOf(org, 'staff');
      await labels(staff.token, 'en').expect(200);
      await list(staff.token).expect(403);
    });

    it('rejects unsupported locales and unknown query fields', async () => {
      const org = await seed.org();
      const owner = await memberOf(org, 'owner');
      expect((await labels(owner.token, 'fr').expect(400)).body).toMatchObject({
        code: 'validation.failed',
      });
      await request(kit.server)
        .get('/api/v1/labels?tenantId=x')
        .auth(owner.token, { type: 'bearer' })
        .expect(400);
    });

    it('inherits partner overrides per locale; the organization beats them', async () => {
      const org = await seed.org();
      const admin = await memberOf(org, 'admin');
      await partnerOverride(org.id, 'de', NAV, 'Bestand');
      await partnerOverride(org.id, 'en', 'platform.app.name', 'Acme Kitchen');
      // A stored partner value whose placeholders don't match is skipped (fail safe).
      await partnerOverride(org.id, 'en', 'platform.email.invite.subject', 'Join us');

      expect(await label(admin.token, 'de')).toBe('Bestand');
      expect(await label(admin.token, 'en', 'platform.app.name')).toBe('Acme Kitchen');
      expect(await label(admin.token, 'en', 'platform.email.invite.subject')).toBe(
        "You're invited to {organization}",
      );

      await put(admin.token, 'en', NAV, 'Products').expect(200);
      expect(await label(admin.token, 'de')).toBe('Bestand'); // never the en org override
      await put(admin.token, 'de', NAV, 'Produkte').expect(200);
      expect(await label(admin.token, 'de')).toBe('Produkte');
    });

    it('skips stored organization rows that are no longer allowed, lists them inactive, lets them be removed', async () => {
      const org = await seed.org();
      const admin = await memberOf(org, 'admin');
      // Written behind the api's back (e.g. a key that left the allow-list).
      await seed.as(org.id, (db) =>
        db.labelOverride.create({
          data: { tenantId: org.id, locale: 'en', key: 'platform.app.name', value: 'Phish' },
        }),
      );
      expect(await label(admin.token, 'en', 'platform.app.name')).toBe('Durby');
      expect((await list(admin.token, 'en').expect(200)).body).toEqual({
        data: [
          {
            locale: 'en',
            key: 'platform.app.name',
            value: 'Phish',
            defaultValue: 'Durby',
            active: false,
          },
        ],
      });
      await del(admin.token, 'en', 'platform.app.name').expect(204);
      expect(await stored(org.id)).toEqual([]);
    });
  });

  describe('writing', () => {
    it('writes exactly one audit row per change and none for no-ops', async () => {
      const org = await seed.org();
      const admin = await memberOf(org, 'admin');

      await put(admin.token, 'en', NAV, 'Products').expect(200);
      await put(admin.token, 'en', NAV, 'Products').expect(200); // no-op
      await put(admin.token, 'en', NAV, 'Goods').expect(200);
      await del(admin.token, 'en', NAV).expect(204);
      await del(admin.token, 'en', NAV).expect(204); // no-op

      const rows = await auditRows(org.id);
      expect(rows.map((r) => r.action)).toEqual([
        'platform.label_override.created',
        'platform.label_override.updated',
        'platform.label_override.deleted',
      ]);
      expect(rows.every((r) => r.actorUserId === admin.id)).toBe(true);
      expect(rows[1]).toMatchObject({
        before: { locale: 'en', key: NAV, value: 'Products' },
        after: { locale: 'en', key: NAV, value: 'Goods' },
      });
      expect(rows[2]).toMatchObject({ before: { value: 'Goods' }, after: null });
      expect(await label(admin.token, 'en')).toBe('Inventory');
    });

    it.each([
      'platform.email.invite.body',
      'platform.email.invite.subject',
      'auth.email.reset.body',
      'platform.errors.permissionDenied',
      'platform.app.name',
      'platform.home.title',
    ])(
      'rejects an organization override of %s (not overridable) and writes nothing',
      async (key) => {
        const org = await seed.org();
        const owner = await memberOf(org, 'owner');
        const res = await put(owner.token, 'en', key, 'Click here: {link} {organization}').expect(
          422,
        );
        expect(res.body).toEqual({
          code: 'labels.not_overridable',
          message: expect.any(String) as string,
          details: { key },
        });
        expect(await stored(org.id)).toEqual([]);
        expect(await auditRows(org.id)).toEqual([]);
      },
    );

    it.each<[string, string, Record<string, unknown>]>([
      ['placeholders', 'Products {organization}', { expected: [], found: ['organization'] }],
      ['too_long', 'x'.repeat(201), {}],
      ['line_break', 'Pro\nducts', {}],
      ['blank', '  ', {}],
      ['braces', 'Products }', {}],
      ['control_character', 'Pro‮ducts', {}],
    ])('rejects %s and writes nothing', async (reason, value, extra) => {
      const org = await seed.org();
      const admin = await memberOf(org, 'admin');
      const res = await put(admin.token, 'en', NAV, value).expect(422);
      expect(res.body).toMatchObject({
        code: 'labels.invalid_value',
        details: { key: NAV, locale: 'en', reason, ...extra },
      });
      expect(JSON.stringify(res.body)).not.toContain(value.trim() || 'never');
      expect(await stored(org.id)).toEqual([]);
      expect(await auditRows(org.id)).toEqual([]);
    });

    it('rejects unknown locales and keys, and malformed bodies', async () => {
      const org = await seed.org();
      const admin = await memberOf(org, 'admin');
      expect((await put(admin.token, 'fr', NAV, 'Produits').expect(404)).body).toMatchObject({
        code: 'labels.unknown_locale',
      });
      expect((await put(admin.token, 'en', 'nope.nav.title', 'X').expect(404)).body).toMatchObject({
        code: 'labels.unknown_key',
      });
      await put(admin.token, 'en', NAV, 42).expect(400);
      expect(await stored(org.id)).toEqual([]);
    });

    it('needs labels.manage: a manager may read but not write', async () => {
      const org = await seed.org();
      const manager = await memberOf(org, 'manager');
      await labels(manager.token, 'en').expect(200);
      expect((await put(manager.token, 'en', NAV, 'Products').expect(403)).body).toMatchObject({
        code: 'rbac.permission_denied',
      });
      await del(manager.token, 'en', NAV).expect(403);
    });
  });

  describe('invitation emails', () => {
    async function invite(org: SeededOrg, inviterToken: string, email: string) {
      const before = kit.mailer.to(email).length;
      await request(kit.server)
        .post('/api/v1/invitations')
        .set('Idempotency-Key', uuidv7())
        .auth(inviterToken, { type: 'bearer' })
        .send({ email, roleId: org.roles.staff })
        .expect(201);
      for (let i = 0; i < 100 && kit.mailer.to(email).length <= before; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const mail = kit.mailer.to(email).at(-1);
      expect(mail, 'invitation mail').toBeDefined();
      return mail as { subject: string; text: string };
    }

    it("use the invitee's own locale, not the inviter's", async () => {
      const org = await seed.org('Bistro');
      const inviter = await memberOf(org, 'owner', 'en');
      const invitee = await kit.createUser({ locale: 'de' });
      const mail = await invite(org, inviter.token, invitee.email);
      expect(mail.subject).toBe('Einladung zu Bistro');
    });

    it("use the organization's locale setting for new addresses, with its partner's labels", async () => {
      const org = await seed.org('Bistro');
      const owner = await memberOf(org, 'owner', 'en');
      await request(kit.server)
        .put('/api/v1/settings/locale')
        .set('Idempotency-Key', uuidv7())
        .auth(owner.token, { type: 'bearer' })
        .send({ value: 'de' })
        .expect(200);
      await partnerOverride(
        org.id,
        'de',
        'platform.email.invite.subject',
        '{organization} lädt ein',
      );

      const mail = await invite(org, owner.token, `new-${uuidv7()}@example.test`);
      expect(mail.subject).toBe('Bistro lädt ein');
      expect(mail.text).toContain('Bistro');
      expect(mail.text).not.toMatch(/\{(organization|link)\}/);
    });
  });
});
