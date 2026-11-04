# ADR 0026: Table QR menu, kitchen and bar screens, Kitchen and Bar roles

- Status: accepted (2026-11-04)
- Date: 2026-11-04
- Step: table service (docs/modules/pos.md → QR menu, Kitchen and bar screens)

## Context

Restaurants want a QR code on every table that shows guests the menu, a screen in the kitchen and at the bar
where tickets move from new to ready, and waiters to see what is ready to serve. Until now tickets were only
printed (ADR 0016 §6, ADR 0025 §5) and nothing was reachable without signing in except auth, invitations, theme
and health.

## Decisions

1. **Public menu by table token.** Each dining table has a `menu_token` (24 random URL-safe characters). The QR
   links to `/menu/<organizationId>.<menuToken>`, the same shape as invitation tokens (ADR 0007): the api reads
   in the named organization's tenant (RLS), so a token never reaches another tenant's rows and no definer
   function is needed. The token is not a credential: it only shows the menu (names, descriptions, gross prices,
   the bill header's name and logo). Staff with `pos.tables.manage` can rotate it. `GET /public/menu/:token` is
   `@Public()`, rate-limited per IP, and answers 404 when the organization lacks the `pos` feature.
2. **Ticket status is append-only.** `pos_ticket_status_changes` holds `preparing`, `ready` and `served` rows
   (rule 7, like `reservation_status_changes`); a ticket's status is its latest row, else `new`. Allowed moves:
   new → preparing | ready, preparing → ready, ready → served, ready → preparing (undo); a void ticket only
   new → served ("seen"). Repeating the current status writes nothing.
3. **Screens per station.** `pos.kitchen.use` and `pos.bar.use` (location scope) see and move their station's
   tickets. Holders of `pos.orders.take` (waiters) may only set `served` on a ready ticket, from the till.
4. **Kitchen and Bar system roles** (amends ADR 0007's list): each holds its station key and
   `platform.settings.read`, nothing else: no prices, orders or menu editing. Added as for `host`: one migration
   adds the `system_role` values, the next creates the roles in every organization; `SystemRoles.ensure` creates
   them for new ones. Admin and Manager also get both station keys.
5. **Screens poll.** The boards and the floor reload every 5 seconds; push (SSE) can come later without an api
   change.

## Consequences

- Waiters see "Ready" on the floor and the till until they mark it served.
- A guest ordering from the QR page would be a separate decision (public writes, abuse protection, confirmation).
