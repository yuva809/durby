# ADR 0084: Waitlist with "table ready"

- Status: accepted
- Date: 2026-11-25
- Spec: [reservations](../modules/reservations.md) → Waitlist (R3). Builds on
  [ADR 0019](0019-reservations-exclusion-constraint-and-redis-holds.md), [ADR 0044](0044-realtime-sse.md) and the
  waitlist keys of [ADR 0037](0037-crud-permission-keys.md).

## Context

When the house is full, the host keeps guests on a paper list and shouts names. The list should be on the host screen,
the same on every device, and the guest told when the table is ready. Durby has no SMS provider.

## Decisions

1. **One row per party** in `waitlist_entries`: `waiting → notified → seated | left | removed`. The order is the order of
   adding; being told does not change it. No table is held.

2. **Seating is a walk-in.** It runs the walk-in code in the same transaction, so tables, party size and the next booking
   are checked as always, and reports count the guests. The entry points to the booking.

3. **Notices go through a `GuestNotifier`** (Q9) with `email` and `in_person`. SMS becomes another channel when there is a
   provider. With a phone number only, the host calls or writes from their own phone (`tel:`, `sms:`) and marks the guest
   as told.

4. **The email is sent by the api after the commit**: the write marks the entry and completes its idempotency key first, so
   a repeated click never sends twice. The result (`sent`, `failed`, `pending`) is stored when it is known. At most 3
   emails per entry, one minute apart to the same address (a failed one can be repeated at once). The answer to the click
   says `pending`; the host screen reloads for the result. It is text only, in the guest's language, without a link, and not affected by
   `NOTIFICATION_EMAILS` (that is about staff updates, ADR 0083).

5. **Contact data lives on the entry, not on a guest record**, and only while it is needed: name, phone, email and note
   are erased 24 hours after the entry ended, by the hourly retention pass (not audited: the audited fields do not change). An entry still open after 24 hours counts as
   left. Seating creates or matches a guest (as any walk-in) with its own retention; erasing that guest also erases the
   entry's data. A party on a list is matched to nobody, because families share phone numbers and the list must show the
   name that was given.

6. **Hints**: every change writes `reservations.waitlist.changed` (ids only) and reaches open host screens through the
   `reservations` topic.

7. **Audit** without names, contact data or notes: location, party size, quoted minutes, status, channel, count, booking.

8. **Permissions**: reading with `reservations.bookings.read`; adding, changing and removing with the existing
   `reservations.waitlist.*`; seating also needs `reservations.bookings.create`.

## Consequences

- Expand-only migration: one new table and three enums. A rollback needs nothing.
- A crash between commit and send leaves the notice `pending`; the host can send it again after a minute.
- The host sees "failed" only when the mail server refuses; a wrong address that bounces later is not known.
- Not in this version: SMS, a page for guests, joining online, computed waiting times, holding a table.
