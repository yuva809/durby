# Test S5 — Hold (park) a cart, then finalize it with a card tender

| | |
|---|---|
| Approved by user | 2026-10-20, as proposed |
| Scenario | 1 × BEV-WAT-004 (Rs. 30.00, `no_vat`), walk-in, register `sample 1`; hold, then resume from "Held sales" and pay by **card** 30.00 |
| Method | `tools/cdp-test-seq.mjs`: 2 guarded writes; the finalize path was pinned at runtime to the id returned by the hold (`${w0..id}`), and the held-list row was chosen by the returned order number |
| Evidence | `evidence/tests/S5-dryrun*.json`, `S5-hold-finalize-card.spec.json`, `S5-result.json`, `evidence/captures/shapes-S5-hold-card.txt` |
| Run notes | First run aborted **before any write** (till input not yet rendered); runner fixed (field wait) and re-run under the same approval |

## UI `[OBS]`
Cart panel: per-line **− / + / Edit / Void**, customer attach, **Hold F8**, **Resume (n) F9**, **Tender F10** (keyboard shortcuts); compact duplicates (Walk-in / Browse / Tender). "Held sales" dialog lists **all held sales tenant-wide** (holds request has no register filter; it showed a pre-existing hold from Register-B) with a **Take payment** button per hold → the normal tender dialog ("Take payment — रु 30.00") → **Card** mode → "Complete sale".

## Requests / responses `[OBS]`
1. `POST /api/pos/retail/holds` `{ clientOrderId, registerId, lines:[{productId, quantity:"1"}], cashierName }` → **201** bare order: `orderNumber ORD-2026-000004`, `status held`, `paymentStatus pending`, `taxTotal 0.00`, `grandTotal 30.00`, `tenders []`, **`shiftId null`**, `receiptNumber null`.
2. `POST /api/pos/retail/holds/{orderId}/finalize` `{ registerId, tenders:[{type:"card", amount:"30.00"}], cashierName }` → **201** `{ order, receipt, cashReceived: null, changeDue: "0.00" }`: `status completed`, `paymentStatus paid`, `shiftId` = current shift, `receiptNumber RCPT-000002`, `tenders[{type card, amount 30.00, capturedAt}]`.

## Side effects `[OBS]`
| Effect | Result |
|---|---|
| Numbering | order number assigned **at hold**; shift + receipt number bound **at finalize** |
| Stock | BEV-WAT-004 172 → **171** (at finalize; not observed at hold time) |
| Invoice | **INV-2026-000018** `sales_invoice`, `settled`, total 30.00, **tax 0.00**, `settlementAccountId null`, `payments []` |
| Journal | **JV-2026-000059** `core.invoice.issued`: Dr **BC0001 Cash In Hand** 30.00 / Cr DI0001 Sales Goods 30.00 · Dr COGS0001 18.00 / Cr INV0001 Inventory 18.00 (no VAT line) |
| X-report | ordersTotal 2, ordersCompleted 1, ordersRefunded 1, grossSales 52.60, capturedTotal 52.60, **tenderTotals {cash 22.60, card 30.00}**, **expectedCash 22.60** (card excluded) |

## Findings
- **Card receipts post to Cash In Hand** in the GL (same account as cash): no card-clearing/bank account; tender type distinguished only in shift reporting.
- Held orders are **not shift-bound** and are **visible from every register**; any till can take payment for any hold (it then belongs to the finalizing register's shift).
- `no_vat` items produce no tax line.

## Unknown `[UNK]`
- Whether stock is reserved while an order is held (stock not re-read between hold and finalize).
- Hold cancel/discard from the till (no endpoint in the till client; order management has `held → cancelled` transition).
- Card terminal integration: none observed; card is record-only.

## Cleanup
Nothing to clean: completed sale. Records: ORD-2026-000004, RCPT-000002, INV-2026-000018, JV-2026-000059, BEV-WAT-004 −1.
