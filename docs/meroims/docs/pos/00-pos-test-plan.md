# Durby POS — MeroIMS Controlled Test Plan (Option B)

**Scope:** POS only. Broader ERP is deferred (`docs/deferred-erp-backlog.md`).
**Rules:** every write scenario is proposed here first and run **only after its own explicit approval**. Approving one scenario does not approve the next. Synthetic records only, named with the `TEST-DURBY-` prefix. Request/response, validation behaviour and before/after state are captured. Tokens are redacted. Posted financial records and audit history are **never deleted** for cleanup; they are reversed or voided only where the app supports it, and otherwise left and documented.

## Pre-test state (read-only evidence, 2026-10-20)
| Fact | Evidence | Tag |
|---|---|---|
| Retail POS enabled; restaurant POS disabled for this tenant | `/restaurant/*` pages show "unavailable"; `GET /api/pos/restaurant/{areas,tables,stations}` → **403** `{code,message}` | OBS |
| Restaurant model exists in code: areas, tables + QR, stations (kitchen/bar), waiter floor, KOT status, modifiers, seats | bundle routes `/restaurant/{till,tables,kitchen,bar,waiter}`; `kotStatus`, `ModifierState`; order fields `diningTableName`, `tableOrderId`, `reservationId` | OBS (code) / UNK (behaviour) |
| At least one register exists and **a shift is already open** on it (opened by an existing user) | `/till` shows X-report · Cash in/out · Close shift; `retail/context.registers[].openShift{status, openingFloat, openedById…}` | OBS |
| POS admin: registers, POS users, Bank-QR accounts, discount codes (none yet), receipt details, till logo | `/pos-settings` + `GET /api/pos/admin/*` | OBS |
| Orders model: `channel, status, paymentStatus, tenders[]{type,amount,capturedAt}, cashReceived, changeDue, receiptNumber, clientOrderId, shiftId, registerId, discountCode` | `GET /api/pos/orders`, `GET /api/pos/retail/holds` | OBS |
| Order write endpoints exist in client: `POST? /api/pos/retail/sales`, `/api/pos/shifts`, `/api/pos/retail/holds` | bundle literals; methods/bodies UNK | OBS (path) / UNK |

## Why an isolated test register first
The existing open shift belongs to another user. Selling inside it would change that person's shift totals and X/Z figures. A dedicated `TEST-DURBY-01` register lets every later test (shift open/close, sales, refunds) run in **its own shift**, keeping test figures separate and easy to identify.

## Scenario queue (each needs separate approval)
| # | Scenario | Writes | Expected side effects | Status |
|---|---|---|---|---|
| **S1** | Create register (approved name: `sample 1`) | 1 register config row | none | ✅ **Done**: 201, no side effects, no audit entry ([result](tests/S1-create-register.md)) |
| S2 | Open shift on `sample 1` (float 0, user choice) | shift row | none | ✅ **Done**: 201, no journal, no cash movement ([result](tests/S2-open-shift.md)) |
| S5* | **Hold** 1 × BEV-WAT-004 then **finalize with card** (run as S5) | held order → completed, invoice, journal | ✅ **Done**: ORD-2026-000004 / RCPT-000002 / INV-2026-000018 / JV-2026-000059; **card posts to Cash In Hand** ([result](tests/S5-hold-finalize-card.md)) |
| S3* | **Cash sale** 1 × CHOC-003, cash 50 (run as S3) | order, invoice, stock, journal | ✅ **Done**: ORD-2026-000003 / RCPT-000001 / INV-2026-000017 / JV-2026-000057, stock −1 ([result](tests/S3-cash-sale.md)) |
| S5b | Bank-QR (`gateway`) tender sale | order, tender | | not proposed (card covered in S5) |
| S6 | Discount code + VAT behaviour on a sale | discount code config + order | as S4 | not proposed yet |
| S4* | **Full refund** of ORD-2026-000003, restock (run as S4) | sales return, journal, stock +1 | ✅ **Done**: SRT-2026-000001, JV-2026-000058, stock +1; **X-report expectedCash not reduced** ([result](tests/S4-refund.md)) |
| S6* | **Cash in/out**: paid in 100, paid out 10, drop 50 (run as S6) | 3 shift cash movements | ✅ **Done**: expectedCash 22.60→122.60→112.60→62.60; **no journals, paid-out not expensed** ([result](tests/S6-cash-movements.md)) |
| S7* | **Close shift**, counted 40.00 (run as S7) | shift closed + Z-report snapshot | ✅ **Done**: expected 62.60, counted 40.00, **variance −22.60 = refund**, no journal ([result](tests/S7-close-shift.md)) |
| S10 | (Optional, settings change) Enable restaurant mode to study tables/KOT, then disable | tenant setting | UI/feature change for everyone in the tenant | decision for later |

