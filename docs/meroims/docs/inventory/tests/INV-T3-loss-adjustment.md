# Test INV-T3 — Loss (waste) adjustment

| | |
|---|---|
| Approved by user | 2026-10-20 |
| Scenario | Product page CHOC-003 (weighted average, 405 @ 15.0099) → **Adjust Stock → Reduce Stock**: Quantity 1, Reason **loss**, Remarks `TEST-DURBY-INV-T3 waste` |
| Method | 3 dry runs (found the correct dialog; see below), then one guarded `POST /api/core/stock/adjustments` (exact body); REA shapes `evidence/captures/shapes-INV-T3-loss.txt` |
| Evidence | `evidence/tests/INV-T3-dryrun*.json`, `INV-T3-loss.spec.json`, `INV-T3-result.json` |

## UI `[OBS]`
- `/inventory/adjustment` row action **"Adjust this item"** (icon button) uses a dialog that sends **no `adjustmentType`** (code).
- Product page **Adjust Stock** → menu **Add Stock / Reduce Stock** (+ **Archive Item**, not touched).
  - *Reduce Stock* dialog: Quantity · **Reason** select `loss` (default) / `correction` · Remarks.
  - *Add Stock* dialog: Quantity · **Unit Cost (Rs.)** · Reason `correction` / `opening` / **`found`** · Remarks.
- Five client entry points send adjustments (quick-create `opening`, adjustment page (no type), product page (selectable), **expiry write-off `loss` with batch**, item form `correction`).

## Request / response `[OBS]`
`POST /api/core/stock/adjustments` `{ "productId": "<CHOC-003>", "direction": "reduce", "quantity": "1", "reason": "TEST-DURBY-INV-T3 waste", "adjustmentType": "loss", "warehouseId": "<default>" }` → **201** `{ "adjustmentId": "<uuid>" }`

## Effects `[OBS]`
| Effect | Result |
|---|---|
| Stock | 405 → **404**; avgCost unchanged 15.0099 (reduction at current average) |
| Movement | `adjustment / adjustment` −1 @ **15.0099**, reason kept. **`loss` is not reflected in movementType** |
| Valuation ledger | out 1 @ 15.01 → 404 @ 15.01 = **6063.99** |
| Journal | **JV-2026-000062** `core.stock.adjusted` posted, no source document: **Dr ADJ0001 Stock Adjustment Loss 15.01** (qty 1, unitCost 15.0099) / **Cr INV0001 Inventory Asset 15.01** |

## Findings
- Waste/loss is expensed to a dedicated **Stock Adjustment Loss** account at moving-average cost. Contrast: stock *increases* via item form post against **Opening Balance Equity** (existing JV-52/56).
- The adjustment type drives the journal accounts but is not kept on the movement type; reporting by waste reason would need the journal or the free-text reason.
- Response is minimal (`adjustmentId` only).

## Cleanup
Permanent dev records: adjustment, movement −1, JV-2026-000062.
