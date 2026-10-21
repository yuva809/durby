# 06 — POS Test Results, Side Effects & Remaining Unknowns

All tests: MeroIMS dev tenant (user-confirmed safe), Admin login, **one approval per scenario**, guarded so only the approved request(s) could reach the API (body checked before release), evidence redacted. Detailed records in `docs/pos/tests/`.

## 1. Scenario summary
| # | Scenario | Write(s) | Result | Key observation |
|---|---|---|---|---|
| S1 | Create register "sample 1" | `POST /api/pos/admin/registers` | 201 | register = simple config row; **no audit-log entry** |
| S2 | Open shift (float 0) | `POST /api/pos/shifts` | 201 | multiple registers open at once; no journal |
| S3 | Cash sale 1 × CHOC-003, cash 50 | `POST /api/pos/retail/sales` | 201 | VAT-exclusive pricing (22.60); invoice + stock −1 + journal (~1.8 s async) |
| S4 | Full refund, restock | `POST /api/pos/orders/{id}/refund` | 201 | sales return + own journal; **drawer expectedCash not reduced** |
| S5 | Hold → finalize with card | `POST …/holds`, `POST …/holds/{id}/finalize` | 201, 201 | order no. at hold, receipt/shift at finalize; **card booked to Cash In Hand** |
| S6 | Paid in 100 / paid out 10 / drop 50 | 3 × `POST …/cash-movements` | 201 ×3 | expectedCash formula confirmed; **no journals** |
| S7 | Close shift, counted 40 | `POST /api/pos/shifts/{id}/close` | 201 | Z snapshot: expected 62.60, variance −22.60 (= refund); **no journal** |

Guard statistics: 10 writes released, **0 unapproved writes attempted**, 2 runs aborted safely before writing (UI not ready / wrong selector) and re-run under the same approval.

## 2. Side-effect matrix
| | Order | Receipt no. | Document | Stock | Journal | Shift figures | Money account |
|---|---|---|---|---|---|---|---|
| Open shift | | | | | ✗ | opened | ✗ |
| Cash sale | ✓ completed | ✓ | invoice (settled) | −1 | ✓ | cash +22.60 | ✗ |
| Refund (restock) | ✓ refunded | ✗ | sales return | +1 | ✓ | refunded count only | ✗ |
| Hold | ✓ held | ✗ | ✗ | ✗ (not re-read; UNK) | ✗ | ✗ | ✗ |
| Finalize (card) | ✓ completed | ✓ | invoice | −1 | ✓ (to Cash In Hand) | card +30 | ✗ |
| Cash movements | | | | | ✗ | paidIn/paidOut/drops | ✗ |
| Close shift | | | | | ✗ | closed + variance | ✗ |

## 3. Records left in the dev tenant
| Record | Status | Cleanup |
|---|---|---|
| Register "sample 1" | active, no open shift | optional: *Turn off* or *Remove* (separate approval) |
| Shift 264e8f96… | closed (variance −22.60) | none (permanent) |
| ORD-2026-000003 / RCPT-000001 / INV-2026-000017 / SRT-2026-000001 / JV-57, JV-58 | refunded / settled | none: reversal already recorded |
| ORD-2026-000004 / RCPT-000002 / INV-2026-000018 / JV-59 | completed | none (permanent test sale, Rs. 30) |
| Cash movements ×3 (TEST-DURBY-S6 …) | on closed shift | none |
| Stock | CHOC-003 net 0; BEV-WAT-004 −1 | optional stock adjustment (separate approval) |
| Browser preference `ims.till.register` | **restored** (removed) | done |

## 4. Remaining unknowns (prioritised for Durby design)
| Priority | Unknown | Why it matters | How it could be resolved |
|---|---|---|---|
| High | Restaurant mode: table orders, KOT routing, course firing, modifiers, split bill, waiter app, QR table ordering | core of Durby | enable restaurant channel in dev tenant (settings change; separate approval) and test |
| High | POS-staff auth (PIN?) and roles/permissions for voids, refunds, price overrides | security model | create a test POS user (approval) |
| High | Discount codes, VAT rounding on multi-line + discount, split tender, partial refund, refund w/o restock | pricing/tax correctness | additional scenarios |
| Medium | Idempotency on repeated `clientOrderId`; concurrent finalize of the same hold from two tills | offline/retry safety | controlled duplicate-request test (approval) |
| Medium | Stock reservation while held; negative stock policy ("out" items sellable?) | inventory accuracy | test with low-stock item |
| Medium | Order void/cancel (`transition → cancelled`) accounting | cancellations | test on a held order |
| Low | Non-zero opening float accounting; register Turn off/Remove with history | edge cases | small tests |
| Low | Server framework, DB, queue, hosting | informative only | not observable from browser |

## 5. Evidence index
- Test specs/results: `evidence/tests/S*-*.spec.json`, `S*-result.json`, `S*-dryrun*.json`
- Value-free shapes per test: `evidence/captures/shapes-S*.txt`
- Client code excerpts: `evidence/pos-retail-api-client.txt`, `evidence/bundle/js-lazy/` (order management)
- Runner: `tools/cdp-test-seq.mjs` (guarded, redacting); read-only crawler `tools/cdp-drive.mjs`
