# ADR 0045: Branch stock requests with Branch, Warehouse and Driver roles

- Status: accepted (2026-11-17)
- Date: 2026-11-17
- Builds on: ADR 0007 (RBAC), ADR 0027 (stock ledger), ADR 0037 (CRUD keys), ADR 0044 (operations menu, orders)

## Context

AsiaMight's branches restock from the main warehouse (Lager). A branch asks for goods, the owner or an admin decides,
the warehouse picks and packs, a driver brings them, and the branch confirms what arrived. Each person should see only
their part. Sales orders to customers (ADR 0044) stay; this is a second flow beside them.

## Decisions

1. **Three built-in roles, only where they make sense.** `branch`, `warehouse` (shown as "Warehouse (Lager)") and
   `driver` are system roles in every organization (migration backfill, `SystemRoles.ensure`), but the role list shows
   them only where the organization has the `orders` module (`SYSTEM_ROLE_FEATURES`). Restaurants never see them. The
   owner onboards people with them in Add Staff and can adjust keys per person as for any role.

2. **New keys.** `orders.requests.read` / `create` / `receive` (location: the branch), `orders.requests.approve`
   (organization: owner and admin only), `orders.delivery.assign` (location: the source warehouse). Picking and
   driving reuse `orders.picking.use` and `orders.delivery.use`. Branch: request, receive, own stock. Warehouse: pick,
   assign drivers, stock in and adjustments, read orders and requests. Driver: their deliveries. Managers request,
   receive and assign; they don't approve.

3. **One record, two numbers.** A `stock_requests` row is the request (`SRQ-…`) and, once approved, the transfer
   (`TRF-…`, `transfer_number`). Lines keep requested, approved, picked and received quantities. Statuses:
   `submitted → approved → (picking) → packed → in_transit → delivered → received`; `rejected` and `cancelled` only
   before approval. The branch may confirm receipt from packed on, so a driver who forgets to tap doesn't block it. An
   append-only timeline, an audit row and the idempotency key go with every step.

4. **Stock moves when it moves.** Packing transfers the picked goods from the source into the organization's
   **In transit** warehouse (`warehouses.is_transit`, one per organization, created on first use), refused below zero
   unless the location allows it. Receiving transfers what arrived from In transit into the branch's warehouse and books
   the rest out of In transit as a shortage (an adjustment). Main stock is right the moment goods leave; documents name
   the request (`stock_documents.source_request_id`).

5. **What each side sees.** A branch sees the source warehouse's available quantities (no costs) through
   `/stock-requests/availability`, without inventory access there. Lists show a caller their branch's requests, their
   warehouse's, all of them for approvers, and `mine=true` for a driver; one request is 404 to anyone else. Drivers are
   those holding `orders.delivery.use` at the source (`MemberNames.holders`).

6. **Shared screens.** Picking shows transfers above sales orders; Delivery Tracking shows transfers for those who
   assign drivers; drivers get My Deliveries. Batches and expiry ("soonest expiry first") are a later step.

## Consequences

- The `system_role` enum gains three values; every organization has three more role rows, hidden without `orders`.
- In transit is a real warehouse: it appears in Inventory with what is on the road, and stock reports include it.
- A shortage on arrival is booked as an adjustment out of In transit; finding the goods later is a normal receipt.
