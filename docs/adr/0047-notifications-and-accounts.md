# ADR 0047: Stored notifications, email and browser push, and several signed-in accounts

- Status: accepted (2026-11-17)
- Date: 2026-11-17
- Builds on: ADR 0006 (auth), ADR 0013 (outbox), ADR 0041 (email links), ADR 0045 (branch requests), ADR 0046 (top
  bar)

## Context

The bell of ADR 0046 shows only what waits for the person, worked out per request. People asked for a history of what
happened (a request was approved, stock is on the way, feedback was answered), for those updates by email or on the
phone when the app is closed, and, on shared counters and for owners with several logins, for switching between
signed-in users without signing out.

## Decisions

1. **Updates are stored, in the change's transaction.** A `notifications` table (tenant data, RLS, never deleted by
   the app) gets one row per person and event, written by the owning module with `NotificationService.notify` inside
   the transaction of the change: a change that rolls back notifies no one. The person who caused it never gets one.
   `params` hold only what the text needs (numbers, names of items, warehouses and branches); no free text or contact
   details. The bell gets two tabs, "Waiting for you" (ADR 0046, unchanged) and "Updates" (the last 30, unread count,
   mark one or all read). The badge adds both counts.

2. **Who hears what:**

   | Kind                             | When                                                  | Who                                      |
   | -------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
   | `request_submitted`              | a branch sends a stock request                        | `orders.requests.approve` holders        |
   | `request_approved` / `_rejected` | the owner or admin decides                            | whoever asked                            |
   | `request_on_the_way`             | the warehouse packs it                                | `orders.requests.receive` at the branch  |
   | `request_driver_assigned`        | a driver is set (when packing or later)               | the driver                               |
   | `request_short`                  | the branch receives less than was sent                | approvers                                |
   | `sales_confirmed`                | a sales order is confirmed                            | `orders.picking.use` at its branch       |
   | `sales_packed`                   | it is packed                                          | `orders.delivery.use` at its branch      |
   | `sales_returned`                 | it comes back                                         | `orders.orders.edit` at its branch       |
   | `low_stock`                      | a level drops from above to at or below reorder level | `inventory.stock.read` at that warehouse |
   | `feedback_answered`              | Durby staff mark feedback seen or done                | the sender                               |

   Low stock is said once per crossing, not on every sale below the level, and also to the person who booked it; "In
   transit" warehouses are skipped. Customer names stay out of sales order texts (a customer may be a person).

3. **Email and push follow each person's choice per kind.** `notification_preferences` (per person, organization and
   kind) holds `email` and `push`; without a row, email is on only for `request_submitted` and
   `request_driver_assigned` (what needs them or is assigned to them) and push is off. Account → Notifications
   (`/account/notifications`) shows the grid. The bell always has every update.

4. **Delivery is the worker's job.** `notify` adds an outbox event `platform.notification.created` (notification ids
   only, at most 150 per event) when any recipient chose email or push for the kind. The handler
   `platform.deliverNotifications` reads the rows and choices in the organization's tenant context and sends:
   - **email** through the Mailer, in the person's language, with the organization's labels, the bell's text as
     subject and links on the organization's partner domain (ADR 0041), plus a link to the settings page;
   - **browser push** (Web Push, VAPID, the `web-push` library) to every device the person turned on in this
     organization. The payload is `{ title, url }` (the bell's text and a path on the site), encrypted for the
     browser. A subscription the push service reports gone (404/410) is deleted.

   Each send is best effort: a failure is logged without address, endpoint or text, and the event is not retried for
   it (the bell still has the update). A retried event may send twice; that is accepted.

5. **Push devices.** `push_subscriptions` (tenant data, RLS) keeps endpoint and keys per person and organization. The
   page's "Push on this device" card registers `/sw.js` (shows the message, opens only paths on this site), asks the
   browser's permission and subscribes with the server's public key. A browser has one subscription; turning push on
   in another organization or as another person on the same browser moves it there. The endpoint is a capability URL:
   it never appears in URLs, logs or responses (the status check is a `POST` with the endpoint in the body). Push is
   off on a server without `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` (all or none).

6. **Up to five signed-in accounts per browser.** Each account lives in a slot 0–4 with its own httpOnly refresh
   cookie (`__Secure-durby_rt`, `__Secure-durby_rt_1` … `_4`), picked by the `X-Durby-Account` header on login,
   refresh, logout, switch-organization and password change. Slot 0 is the cookie as before, so existing sign-ins
   carry on; a header outside 0–4 is refused. The access token still says who the caller is; the slot only says which
   cookie to read. Each slot rotates under its own Web Lock.

   The web remembers which email is in which slot in `localStorage` (emails only: the one reviewed exception to "no
   browser storage", tested) and each tab's slot in `sessionStorage`, so two tabs can show two accounts. The person
   card lists the other accounts, "Add another account" (sign-in page in add mode; the others stay signed in), "Sign
   out" (another account takes over if there is one) and "Sign out of all accounts". An account whose sign-in ended is
   dropped from the list when it is next tried.

## Consequences

- New routes are `@Authenticated()` (the caller's own rows; every query names the caller), listed in the route marker
  test. Marking read and choices are personal state, not audited; the changes that cause notifications are audited as
  before.
- Every module that notifies works out its recipients with `MemberNames.holders` (which now also takes
  organization-scoped keys), in its own transaction.
- On a shared device the account list shows the emails signed in there; signing out removes them. Push messages show
  on the device's lock screen: people choose push per kind for that reason.
- `OutboxService.add` and `notify` take an explicit tenant for the staff portal, which has no tenant context.
- Later: notification digests, per-organization quiet hours, push for iOS outside home-screen apps (not supported by
  the browser), removing old notifications after a retention period.
