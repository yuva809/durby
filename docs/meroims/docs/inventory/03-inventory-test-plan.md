# 03 — Inventory Controlled Test Plan (Option B)

Same rules as the POS tests: one scenario per approval, dry-run first, guarded single write with body check, redacted evidence, no deletion of posted records.

## INV-T1 — Cash purchase bill at new unit costs: ✅ DONE ([result](tests/INV-T1-purchase-bill.md))
- **Why:** settles checklist items 6, 12b and 13b (purchase) in one write: goods receipt stock increase, cost-layer behaviour for **both** costing methods, and purchase journal.
- **Document:** `/purchases/bills/create` → tab **Cash Purchase** (no supplier), date today, **no tax** (default `tax_option: no_vat`), no discount/charges, note `TEST-DURBY-INV-T1`, paid in full from the default cash account.
- **Lines:**
  | Product | Costing | Current | Purchase |
  |---|---|---|---|
  | BEV-WAT-004 | **FIFO** | 171 on hand @ 18.00 | **2 @ 20.00** |
  | CHOC-003 | **weighted average** | 403 on hand @ 15.00 | **2 @ 17.00** |
  Total 74.00.
- **Guarded request:** only `POST /api/core/purchases/bills`; body must contain exactly these 2 lines (product ids, quantity 2, unitPrice 20.00 / 17.00), `customFields.tax_option == "no_vat"`, `cash_transaction: true`, `settledAmount == "74.00"`, note containing `TEST-DURBY-INV-T1`.
- **Captured before/after:** stock levels (onHand, avgCost) for both items; movements (expect `purchase/purchase_bill`); inventory-ledger rows (balance rate after receipt); new purchase bill document (number, status, lines, settlement); new journal + lines (expect Dr Inventory 74.00 / Cr Cash In Hand 74.00 [INF]); cash money account; inventory-position total.
- **Expected effects to verify (not assumed):** BEV-WAT-004 173 on hand with layers 171@18 + 2@20 (FIFO); CHOC-003 405 on hand with average ≈ 15.0099 (weighted average); a `PB-…` document; one journal.
- **Risks:** permanent dev records (purchase bill, 2 stock movements, journal); stock +4 units; cash/inventory GL change of 74.00. Reversal only via a purchase return or void (separate approval). Documents are editable in MeroIMS, but the bill will not be edited.
- **Follow-ups (each needs its own approval, later):** INV-T2: a 1-unit POS sale of BEV-WAT-004, to see whether FIFO consumes the 18.00 layer before the 20.00 layer. INV-T3: a 1-unit **loss** adjustment, to see waste/loss accounting.

## INV-T2 — 1-unit cash sale of the FIFO product: ✅ DONE ([result](tests/INV-T2-fifo-sale.md)): costed at average 18.0231
- **Why:** settles checklist 12b: does MeroIMS cost a FIFO product's sale from the oldest layer (18.00) or at the blended average (18.0231)?
- **How:** `/sales/invoices/create` → **Cash Sale** (walk-in, no customer), 1 × BEV-WAT-004 at its sales price 30.00, no tax (product is `no_vat`, invoice tax off), receive total amount, note `TEST-DURBY-INV-T2`. Single guarded `POST /api/core/sales/invoices` with exactly that body. (Back-office invoice instead of POS: no shift needed, single write; the POS sale already showed it posts through the same invoice path, S3/S5.)
- **Capture:** invoice line `unitCost`, movement `unitCost`, stock level avgCost, valuation ledger rows, journal COGS amount, operational cash account.
- **Decision rule:** COGS 18.00 → FIFO layers consumed; 18.02 → average used despite the FIFO flag.
- **Risks:** permanent records: invoice INV-2026-0000xx, movement −1, journal; +30.00 revenue in dev.

## INV-T3 — Loss (waste) adjustment of 1 unit: ✅ DONE ([result](tests/INV-T3-loss-adjustment.md)): Dr Stock Adjustment Loss / Cr Inventory
- **Why:** settles checklist 4c/13b: how waste/breakage is booked (restaurants record waste daily).
- **How:** `/inventory/adjustment` → CHOC-003 → Adjust → reduce 1, type **loss**, reason `TEST-DURBY-INV-T3 waste`. Single guarded `POST /api/core/stock/adjustments {productId:<CHOC-003>, direction:"reduce", quantity:"1", adjustmentType:"loss", reason:"TEST-DURBY-INV-T3 waste"}` (exact UI field names confirmed in a dry run first).
- **Capture:** movement type and unitCost, level, valuation ledger, journal accounts (expected Dr a stock-adjustment/loss expense / Cr Inventory at ≈15.01, to verify).
- **Risks:** permanent movement + journal; −1 unit (≈15.01 value).
