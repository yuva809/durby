# ADR 0016: Table service before TSE (catalog, tables, guest checks)

- Status: accepted
- Date: 2026-10-27
- Step: Phase 2, table service step 1 (branch `feature/kitchen`)

## Context

Restaurants want table service: the owner maintains products and tables, waiters take orders per table and send
them to the kitchen, a billing counter prints table bills and looks up past ones. The architecture plans the official
POS with a TSE (KassenSichV) after Inventory and Billing. In Germany a printed customer receipt from a cash register
system must be TSE-signed, so a "bill" printed by Durby before the TSE exists must not be a receipt.
Specs: [catalog](../modules/catalog.md), [pos](../modules/pos.md).

## Decisions

1. **Two modules.** `catalog` (product categories, products) is shared by table service now and by inventory and
   billing later. `pos` holds table service: dining tables, orders, kitchen tickets, guest checks. `fiscal` (TSE,
   payments, receipts) stays a later module.

2. **New feature `catalog`**, in every seeded plan, added by a migration with a `platform.plan.features_changed` audit
   row per organization (ADR 0009). Tables, orders and checks use the existing `pos` feature.

3. **Guest checks, not receipts.** Until `pos.fiscal` exists, the printed table bill is a guest check
   ("Zwischenrechnung"): a numbered pre-bill with line items, totals and the VAT breakdown, printed with a fixed
   "This is not a receipt" line. Durby records no payment for it. Payment and the TSE-signed receipt come with the
   fiscal step, which links the receipt to the guest check.

4. **Prices are gross with a tax rate per product.** Menus show prices including VAT; the guest check derives net
   amounts per rate. A per-product `tax_rate` is enough until a tax engine is needed (e.g. take-away vs dine-in
   rates); then products get a tax category instead, in an expand/contract migration.

5. **Archive instead of delete** for categories, products and tables: orders and checks reference them, and history
   must stay readable.

6. **Printing is browser printing.** Kitchen tickets and guest checks are print-styled pages (`window.print()`), so no
   printer driver or device integration is needed yet. ESC/POS or a print bridge is a later decision.

7. **Waiter and cashier are system roles** (step 2), same grants for every organization, amending ADR 0007's list.
   Two migrations: one adds the `system_role` enum values (a new value can't be used in the transaction that adds
   it), the next creates both roles in every existing organization; new organizations get them from
   `SystemRoles.ensure`. Waiter and Cashier start with Staff's reads; step 3 adds their order keys.

## Consequences

- Tenants in Germany can run table service with Durby but still need their existing cash register for payment until
  the fiscal step.
- Staff now also holds `catalog.products.read` and `pos.tables.read`, Manager also `pos.tables.manage` (ADR 0007:
  system roles change for every organization). A custom "people manager" role can only manage members whose role it
  fully covers, so such a role must be given the new keys to keep managing Staff members (ADR 0007, open point on
  assigning system roles from custom roles).
- Order lines and guest checks will snapshot product name, price and tax rate, so later product edits never change
  past orders or checks.
