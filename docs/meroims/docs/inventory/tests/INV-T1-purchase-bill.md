# Test INV-T1 — Cash purchase bill at new unit costs

| | |
|---|---|
| Approved by user | 2026-10-20, as proposed |
| Scenario | Cash Purchase (no supplier, no tax): 2 × BEV-WAT-004 @ 20.00 (FIFO product), 2 × CHOC-003 @ 17.00 (weighted-average product), note `TEST-DURBY-INV-T1` |
| Method | `tools/cdp-test-seq.mjs`: 2 dry runs, then one guarded `POST /api/core/purchases/bills` released only for the exact body; REA passive shapes `evidence/captures/shapes-INV-T1-purchase.txt` |
| Evidence | `evidence/tests/INV-T1-dryrun*.json`, `INV-T1-purchase.spec.json`, `INV-T1-result.json` |

## UI `[OBS]`
`/purchases/bills/create` → tabs Cash Purchase / Party Purchase; one line pre-created (Qty 1); product search dropdown option "Mineral Water Stock 171 · BEV-WAT-004 Rs. 30.00" **plus a "Create “<text>”" quick-create button** (not clicked); Add Row; "Pay total amount — Rs. 74.00" checked by default; Save / Save & Add New. After save → navigates to `/purchases/bills/{id}`.

## Request / response `[OBS]`
`POST /api/core/purchases/bills`
```json
{ "date": "2026-10-20",
  "lines": [ { "productId": "<BEV-WAT-004>", "kind": "product", "quantity": "2", "unitPrice": "20.00",
               "unitMeta": { "unit_mode": "primary", "entered_quantity": "2", "entered_rate": "20", "unit_label": "Bottle", "discount_source": "auto" } },
             { "productId": "<CHOC-003>", "kind": "product", "quantity": "2", "unitPrice": "17.00", "unitMeta": { "unit_label": "Piece", "…": "…" } } ],
  "customFields": { "tax_option": "no_vat", "cash_transaction": true, "cash_label": "Cash Purchase" },
  "warehouseId": "<default warehouse>", "notes": "TEST-DURBY-INV-T1", "requestId": "<client uuid>" }
```
→ **201** document (47 fields): `documentNumber BILL-2026-000001`, `documentType purchase_bill`, `status settled`, `isDraft false`, subTotal/grandTotal 74.00, tax 0.00, settledAmount 74.00, balanceDue 0.00, warehouseId.
Note: no `settledAmount` sent; cash purchases are settled in full server-side `[INF from request+response]`. `requestId` = client idempotency key for documents.

## Effects `[OBS]`
| Effect | Before → After |
|---|---|
| BEV-WAT-004 (FIFO) level | 171 @ avgCost 18.0000 → **173 @ 18.0231** |
| CHOC-003 (weighted avg) level | 403 @ 15.0000 → **405 @ 15.0099** |
| Movements | `purchase / purchase_bill`, +2 each, unitCost 20.0000 / 17.0000 |
| Valuation ledger | FIFO item: `Purchase Bill in 2@20.00 → bal 173@18.02 = 3118.00`; wAvg item: `in 2@17.00 → bal 405@15.01 = 6079.00` |
| Bill lines | `unitCost` = unitPrice (20.0000 / 17.0000), tax 0.00, batch none; `payments []`; settlementAccount set; settlementStatus settled |
| Journal | **JV-2026-000060** `core.purchase.recorded`, posted: Dr INV0001 Inventory Asset 40.00 (qty 2, product) · Dr INV0001 34.00 (qty 2, product) · **Cr BC0001 Cash In Hand 74.00 with `operationalAccountId` set** |
| Operational cash money account | 0.00 → **−74.00** (negative balance allowed) |
| Inventory position total | 1,521,846.00 → **1,521,920.01** (+74.01 = 0.01 rounding drift) |

## Findings
- Weighted average recomputes on receipt: (403×15 + 2×17)/405 = 15.0099 ✔.
- **FIFO products are reported at a blended average** in stock levels and the valuation ledger; whether COGS consumes FIFO layers is **not yet observable** (needs a sale: INV-T2).
- Purchase settlement moves the operational cash account; POS sales do not (their GL cash line has no `operationalAccountId`). Same GL account, two different behaviours.
- Valuation report rounding: total moved by 74.01 for a 74.00 receipt.
- No supplier needed for cash purchases; negative cash allowed.

## Cleanup
Permanent dev records: BILL-2026-000001, 2 movements, JV-2026-000060, +2 units each. Reversal would be a purchase return or void (separate approval). Not edited.
