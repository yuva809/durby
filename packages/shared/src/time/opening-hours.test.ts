import { describe, expect, it } from 'vitest';
import {
  closedDatesSchema,
  DEFAULT_OPENING_HOURS,
  serviceWindowsOn,
  type WeeklyHours,
  weeklyHoursSchema,
  windowsOutside,
} from './opening-hours';
import { addDays } from './zoned';

const BERLIN = 'Europe/Berlin';
const HOUR = 3_600_000;
const NONE = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
const week = (overrides: Partial<WeeklyHours>): WeeklyHours => ({ ...NONE, ...overrides });
const iso = (w: { start: Date; end: Date }) => [w.start.toISOString(), w.end.toISOString()];

describe('weeklyHoursSchema', () => {
  it('accepts the default and ordinary schedules', () => {
    expect(weeklyHoursSchema.safeParse(DEFAULT_OPENING_HOURS).success).toBe(true);
    expect(
      weeklyHoursSchema.safeParse(
        week({
          mon: [
            { from: '11:30', to: '14:30' },
            { from: '17:30', to: '23:00' },
          ],
          fri: [{ from: '18:00', to: '02:00' }], // past midnight
        }),
      ).success,
    ).toBe(true);
    expect(weeklyHoursSchema.safeParse(NONE).success).toBe(true); // closed all week
  });

  it('rejects bad times, empty windows, too many windows and unknown fields', () => {
    const bad = [
      week({ mon: [{ from: '7:00', to: '12:00' }] }),
      week({ mon: [{ from: '11:00', to: '24:00' }] }),
      week({ mon: [{ from: '12:00', to: '12:00' }] }),
      week({
        mon: ['08', '10', '12', '14', '16'].map((h) => ({ from: `${h}:00`, to: `${h}:30` })),
      }),
      { ...NONE, mon: [{ from: '11:00', to: '12:00', note: 'x' }] },
      { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
      { ...NONE, holiday: [] },
    ];
    for (const value of bad) expect(weeklyHoursSchema.safeParse(value).success).toBe(false);
  });

  it('rejects overlapping windows, also past midnight into the next day and Sunday into Monday', () => {
    const overlapping = [
      week({
        mon: [
          { from: '11:00', to: '15:00' },
          { from: '14:00', to: '22:00' },
        ],
      }),
      week({ fri: [{ from: '18:00', to: '02:00' }], sat: [{ from: '01:00', to: '05:00' }] }),
      week({ sun: [{ from: '20:00', to: '03:00' }], mon: [{ from: '02:00', to: '06:00' }] }),
    ];
    for (const value of overlapping) expect(weeklyHoursSchema.safeParse(value).success).toBe(false);
    // Touching is fine: [from, to).
    expect(
      weeklyHoursSchema.safeParse(
        week({ fri: [{ from: '18:00', to: '02:00' }], sat: [{ from: '02:00', to: '05:00' }] }),
      ).success,
    ).toBe(true);
  });
});

describe('closedDatesSchema', () => {
  it('accepts unique real dates and rejects the rest', () => {
    expect(closedDatesSchema.safeParse(['2026-12-24', '2026-12-25']).success).toBe(true);
    expect(closedDatesSchema.safeParse([]).success).toBe(true);
    expect(closedDatesSchema.safeParse(['2026-02-30']).success).toBe(false);
    expect(closedDatesSchema.safeParse(['2026-12-24', '2026-12-24']).success).toBe(false);
    const days = (n: number) => Array.from({ length: n }, (_, i) => addDays('2026-01-01', i));
    expect(closedDatesSchema.safeParse(days(366)).success).toBe(true);
    expect(closedDatesSchema.safeParse(days(367)).success).toBe(false);
  });
});

describe('serviceWindowsOn', () => {
  const hours = week({
    sat: [
      { from: '11:30', to: '14:30' },
      { from: '17:00', to: '23:00' },
    ],
    sun: [{ from: '22:00', to: '03:00' }],
  });

  it('returns the windows of the local weekday as instants', () => {
    // 2026-11-14 is a Saturday (CET).
    expect(serviceWindowsOn('2026-11-14', hours, [], BERLIN).map(iso)).toEqual([
      ['2026-11-14T10:30:00.000Z', '2026-11-14T13:30:00.000Z'],
      ['2026-11-14T16:00:00.000Z', '2026-11-14T22:00:00.000Z'],
    ]);
    expect(serviceWindowsOn('2026-11-16', hours, [], BERLIN)).toEqual([]); // Monday: closed
  });

  it('gives a window past midnight to the day it starts', () => {
    expect(serviceWindowsOn('2026-11-15', hours, [], BERLIN).map(iso)).toEqual([
      ['2026-11-15T21:00:00.000Z', '2026-11-16T02:00:00.000Z'],
    ]);
  });

  it('skips closed dates, including a window that runs into the next day', () => {
    expect(serviceWindowsOn('2026-11-14', hours, ['2026-11-14'], BERLIN)).toEqual([]);
    expect(serviceWindowsOn('2026-11-15', hours, ['2026-11-15'], BERLIN)).toEqual([]);
    expect(serviceWindowsOn('2026-11-15', hours, ['2026-11-16'], BERLIN)).toHaveLength(1);
  });

  it('keeps local times across the switch: a night shorter in spring, longer in autumn', () => {
    const night = week({ sat: [{ from: '22:00', to: '03:00' }] });
    // Sat 28 March 2026 22:00 CET → Sun 03:00 CEST: 4 hours.
    const [spring] = serviceWindowsOn('2026-03-28', night, [], BERLIN);
    expect(iso(spring!)).toEqual(['2026-03-28T21:00:00.000Z', '2026-03-29T01:00:00.000Z']);
    expect(spring!.end.getTime() - spring!.start.getTime()).toBe(4 * HOUR);
    // Sat 24 October 2026 22:00 CEST → Sun 03:00 CET: 6 hours.
    const [autumn] = serviceWindowsOn('2026-10-24', night, [], BERLIN);
    expect(iso(autumn!)).toEqual(['2026-10-24T20:00:00.000Z', '2026-10-25T02:00:00.000Z']);
    expect(autumn!.end.getTime() - autumn!.start.getTime()).toBe(6 * HOUR);
  });

  it('moves a bound that falls into the spring gap to the end of the gap', () => {
    const early = week({ sun: [{ from: '02:30', to: '06:00' }] });
    expect(serviceWindowsOn('2026-03-29', early, [], BERLIN).map(iso)).toEqual([
      ['2026-03-29T01:00:00.000Z', '2026-03-29T04:00:00.000Z'],
    ]);
    const late = week({ sat: [{ from: '23:00', to: '02:30' }] });
    expect(serviceWindowsOn('2026-03-28', late, [], BERLIN).map(iso)).toEqual([
      ['2026-03-28T22:00:00.000Z', '2026-03-29T01:00:00.000Z'],
    ]);
  });

  it('opens at the first and closes at the last occurrence of a repeated autumn time', () => {
    const repeated = week({ sun: [{ from: '02:30', to: '06:00' }] });
    const late = week({ sat: [{ from: '23:00', to: '02:30' }] });
    expect(serviceWindowsOn('2026-10-25', repeated, [], BERLIN).map(iso)).toEqual([
      ['2026-10-25T00:30:00.000Z', '2026-10-25T05:00:00.000Z'],
    ]);
    expect(serviceWindowsOn('2026-10-24', late, [], BERLIN).map(iso)).toEqual([
      ['2026-10-24T21:00:00.000Z', '2026-10-25T01:30:00.000Z'],
    ]);
  });
});

describe('windowsOutside', () => {
  const open = week({
    mon: [{ from: '11:00', to: '23:00' }],
    fri: [{ from: '17:00', to: '02:00' }],
    sat: [
      { from: '11:00', to: '14:00' },
      { from: '17:00', to: '23:00' },
    ],
  });

  it('is empty when the service hours lie inside the opening hours', () => {
    expect(windowsOutside(open, open)).toEqual([]);
    expect(
      windowsOutside(
        week({ mon: [{ from: '12:00', to: '22:00' }], fri: [{ from: '18:00', to: '01:00' }] }),
        open,
      ),
    ).toEqual([]);
  });

  it('lists the parts outside, per weekday, past midnight and across a gap', () => {
    expect(
      windowsOutside(
        week({
          mon: [{ from: '10:00', to: '23:30' }],
          tue: [{ from: '12:00', to: '14:00' }], // closed on Tuesdays
          fri: [{ from: '18:00', to: '03:00' }],
          sat: [{ from: '12:00', to: '20:00' }], // runs through the afternoon gap
        }),
        open,
      ),
    ).toEqual([
      { day: 'mon', from: '10:00', to: '11:00' },
      { day: 'mon', from: '23:00', to: '23:30' },
      { day: 'tue', from: '12:00', to: '14:00' },
      { day: 'fri', from: '02:00', to: '03:00' },
      { day: 'sat', from: '14:00', to: '17:00' },
    ]);
  });

  it("compares each day with that day's opening hours only, like the engine", () => {
    // Friday's opening runs to 02:00 Saturday, but a Saturday 00:30 window starts on Saturday,
    // whose own opening hours start at 11:00: it is outside (the engine never offers it).
    expect(windowsOutside(week({ sat: [{ from: '00:30', to: '01:30' }] }), open)).toEqual([
      { day: 'sat', from: '00:30', to: '01:30' },
    ]);
  });
});
