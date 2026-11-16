# Feedback

- Code: `packages/shared/src/api/feedback.ts`, `apps/api/src/platform/feedback/` (customer side),
  `apps/api/src/platform/staff/staff-feedback.*` (admin portal), `apps/web/components/feedback/`,
  `apps/web/components/staff/feedback-page.tsx`
- Decisions: [ADR 0044](../adr/0044-operations-menu-orders-fulfilment.md) step 5

Members of a customer organization tell the team behind the app about a bug, an idea or a question (`/feedback`,
Tools & utilities in the operations menu). Durby staff read every customer's feedback in the admin portal
(`/platform/feedback`) and mark it seen or done.

## Data

`feedback` (platform table): `organization_id` (FK), `user_id` (no FK: rows outlive users), `category`
(`bug` | `idea` | `question`), `message` (1–2,000 characters), `page_path?` (a same-origin path), `status`
(`new` | `seen` | `done`), timestamps. `durby_app` can't delete it.

**Platform data, not tenant data.** It is the operator's support inbox and is read across customers, like the
platform audit log, so it has no `tenant_id` and no RLS. The customer side only inserts with the session's
organization and lists rows filtered by it; nothing else in a tenant request touches the table.

## API

| Route                                 | Access                                         | Notes                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/feedback`               | `platform.feedback.send` (every role)          | `{ category, message, pagePath? }`; idempotent, completes in the transaction                                                                   |
| `GET /api/v1/feedback`                | `platform.feedback.send`                       | The organization's 50 newest                                                                                                                   |
| `GET /api/v1/platform/feedback`       | `staff.feedback.read` (all staff roles)        | `?status=`; 200 newest, with customer and sender's email                                                                                       |
| `PATCH /api/v1/platform/feedback/:id` | `staff.feedback.manage` (super admin, support) | `{ status }`; set-state, a platform audit row per change (`staff.feedback.status_changed`, snapshot: id, category, status — never the message) |

`platform.feedback.send` is location-scoped so location-limited members (waiters, kitchen) hold it too.

## Not in this step

**Screenshots.** The plan had an optional screenshot (≤ 2 MB). The api accepts JSON bodies up to Nest's default
100 kB and there is no object storage yet (ADR 0015 §4), so attachments wait for object storage; until then the form
asks people to name the page and what they did, and `?from=/orders` fills in the page.

## Tests

- Web: `components/feedback/feedback.test.tsx` (send with category and page, validation, history, no access; portal
  list with customer and sender, mark done, read-only role).
- API e2e (Docker): `test/feedback.e2e.spec.ts` (every role sends, organizations isolated, staff list and status with
  one audit row, keys enforced).
