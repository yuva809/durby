# 02 — Inventory Completion Checklist (MeroIMS → Durby)

Legend: ✅ verified (runtime) · 📄 client-code contract only · ◐ partial · ◻ not investigated · ⛔ blocked (tenant data/config) · 🌐 external
"Durby need" = whether it is essential before designing **Durby's restaurant inventory MVP** (E = essential, L = later/ERP).

| # | Area | Status | Evidence | Missing | Durby need |
|---|---|---|---|---|---|
| 1 | Product master, categories, units, tax option, reorder level | ✅ shapes + UI · 📄 writes | 01 §1, `shapes-04`, b2 dossier | — | E (done) |
| 1b | Secondary units / pack conversion | 📄 + shape | 01 §1 | runtime behaviour (no data) ⛔ | L |
| 1c | Variants | 📄 | 01 §1 | runtime ⛔ (0 variants) | L |
| 1d | How valuation method is set | ◻ | — | setting location | L (Durby decides) |
| 2 | Stock levels, availability, movement history, valuation ledger | ✅ | INV-readonly, `shapes-04` | `available` formula with reserved/expired ≠ 0 | E (done) |
| 3 | Warehouses / branches / allocation | ◐ shapes + 📄 writes | 01 §3 | multi-location behaviour ⛔ (1 warehouse, 0 branches) | L (single location MVP) |
| 4 | Manual adjustments: contract | 📄 | 01 §4 | — | E (done) |
| 4b | Stock-increase adjustment accounting | ✅ | JV-52, JV-56 | — | E (done) |
| 4c | **Loss / reduce adjustment accounting** (waste, breakage) | ✅ (INV-T3) Dr Stock Adjustment Loss / Cr Inventory at avg cost | tests/INV-T3 | `correction`-reduce and `found` accounting | **E** (done) |
| 5 | Warehouse transfers & branch requests (contracts, statuses, actions) | 📄 | 01 §5 | stock/cost timing ⛔ | L |
| 6 | **Purchase bill / goods receipt: stock, cost and journal effect** | ✅ (INV-T1) | tests/INV-T1 | supplier (party) purchase, VAT input, charges | **E**: done for cash/no-tax |
| 7 | Purchase return effect | 📄 · ◻ | 01 §7 | stock/journal | L |
| 8 | POS sale deduction + COGS | ✅ | S3, S5 | — | E (done) |
| 8b | Refund with restock | ✅ | S4 | — | E (done) |
| 8c | Refund without restock / order cancel / line void stock effect | ◻ | — | write tests | E-lite (Durby defines rules) |
| 8d | Held orders reserve stock? | ◻ | S5 (no invoice at hold) | reservation behaviour | L (Durby: no reservation for restaurants) |
| 9 | Selling at zero stock: UI guard | 📄 | till code | — | E (done) |
| 9b | **Server enforcement of insufficient stock** | ◻ | — | write test | E-lite (Durby policy: allow + alert) |
| 10 | Concurrent sales from multiple tills | ◻ | — | risky to test | L (Durby design via append-only movements) |
| 11 | Batch / expiry | 📄 + shapes | 01 §11 | runtime ⛔ (0 perishable) | L |
| 11b | Serial numbers | not found | client code search | absence not proven | not needed |
| 12 | Costing methods present (FIFO / weighted avg) | ✅ | INV-readonly products | — | E (done) |
| 12b | **Cost-layer behaviour (FIFO consumption, average recompute)** | ✅ average recompute (INV-T1); **FIFO flag ignored: sale costed at moving average** (INV-T2) | tests/INV-T1, INV-T2 | — | **E** (done) |
| 12c | Landed cost from purchase charges | ◻ | — | allocation | L |
| 13 | Inventory journals: sale / refund / increase | ✅ | S3–S5, JV-52/56 | — | E (done) |
| 13b | Purchase / loss / transfer journals | ◐ purchase ✅ (JV-60); loss ✅ (JV-62); transfer ◻ ⛔ | tests/INV-T1, INV-T3 | transfer (needs 2nd warehouse) | L (transfer) |
| 14 | Reports (position, ledger) | ✅ | INV-readonly | — | E (done) |
| 14b | Stocktake workflow | not found | — | (adjustments used instead) | E for Durby, design own |
| 14c | GL-vs-valuation reconciliation | ◻ | — | compare totals | L |
| 15 | Recipe / BOM consumption | ✅ not implemented ("Coming soon", no code) | b2 dossier, code search | — | **E for Durby, but no MeroIMS reference exists** |

## Readiness verdict
- **Enough evidence** for: product master, stock-level/movement model, valuation ledger, POS sale/refund stock + COGS posting, opening-stock accounting, transfer/request workflow shape (for later multi-location).
- **Settled by INV-T1:** goods receipt (stock + cost + journal) and weighted-average recomputation.
- **Settled by INV-T2/T3:** MeroIMS **ignores the FIFO flag** (sales costed at moving average); waste/loss posts Dr *Stock Adjustment Loss* / Cr Inventory at average cost.
- **Final verdict:** enough evidence to design Durby's restaurant inventory module (see bottom of `01`). Remaining gaps are either **blocked by tenant setup** (multi-warehouse, branches, batches/expiry, variants, secondary units), **not part of MeroIMS** (recipes, stocktake), or **policy choices Durby makes itself** (overselling, reservations, costing method).
- **Cannot come from MeroIMS at all:** recipe/ingredient consumption (not implemented), stocktake workflow, restaurant-mode stock bypass details (restaurant mode disabled). Durby must design these from requirements.
- **Not prerequisites for the Durby POS MVP:** multi-warehouse transfers, branch requests, batches/expiry, variants, purchase returns, landed cost, concurrency tests (Durby's append-only design addresses concurrency by construction).
