# Notifications

Stored updates under the bell, and the same by email and browser push for those who choose it. Decision: ADR 0047
(builds on the "waiting for me" bell of ADR 0046). Code: `apps/api/src/platform/notifications/`, shared contract
`packages/shared/src/api/notifications.ts`, web `components/shell/notifications-bell.tsx`,
`components/account/notification-settings.tsx`, `components/account/push-device.tsx`, `lib/account/push.ts`,
`public/sw.js`. Technical and test page: docs/html/notifications.html.

## Model

| Table                      | Key                                | Holds                                                                       |
| -------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `notifications`            | `id`                               | `user_id`, `kind`, `entity_type`, `entity_id`, `params` (≤ 2 KB), `read_at` |
| `notification_preferences` | `tenant_id, user_id, kind`         | `email`, `push`                                                             |
| `push_subscriptions`       | `id`; unique `tenant_id, endpoint` | `user_id`, `endpoint` (https, ≤ 1024), `p256dh`, `auth`                     |

All three are tenant data with the `tenant_isolation` RLS policy. `notifications` can't be deleted by the app role.
Each person sees and changes only their own rows (the service filters by the caller).

## Writing a notification

```ts
await this.notifications.notify(tx, {
  userIds, // from MemberNames.holders(db, key, locationId?) or a known person
  kind: 'request_submitted',
  entityType: 'stock_request',
  entityId: request.id,
  params: { number, branch }, // what the text needs; no free text or contact details
});
```

- Inside the transaction of the change; the actor (the tenant context's user) is left out unless `actorUserId: null`.
- The staff portal passes `{ tenantId, actorUserId: null }` and sets `app.tenant_id` in its transaction first.
- A new kind: add it to `NOTIFICATION_KINDS`, its text `platform.notifications.kinds.<camelKind>` (with the params),
  its name `platform.notifications.kindNames.<camelKind>`, where it leads in `notificationPath`, and the trigger in the
  owning module. Default email is off unless it belongs in `NOTIFICATION_EMAIL_BY_DEFAULT`.

The kinds and who hears them are listed in ADR 0047 §2; `daily_sales` (the owners, every morning) in ADR 0083. Its push
is on by default (`NOTIFICATION_PUSH_BY_DEFAULT`). `notificationText` in `packages/shared` words every kind for bell,
email and push.

## Delivery

`notify` adds the outbox event `platform.notification.created` (`{ notificationIds }`, ≤ 150) when any recipient has
email or push on for the kind. The worker's handler `platform.deliverNotifications`:

1. reads the rows, the people's choices, emails and languages, and the organization's partner domains;
2. pushes `{ title, body?, url }` to each subscription of those with push on, all at once with a 3 s limit (`gone` → the
   subscription is deleted);
3. unless `NOTIFICATION_EMAILS=off`, emails those with email on: subject `"{organization}: {text}"`, body with the link on the partner domain (none for
   feedback) and the link to `/account/notifications`.

Best effort per person and channel: failures are logged with the kind and the error only (never addresses,
endpoints or texts); the event is not retried for them.

## API

All `@Authenticated()`, the caller's own rows in the active organization.

| Route                                         | Does                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/v1/notifications`                   | the last 30 and the unread count                                       |
| `POST /api/v1/notifications/:id/read`         | marks one read (someone else's: 404 `platform.notification_not_found`) |
| `POST /api/v1/notifications/read-all`         | marks all read                                                         |
| `GET /api/v1/notifications/preferences`       | every kind with the choice or the default                              |
| `PUT /api/v1/notifications/preferences`       | sets the kinds sent (set-state)                                        |
| `GET /api/v1/notifications/push`              | `{ publicKey }` (null: push is off on this server)                     |
| `POST /api/v1/notifications/push/status`      | `{ subscribed }` for `{ endpoint }` (read-only, idempotency-exempt)    |
| `POST /api/v1/notifications/push/subscribe`   | keeps this browser for the caller here (set-state)                     |
| `POST /api/v1/notifications/push/unsubscribe` | removes it for the caller                                              |

## Browser push

- Keys once per environment: `npx web-push generate-vapid-keys`, then in the api's `.env`:
  `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` (`mailto:…` or `https://…`). All three or none.
  The private key is a secret; changing the pair drops every device (they must turn push on again).
- `/sw.js` only shows messages and opens their page (paths on this site only); besides that it caches only the
  app's hashed static files (ADR 0072).
- Works in Chrome, Edge, Firefox and Safari on macOS; on iPhone and iPad only when the app is added to the home
  screen. The card says when the browser can't, or when notifications are blocked for the site.
- A browser has one subscription; turning push on as another person or in another organization on the same browser
  moves it there. "Turn off" stops sending here and keeps the browser's subscription for the others.

## Tests

- API unit: `notification-delivery.handler.spec.ts` (defaults, choices, language, partner links, push and gone
  subscriptions, failures), env schema (push keys all or none).
- API e2e (Docker / CI): `test/notifications.e2e.spec.ts` (request flow recipients, mark read, low-stock crossing once,
  choices, push devices).
- Web: `components/shell/top-bar.test.tsx` (Updates tab, badge, open and mark read, mark all),
  `components/account/notification-settings.test.tsx` (grid, save only changes, push card, VAPID key decoding).
