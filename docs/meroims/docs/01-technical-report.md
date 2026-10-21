# MeroIMS — Technical Reverse-Engineering Report (Phase 1)

**Target:** `https://app-dev.meroims.com/` (user-owned dev environment)
**Method:** REA MCP (passive CDP inspection + static JS bundle analysis) + direct static asset inspection
**Scope:** Read-only. No writes, no transactions, no settings changes.
**Date:** 2026-10-20
**Evidence tags:** `[OBS]` observed directly · `[INF]` inferred from evidence · `[UNK]` unknown / not yet verified

> Goal: understand MeroIMS comprehensively, then rebuild equivalent functionality for **Durby** on Next.js + NestJS + Prisma + PostgreSQL.

---

## 1. Technology stack

| Layer | Finding | Confidence | Evidence |
|---|---|---|---|
| Frontend framework | **Next.js** (App Router) | OBS | `/_next/static/chunks/*`, `/_next/image` optimizer, route tree below |
| Bundler | **Turbopack** | OBS | `turbopack-*.js` runtime chunk |
| UI runtime | **React** (Suspense used) | OBS | `jsx`, `Suspense` in chunk tails |
| Styling | CSS modules + utility classes (`inter_*-module__…`, `h-full antialiased`) | OBS | HTML shell `<html class=…>`, CSS chunks |
| Fonts | Inter (self-hosted woff2) | OBS | `/_next/static/media/*.woff2` |
| Source maps | **NOT published** (`.js.map` returns the SPA HTML shell, soft-404) | OBS | `.map` body begins `<!DOCTYPE html>` |
| Bundle size | 46 JS chunks, ~2.0 MB | OBS | downloaded set |
| API style | REST under `/api/*`, JSON | OBS | 90 endpoint literals (§4) |
| Realtime | **Server-Sent Events** at `/api/events/stream` | OBS | endpoint literal |
| Backend framework | NestJS-style module split (`auth`/`core`/`pos`/`accounting`) | INF | API namespacing matches target stack; not yet confirmed from a server artifact |
| Currency / locale | Nepali Rupee (Rs.), "Nabil Bank"; TDS tax | OBS | dashboard, `/accounting/tax/tds-types` |

---

## 2. Application module map (navigation)

Captured from the authenticated dashboard accessibility tree `[OBS]`:

**Primary sidebar:** Dashboard · Parties · Branches & Warehouses · Stock Request · Picking · Delivery Tracking · Inventory · Sales · Purchase · Retail Till · POS · Web Store · Expenses · Accounting · Management · Opening Balance · Reports · Audit Log · Manage Staffs · Import Data · Business Tools

**Global UI:** Switch Profile · Notifications · Quick-add (New invoice / Payment in / Purchase bill / Inventory / Accounts) · Open user menu · Toggle sidebar

---

## 3. Frontend route tree (Next.js pages)

Observed route literals in the bundle `[OBS]`:

```
/dashboard
/parties
/inventory              /inventory/new           /inventory/adjustment
/inventory/bom          /inventory/production-order
/inventory/variant-products   /inventory/variant-products/new   /inventory/variant-attributes
/inventory/warehouse-transfer /inventory/units  /inventory/product-category
/inventory/expiry       /inventory/documents
/sales/invoices         /sales/invoices/create
/sales/quotations       /sales/quotations/create
/sales/returns          /sales/returns/create
/sales/payment-in       /sales/payment-in/create
/purchases/bills        /purchases/bills/create
/purchases/returns      /purchases/returns/create
/purchases/payment-out  /purchases/payment-out/create
/expenses               /expenses/create
/stock-requests         /stock-requests/new
/picking                /delivery-tracking
/accounting             /accounting-workbench
/reports  (balance-sheet, income-statement, gl-master, gl-summary,
           detail-general-ledger, transaction-list, customer-statement,
           supplier-statement, inventory-position)
/management   /staff   /audit-log   /settings   /pos-settings
```

> Implication for Durby: this is a full **ERP**, not just a POS: commerce + inventory (variants, multi-warehouse, inter-branch stock requests) + **double-entry accounting** + POS/retail till.
>
> **CORRECTION (runtime, 2026-10-20):** `/inventory/bom` and `/inventory/production-order` render **"Coming soon"** with no API calls `[OBS]`. Manufacturing (BOM / production orders) is **not implemented**. The route literals alone were not evidence of a working feature.

---

## 4. Backend API surface (90 endpoints)

All `[OBS]` as string literals / call sites in the bundle. HTTP methods observed in code: **PATCH ×19, POST ×14, DELETE ×6** (GET is the unmarked default). Request/response **payload shapes are not yet captured** `[UNK]` — that is Phase 2 (runtime).

