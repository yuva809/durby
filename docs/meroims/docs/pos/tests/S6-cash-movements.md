# Test S6 — Cash in / out (paid in, paid out, drop)

| | |
|---|---|
| Approved by user | 2026-10-20, all three movements |
| Shift | S2 shift on register `sample 1` (`264e8f96…`) |
| Method | `tools/cdp-test-seq.mjs`: three **one-time** guarded rules on `POST /api/pos/retail/shifts/<shift>/cash-movements`, each requiring its exact type/amount/reason |
| Evidence | `evidence/tests/S6-dryrun*.json`, `S6-cash-movements.spec.json`, `S6-result.json`, `evidence/captures/shapes-S6-cash-movements.txt` |

## UI `[OBS]`
Till → **Cash in/out** → modal "Cash in / out": *Movement* select (**Paid in** "add cash to drawer" · **Paid out** "expense from drawer" (default) · **Drop** "move cash to safe"), *Amount*, *Reason* (placeholder "e.g. courier charge"), **Record** (disabled until amount > 0).

## Requests / responses `[OBS]`
`POST /api/pos/retail/shifts/{shiftId}/cash-movements` `{ "type": "paid_in|paid_out|drop", "amount": "100.00", "reason": "…" }`
→ **201** `{ id, tenantId, shiftId, registerId, movementType, amount, reason, createdById, createdAt }`

| Movement | X-report afterwards |
|---|---|
| paid_in 100.00 | paidIn 100.00 · expectedCash **122.60** |
| paid_out 10.00 | paidOut 10.00 · expectedCash **112.60** |
| drop 50.00 | drops 50.00 · expectedCash **62.60** |

## Findings `[OBS]`
- **Formula confirmed:** `expectedCash = openingFloat + Σcash tenders + paidIn − paidOut − drops`. Refunds are **not** subtracted (see S4).
- **No accounting effect:** no journal for any movement (newest journal still JV-2026-000059); cash/bank money accounts unchanged. A "paid out (expense)" is never expensed in the GL, and a drop to safe is not a GL transfer. The GL Cash In Hand drifts from the physical drawer.
- Movements are immutable shift sub-records with actor and timestamp; no edit/delete endpoint in the client.

## Physically correct drawer now
0.00 float + 22.60 cash sale − 22.60 cash refund + 100.00 − 10.00 − 50.00 = **40.00**, vs system `expectedCash` **62.60** (difference = the S4 refund).

## Cleanup
None possible or needed; shift records stay. The shift is still open for the close-shift test.
