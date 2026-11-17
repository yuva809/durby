# ADR 0046: Top bar search, "waiting for me" notifications and the sidebar account card

- Status: accepted (2026-11-17)
- Date: 2026-11-17
- Builds on: ADR 0015 (web shell), ADR 0044 (operations menu, orders), ADR 0045 (branch requests)
- Extended by: ADR 0047 (stored updates, email and push, several signed-in accounts)

## Context

People in every partner's app (Durby and AsiaMight) asked for a search across their data, a bell that tells them
what needs them, a quick way to the audit log, and the person and organization switch at the bottom of the sidebar.

## Decisions

1. **Search is one box for pages and records.** Ctrl+K / ⌘K or the box in the top bar opens a palette. Menu pages
   match on the client (only those the person can open). From two letters, `GET /api/v1/search?q=` adds records:
   stock items (name, SKU), products (name, menu number), customers (name, code), sales orders (number, customer),
   stock requests and transfers (SRQ / TRF number) and staff (display name), at most five per type. Each module answers
   through its own lookup (`CatalogLookup`, `InventoryLookup`, `OrdersLookup`, `MemberNames.search`) with the same key
   and location rules as its lists; a new `workspace` module only puts the answers together. Modules the organization
   lacks answer nothing. Results link to their page; orders and requests open in their side panel (`?open=<id>`).

2. **Notifications are "waiting for me", worked out, not stored.** `GET /api/v1/attention` counts, for the caller,
   requests to approve, transfers to pick, deliveries assigned to them, goods on the way to their branch, sales orders
   to pick or dispatch, draft orders and low stock, each only for those who can act on it and only where they can.
   The bell shows the total and a list that leads to the page where each is dealt with; it refreshes every minute, on
   tab focus and when opened. An item disappears once it is done; there is nothing to mark as read. Stored messages,
   email or push notifications are later.

3. **Audit Log in the top bar** for `platform.audit.read`, beside the bell.

4. **The person card at the bottom of the sidebar** (email, organization, role) holds the organization switch (the
   organizations of this site, ADR 0042), Account and Sign out; with several organizations a "Switch organization"
   button also sits at the top of the sidebar. The top bar no longer holds them. Switching between several signed-in
   users is not part of this.

## Consequences

- Both endpoints are `@Authenticated()` and read-only: the services filter, as the stock request reads do (ADR 0045).
- Every count is a query per request; the counts use existing indexes (status, location) and the lists stay small.
- New searchable types or "waiting" kinds are added in the owning module's lookup and in the shared registries.