### 4.1 Auth (`/api/auth`, `/api/pos/auth`)
- `POST /api/auth/login` · `/api/auth/refresh` · `/api/auth/platform-access`
- `/api/pos/auth/refresh`
- INF: access/refresh-token scheme (separate POS refresh); mechanism (cookie vs bearer) **UNK** until runtime capture.

### 4.2 Core — identity / tenancy
- `/api/core/me`, `/api/core/me/password`, `/api/core/me/deliveries-elsewhere`
- `/api/core/tenants`, `/api/core/tenants/{id}`
- `/api/core/branches/mine`, `/api/core/warehouses`
- `/api/core/billing/status`, `/api/account-config`, `/api/overview`
- `/api/events/stream` (SSE)

### 4.3 Core — parties, products, stock
- `/api/core/parties`, `/api/core/parties/{id}`
- `/api/core/lookups`, `/api/core/lookups/party-categories`
- `/api/core/products`, `/api/core/products/{id}`, `/api/core/products/export`
- `/api/core/stock/levels`, `/stock/adjustments`, `/stock/transfers`, `/stock/deliveries`, `/stock/expiry`
- `/api/core/stock/requests`, `/stock/requests/{id}`, `/stock/requests/catalog`, `/stock/requests/confirmations`

### 4.4 Core — sales & purchases
- `/api/core/sales/invoices`, `/sales/quotations`(+`/{id}`), `/sales/returns`
- `/api/core/sales/item-search`, `/sales/party-search`
- `/api/core/purchases/bills`, `/purchases/returns`
- `/api/core/vendor-invoices/import/capabilities`, `/import/scans`

### 4.5 Core — finance
- `/api/core/payments`(+`/{id}`), `/payments/allocation-preview`
- `/api/core/accounts`(+`/{id}`, `/entries/{id}`, `/search`)
- `/api/core/finance/categories`, `/finance/records`(+`/{id}`)
- `/api/core/credit-terms`, `/cheque-statuses`, `/signatures`, `/documents`(+`/{id}`)
- `/api/core/notifications`(+`/{id}`, `/read-all`)
- `/api/core/search`, `/api/core/reports/transactions`

### 4.6 Accounting (double-entry)
- `/api/accounting/chart-accounts`(+`/{id}`, `/search`), `/chart-account-groups`(+`/{id}`)
- `/api/accounting/journals/by-source/{…}`, `/party-balances`, `/fiscal-years`
- `/api/accounting/tax/tds-types`, `/accounting/search`
- Reports: `/reports/balance-sheet`, `/income-statement-tree`, `/profit-loss`, `/trial-balance`, `/day-book`, `/cash-flow`, `/aging/{…}`, `/ledger/{…}`, `/account-ledger/{…}`

### 4.7 POS / retail
- `/api/pos/shifts`(+`/{id}`), `/pos/retail/shifts/{…}`
- `/api/pos/retail/context`, `/retail/products/lookup`, `/pos/products`
- `/api/pos/retail/sales`, `/retail/holds`(+`/{id}`), `/retail/orders/{id}`

---

## 5. Inferred domain entities (data model seeds)

From endpoints + dashboard `[INF]` (to be confirmed by response shapes in Phase 2):
Tenant, Branch, Warehouse, User/Staff(+roles), Party (customer/supplier, categories, credit terms),
Product (+ variants, variant attributes, categories, units, BOM, production order, expiry/batch),
StockLevel, StockRequest, StockTransfer, StockAdjustment, Delivery,
SalesInvoice, Quotation, SalesReturn, PurchaseBill, PurchaseReturn, VendorInvoiceImport,
Payment (+ allocations), Expense, FinanceRecord/Category, ChequeStatus, Signature, Document,
ChartOfAccount (+ groups), Journal/Ledger entry, FiscalYear, TDSType, Notification,
POSShift, RetailSale, RetailHold, RetailOrder.

---

## 6. Evidence references (REA)
- `list_browser_targets` → `ev_337b865a…` (authenticated target)
- `inspect_web_page` (dashboard, a11y tree) → `ev_…` saved: `tool-results/mcp-rea-inspect_web_page-1792503996435.txt`
- `analyze_javascript_application` (bundle, summary) → parent `ev_b57b1d368b…` (45/46 parsed, 109 findings, request-family call sites; semantic graph partial by budget)
- Downloaded bundle: `scratchpad/meroims-bundle/js/*.js` (46 files)

---

## 7. Open items → Phase 2 (runtime capture, read-only)
1. **HTTP method + request/response JSON shape per endpoint** — via `observe_web_session` while navigating each module.
2. **Auth mechanism** — cookie vs bearer, token lifetime, refresh flow, multi-tenant header.
3. **Pagination / filter / sort conventions** (query params).
4. **SSE event types** on `/api/events/stream`.
5. **Validation rules & error envelope** shape.
6. Confirm backend framework from response headers `[UNK]`.
