# ADR 0044: Operations menu, orders and fulfilment for AsiaMight

- Status: accepted (2026-11-15)
- Date: 2026-11-15
- Builds on: ADR 0015 (white-label shell), ADR 0040 (AsiaMight), ADR 0012 (numbering), ADR 0027 (stock ledger),
  ADR 0037 (CRUD permissions), ADR 0038 (inventory sub-modules)
- Changes: ADR 0040 §4 ("no per-partner menu order")

## Context

AsiaMight runs a distribution business on Durby's inventory plan. Its sidebar should read like its work:
**Business operations** (Inventory, Product Category, Order History, Picking, Branches, Delivery Tracking),
**Administration & reports** (Audit Log, Manage Staff) and **Tools & utilities** (Import Data, Feedback). Durby
has no customer orders, picking, delivery tracking, a general import or in-app feedback yet.

## Decisions

1. **Sidebar layout is part of the partner theme.** `partner_themes.nav_layout` (`default` | `operations`, CHECK),
   set by migration like the rest of the theme, returned by `GET /theme` as `navLayout` (still no partner id). The
   web picks the layout's groups and items (`apps/web/lib/nav/layouts.ts`); every item keeps its feature and
   permission, so the plan and the role still decide what shows. AsiaMight uses `operations`; every other host keeps
   Durby's menu. Settings stays in the operations menu under Administration (roles, company, plan need it).

2. **Product Category and Branches are pages of their own.** `/catalog/categories` lists the categories with
   counts, create, edit, archive and drag-and-drop order (same api as `/catalog`). `/branches` is Settings →
   Locations under the name Branches. The default menu's Inventory → Product Category link opens the new page too.

3. **Orders are entered by staff** (module `orders`, feature `orders` depending on `inventory`, in the `inventory`
   plan). A sales order has a customer, a branch, a warehouse and lines of **stock items** (not menu products) with
   a quantity and a unit price (stock items get an optional sale price that fills it in). Statuses:
   `draft → confirmed → picking → packed → dispatched → delivered`, `cancelled` before dispatch. Numbers from the
   numbering service; money in exact cents; an audit entry per change.

4. **Picking takes the stock out.** Confirming a pick list books one stock issue document (append-only ledger,
   idempotent); short picks are kept per line. Returning an undelivered order books the stock back.

5. **Delivery tracking is a status board**, not routing: driver, phone, vehicle, notes and a timeline per order.

6. **Import Data** is a CSV wizard (template, preview with row errors, import in one transaction, at most 5,000
   rows) for product categories, products / stock items, opening stock and customers.

7. **Feedback goes to the platform team**: staff send a category, a message and an optional screenshot; the staff
   portal lists it with a status.

Steps 3–7 ship one at a time; until a module ships its menu item is `planned` (hidden).

## Consequences

- A partner can change its menu's shape without code for the page itself, but each layout is code reviewed
  (`layouts.ts`), not configuration: a new layout needs a release.
- Order lines reference stock items, so a restaurant's POS orders and AsiaMight's sales orders stay separate
  modules.
- New permissions (orders, picking, delivery, import, feedback) appear as columns in Add Staff (ADR 0037).
