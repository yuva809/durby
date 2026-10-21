# MeroIMS Feature / Route Checklist (Admin scope)

Status legend: ◻ Not Inspected · ◐ In Progress · ✅ Inspected · ⛔ Blocked (reason)

> "Inspected" = UI + triggering API calls + request/response shape observed (value-free). Routes from Phase 1 bundle `[OBS]`.

## Auth & session
| Route / flow | Status | Notes |
|---|---|---|
| /login (email+password) | ◐ | Login observed (logged in). Need `/api/auth/login` shape + token mechanism |
| token refresh | ◻ | `/api/auth/refresh`, `/api/pos/auth/refresh` |
| platform-access | ◻ | `/api/auth/platform-access` |
| logout | ◻ |  |

## Core / shell
| Route / flow | Status | Notes |
|---|---|---|
| /dashboard | ✅ | KPIs, a11y nav map captured |
| tenant/branch selection (Switch Profile) | ◻ | `/api/core/branches/mine`, `/api/core/tenants` |
| notifications | ◻ | `/api/core/notifications*` |
| SSE live updates | ◻ | `/api/events/stream` |
| /api/overview, /api/account-config, billing/status | ◻ |  |

## Parties
| /parties (list) | ◻ | `/api/core/parties` |
| party create/detail | ◻ | ask before create |
| party-categories, credit-terms | ◻ | `/api/core/lookups/party-categories`, `/credit-terms` |

## Products & inventory
| /inventory (list) | ◻ | `/api/core/products`, `/stock/levels` |
| /inventory/new | ◻ |  |
| /inventory/product-category, /units | ◻ |  |
| /inventory/variant-attributes, /variant-products(+/new) | ◻ |  |
| /inventory/bom | ◻ | manufacturing |
| /inventory/production-order | ◻ | manufacturing |
| /inventory/warehouse-transfer | ◻ | `/stock/transfers` |
| /inventory/adjustment | ◻ | `/stock/adjustments` |
| /inventory/expiry | ◻ | `/stock/expiry` |
| /inventory/documents | ◻ | `/core/documents` |
| warehouses | ◻ | `/core/warehouses` |

## Stock requests / picking / delivery
| /stock-requests(+/new) | ◻ | `/stock/requests*` |
| /picking | ◻ |  |
| /delivery-tracking | ◻ | `/stock/deliveries` |

## Sales
| /sales/invoices(+/create) | ◐ | FIRST capture target |
| /sales/quotations(+/create) | ◻ |  |
| /sales/returns(+/create) | ◻ |  |
| /sales/payment-in(+/create) | ◻ | `/core/payments` |
| item-search, party-search | ◻ | `/core/sales/item-search`, `/party-search` |

## Purchases
| /purchases/bills(+/create) | ◻ | `/core/purchases/bills` |
| /purchases/returns(+/create) | ◻ |  |
| /purchases/payment-out(+/create) | ◻ |  |
| vendor-invoice import | ◻ | `/core/vendor-invoices/import/*` |

## Payments
| payments list / allocation | ◻ | `/core/payments`, `/allocation-preview` |
| cheque-statuses | ◻ |  |

## Expenses
| /expenses(+/create) | ◻ | `/core/finance/records`, `/finance/categories` |

## Accounting
| /accounting, /accounting-workbench | ◻ |  |
| chart-accounts(+groups) | ◻ | `/api/accounting/chart-accounts*` |
| journals, fiscal-years | ◻ | `/accounting/journals/by-source`, `/fiscal-years` |
| /opening-balance | ◻ |  |
| tax / tds-types | ◻ | `/accounting/tax/tds-types` |
| party-balances | ◻ |  |

## Reports
| balance-sheet, income-statement, profit-loss | ◻ |  |
| trial-balance, day-book, cash-flow | ◻ |  |
| gl-master, gl-summary, detail-general-ledger | ◻ |  |
| transaction-list, customer/supplier-statement | ◻ |  |
| aging, account-ledger, inventory-position | ◻ |  |

