# 07 — API Catalog (v0.1 — in progress)

**API origin:** `https://api-dev.meroims.com` (frontend: `https://app-dev.meroims.com`) `[OBS]`
**Evidence:** `evidence/captures/raw-0{1,2}-*.json` (REA scenario, method/path/status/param names) and `raw-03-invoice-shapes.json` + `shapes-03-invoice-flow.txt` (REA passive capture, **value-free** JSON shapes). Field *types* below are JSON types as transmitted; DB column types are `[UNK]`.

---

## A. Cross-cutting conventions

| Convention | Finding | Tag |
|---|---|---|
| Transport | JSON over HTTPS, cross-origin; every call preceded by CORS `OPTIONS` preflight → `204` | OBS |
| Auth | `Authorization` request header on every API call; no `cookie` header on API calls | OBS |
| Auth (SSE) | `GET /api/events/stream?access_token=…` (token in query string, since EventSource cannot set headers) | OBS |
| Paginated list envelope | `{ data: T[], meta: { page, perPage, total, totalPages }, stats?: {…} }` | OBS (payments, documents) |
| Search envelope | `{ data: T[], hasMore: boolean }` (cursor-less "load more") | OBS (party-search, item-search) |
| Plain list | some endpoints return a bare array (`GET /api/core/accounts`) or `{ data: T[] }` without meta | OBS |
| Page params | `page`, `perPage`; some use `limit` (notifications) | OBS |
| IDs | UUID strings | OBS (routes + `id` fields) |
| **Money** | **serialized as strings** (`amount`, `grandTotal`, `balance`, `salesPrice`, `tdsAmount`…) → exact-decimal handling, not floats | OBS |
| Timestamps | `createdAt`, `updatedAt`, `date` as strings (ISO format presumed) | OBS (format INF) |
| Tenancy | `tenantId` present on every business row returned | OBS |
| Branch scoping | nullable `branchId` on documents/payments | OBS |
| Soft delete | `archivedAt` (master data, documents) | OBS |
| Voiding (financial) | `status`, `voidReason`, `voidedAt`, `voidedById`: records are voided, not deleted | OBS (fields); behavior INF |
| Approval | `approvedAt`, `approvedById` on documents | OBS (fields) |
| Drafts | `isDraft` on documents | OBS |
| List aggregates | `stats` block alongside lists (count, totalAmount, monthAmount, outstanding, linkedCount) | OBS |
| Extensibility | `customFields` object on documents (e.g. `chalani_no`, `tax_option`) | OBS |
| HTTP verbs in client code | PATCH ×19, POST ×14, DELETE ×6 (+ GET) | OBS (bundle) |

---

## B. Endpoints with observed shapes

### GET /api/core/documents `?{type,page,perPage}` — unified commercial documents
Used by: Sales Invoice, Quotations, Sales Return, Purchase Bill, Purchase Return lists `[OBS]`.
Response `data[]` fields `[OBS]`:
`id, tenantId, branchId?, warehouseId, documentType, documentNumber, date, status, isDraft, currency,
partyId?, partyName?, partyEmail?, creditTermId?, subTotal, discountTotal, discountPercentage?, taxTotal, taxPercentage?,
otherCharges, charges[], grandTotal, balanceDue, settledAmount, settledAtEntry, settlementStatusId, settlementAccountId?,
tdsTypeId?, tdsAccountId?, tdsAmount, sourceDocumentId?, posOrderId?, stockRequestId?, stockTransferId?, quotationStatus?,
signatureId?, customFields{…}, notes?, termsConditions?, canEmailInvoice, approvedAt, approvedById?, archivedAt?,
voidReason?, voidedAt?, voidedById?, createdById?, createdAt, updatedAt`
`meta{page,perPage,total,totalPages}`, `stats{count,totalAmount,monthAmount,outstanding}`.
Notes `[INF]`: `sourceDocumentId` links conversions (quotation→invoice, invoice→return); `posOrderId` marks POS-originated documents; `stockRequestId`/`stockTransferId` tie documents to inter-branch stock movement. Line items are **not** in the list payload (detail endpoint `[UNK]` — not yet captured).

