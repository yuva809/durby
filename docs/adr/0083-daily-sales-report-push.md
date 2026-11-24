# ADR 0083: Daily sales report as a push message

- Status: accepted
- Date: 2026-11-24
- Spec: [reports](../modules/reports.md) → Daily report, [notifications](../platform/notifications.md). Builds on
  [ADR 0047](0047-notifications-and-accounts.md) (notifications, push), [ADR 0081](0081-reports-read-model.md) and
  [ADR 0082](0082-owner-overview.md) (figures).

## Context

Owners want one message every morning saying how the restaurant did yesterday, on their phone, and no other messages.
Browser push exists, but nothing runs on a schedule, and the server setup never let a push (or a notification email) out:
the keys were not passed to the containers, and the worker had no route to the internet.

## Decisions

1. **Who**: active members with the Owner role, in organizations with `reports` and `pos`. One message per organization.

2. **Which day**: yesterday in the organization's zone, as a business day of each active location (ADR 0082). **When**: at
   `reports.dailyReportAt` (default 08:00) the next morning, or once that day has ended at every active location if that
   is later. A worker that was down still sends within 12 hours; after that the day is skipped. A day without orders
   sends nothing.

3. **Figures** come from the Overview's own code for that day.

4. **Once per day**: `report_daily_messages` has one row per organization and day sent, inserted (conflicts ignored) in the
   transaction that writes the notifications. A restart or a second worker can't send twice. The row is the record; the
   message changes no business data, so there is no audit entry. A day without orders gets no row: report data that
   comes later (a rebuild after the first release) is still reported within the 12 hours.

5. **The worker runs it**: every 5 minutes over all organizations, each in its own tenant context, like the outbox
   cleanup. `organizations` has no RLS; nothing tenant-scoped is read across tenants. An organization that fails is
   logged and tried again at the next pass.

6. **Kind `daily_sales`** is pushed by default (the only one) and not emailed. A device must still be turned on. The text
   is put together from plain values in the reader's language, by one function for push, email and bell.

7. **Push messages may have a body** next to the title. Sends of one event run together with a 3 s limit: they happen
   inside the handler's transaction (5 s), and a slow push service would roll it back and repeat every message.

8. **`NOTIFICATION_EMAILS`** (`on` / `off`): `off` in the server's compose file unless its `.env` says `on`. Without it,
   giving the worker a way out would start emails that people's default choices ask for but that never went out there.
   Account emails (invitation, password, verification, staff) come from the api and are not affected.

9. **The worker gets a way out** (`egress` network, no published ports, not shared with Caddy or the web). Needed for the
   push services; their addresses are not known in advance. Before, the worker reached Postgres and Redis only.

10. **Home-screen web app**: a manifest per partner theme and generated icons, because iPhones only allow push there.

## Consequences

- Sales amounts can show on a lock screen. The settings page says so; each person can turn the kind off.
- The previous release can't read a `daily_sales` row: after a rollback an owner's bell shows an error until the newer
  release is back. True for every new kind so far.
- The Android app is a WebView without push; its owners use the browser. Native push (Firebase) is a later decision.
- With `NOTIFICATION_EMAILS=off` the Email column in the settings has no effect on that server.
