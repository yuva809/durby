# MeroIMS → Durby — Master Index

**Current scope (2026-10-20): Durby POS only.** POS blueprint package: [`pos/README.md`](pos/README.md). Broader ERP deferred: [`deferred-erp-backlog.md`](deferred-erp-backlog.md).

**Project:** Reverse-engineer MeroIMS (`app-dev.meroims.com`, user-owned dev env, Admin login) to a professional architecture blueprint, then design a comparable system for **Durby** (Next.js + NestJS + Prisma + PostgreSQL).
**Rules:** Read-only. No create/update/delete/post without explicit approval. No real customer-record harvesting (value-free body shapes only). Secrets redacted. Evidence tagged `[OBS] / [INF] / [UNK]`.
**Location:** `~/Downloads/durby-erp/` — `docs/` (reports), `evidence/` (bundle, captures, tool-results).

## Investigation phases
| Phase | Description | Status |
|---|---|---|
| 1 | Static analysis (stack, routes, endpoints, bundle) | ✅ Done |
| 2 | Runtime capture (methods, req/resp shapes, auth, SSE) | ✅ Read-only sweep complete (74 routes) · write flows pending authorization |
| 3 | Feature catalog (module-by-module spec) | ◻ Pending |
| 4 | Frontend architecture | ◻ Pending |
| 5 | Backend architecture | ◻ Pending |
| 6 | Data model / ER (proposed) | ◻ Pending |
| 7 | Business logic end-to-end | ◻ Pending |
| 8 | Security & multi-tenancy | ◻ Pending |
| 9 | Infrastructure & deployment | ◻ Pending |
| 10 | Final documentation package | ◻ Pending |
| 11 | Durby architecture + roadmap | ◻ Pending (not started until investigation complete) |

## Document set (target: docs/)
| # | File | Status |
|---|---|---|
| — | 00-master-index.md (this) | ✅ |
| — | 01-technical-report.md (Phase 1) | ✅ |
| — | feature-checklist.md (evidence-generated, 74 routes) | ✅ |
| — | routes/b1…b5-*.md (per-route dossiers) | ✅ |
| 00 | 00-executive-summary.md | ◻ |
| 01 | 01-complete-module-inventory.md | ◻ |
| 02 | 02-navigation-and-route-map.md | ✅ (v1) |
| 03 | 03-feature-specifications.md | ◻ |
| 04 | 04-workflow-and-business-rules.md | ◻ |
| 05 | 05-frontend-architecture.md | ◻ |
| 06 | 06-backend-architecture.md | ◻ |
| 07 | 07-complete-api-catalog.md | ◐ v0.3 (read endpoints; batch 4–5 endpoints to merge) |
| 08 | 08-data-model-and-er-diagram.md | ◻ |
| 09 | 09-accounting-and-inventory-logic.md | ◻ |
| 10 | 10-authentication-and-multi-tenancy.md | ◻ |
| 11 | 11-integrations-and-realtime-events.md | ◻ |
| 12 | 12-infrastructure-and-deployment.md | ◻ |
| 13 | 13-security-and-operational-considerations.md | ◻ |
| 14 | 14-unknowns-and-evidence-gaps.md | ◻ |
| 15 | 15-proposed-durby-architecture.md | ◻ |
| 16 | 16-step-by-step-development-roadmap.md | ◻ |
| 17 | 17-testing-and-acceptance-criteria.md | ◻ |
| 18 | 18-glossary-of-technical-and-business-terms.md | ◻ |

## Evidence register (REA)
| Evidence ID | Operation | What |
|---|---|---|
| ev_337b865a… | list_browser_targets | Authenticated target discovery |
| ev_…1792503996435 (file) | inspect_web_page | Dashboard DOM + a11y tree (module map) |
| ev_b57b1d368b… | analyze_javascript_application | Bundle static graph (45/46 parsed, 109 findings) |

Bundle: `evidence/bundle/js/*.js` (46 chunks). Endpoint list: `evidence/api-endpoints.txt` (90).

## Route dossiers (UI inventory + API calls + shapes per route)
| Batch | Scope | Routes |
|---|---|---|
| [b1-commerce](routes/b1-commerce.md) | sales, purchases, payments, expenses (lists, details, create forms) | 15 |
| [b2-inventory](routes/b2-inventory.md) | products, variants, categories, units, adjustment, OC/DC, BOM, production, expiry, transfers | 13 |
| [b3-operations-pos](routes/b3-operations-pos.md) | parties, branches, warehouses, stock requests, picking, delivery, POS orders, Retail Till, POS settings, PMS | 11 |
| [b4-finance](routes/b4-finance.md) | money accounts, chart of accounts, workbench (6 tabs), accounting reports, cheques, quick receipt/payment, bank reconciliation, opening balance | 10 |
| [b5-reports-admin](routes/b5-reports-admin.md) | dashboard, 15 reports, management, audit log, staff, settings, import, business tools, storefront | 25 |

