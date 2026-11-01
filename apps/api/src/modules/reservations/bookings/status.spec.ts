import { RESERVATION_STATUSES } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { type StatusAction, transition, UNDO_WINDOW_MS, undoable } from './status';

/** docs/modules/reservations.md → Status flow, R1.6c: pure rules, no database, no clock. */

const NOW = new Date('2027-03-06T19:00:00Z');
const START_PASSED = new Date('2027-03-06T18:30:00Z');
const START_AHEAD = new Date('2027-03-06T19:30:00Z');

describe('transition', () => {
  const allowed: Record<StatusAction, string[]> = {
    arrive: ['booked'],
    seat: ['booked', 'arrived'],
    finish: ['seated'],
    no_show: ['booked', 'arrived'],
    cancel: ['pending', 'booked', 'arrived'],
  };
  const target: Record<StatusAction, string> = {
    arrive: 'arrived',
    seat: 'seated',
    finish: 'finished',
    no_show: 'no_show',
    cancel: 'cancelled',
  };

  for (const action of Object.keys(allowed) as StatusAction[]) {
    it(`${action}: from ${allowed[action].join(', ')} only`, () => {
      for (const from of RESERVATION_STATUSES) {
        const result = transition(action, { status: from, startsAt: START_PASSED }, NOW);
        if (allowed[action].includes(from)) {
          expect(result, from).toEqual({ ok: true, to: target[action] });
        } else {
          expect(result, from).toEqual({ ok: false, from, to: target[action] });
        }
      }
    });
  }

  it('allows a no-show only once the start has passed', () => {
    expect(transition('no_show', { status: 'booked', startsAt: START_AHEAD }, NOW)).toEqual({
      ok: false,
      from: 'booked',
      to: 'no_show',
    });
    expect(transition('no_show', { status: 'booked', startsAt: NOW }, NOW)).toEqual({
      ok: true,
      to: 'no_show',
    });
  });
});

describe('undoable', () => {
  const change = (over: Partial<Parameters<typeof undoable>[0]> = {}) => ({
    id: 'c2',
    fromStatus: 'booked' as const,
    undoesId: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    ...over,
  });

  it('undoes the latest change within 5 minutes', () => {
    expect(undoable(change(), 'c2', NOW)).toBe(true);
    const edge = (ms: number) => change({ createdAt: new Date(NOW.getTime() - ms) });
    expect(undoable(edge(4 * 60_000 + 59_000), 'c2', NOW)).toBe(true); // 4:59
    expect(undoable(edge(UNDO_WINDOW_MS), 'c2', NOW)).toBe(true); // 5:00
    expect(undoable(edge(5 * 60_000 + 1_000), 'c2', NOW)).toBe(false); // 5:01
  });

  it('refuses another change than the latest, an undo, and the creation', () => {
    expect(undoable(change(), 'c1', NOW)).toBe(false);
    expect(undoable(change({ undoesId: 'c1' }), 'c2', NOW)).toBe(false);
    expect(undoable(change({ fromStatus: null }), 'c2', NOW)).toBe(false);
  });
});
