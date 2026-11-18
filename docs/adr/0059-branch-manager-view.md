# ADR 0059: The branch's view in the operations menu: its own menu, categories without the catalog, Order History, Delivery Tracking

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0044 (operations menu), ADR 0045 (branch stock requests), ADR 0048 (inventory on category tiles),
  ADR 0053 (request cart)

## Context

A branch manager at the distributor saw the owner's menu cut down to what their role allows: Overview (a placeholder),
Inventory, Stock Requests and Settings (Company and Plan only). Their inventory showed every item as Uncategorized:
the category tiles read the catalog, which a branch may not read (it holds the products' prices). The distributor
wants the menu its branches know: Inventory with a request cart, Order History, Delivery Tracking and Feedback.

## Decisions

1. **A branch's own menu** (`lib/nav/layouts.ts`): in the operations layout, someone who asks for goods
   (`orders.requests.create`) and neither approves requests nor reads sales orders (`isBranchView`; the Branch manager
   role) gets **Inventory · Order History · Delivery Tracking**, and **Feedback** under Tools & utilities. No Overview
   (`/` sends them to `/inventory`) and no Settings item. Everyone else keeps the operations menu; the Durby menu has
   no branch variant. The menu stays a UI hint: the api checks every route as before.
2. **Categories for stock readers**: `GET /api/v1/inventory/categories` (`inventory.stock.read`, the inventory
   feature) lists the same categories as `GET /api/v1/catalog/categories` through the catalog's public service. The
   inventory page reads them from there when the person can't read the catalog, so a branch's stock shows on the
   category tiles. Images stay with the catalog (`catalog.products.read`): a branch's tiles show their colour.
3. **Order History** is `/requests` titled for the branch; the page is a table for everyone: request, branch, items,
   **requested by** (new `requestedByName` on every request summary: the requester's display name, null without
   one), date, status and transfer number, searched by request or transfer number and filtered by stage (All
   statuses, Waiting for approval, In progress, Done). Approvers open on Waiting for approval, everyone else on all.
4. **Delivery Tracking** for a branch (`/deliveries` without `orders.delivery.use` or `assign`, with
   `orders.requests.receive`): its requests from approval on, each with its steps (Approved, Picking, Packed, On the
   way, Delivered), the driver once assigned and "Confirm receipt" from packed on (opens the request on `/requests`);
   below, what was received in the last 7 days. Those who assign drivers keep the board.
5. **Request cart**: the inventory page's button reads "Request cart" (ADR 0053's cart, `/requests/new`).

## Consequences

- A member whose own permissions switch Feedback (`platform.feedback.send`) off doesn't see it; the Branch manager
  role grants it.
- Prices stay hidden from a branch's menu pages: categories carry no prices and the catalog stays closed. Stock values
  and costs in the inventory api are a separate step.
