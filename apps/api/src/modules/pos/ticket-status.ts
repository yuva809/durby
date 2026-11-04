import type { TicketStatus } from '@durby/shared';

/**
 * Ticket moves on the kitchen and bar screens (docs/modules/pos.md → Kitchen and bar screens,
 * ADR 0026): new → preparing | ready, preparing → ready, ready → served, ready → preparing (undo);
 * a void ticket only new → served ("seen"). Repeating the current status is no move at all.
 */
export function canMove(
  kind: 'order' | 'void',
  from: TicketStatus,
  to: Exclude<TicketStatus, 'new'>,
): boolean {
  if (kind === 'void') return from === 'new' && to === 'served';
  switch (from) {
    case 'new':
      return to === 'preparing' || to === 'ready';
    case 'preparing':
      return to === 'ready';
    case 'ready':
      return to === 'served' || to === 'preparing';
    case 'served':
      return false;
  }
}

/** The latest status change (uuidv7 ids sort by time) as a Prisma nested select. */
export const LATEST_STATUS = {
  orderBy: { id: 'desc' },
  take: 1,
  select: { status: true, createdAt: true },
} as const;

/** A ticket's status from its latest change, else new. */
export function statusOf(
  changes: readonly { status: Exclude<TicketStatus, 'new'> }[],
): TicketStatus {
  return changes[0]?.status ?? 'new';
}
