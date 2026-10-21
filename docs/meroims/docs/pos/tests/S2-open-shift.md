# Test S2 — Open shift on register `sample 1`

| | |
|---|---|
| Approved by user | 2026-10-20, **opening float 0** (user choice; float accounting therefore untested) |
| Method | `tools/cdp-test-write.mjs` (one allowed write `POST /api/pos/shifts`) + REA passive capture (`evidence/captures/shapes-S2-open-shift.txt`) |
| Evidence | `evidence/tests/S2-open-shift.spec.json`, `S2-dryrun.json`, `S2-result.json` |
| Client preference changed | `localStorage["ims.till.register"]`: previously **unset** (till defaulted to first register) → `sample 1` id. **To restore at end of testing: remove the key.** |

## Observed `[OBS]`
| Item | Result |
|---|---|
| Picker UI ("Open the till") | one button per register showing "shift open — join it" / "closed"; Opening float input (default `0`); presets 0/500/1000/2000/5000; **Open shift** button |
| Pre-state | Register-A open (float 0.00), Register-B open (float 500.00), Register-C closed, sample 1 closed |
| Request | `POST /api/pos/shifts` `{ "registerId": "<uuid>", "openingFloat": "0" }` |
| Response | **201** `{ id, tenantId, registerId, openedById, status: "open", openingFloat: "0.00", openedAt, closedAt: null, closedById: null, countedCash: null, closeSummary: null }` (money normalised to 2 dp) |
| Other writes | none (guard blocked 0) |
| Till after | selling mode: X-report · Cash in/out · Close shift · Walk-in customer · Browse · Tender; "Live" indicator (SSE) |
| X-report (`GET /api/pos/retail/shifts/{id}/x-report`) | `{ shiftId, registerId, status, openedAt, ordersTotal, ordersCompleted, ordersRefunded, grossSales, capturedTotal, tenderTotals{}, openingFloat, paidIn, paidOut, drops, expectedCash }` — title "X-report (mid-shift)" |
| Journals | unchanged (newest JV-2026-000056, 2026-09-21, `sourceEventType: core.stock.adjusted`) |
| Cash / bank money accounts | unchanged |

## Inferences `[INF]`
- Several registers can hold open shifts at once; a shift belongs to one register; a browser "joins" a register's open shift (shift is register-scoped, not user-scoped).
- `expectedCash = openingFloat + cash tenders + paidIn − paidOut − drops` (to verify in S4/S8 — formula not yet observed with non-zero values).
- Journal `sourceEventType` follows `<module>.<entity>.<verb>` (e.g. `core.stock.adjusted`).

## Unknown `[UNK]`
- Whether a non-zero opening float creates a cash movement or journal.
- Whether one user may open shifts on several registers; concurrency rules.

## Cleanup
Shift left **open** for the sale tests. To be closed in a later close-shift test (separately approved) with counted cash = expected cash. Not deletable/should not be deleted.
