# ADR 0080: Branches without their own stock

- Status: accepted
- Date: 2026-11-24
- Changes, per organization, [ADR 0053](0053-main-warehouse-and-request-cart.md) (a branch without a store gets one
  with its first request) and the receipt step of [ADR 0045](0045-branch-stock-requests.md).

## Context

AsiaMight's owner found a warehouse "Asia Might Hagelberger" in the audit log, created by a branch manager. Nobody
had used the Warehouses page: ADR 0053 creates a branch's store with its first stock request, audited under whoever
sent it. AsiaMight runs its stock in the main warehouse only: what a branch requests should leave the main warehouse,
and that is all. Branch stores, and stock booked into them on receipt, are not wanted there. Other organizations keep
stock per branch.

## Decision

1. **A setting, `orders.branchStores`** ("Branches keep their own stock"), organization or partner scope, default on
   (today's behaviour). AsiaMight turns it off on the Settings page.
2. **Off:** a request names no destination warehouse (`stock_requests.to_warehouse_id` is now nullable) and no store
   is made for the branch. Packing moves the goods out of the main warehouse into In transit as before, so the main
   stock goes down when packed. On receipt, what arrived leaves In transit as a **delivery** (a new stock document
   kind, numbered in the transfer series, linked to the request); what did not arrive is booked short as before.
3. A request that names a store which has been archived since is delivered the same way.
4. The request cart no longer says a store will be created when branches keep no stock; the destinations list tells
   the web which applies (`keepsStock`).
5. Existing branch stores are archived by the owner (Inventory → Warehouses); their history stays readable.

## Consequences

- With the setting off, branch stock is not tracked anywhere: the main warehouse's activity shows what each branch
  was sent (transfer out at packing, delivery on receipt).
- Switching the setting back on makes the next request of a branch without a store create one, as before.
