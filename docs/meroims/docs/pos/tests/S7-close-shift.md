# Test S7 — Close shift (Z-report)

| | |
|---|---|
| Approved by user | 2026-10-20, counted cash **40.00** (physically correct drawer) |
| Shift | S2 shift on `sample 1` (`264e8f96…`) after S3–S6 |
| Method | `tools/cdp-test-seq.mjs`: one guarded write `POST /api/pos/shifts/<shift>/close` with body exactly `{countedCash:"40.00"}` |
| Evidence | `evidence/tests/S7-dryrun*.json`, `S7-close-shift.spec.json`, `S7-result.json`, `evidence/captures/shapes-S7-close-shift.txt` |

## UI `[OBS]`
Till → **Close shift** → modal "Close shift (Z-report)": "Opening float was रु 0.00. Count the whole drawer and enter the total." → **Counted cash** → **Close shift**. **Blind count**: expected cash is not shown before closing. Result modal "**Z-report — shift closed**" with **Print (80mm)** / Done. Afterwards the till shows "Open the till" (register picker); `sample 1` is *closed*.

## Request / response `[OBS]`
`POST /api/pos/shifts/{shiftId}/close` `{ "countedCash": "40.00" }` → **201**
```json
{ "id": "…", "registerId": "…", "openedById": "…", "status": "closed", "openingFloat": "0.00",
  "openedAt": "…", "closedAt": "…", "closedById": "…", "countedCash": "40.00",
  "closeSummary": { "ordersTotal": 2, "ordersCompleted": 1, "ordersRefunded": 1,
    "grossSales": "52.60", "capturedTotal": "52.60", "tenderTotals": { "cash": "22.60", "card": "30.00" },
    "openingFloat": "0.00", "paidIn": "100.00", "paidOut": "10.00", "drops": "50.00",
    "expectedCash": "62.60", "countedCash": "40.00", "cashVariance": "-22.60", "balanced": false } }
```

## Findings `[OBS]`
- The Z-report is a **frozen `closeSummary` snapshot** stored on the shift (same fields as the X-report + `countedCash`, `cashVariance`, `balanced`).
- **Variance −22.60 = exactly the S4 cash refund**, confirming refunds are not part of `expectedCash`.
- **No journal** for the variance (no over/short posting); cash/bank money accounts unchanged. Variance lives only on the shift.
- No reopen endpoint in the client; closing is terminal for the shift.

## End-to-end cash reconciliation for the test shift
| | Physical drawer | System (`expectedCash`) | GL Cash In Hand movements from this shift |
|---|---|---|---|
| Float | 0.00 | 0.00 | — |
| Cash sale S3 | +22.60 | +22.60 | Dr 22.60 |
| Card sale S5 | 0 | 0 | **Dr 30.00 (card booked as cash)** |
| Refund S4 | −22.60 | **not deducted** | Cr 22.60 |
| Paid in / out / drop S6 | +100 −10 −50 | +100 −10 −50 | **none** |
| **Total** | **40.00** | **62.60** | **net +30.00** |
Three different "cash" figures for one shift: a key design lesson for Durby (single source of truth for drawer cash, all cash movements journaled, card to a clearing account).