### GET /api/core/payments `?{direction,page,perPage}`
`data[]`: `id, tenantId, branchId?, paymentNumber, date, direction, status, currency, amount, partyId, partyName, accountId, instrument, reference?, notes?,
allocations[], attachments[], sources[{ method, accountId, amount, chequeId?, chequeNumber?, chequeIssuedDate?, chequeReceivedDate?, chequeStatusId? }],
bankChargeAmount, bankChargeAccountId?, tdsAmount, tdsTypeId?, tdsAccountId?, voidReason?, voidedAt?, voidedById?, createdById, createdAt`
`meta{…}`, `stats{count,linkedCount,monthAmount,totalAmount}`.
Notes: **split tender** (`sources[]` with per-source method/account/cheque); **allocations[]** against documents; bank charges and TDS withheld at payment time `[OBS fields]`.

### GET /api/core/accounts → bare array
`id, tenantId, name, code?, accountKind, bankName?, accountNumber?, accountHolderName?, openingBalance, balance, netChange, isDefault, isActive, description?, archivedAt?`
Notes: these are **cash/bank "money accounts"**, distinct from the accounting chart of accounts (`/api/accounting/chart-accounts`) `[INF]`.

### GET /api/core/sales/party-search → `{data, hasMore}`
`id, name, partyType, phone, email?, balance, creditLimit?`. Fires per keystroke in the invoice customer field `[OBS]`.

### GET /api/core/sales/item-search → `{data, hasMore}`
`id, name, sku, barcode?, hsCode?, itemType, unitId, salesPrice, available, secondaryUnitId?, unitsPerSecondaryUnit?, secondarySalesPrice?`
Notes: returns **available stock** with the price (stock-aware invoicing); supports a **secondary unit with a conversion factor** (e.g. box vs piece) `[OBS fields]`.

### GET /api/core/lookups → `{partyCategories[], productCategories[], units[]}`
productCategories: `id, name, description?, color?, imageUrl?, parentCategoryId? (hierarchical), isActive, archivedAt?`; units: `id, name, symbol?`.

### GET /api/core/credit-terms → `{data[]}` — `id, name, days, sortOrder, isActive`
### GET /api/accounting/tax/tds-types → `{data[]}` — `id?, code, name, isActive, isSystem` (system-seeded + tenant-defined)
### GET /api/core/signatures → `{data[]}` (empty in dev)
### GET /api/core/notifications `?{limit}` → `{data[], unreadCount}`

---

## C. Endpoints observed (method/path only — shapes pending)
GET `/api/core/me` · `/api/core/branches/mine` · `/api/account-config` · `/api/core/billing/status` · `/api/overview?{scope}` · `/api/core/parties?{page,perPage}` · `/api/accounting/party-balances?{asOf}` · `/api/core/warehouses?{includeBranchStores}` · `/api/core/finance/records?{recordType,page,perPage}` · `/api/core/finance/categories?{recordType}` · `/api/events/stream?{access_token}` (SSE)

## D. Bundle-only endpoints (not yet seen at runtime)
See `evidence/api-endpoints.txt` (90 literals). Write endpoints (POST/PATCH/DELETE) will be catalogued **without being invoked**: their request shapes come from the client code, unless you authorize a synthetic test record.

---
## B2. Round 4 — details, parties, products, stock, profile (`evidence/captures/shapes-04-details-profile.txt`)

### GET /api/core/documents/{id} — document detail `[OBS]`
All list fields plus: `lines[]`, `payments[]`, `attachments[]`, nested `party{…}`, `creditTerm{…}`, `settlementStatus{id,name,isSystem}`, `settlementAccount?`, `signature?`.
`lines[]`: `id, tenantId, documentId, lineNo, kind, productId, description, quantity, unitPrice, unitCost, discountAmount, discountPercentage?, taxAmount, lineTotal, batchNo?, expiryDate?, unitMeta?{unit_mode, unit_label, entered_quantity, entered_rate, discount_source}`.
- `unitCost` on sales lines → cost snapshot at time of sale (COGS basis) `[INF]`.
- `unitMeta` keeps the user's entered unit/qty/rate while `quantity` is base-unit `[INF]`.
- POS-originated invoice observed: `posOrderId` set, `partyId` null (walk-in) `[OBS]`.

