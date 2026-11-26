/**
 * A booking as a calendar entry (docs/modules/reservations.md → Mail, R2.4; RFC 5545): attached to the confirmation
 * (`PUBLISH`) and the cancellation (`CANCEL`, removes it from the guest's calendar). Times in UTC, so no time zone
 * block is needed; `SEQUENCE` rises with every change, so calendars replace the earlier version.
 */
export interface CalendarBooking {
  method: 'PUBLISH' | 'CANCEL';
  /** `<reservationId>@<domain>`: stable across versions. */
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  /** When this version was made. */
  stamp: Date;
  summary: string;
  location: string;
  description: string;
}

const utc = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** Text values: backslash, semicolon, comma and line breaks escaped. */
const text = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 octets continue on the next line after a space (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const n = Buffer.byteLength(char, 'utf8');
    if (size + n > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function bookingIcs(booking: CalendarBooking): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Durby//Reservations//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${booking.method}`,
    'BEGIN:VEVENT',
    `UID:${booking.uid}`,
    `SEQUENCE:${booking.sequence}`,
    `DTSTAMP:${utc(booking.stamp)}`,
    `DTSTART:${utc(booking.start)}`,
    `DTEND:${utc(booking.end)}`,
    `SUMMARY:${text(booking.summary)}`,
    `LOCATION:${text(booking.location)}`,
    `DESCRIPTION:${text(booking.description)}`,
    `STATUS:${booking.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
