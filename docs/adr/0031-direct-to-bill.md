# ADR 0031: Kitchen and bar processing switches (direct to bill)

- Status: accepted (2026-11-06)
- Date: 2026-11-06

## Context

Every item a waiter sends becomes a kitchen or bar ticket (ADR 0025): printed as a slip and shown on the
station's screen until served (ADR 0026). A café, or a bar where the waiter pours the drinks, has nobody to
prepare a ticket for: items should go straight onto the bill.

## Decisions

1. **Two settings, one per station:** `pos.kitchenProcessing` and `pos.barProcessing` (boolean, default `true`,
   every scope). Set for the organization; a location can override (like the bill header and footer).
2. **Items still hang off a ticket.** Lines are append-only and belong to a ticket (rule 7), so a send still writes
   one ticket per station, but a station that is off gets a **direct** ticket: `pos_kitchen_tickets.direct`, a
   snapshot taken at send time like `station`. A void copies the voided line's ticket's `direct`.
3. **Direct tickets are not work:** they never appear on the kitchen or bar screen, take no status changes (409
   `pos.ticket_status_invalid`) and print nothing on send (a reprint still prints on demand). Totals, the bill,
   voids and inventory consumption (`pos.kitchen_ticket.created`, ADR 0028) are unchanged.
4. The till learns the effective switches from `GET /pos/tables/:tableId/order` (`processing`), so its send
   button can say "Add to bill" before sending; the api decides on send.

## Consequences

- Turning a station off affects only later sends; tickets already on a screen stay there until served.
- Expand-only migration (a column with a default); older releases ignore it.
