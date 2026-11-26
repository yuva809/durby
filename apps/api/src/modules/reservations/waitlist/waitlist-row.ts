import type { WaitlistEntry } from '@durby/shared';
import { snapshot } from '../../../platform/audit';

export const ENTRY_SELECT = {
  id: true,
  locationId: true,
  name: true,
  phone: true,
  email: true,
  locale: true,
  partySize: true,
  quotedMinutes: true,
  note: true,
  status: true,
  createdAt: true,
  notifiedAt: true,
  noticeChannel: true,
  noticeResult: true,
  emailedAt: true,
  emailCount: true,
  endedAt: true,
  erasedAt: true,
  reservationId: true,
} as const;

type Times = 'createdAt' | 'notifiedAt' | 'endedAt';

export type EntryRow = Omit<WaitlistEntry, Times | 'locale'> & {
  locale: string;
  createdAt: Date;
  notifiedAt: Date | null;
  emailedAt: Date | null;
  endedAt: Date | null;
  erasedAt: Date | null;
};

/** Without name, phone, email and note: audit rows can't be erased (ADR 0084 §7). */
export const entrySnapshot = (row: EntryRow) =>
  snapshot('waitlist_entry', {
    id: row.id,
    locationId: row.locationId,
    partySize: row.partySize,
    quotedMinutes: row.quotedMinutes,
    status: row.status,
    noticeChannel: row.noticeChannel,
    noticeCount: row.emailCount,
    reservationId: row.reservationId,
  });

export const toEntry = (row: EntryRow): WaitlistEntry => ({
  id: row.id,
  locationId: row.locationId,
  name: row.name,
  phone: row.phone,
  email: row.email,
  locale: row.locale as WaitlistEntry['locale'],
  partySize: row.partySize,
  quotedMinutes: row.quotedMinutes,
  note: row.note,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  notifiedAt: row.notifiedAt?.toISOString() ?? null,
  noticeChannel: row.noticeChannel,
  noticeResult: row.noticeResult,
  emailCount: row.emailCount,
  endedAt: row.endedAt?.toISOString() ?? null,
  reservationId: row.reservationId,
});
