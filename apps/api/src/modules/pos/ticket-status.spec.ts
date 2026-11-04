import { TICKET_STATUSES, type TicketStatus } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { canMove, statusOf } from './ticket-status';

const targets = ['preparing', 'ready', 'served'] as const;
const moves = (kind: 'order' | 'void') =>
  TICKET_STATUSES.flatMap((from: TicketStatus) =>
    targets.filter((to) => canMove(kind, from, to)).map((to) => `${from}→${to}`),
  );

describe('ticket moves (ADR 0026)', () => {
  it('lets an order ticket go forward one or two steps, and undo ready', () => {
    expect(moves('order')).toEqual([
      'new→preparing',
      'new→ready',
      'preparing→ready',
      'ready→preparing',
      'ready→served',
    ]);
  });

  it('lets a void ticket only be seen', () => {
    expect(moves('void')).toEqual(['new→served']);
  });

  it('reads the status from the latest change, else new', () => {
    expect(statusOf([])).toBe('new');
    expect(statusOf([{ status: 'ready' }])).toBe('ready');
  });
});
