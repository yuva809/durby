import { createTranslator, type Locale } from '@durby/i18n';
import { describe, expect, it } from 'vitest';
import type { UserDirectory } from '../auth';
import type { AppConfig } from '../config';
import type { LabelService } from '../labels';
import { InMemoryMailer } from '../mail/in-memory-mailer';
import type { OutboxEvent } from '../outbox';
import type { PlatformPrismaClient, TenantTransactionClient } from '../tenancy';
import { NotificationDeliveryHandler, notificationText } from './notification-delivery.handler';
import type { PushSender } from './push-sender';

const TENANT = '0190a000-0000-7000-8000-0000000000a1';
const ANNA = '0190a000-0000-7000-8000-000000000001';
const BEN = '0190a000-0000-7000-8000-000000000002';
const REQUEST = '0190a000-0000-7000-8000-000000000101';

function row(id: string, userId: string, kind: string, entityType = 'stock_request') {
  return {
    id,
    userId,
    kind,
    entityType,
    entityId: REQUEST,
    params: { number: 'SRQ-2026-000001', branch: 'Nord', status: 'done' },
  };
}

function setup(
  rows: ReturnType<typeof row>[],
  prefs: { userId: string; kind: string; email: boolean; push?: boolean }[] = [],
) {
  const mailer = new InMemoryMailer();
  const subscriptions = [
    { id: 's1', userId: BEN, endpoint: 'https://push.example/ok', p256dh: 'k', auth: 'a' },
    { id: 's2', userId: BEN, endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'a' },
  ];
  const deleted: string[] = [];
  const pushed: { endpoint: string; title: string; url: string }[] = [];
  const tx = {
    notification: { findMany: () => Promise.resolve(rows) },
    notificationPreference: {
      findMany: () => Promise.resolve(prefs.map((p) => ({ push: false, ...p }))),
    },
    pushSubscription: {
      findMany: () => Promise.resolve(subscriptions),
      deleteMany: ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return Promise.resolve({ count: 1 });
      },
    },
  } as unknown as TenantTransactionClient;
  const push: PushSender = {
    publicKey: 'public-key',
    send: (target, message) => {
      pushed.push({ endpoint: target.endpoint, ...message });
      return Promise.resolve(target.endpoint.endsWith('gone') ? 'gone' : 'sent');
    },
  };
  const platformDb = {
    organization: {
      findUniqueOrThrow: () =>
        Promise.resolve({
          name: 'AsiaMight',
          partner: { domains: [{ hostname: 'app.asiamight.site' }] },
        }),
    },
  } as unknown as PlatformPrismaClient;
  const users = {
    profiles: () =>
      Promise.resolve(
        new Map([
          [ANNA, { id: ANNA, email: 'anna@example.com', locale: 'de' }],
          [BEN, { id: BEN, email: 'ben@example.com', locale: 'en' }],
        ]),
      ),
  } as unknown as UserDirectory;
  const labels = {
    translator: (locale: Locale) => Promise.resolve(createTranslator(locale)),
  } as unknown as LabelService;
  const config = {
    WEB_ORIGINS: ['https://app.durby.tech', 'https://app.asiamight.site'],
    WEB_BASE_URL: 'https://app.durby.tech',
  } as unknown as AppConfig;
  const handler = new NotificationDeliveryHandler(mailer, config, platformDb, labels, users, push);
  const event = {
    id: '0190a000-0000-7000-8000-000000000900',
    tenantId: TENANT,
    type: 'platform.notification.created',
    version: 1,
    payload: { notificationIds: rows.map((r) => r.id) },
    occurredAt: new Date(),
  } as OutboxEvent;
  return { mailer, pushed, deleted, run: () => handler.deliver(event, tx) };
}

describe('notification emails (ADR 0047)', () => {
  it('emails by default only the kinds that are on by default, in each person’s language', async () => {
    const { mailer, run } = setup([
      row('0190a000-0000-7000-8000-000000000201', ANNA, 'request_submitted'),
      row('0190a000-0000-7000-8000-000000000202', BEN, 'request_approved'),
    ]);
    await run();
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail!.to).toBe('anna@example.com');
    expect(mail!.subject).toBe('AsiaMight: Nord fordert Ware an: SRQ-2026-000001');
    // Links on the organization's partner domain.
    expect(mail!.text).toContain(`https://app.asiamight.site/requests?open=${REQUEST}`);
    expect(mail!.text).toContain('https://app.asiamight.site/account/notifications');
  });

  it('follows each person’s choice, and keeps going when one send fails', async () => {
    const { mailer, run } = setup(
      [
        row('0190a000-0000-7000-8000-000000000201', ANNA, 'request_submitted'),
        row('0190a000-0000-7000-8000-000000000202', BEN, 'request_approved'),
      ],
      [
        { userId: ANNA, kind: 'request_submitted', email: false },
        { userId: BEN, kind: 'request_approved', email: true },
      ],
    );
    await run();
    expect(mailer.sent.map((m) => m.to)).toEqual(['ben@example.com']);

    mailer.clear();
    mailer.failWith = new Error('smtp down');
    await expect(run()).resolves.toBeUndefined();
  });

  it('pushes the text and the page to each device of those who chose push, and drops gone ones', async () => {
    const { mailer, pushed, deleted, run } = setup(
      [row('0190a000-0000-7000-8000-000000000202', BEN, 'request_approved')],
      [{ userId: BEN, kind: 'request_approved', email: false, push: true }],
    );
    await run();
    expect(mailer.sent).toEqual([]);
    expect(pushed).toEqual([
      {
        endpoint: 'https://push.example/ok',
        title: 'Your stock request was approved: SRQ-2026-000001',
        url: `/requests?open=${REQUEST}`,
      },
      {
        endpoint: 'https://push.example/gone',
        title: 'Your stock request was approved: SRQ-2026-000001',
        url: `/requests?open=${REQUEST}`,
      },
    ]);
    expect(deleted).toEqual(['s2']);
  });

  it('writes the feedback status in words', () => {
    const t = createTranslator('en');
    expect(notificationText(t, { kind: 'feedback_answered', params: { status: 'done' } })).toBe(
      'Your feedback was dealt with by our team',
    );
  });
});