## S1 — Create isolated test register
- **UI path:** `/pos-settings` → *Registers* → field "Register name (e.g. Till 1)*" = `TEST-DURBY-01` → **Add**.
- **Performed by:** REA `capture_browser_scenario` (connect mode, declared actions: fill + click Add) with request/response bodies captured. Synthetic data only, tokens redacted. The network write-guard is lifted **only for this one request** (`POST /api/pos/admin/registers`, path to be confirmed).
- **Captures:** before-state `GET /api/pos/admin/registers` + `GET /api/pos/retail/context`; the write request/response (status, body, validation errors if any); after-state the same GETs; audit-log check (`GET /api/core/audit-logs`) for a register-created entry.
- **Expected effects `[INF]`:** a new register `{name:"TEST-DURBY-01", isActive:true, branchId:null}`; it appears in the till's register list with `openShift:null`. **No** stock, payment or journal effects.
- **Possible outcomes worth recording:** plan/entitlement limit on register count (validation error), or a required branch.
- **Risks:** other tenant users may see an extra register in the till's register picker; the till UI may auto-switch to the new register for this browser. **Not financial.**
- **Cleanup:** POS Settings offers **Turn off** and **Remove** for registers. Since a register is configuration (not a financial record) and no shift will have been opened on it in S1, *Remove* is acceptable. Alternatively keep it (turned off) for S2+. **Removal will be asked separately.**
- **Stop conditions:** if the POST touches anything other than the register resource, or the response shows payment/fiscal side effects, stop and report.

## Retail-till API contract (from client code, `evidence/pos-retail-api-client.txt`) `[OBS, bundle]`
| Action | Request |
|---|---|
| Context | `GET /api/pos/retail/context` |
| Products / lookup | `GET /api/pos/products?registerId=` · `GET /api/pos/retail/products/lookup?code=&registerId=` |
| **Open shift** | `POST /api/pos/shifts {registerId, openingFloat}` (UI: register picker + float presets 0/500/1000/2000/5000; "Join open shift" if one exists) |
| Close shift | `POST /api/pos/shifts/{id}/close {countedCash}` |
| X-report | `GET /api/pos/retail/shifts/{id}/x-report` (grossSales, capturedTotal, tenderTotals, openingFloat, paidIn, paidOut, expectedCash, countedCash…) |
| Cash in/out | `POST /api/pos/retail/shifts/{id}/cash-movements {type, amount, reason}` |
| **Sale** | `POST /api/pos/retail/sales {clientOrderId: uuid, registerId, customer?{partyId?,name,phone,vatNumber}, lines[{productId, quantity, unitPrice?, discountAmount?}], tenders, cashierName, note}` (price/discount sent only if edited → server-side pricing) |
| Hold / finalize | `POST /api/pos/retail/holds {clientOrderId, registerId, customer?, lines, cashierName, note}` · `POST /api/pos/retail/holds/{id}/finalize {registerId, tenders, cashierName}` |
| Receipt | `GET /api/pos/retail/orders/{id}/receipt` |
| Customer search | `GET /api/core/sales/party-search?search=&limit=20` |
| Tender types seen | `cash`, `card`, `credit` |
| Register selection | per browser: `localStorage["ims.till.register"]` (defaults to first register) |
| Live stock | SSE `core.stock.level_changed {productId, warehouseId, available, tenantAvailable}` |
| Gate errors | `pos.retail_disabled`, `pos.restaurant_disabled`, `pos.store_not_provisioned` |

