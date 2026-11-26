import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TURN_TIMES,
  SLOT_INTERVALS,
  turnTimeFor,
  type TurnTimes,
  turnTimesSchema,
} from './reservation-settings';
import { SETTINGS } from './settings';

const ok = (value: unknown) => turnTimesSchema.safeParse(value).success;

describe('turn times', () => {
  it('defaults to 90 min for 1–2 guests, 120 for 3–4, 150 for 5 and more', () => {
    expect(DEFAULT_TURN_TIMES).toEqual([
      { fromParty: 1, toParty: 2, minutes: 90 },
      { fromParty: 3, toParty: 4, minutes: 120 },
      { fromParty: 5, toParty: null, minutes: 150 },
    ]);
    expect(ok(DEFAULT_TURN_TIMES)).toBe(true);
    expect([1, 2, 3, 4, 5, 12, 100].map((n) => turnTimeFor(n, DEFAULT_TURN_TIMES))).toEqual([
      90, 90, 120, 120, 150, 150, 150,
    ]);
  });

  it('accepts one open band for every party size', () => {
    expect(ok([{ fromParty: 1, toParty: null, minutes: 120 }])).toBe(true);
  });

  it('rejects bands that are unsorted, overlapping, leave a gap or end closed', () => {
    const bad: TurnTimes[] = [
      // unsorted
      [
        { fromParty: 3, toParty: null, minutes: 120 },
        { fromParty: 1, toParty: 2, minutes: 90 },
      ],
      // overlapping
      [
        { fromParty: 1, toParty: 3, minutes: 90 },
        { fromParty: 3, toParty: null, minutes: 120 },
      ],
      // gap (no turn time for 3 guests)
      [
        { fromParty: 1, toParty: 2, minutes: 90 },
        { fromParty: 4, toParty: null, minutes: 120 },
      ],
      // doesn't start at 1
      [{ fromParty: 2, toParty: null, minutes: 90 }],
      // last band closed: no turn time above 4
      [
        { fromParty: 1, toParty: 2, minutes: 90 },
        { fromParty: 3, toParty: 4, minutes: 120 },
      ],
      // open band in the middle
      [
        { fromParty: 1, toParty: null, minutes: 90 },
        { fromParty: 3, toParty: null, minutes: 120 },
      ],
      // empty band
      [
        { fromParty: 1, toParty: 0, minutes: 90 },
        { fromParty: 1, toParty: null, minutes: 120 },
      ],
      [],
    ];
    for (const value of bad) expect(ok(value), JSON.stringify(value)).toBe(false);
  });

  it('rejects non-positive or non-integer minutes and unknown fields', () => {
    for (const minutes of [0, -30, 90.5, 721]) {
      expect(ok([{ fromParty: 1, toParty: null, minutes }])).toBe(false);
    }
    expect(ok([{ fromParty: 1, toParty: null, minutes: 90, note: 'x' }])).toBe(false);
    expect(ok([{ fromParty: 1, toParty: 101, minutes: 90 }])).toBe(false);
  });
});