## How the evidence was collected
- **Driver** `tools/cdp-drive.mjs`: walks routes in the logged-in tab using the app's own client router (`window.next.router.push`), opens the first row of each list, clicks view tabs only. **Every non-GET request to `api-dev` is blocked at the CDP Fetch layer** (except `POST /api/auth/refresh`); blocked total = 0. Tenant/user/party names and amounts are redacted in its output.
- **REA** `inspect_web_page` (passive, `include_json_body_shapes`): armed during each driver run; records **value-free** JSON shapes. Raw captures have tokens scrubbed (`tools/process-shapes.sh`).
- **Post-processing** `tools/post-batch.sh` → dossiers; `tools/build-checklist.py` → checklist.

## Workflow coverage (your 17 workflows)
| # | Workflow | Read side | Write side | Notes |
|---|---|---|---|---|
| 1 | Auth, session, logout | ◐ refresh observed (`POST /api/auth/refresh` shape: `{refreshToken}` → `{accessToken, refreshToken, actorType, tenantId}`); storage keys `ims.session` etc. | ◻ login/logout not exercised | needs you: logout + log back in during a capture |
| 2 | Dashboard, tenant/branch selection | ✅ dashboard, `/me` tenants[] + flags, `branches/mine` | ◻ tenant switch not exercised | needs you: Switch Profile changes session state |
| 3 | Parties | ✅ list/directory, detail, balances, import capabilities | ◻ | |
| 4 | Products, categories, variants, units, pricing | ✅ | ◻ | |
| 5 | Sales invoices & quotations | ✅ list, detail+lines, create form, journal-by-source | ◻ | quotations empty in tenant |
| 6 | Sales returns / credit | ✅ list, create form | ◻ | |
| 7 | Purchase bills & returns | ✅ forms; lists empty | ◻ | no bills in tenant → no detail |
| 8 | Payments & allocations | ✅ payment detail + `/allocations`, allocation-preview (bundle) | ◻ | |
| 9 | Inventory, warehouses, transfers, adjustments, stock requests | ✅ incl. 11-state stock-request lifecycle, OC/DC | ◻ | |
| 10 | BOM / production | ⛔ **not implemented** ("Coming soon") | — | corrects Phase 1 |
| 11 | POS shifts, lookup, holds, checkout | ◐ till context, holds, products, orders, POS admin (registers/users/discounts/bank accounts) | ◻ shift open/close, sale | needs authorization for synthetic sale |
| 12 | Chart of accounts, journals, periods | ✅ incl. journal lines + audits, mappings (20 roles), period-locks | ◻ | fiscal years / locks empty |
| 13 | Financial reports | ✅ BS, P&L, TB, GL master/summary/detail, day book, cash flow, aging, ledgers, business reports | — | trial balance returned [] |
| 14 | Vendor invoice import / integrations | ◐ import capabilities, AI-assisted party import page, legacy import | ◻ | |
| 15 | SSE / notifications | ◐ stream endpoint + 25 event names from bundle; notifications shape | — | event payloads not captured (websocket/SSE frames) |
| 16 | Users, roles, permissions, branches, tenants | ◐ staff (none), staff-roles, POS users, branches (none), entitlements | ◻ | no staff → permission matrix shape unknown |
| 17 | Settings / configuration | ✅ settings (number prefixes), POS settings, printing templates, storefront | ◻ | |

## POS phase (current scope)
| Item | Status |
|---|---|
| Controlled write tests S1–S7 (register, shift, cash sale, refund, hold+card, cash movements, close) | ✅ done, each separately approved ([results](pos/06-pos-tests-results-and-unknowns.md)) |
| POS feature inventory, workflows, API catalog, domain model, architecture | ✅ [pos/01–05](pos/README.md) |
| Durby POS blueprint, German compliance workstream, roadmap | ✅ [pos/07–09](pos/README.md) |
| Restaurant mode of MeroIMS | ◻ not observable (disabled); would need a separately approved settings change |
| Durby implementation | ◻ not started (awaiting your go-ahead) |

## Inventory investigation (2026-10-20)
| Item | Status |
|---|---|
| Read-only investigation of all 15 inventory areas | ✅ [inventory/01](inventory/01-inventory-investigation.md) |
| Completion checklist + readiness verdict | ✅ [inventory/02](inventory/02-inventory-completion-checklist.md) |
| Controlled tests INV-T1 (purchase), INV-T2 (FIFO sale), INV-T3 (loss) | ✅ done, each approved: [inventory/03](inventory/03-inventory-test-plan.md), [tests](inventory/tests/) |
| Inventory design readiness for Durby | ✅ enough for restaurant MVP (see [01](inventory/01-inventory-investigation.md) final section) |
