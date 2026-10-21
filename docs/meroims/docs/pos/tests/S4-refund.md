# Test S4 — Full refund of the S3 sale

| | |
|---|---|
| Approved by user | 2026-10-20, as proposed (restock ON) |
| Target | ORD-2026-000003 (RCPT-000001, INV-2026-000017), 1 × CHOC-003, 22.60 cash, register `sample 1` |
| Method | `tools/cdp-test-seq.mjs` (guard: only `POST /api/pos/orders/<id>/refund` with body `[{CHOC-003, 1}]`, `restock:true`, TEST-DURBY reason) + REA passive (`shapes-S4-refund.txt`) |
| Evidence | `evidence/tests/S4-dryrun.spec.json`, `S4-dryrun.json`, `S4-refund.spec.json`, `S4-result.json` |

## UI flow `[OBS]`
`/orders` table → row **Manage** → dialog "ORD-… · Walk-in" with **Reprint receipt (80mm)** and **Refund…** → refund form: per-line quantity (default ordered qty `1.0000`), checkbox **Return items to stock** (default checked), **Reason** → buttons **Back** / **Refund order**. After refund the dialog shows no actions (terminal state).

## Request / response `[OBS]`
`POST /api/pos/orders/{orderId}/refund` `{ "lines": [{ "productId": "<CHOC-003>", "quantity": "1.0000" }], "restock": true, "reason": "TEST-DURBY-S4 refund of S3" }`
**201** → the full order object with `status: "refunded"`, `paymentStatus: "refunded"`; no separate refund entity returned; original `tenders` unchanged.

## Side effects `[OBS]`
| Effect | Result |
|---|---|
| Order history | `created →pending`, `completed pending→completed`, **`refunded completed→refunded` (note = reason)**, actorType `owner` |
| Stock | CHOC-003 402 → **403** (restock) |
| Reversal document | **SRT-2026-000001** `sales_return`, `settled`, `posOrderId` = order, **`sourceDocumentId` → INV-2026-000017**, subTotal 20.00, tax 2.60, total 22.60, line `unitCost 15.0000`, `payments: []` |
| Original invoice | **unchanged**: INV-2026-000017 still `settled`, not voided |
| Journal | **JV-2026-000058** `core.sales_return.recorded`, posted, `reversalOfId: null`: Dr **SR0001 Sales Returns** 20.00 · Dr CL0001 VAT 2.60 · Cr BC0001 Cash In Hand 22.60 · Dr INV0001 Inventory 15.00 · Cr COGS0001 15.00 |
| **Shift X-report** | `ordersCompleted 0`, `ordersRefunded 1`, but **`grossSales 22.60`, `tenderTotals.cash 22.60`, `expectedCash 22.60` unchanged** |
| Other writes | none |

## Findings
- **Refund ≠ void.** A refund creates a linked *sales return* document plus its own journal; the original invoice and journal stay intact (append-only financial history).
- **Contra-revenue:** refunds post to a separate *Sales Returns* account (role `sales_return`), not a debit to Sales.
- **Drawer inconsistency `[OBS]`:** the GL credits Cash In Hand for the refund, but the shift's `expectedCash` is not reduced. Closing this shift with the physically correct count (0.00) should show a 22.60 shortage. To be confirmed in a close-shift test.
- Refund method is not chosen in the UI or request; it is implicitly against the original tender (cash here) `[INF]`.
- Partial refunds are supported by quantity (UI), not tested.

## Unknown `[UNK]`
- Partial refund behaviour, refund of mixed tenders, refund without restock posting (inventory/COGS lines absent?).
- Whether a refund receipt exists (no receipt call observed after refund).

## Cleanup
Nothing to clean: refund is the reversal of S3. `refunded` is terminal. Records added: SRT-2026-000001, JV-2026-000058, order event.