### GET /api/core/me — session principal + tenant memberships `[OBS]`
`activeTenantId, actorType, staffRole?, permissions?,`
`user{ id, name, email, phone?, userRole, isActive, failedLoginCount, lockedUntil?, mustChangePassword, trialEnabled, trialStartedAt? }`,
`tenants[]{ id, name, kind, ownerId, isActive, currency, dateSystem, panNo, isVatRegistered, address, phone, email?, website?, logoUrl?, brandName?, brandTagline?, brandIconUrl?,`
` planId, planStartedAt, planExpiresAt?, planLimitOverrides?, accountingStartDate?, industry?, documentPrefixes?, invoiceNumberEnabled, chalaniEnabled,`
` salesPrintTemplate, purchasePrintTemplate, branchSharedStock, transferApprovalRequired,`
` posRetailEnabled, posRestaurantEnabled, restaurantKitchenEnabled, restaurantBarEnabled, restaurantIgnoreStock, posMobileEnabled, posEcommerceEnabled, pmsEnabled,`
` storeTemplateId?, legacyImportEnabled, legacyTenantKey?, features{storefront_blog, storefront_design, storefront_templates, storefront_themes} }`
Notes: users ↔ tenants is many-to-many; the active tenant is server-side session state or a token claim `[UNK]`. Owner/admin shows `staffRole=null, permissions=null` `[OBS]`, which suggests RBAC applies to staff actors `[INF]`.

### GET /api/core/parties ?{page,perPage}
`id, tenantId, name, partyType, phone, email?, address, categoryId, panNo?, vatNo?, creditLimit?, openingBalance, openingBalanceDate?, openingType, balance, loyaltyPoints, photoUrl?, isActive, createdAt, updatedAt` + `meta`.

### GET /api/accounting/party-balances ?{asOf}
`{ asOf, parties: number, balances: { [partyId]: string } }`: party balances served by the **accounting** module, keyed by party UUID `[OBS]`.

### GET /api/core/products ?{page,perPage,…}
`id, tenantId, name, sku, barcode?, hsCode?, description, brand?, categoryId, itemType, unitId, secondaryUnitId?, unitsPerSecondaryUnit?, packSize?,`
`salesPrice, secondarySalesPrice?, purchasePrice, taxOption, valuationMethod, trackExpiry, lowStockThreshold,`
`salesAccountId?, purchaseAccountId?, salesReturnAccountId?, purchaseReturnAccountId?,`
`parentProductId?, variantAttributes?, originBranchId?, image?, imageUrl?, isActive, archivedAt?, createdById?, createdAt, updatedAt,`
`stock{ onHand, available, warehouses[]{warehouseId, warehouseName, onHand, available} }` + `meta`.

### GET /api/core/stock/levels → array
`id, tenantId, productId, warehouseId, warehouseName, branchId?, branchName, onHand, reserved, expired, available, avgCost`.

### GET /api/core/stock/movements ?{…} — stock ledger
`id, tenantId, productId, warehouseId, movementType, quantity, unitCost, sourceType, sourceId, reason, batches[], createdById, createdAt` + `meta`.

### GET /api/core/reports/business/inventory-ledger
`{ slug, from, to, rows[], sections[]{ title, rows[]{ date, number, type, contact, warehouse, inQty?, inRate?, inAmount?, outQty?, outRate?, outAmount?, balanceQty, balanceRate, balanceAmount } } }`: a perpetual valuation ledger with running balance qty/rate/amount `[OBS]`.