describe('reservations settings', () => {
  it('registers the keys with the agreed defaults (a new location works without setup)', () => {
    expect({
      serviceHours: SETTINGS['reservations.serviceHours'].default,
      slotIntervalMinutes: SETTINGS['reservations.slotIntervalMinutes'].default,
      turnTimes: SETTINGS['reservations.turnTimes'].default,
      maxCoversPerSlot: SETTINGS['reservations.maxCoversPerSlot'].default,
      lastBookingOffsetMinutes: SETTINGS['reservations.lastBookingOffsetMinutes'].default,
      instantMaxParty: SETTINGS['reservations.online.instantMaxParty'].default,
      autoConfirm: SETTINGS['reservations.autoConfirm'].default,
      holdMinutes: SETTINGS['reservations.holdMinutes'].default,
    }).toEqual({
      serviceHours: 'openingHours',
      slotIntervalMinutes: 15,
      turnTimes: DEFAULT_TURN_TIMES,
      maxCoversPerSlot: 'off',
      lastBookingOffsetMinutes: 60,
      instantMaxParty: 10,
      autoConfirm: true,
      holdMinutes: 5,
    });
  });

  it('can be set at every level, partner to location, and binds no recorded data', () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      if (!key.startsWith('reservations.')) continue;
      // Guests are the organization's (one guest across its locations), so their retention is too (Q8).
      const scopes =
        key === 'reservations.guestRetentionMonths'
          ? ['partner', 'organization']
          : ['partner', 'organization', 'brand', 'location'];
      expect(def.scopes, key).toEqual(scopes);
      expect(def.dataBound, key).toBe(false);
    }
  });

  it('takes slot intervals of 15, 30 or 60 minutes only', () => {
    expect(SLOT_INTERVALS).toEqual([15, 30, 60]);
    const schema = SETTINGS['reservations.slotIntervalMinutes'].schema;
    for (const v of [15, 30, 60]) expect(schema.safeParse(v).success).toBe(true);
    for (const v of [0, 10, 20, 45, '15', null]) expect(schema.safeParse(v).success).toBe(false);
  });

  // A stored setting is never JSON null (ADR 0010: deleting the row inherits), so "off" and "the
  // opening hours" are values of their own: a location can switch off what its organization set.
  it('takes positive whole minutes and counts; "off" instead of null', () => {
    const accepts = (key: keyof typeof SETTINGS, value: unknown) =>
      SETTINGS[key].schema.safeParse(value).success;
    expect(accepts('reservations.maxCoversPerSlot', 'off')).toBe(true);
    expect(accepts('reservations.maxCoversPerSlot', 40)).toBe(true);
    expect(accepts('reservations.maxCoversPerSlot', null)).toBe(false);
    expect(accepts('reservations.maxCoversPerSlot', 0)).toBe(false);
    expect(accepts('reservations.maxCoversPerSlot', 'none')).toBe(false);
    for (const key of [
      'reservations.lastBookingOffsetMinutes',
      'reservations.holdMinutes',
    ] as const) {
      expect(accepts(key, null), key).toBe(false);
      expect(accepts(key, 0), key).toBe(false);
      expect(accepts(key, -5), key).toBe(false);
      expect(accepts(key, 2.5), key).toBe(false);
    }
    expect(accepts('reservations.holdMinutes', 15)).toBe(true);
    expect(accepts('reservations.holdMinutes', 16)).toBe(false);
    // A threshold for instant online booking: 1–100 guests, or 'off' (every size instantly).
    expect(accepts('reservations.online.instantMaxParty', 'off')).toBe(true);
    expect(accepts('reservations.online.instantMaxParty', 1)).toBe(true);
    expect(accepts('reservations.online.instantMaxParty', 100)).toBe(true);
    for (const v of [0, 101, 2.5, null, 'none']) {
      expect(accepts('reservations.online.instantMaxParty', v), String(v)).toBe(false);
    }
    expect(accepts('reservations.lastBookingOffsetMinutes', 480)).toBe(true);
    expect(accepts('reservations.lastBookingOffsetMinutes', 481)).toBe(false);
    expect(accepts('reservations.autoConfirm', 'yes')).toBe(false);
  });

  it('serviceHours is "openingHours" or a weekly schedule, never null', () => {
    const schema = SETTINGS['reservations.serviceHours'].schema;
    const day = [{ from: '17:00', to: '22:00' }];
    const week = { mon: [], tue: day, wed: day, thu: day, fri: day, sat: day, sun: [] };
    expect(schema.safeParse('openingHours').success).toBe(true);
    expect(schema.safeParse(week).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse('closed').success).toBe(false);
    expect(schema.safeParse({ ...week, holiday: [] }).success).toBe(false);
  });
});