## S2 — Open a shift on register `sample 1` (PROPOSED, awaiting approval)
- **Pre-step (client-side preference, no server write):** set this browser's `localStorage["ims.till.register"]` to the `sample 1` register id. This is what selecting it in the picker does. Reload `/till` → the picker shows `sample 1` as *closed*. The previous value is saved and **restored after testing**.
- **Write:** Opening float `100` → **Open shift** → expected `POST /api/pos/shifts {registerId: <sample 1>, openingFloat: "100"}`. Only this one write is let through.
- **Captured:** request/response (status, body, validation), till UI after opening, X-report for the new shift (read), and before/after of: registers in `retail/context` (bank-account fields stripped), newest journals (header fields only), and the default cash money-account transactions (whether the float creates a cash/accounting entry).
- **Expected `[INF]`:** a shift `{id, registerId, status:"open", openingFloat:"100", openedAt, openedById}`; `sample 1` shows "shift open". The float **may or may not** create a cash movement or journal; this test settles it.
- **Not affected:** Register A's existing open shift (different register).
- **Risks:** the shift stays **open** until closed (planned S9). Shifts are operational records that likely can't be deleted; cleanup is closing it later with counted cash = expected cash. Dashboards may count one more open shift meanwhile.
- **Stop conditions:** any write other than the shift POST, or a response showing a fiscal/payment side effect.

## Tender model (client code) `[OBS, bundle]`
Tender dialog modes: `cash` (amount received, change computed; default = total) · `card` (amount = total) · `qr` → **`{type:"gateway"}`** (needs a bank-QR account) · `credit` (needs attached party) · `split` (cash+card rows; change allowed only from cash). Modes shown/hidden by per-tenant UI toggles (`tab.card`, `tab.qr`, `tab.credit`, `tab.split`). Payload: `tenders: [{ type, amount: "0.00" }]`.

## S3 — First cash sale (PROPOSED, awaiting approval)
- **Where:** `/till` on register `sample 1`, inside the shift opened in S2 (Register A/B shifts untouched).
- **Cart:** 1 × **CHOC-003** (catalog price Rs. 20.00, `taxOption: vat_13`, 403 in stock), walk-in customer (no party). If the till offers an order note, note = `TEST-DURBY-S3`.
- **Tender:** cash, amount received **Rs. 50.00** → change due Rs. 30.00 if the price is VAT-inclusive (Rs. 27.40 if VAT is added on top). This settles VAT-inclusive vs exclusive pricing.
- **UI steps (runner, multi-step):** type `CHOC-003` in "Scan barcode, or type a name / SKU…" + Enter → **Tender** → cash amount `50` → final confirm button (exact label confirmed in a dry run that stops before the final click). Only one write is allowed through: `POST /api/pos/retail/sales`.
- **Expected request `[INF from client code]`:** `{ clientOrderId: uuid, registerId, lines: [{ productId, quantity: "1" }], tenders: [{ type: "cash", amount: "50.00" }], cashierName, note? }`.
- **Expected effects (to verify, not assumed):**
  - POS order: `status` completed, `paymentStatus` paid, `orderNumber`, `receiptNumber`, `cashReceived`, `changeDue`, `shiftId`.
  - **Stock:** CHOC-003 −1 (stock movement with a POS source; SSE `core.stock.level_changed`).
  - **Sales document:** an invoice with `posOrderId` (POS-originated invoices exist in the tenant).
  - **Accounting:** new system journal(s) (sales revenue, output VAT, cash; COGS/inventory) via posting rules.
  - **Shift:** X-report `ordersCompleted 1`, `grossSales`, `tenderTotals.cash`, `expectedCash`.
  - Receipt: `GET /api/pos/retail/orders/{id}/receipt`.