## POS / retail
| /pos, Retail Till | ◻ | `/pos/retail/context` |
| shifts (open/close) | ◻ | `/pos/shifts` — ask before open |
| product lookup | ◻ | `/pos/retail/products/lookup` |
| holds | ◻ | `/pos/retail/holds` |
| checkout / sales | ◻ | `/pos/retail/sales` — ask before sale |
| Web Store | ◻ |  |

## Admin / management
| /management | ◻ |  |
| /staff (Manage Staffs) | ◻ | roles/permissions |
| /settings, /pos-settings | ◻ |  |
| /audit-log | ◻ |  |
| Import Data | ◻ |  |
| Business Tools | ◻ |  |
| signatures | ◻ | `/core/signatures` |

---
## Update — runtime pass 1 (2026-10-20)
◐ below = list-page API calls observed (method + path + query param names, no bodies); detail/create flows and response shapes still pending.

| Route | Status | Observed API (list load) |
|---|---|---|
| /sales/invoices | ◐ | GET /api/core/documents ?{type,page,perPage} |
| /sales/invoices/create | ◐ | shell + lookups, credit-terms, tds-types, accounts, signatures (item/party search fire on typing — pending) |
| /sales/quotations | ◐ | GET documents ?{type,page,perPage} |
| /sales/returns | ◐ | GET documents ?{type,page,perPage} |
| /sales/payment-in | ◐ | GET /api/core/payments ?{direction,page,perPage} |
| /parties | ◐ | GET parties ?{page,perPage}; accounting/party-balances ?{asOf}; documents; payments |
| /inventory | ◐ | GET warehouses ?{includeBranchStores} (product list source TBD) |
| /purchases/bills, /purchases/returns | ◐ | GET documents ?{type,page,perPage} |
| /purchases/payment-out | ◐ | GET payments ?{direction,page,perPage} |
| /expenses | ◐ | GET finance/records ?{recordType,page,perPage}; finance/categories ?{recordType} |

### New routes found in the full Admin nav (all ◻ Not Inspected)
/branches · /warehouses · /orders · /pos-settings · /till · /storefront-design · /storefront-blog · /accounts · /accounts/chart-of-account · /cheque-register · /quick-receipt · /quick-payment · /bank-reconciliation · /opening-balance · /import-data · /import-data/parties · /business-tools · /pms (dashboard-only) · /reports/sales-register · /reports/purchase-register · /reports/sales-by-item · /reports/sales-by-customer · /reports/invoice-age · /accounting?report={aging-receivables,aging-payables,profit-loss,cash-flow}

### Shell calls made on every page load `[OBS]`
GET me · branches/mine · account-config · billing/status · notifications ?{limit} · overview ?{scope} · events/stream ?{access_token} (SSE)

## Update — passive shape rounds 3–4
| Item | Status | Notes |
|---|---|---|
| Sales invoice list + detail + create lookups | ✅ | documents, documents/{id} (lines), party-search, item-search, credit-terms, tds-types, lookups |
| Parties list + detail | ✅ (read) | parties, party-balances, documents, payments |
| Products list + detail | ✅ (read) | products, stock/levels, stock/movements, stock/expiry, inventory-ledger report |
| Profile / tenant model | ✅ (read) | /me with tenants[] + feature flags; switching itself not exercised (changes session) |
| Notifications | ✅ (read) | notifications {data, unreadCount} |

## Update — round 5 (accounting & reports)
| Item | Status | Notes |
|---|---|---|
| Manage Accounts (money accounts) + account detail | ✅ (read) | core/accounts, /{id}/transactions, /{id}/entries |
| Chart of Account (groups/accounts/tree) | ✅ (read) | accounting/chart-accounts, /tree (subledgers) |
| Accounting workbench / journals list | ✅ (read) | accounting/journals (headers; lines ◻) |
| Balance sheet, P&L, cash flow, day book, aging AR/AP, account ledger | ✅ (read) | accounting/reports/* |
| Trial balance | ◐ | returned [] — shape unknown |
| Fiscal years | ◐ | returned [] — none configured |
| Cheque register | ◐ | accounting/cheques [] ; /cheque-register/new form not inspected |
| Bank reconciliation | ◐ | no dedicated API observed in window |
| Opening balance | ✅ (read) | accounting/opening-balances, core/stock/opening |
