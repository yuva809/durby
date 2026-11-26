import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  EVENT_HANDLER_PATTERN,
  EVENT_TYPE_PATTERN,
  EVENT_TYPES,
  EVENTS,
  eventRegistryProblems,
  eventSchema,
  isEventType,
  isEventVersion,
} from './registry';

const uuid = '0192f0b2-6c1a-7c3e-9a6f-1b2c3d4e5f60';

describe('event registry', () => {
  it('has no problems', () => {
    expect(eventRegistryProblems(EVENTS)).toEqual([]);
  });

  it('has the config, pos and reservations events', () => {
    expect(EVENT_TYPES).toEqual([
      'config.settings.changed',
      'config.labels.changed',
      'config.number_series.changed',
      'config.entitlements.changed',
      'platform.notification.created',
      'pos.order.opened',
      'pos.order.closed',
      'pos.order.updated',
      'pos.kitchen_ticket.created',
      'pos.kitchen_ticket.status_changed',
      'reservations.reservation.created',
      'reservations.reservation.updated',
      'reservations.reservation.status_changed',
      'reservations.waitlist.changed',
    ]);
  });

  it('reservations events carry ids, a status and the start only', () => {
    const payload = {
      reservationId: '0190a000-0000-7000-8000-000000000001',
      locationId: '0190a000-0000-7000-8000-000000000002',
      status: 'booked',
      startsAt: '2027-03-06T18:00:00.000Z',
    };
    for (const type of [
      'reservations.reservation.created',
      'reservations.reservation.updated',
      'reservations.reservation.status_changed',
    ] as const) {
      const v1 = EVENTS[type].versions[1];
      expect(v1.safeParse(payload).success).toBe(true);
      expect(v1.safeParse({ ...payload, guestName: 'Ada' }).success).toBe(false);
    }
  });

  it('platform.notification.created carries notification ids only', () => {
    const v1 = EVENTS['platform.notification.created'].versions[1];
    expect(v1.safeParse({ notificationIds: [uuid] }).success).toBe(true);
    expect(v1.safeParse({ notificationIds: [] }).success).toBe(false);
    expect(v1.safeParse({ notificationIds: [uuid], kind: 'low_stock' }).success).toBe(false);
  });

  it('pos.order.closed carries ids only', () => {
    const v1 = EVENTS['pos.order.closed'].versions[1];
    const ids = {
      orderId: '0190a000-0000-7000-8000-000000000001',
      locationId: '0190a000-0000-7000-8000-000000000002',
      tableId: '0190a000-0000-7000-8000-000000000003',
    };
    expect(v1.safeParse(ids).success).toBe(true);
    expect(v1.safeParse({ ...ids, number: 'ORD-2026-000001' }).success).toBe(false);
    expect(v1.safeParse({ ...ids, tableId: 'T1' }).success).toBe(false);
  });

  it('recognizes registered types and versions only', () => {
    expect(isEventType('config.settings.changed')).toBe(true);
    expect(isEventType('config.settings.removed')).toBe(false);
    expect(isEventType('toString')).toBe(false);
    expect(isEventVersion('config.settings.changed', 1)).toBe(true);
    expect(isEventVersion('config.settings.changed', 2)).toBe(false);
    expect(eventSchema('config.settings.changed', 2)).toBeUndefined();
    expect(eventSchema('nope.nope.nope', 1)).toBeUndefined();
  });

  it('validates payloads strictly', () => {
    const schema = eventSchema('config.settings.changed', 1);
    expect(
      schema?.safeParse({ scope: 'location', scopeId: uuid, key: 'platform.timezone' }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        scope: 'location',
        scopeId: uuid,
        key: 'platform.timezone',
        value: 'UTC',
      }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({ scope: 'partner', scopeId: uuid, key: 'platform.timezone' }).success,
    ).toBe(false);
    expect(schema?.safeParse({ scope: 'brand', scopeId: uuid, key: 'timezone' }).success).toBe(
      true,
    );
    expect(eventSchema('config.entitlements.changed', 1)?.safeParse({}).success).toBe(true);
    expect(
      eventSchema('config.number_series.changed', 1)?.safeParse({
        key: 'billing.invoice',
        change: 'counter',
      }).success,
    ).toBe(true);
  });

  it('reports bad types, version gaps, loose schemas and personal-data fields', () => {
    expect(
      eventRegistryProblems({
        'config.settings': { current: 1, versions: { 1: z.strictObject({}) } },
        'a.b.created': { current: 2, versions: { 2: z.strictObject({}) } },
        'a.b.updated': { current: 1, versions: { 1: z.object({ id: z.uuid() }) } },
        'a.b.invited': {
          current: 1,
          versions: {
            1: z.strictObject({
              inviteeEmail: z.string(),
              lines: z.array(z.strictObject({ ipAddress: z.string() })),
              meta: z.strictObject({ display_name: z.string() }).optional(),
            }),
          },
        },
      }),
    ).toEqual([
      'config.settings: type must be module.entity.past_tense',
      'a.b.created: versions must be exactly 1 … 2',
      'a.b.updated v1: schema must be strict',
      'a.b.invited v1: field "inviteeEmail" suggests personal data or secrets',
      'a.b.invited v1: field "ipAddress" suggests personal data or secrets',
      'a.b.invited v1: field "display_name" suggests personal data or secrets',
    ]);
  });

  it('allows id and key fields', () => {
    expect(
      eventRegistryProblems({
        'inventory.stock.received': {
          current: 1,
          versions: {
            1: z.strictObject({
              locationId: z.uuid(),
              key: z.string(),
              scopeId: z.uuid(),
              locale: z.string(),
            }),
          },
        },
      }),
    ).toEqual([]);
  });

  it('shares the SQL shapes of types and handler names', () => {
    expect('inventory.stock_item.received').toMatch(EVENT_TYPE_PATTERN);
    expect('inventory.stock').not.toMatch(EVENT_TYPE_PATTERN);
    expect('Inventory.stock.received').not.toMatch(EVENT_TYPE_PATTERN);
    expect('reports.stockProjection').toMatch(EVENT_HANDLER_PATTERN);
    expect('StockProjection.apply').not.toMatch(EVENT_HANDLER_PATTERN);
  });
});
