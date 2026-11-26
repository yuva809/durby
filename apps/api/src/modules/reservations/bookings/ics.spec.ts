import { describe, expect, it } from 'vitest';
import { bookingIcs } from './ics';

const base = {
  method: 'PUBLISH' as const,
  uid: '0190a000-0000-7000-8000-000000000001@durby.example',
  sequence: 2,
  start: new Date('2027-03-06T18:00:00Z'),
  end: new Date('2027-03-06T19:30:00Z'),
  stamp: new Date('2027-03-01T09:15:30.123Z'),
  summary: 'Table for 2 at Bistro Ölmühle',
  location: 'Main street, Hauptstraße 1; 10115 Berlin',
  description: 'Booking RES-2027-000042',
};

describe('bookingIcs', () => {
  it('writes a valid calendar entry in UTC with CRLF line ends', () => {
    expect(bookingIcs(base)).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Durby//Reservations//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        'UID:0190a000-0000-7000-8000-000000000001@durby.example',
        'SEQUENCE:2',
        'DTSTAMP:20270301T091530Z',
        'DTSTART:20270306T180000Z',
        'DTEND:20270306T193000Z',
        'SUMMARY:Table for 2 at Bistro Ölmühle',
        'LOCATION:Main street\\, Hauptstraße 1\\; 10115 Berlin',
        'DESCRIPTION:Booking RES-2027-000042',
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
  });

  it('cancels with the same UID', () => {
    const ics = bookingIcs({ ...base, method: 'CANCEL', sequence: 3 });
    expect(ics).toContain('METHOD:CANCEL\r\n');
    expect(ics).toContain('STATUS:CANCELLED\r\n');
    expect(ics).toContain(`UID:${base.uid}\r\n`);
    expect(ics).toContain('SEQUENCE:3\r\n');
  });

  it('folds long lines at 75 octets without splitting a character, and escapes line breaks', () => {
    const ics = bookingIcs({ ...base, description: `Note: ${'ä'.repeat(60)}\nsecond line` });
    for (const line of ics.split('\r\n'))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain(`DESCRIPTION:Note: ${'ä'.repeat(60)}\\nsecond line`);
  });
});