### GET /api/core/stock/expiry → `{ data[], today }`
### GET /api/core/warehouses → array
`id, name, kind, branchId?, branchName, stockLocationId, sharedBranches[], isDefault, isActive, address?, location?, phone?, email?, archivedAt?`
### GET /api/core/reports/transactions → `{ data[], meta }` (empty in this window)

---
## B3. Round 5 — accounting & reports (`evidence/captures/shapes-05-accounting-reports.txt`)

### GET /api/accounting/journals ?{…} — GL journal headers `[OBS]`
`id, tenantId, branchId?, journalNumber, entryDate, currency, narration, reference?, status, postedAt, systemGenerated,`
`sourceEventType, sourceEventId, sourceDocumentId, sourceDocumentNumber?, totalDebit, totalCredit,`
`approvedById?, rejectedById?, rejectionReason?, reversalOfId?, reversedById?, voidReason?, voidedById?, createdById?, createdAt` + `meta`.
Journal lines: not in list payload; detail endpoint not yet captured `[UNK]`.

### GET /api/accounting/chart-accounts
`{ groups[]{id, name, parentId?, rootType, isSystem, isActive, sortOrder, description?, archivedAt?}, accounts[]{id, code, name, groupId, rootType, isSystem, allowsManualEntries, isActive, sortOrder, description?, archivedAt?}, asOf, tree[…] }`
### GET /api/accounting/chart-accounts/tree
Recursive `tree[]{ key, kind, label, amount, accountId?, subledgerType?, subledgerId?, children[] }` (account balances rolled up the hierarchy, down to **party subledgers**).

### Reports
| Endpoint | Response shape |
|---|---|
| GET /api/accounting/reports/balance-sheet | `{asOf, assets[], liabilities[], equity[] ({accountId, accountCode, accountName, amount}), totalAssets, totalLiabilities, totalEquity, liabilitiesAndEquity, balanced}` |
| GET /api/accounting/reports/profit-loss | `{from, to, totalIncome, totalExpenses, netProfit, …}` |
| GET /api/accounting/reports/cash-flow | `{from, to, openingCash, totalInflow, totalOutflow, netChange, closingCash, …}` |
| GET /api/accounting/reports/day-book | `{from, to, totalDebit, totalCredit, …rows}` |
| GET /api/accounting/reports/aging/receivables, …/payables | `{asOf, buckets[], rows[]{subledgerId, name, amounts[], total}, totals[], grandTotal}` |
| GET /api/accounting/reports/account-ledger/{id} | `{from, to, accounts[]{accountId, code, name, opening, closing, totalDebit, totalCredit, rowCount, rows[]{date, txnNo, txnType, txnTypeLabel, referenceNo, description, debit, credit, balance, journalId, sourceDocumentId}}}` |
| GET /api/accounting/reports/ledger/{id} | `{openingBalance, closingBalance, …}` |
| GET /api/accounting/reports/trial-balance | `[]` in this tenant: observed-empty, shape `[UNK]` |
| GET /api/accounting/opening-balances | `{asOfDate, rows[]{accountId, code, name, groupName, parentGroupName?, rootType, total{amount, side}}}` (Dr/Cr side) |
| GET /api/accounting/fiscal-years | `[]`: no fiscal years configured, shape `[UNK]` |
| GET /api/accounting/cheques | `[]`: no cheques, shape `[UNK]` |

### Money accounts (operational cash/bank)
- GET /api/core/accounts/{id}/transactions → `{openingBalance, data[]{id, date, type, category, amount, reference?, notes?, created_at}}`
- GET /api/core/accounts/{id}/entries → `[]{id, tenantId, accountId, kind, action, body, fileName?, dataUrl?, createdById, createdAt}` (activity notes/attachments)

### GET /api/core/stock/opening → `{products[]{productId, name, sku}, warehouses[]{id, name, isDefault}}` (opening-stock entry form)

### New UI routes seen this round
`/parties/{id}` (party detail page), `/sales/payment-in/{id}` (payment detail), `/cheque-register/new`.