- **Captured:** request/response + validation; before/after of stock level for CHOC-003, newest journals (headers + lines of the new one), newest sales documents (number/type/posOrderId/total), money-account balances, X-report, receipt shape.
- **Risks (this is the first irreversible financial record):** creates a real (dev) POS order, a sales invoice, stock movement and journals; consumes the next order/receipt/invoice number; tenant reports include Rs. 20 of sales. **These records should not be deleted.** The only proper reversal is a refund/void (planned S7, separately approved), which adds reversing records and leaves the originals.
- **Stop conditions:** any write other than the sale POST; a response indicating real payment capture, fiscal device, SMS/email; validation errors are recorded, not retried blindly.

## POS order management (lazy-loaded `/orders` chunks, `evidence/bundle/js-lazy/`) `[OBS, bundle]`
| Action | Request |
|---|---|
| List / detail | `GET /api/pos/orders?…` · `GET /api/pos/orders/{id}` (detail has `events[]{event, toStatus, note, createdAt}`) |
| Status change | `POST /api/pos/orders/{id}/transition {toStatus, note?}` (also "↩ Undo to <previous>") |
| Resume held | `POST /api/pos/orders/{id}/resume` (held → pending) |
| **Refund** | `POST /api/pos/orders/{id}/refund { lines:[{productId, quantity}], restock: boolean, reason? }`. UI: per-line quantity (default = ordered, partial allowed), checkbox "Return items to stock" (default on), "Reason" |
| Driver | `POST /api/pos/orders/{id}/assign-driver {driverId}` |
| Reprint | `/print/receipt/{id}` (80 mm) for completed retail orders |

Transition map: `pending→confirmed|rejected|cancelled` · `confirmed→preparing|cancelled` · `preparing→ready|cancelled` · `ready→assigned_to_driver|completed|cancelled` · `assigned_to_driver→ready|cancelled` · `out_for_delivery→delivered|cancelled` · `delivered→completed|refunded` · **`completed→refunded`** · `held→pending|cancelled`.

## S4 — Full refund of the S3 sale (PROPOSED, awaiting approval)
- **Target:** ORD-2026-000003 (1 × CHOC-003, 22.60, cash), register `sample 1`, shift from S2 still open.
- **UI path:** `/orders` → open the row containing `ORD-2026-000003` → **assert** the panel shows `ORD-2026-000003` and status completed → **Refund…** → quantity `1` (default) · **Return items to stock: checked** · Reason `TEST-DURBY-S4 refund of S3` → submit (label confirmed in dry run).
- **Guarded request:** only `POST /api/pos/orders/<ORD-2026-000003 id>/refund` with `lines = [{productId: CHOC-003, quantity 1}]`, `restock: true`, reason containing `TEST-DURBY`; anything else is blocked.
- **Expected effects (to verify):** order `status → refunded` + history event; X-report `ordersRefunded 1`, `expectedCash` back to 0.00 (cash leaves the drawer) [INF]; stock CHOC-003 402 → **403** (restock); a reversal document (sales return / credit note, or invoice void) [UNK which]; a reversing journal (Dr revenue 20.00 + VAT 2.60 / Cr cash 22.60, and Dr inventory / Cr COGS 15.00 if restocked) [INF]; refund receipt [UNK].
- **Risks:** irreversible: `refunded` is terminal in the transition map; adds refund/return documents and journals; the original S3 records stay. Reports show a sale and its refund.
- **Stop conditions:** wrong order in the panel, refund body not matching, or any additional write.
