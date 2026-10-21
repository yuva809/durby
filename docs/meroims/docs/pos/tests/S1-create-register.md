# Test S1 — Create POS register

| | |
|---|---|
| Approved by user | 2026-10-20 (name changed by user from `TEST-DURBY-01` to **`sample 1`**; deviates from the TEST- prefix convention at user's instruction) |
| Tenant safety | User confirmed: dev tenant, no production, no real customers, no live payment terminals / fiscal printers / SMS-email |
| Method | `tools/cdp-test-write.mjs` (single allowed write, all other writes blocked) + REA passive capture (`evidence/captures/shapes-S1-register.txt`) |
| Evidence | `evidence/tests/S1-register.spec.json`, `S1-dryrun.json`, `S1-result.json`, `S1-audit-check.json` |

## Steps
1. Dry run: located exactly one input `Register name (e.g. Till 1)` and one `Add` button in its section; no click.
2. Before-state `GET /api/pos/admin/registers` → 3 registers (Register-A/B/C, names redacted), all `isActive:true`, `branchId:null`.
3. Typed `sample 1`, clicked **Add**.
4. After-state re-read, audit log checked.

## Observed `[OBS]`
| Item | Result |
|---|---|
| Request | `POST /api/pos/admin/registers` · JSON `{ "name": "sample 1", "branchId": null }` · `Authorization` bearer header |
| Response | **201 Created** · `{ id: uuid, tenantId: uuid, name, branchId: null, isActive: true }` (no `createdAt` in response) |
| Other writes | none attempted (write guard blocked 0) |
| UI feedback | input cleared; no toast/alert rendered |
| After-state | 4 registers; new one active, branchless |
| Validation | not triggered: branch optional; no plan limit hit at 4 registers |
| Audit log | **no entry created**; newest `core/audit-logs` entry predates the test (2026-10-01, `vendor_invoice_import.rejected`). Audit entries use `action: "<entity>.<verb>"`, `entityType` |
| Stock / payment / accounting | none expected, none observed (no such calls) |

## Inferences `[INF]`
- Registers are simple tenant-scoped config rows `{id, tenantId, name, branchId?, isActive}`; uniqueness of `name` is **unknown** (not tested).
- The POS audit trail does not cover register configuration changes.

## Cleanup
Register kept (needed for S2+). POS Settings offers **Turn off** / **Remove** for it; removal will be proposed separately at the end of testing. Nothing financial to reverse.
