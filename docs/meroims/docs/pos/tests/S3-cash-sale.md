# Test S3 — First cash sale (retail till)

| | |
|---|---|
| Approved by user | 2026-10-20, as proposed |
| Scenario | 1 × CHOC-003 (catalog Rs. 20.00, `vat_13`), walk-in, cash received 50.00, register `sample 1`, shift from S2 |
| Method | `tools/cdp-test-seq.mjs` (multi-step UI; guard released only `POST /api/pos/retail/sales` **after checking the request body matched the approval**) + REA passive (`evidence/captures/shapes-S3-cash-sale.txt`) |
| Evidence | `evidence/tests/S3-dryrun.spec.json`, `S3-dryrun.json`, `S3-cash-sale.spec.json`, `S3-result.json`, `S3-accounts-lookup.json` |

## UI flow observed `[OBS]`
1. Search box "Scan barcode, or type a name / SKU…" filters the product grid **client-side** (no lookup call); **Enter does not add** the item. Clicking the product tile adds it (tile: name, SKU, price `रु 20.00`, live stock).
2. **Tender** (disabled while cart is empty) opens "Take payment — रु 22.60": modes Cash / Card / QR / Credit / Split; quick cash (exact, 100, 500, 1,000); keypad; "Cash received" (defaults to total); button "Complete sale रु 22.60 ⏎".
3. Cart is in-memory: it does not survive leaving the till.

## Request / response `[OBS]`
`POST /api/pos/retail/sales`
```json
{ "clientOrderId": "<uuid v4, client-generated>", "registerId": "<sample 1>",
  "lines": [{ "productId": "<CHOC-003>", "quantity": "1" }],
  "tenders": [{ "type": "cash", "amount": "50.00" }], "cashierName": "<operator>" }
```
**201** → `{ order, cashReceived: "50.00", changeDue: "27.40", receipt }`
- `order`: `orderNumber ORD-2026-000003`, `channel retail_pos`, `status completed`, `paymentStatus paid`, `currency NPR`, `subTotal 20.00`, `discountTotal 0.00`, `taxTotal 2.60`, `deliveryCharge 0.00`, `grandTotal 22.60`, `tenders[{type cash, amount 22.60, capturedAt}]`, `shiftId`, `registerId`, `receiptNumber RCPT-000001`, `placedAt`, `completedAt`, table/reservation/driver fields null, `lines[{lineNo, productId, name, sku, quantity "1.0000", unitPrice 20.00, discountAmount 0.00, taxAmount 2.60, lineTotal 20.00}]`.
- `receipt`: `{ store{name, currency, vatPercent "13.0000"}, register{id,name}, table, tableOrderId, shiftId, receiptNumber, orderNumber, orderId, channel, status, soldAt, operator{id,name}, customer{partyId,name}, lines[], totals{currency, subTotal, discountTotal, taxTotal, deliveryCharge, grandTotal}, tenders[], cashReceived, changeDue }`. **No fiscal signature, QR or TSE fields.**

## Side effects `[OBS]`
| Effect | Result |
|---|---|
| Pricing | `vat_13` price is **VAT-exclusive**: 20.00 + 13% = 22.60 |
| Tender stored | applied amount (22.60), separate from cashReceived/changeDue |
| Numbering | order `ORD-YYYY-NNNNNN` and receipt `RCPT-NNNNNN` are **separate sequences** (first receipt in tenant; order #3) |
| Stock | CHOC-003 available 403 → **402** |
| Sales document | **INV-2026-000017** auto-created: `documentType sales_invoice`, `posOrderId` = order id, `status settled`, `settledAmount 22.60`, `balanceDue 0.00`, `payments: []` (settled at entry, no payment record); line `kind product`, `unitCost 15.0000` snapshot; line `taxAmount 0.00` with document `taxTotal 2.60` (tax held at document level on the invoice, line level on the order) |
| Journal | **JV-2026-000057**, `core.invoice.issued`, `systemGenerated`, `status posted` (audit: created → posted), created ~1.8 s after the sale (async posting) |
| Journal lines | Dr 22.60 **BC0001 Cash In Hand** (role `cash_bank`) · Cr 20.00 **DI0001 Sales Goods** (`sales_revenue`, line carries productId+qty) · Cr 2.60 **CL0001 Value Added Tax** (`output_vat`) · Dr 15.00 **COGS0001** (`cost_of_goods_sold`) · Cr 15.00 **INV0001 Inventory Asset** (`inventory`) |
| Posting rules | all 22 mappings use `eventKey: "global"` (tenant-wide role defaults) |
| Operational cash money account | **unchanged** (0.00): GL Cash In Hand is not linked to it via cash-bank mappings |
| Shift / X-report | ordersTotal 1, ordersCompleted 1, grossSales 22.60, capturedTotal 22.60, tenderTotals.cash 22.60, **expectedCash 22.60** |
| Other writes | none (guard blocked 0) |

## Inferences `[INF]`
- Sale → POS order (+receipt) synchronously; invoice + stock movement + journal follow from `core.invoice.issued` (journal ~1.8 s later ⇒ event/queue-driven posting).
- Server prices the sale (client sent only productId + quantity).
- No per-register/per-shift cash account; drawer accountability lives only in shift/X-report figures.

## Unknown `[UNK]`
- Idempotency: behaviour on a repeated `clientOrderId` (not tested; would create a second write).
- Rounding rules for VAT on multi-line/discounted carts.
- Whether the stock movement is written synchronously with the sale or by the event consumer.

## Cleanup / reversal
Nothing deleted. Reversal only through a refund/void flow (to be identified and proposed separately). Records left: ORD-2026-000003, RCPT-000001, INV-2026-000017, JV-2026-000057, CHOC-003 −1.
