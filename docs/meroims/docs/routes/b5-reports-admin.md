# Route dossiers — b5-reports-admin

Generated from `evidence/routes/b5-reports-admin.json` (CDP driver: UI inventory + API calls, read-only, writes blocked at network layer)
and `evidence/captures/shapes-b5-reports-admin.txt` (REA passive capture: value-free JSON shapes). Shell calls made on every page are omitted.
Blocked write attempts in this batch: 0

## `/` — Dashboard

- Headings: Dashboard · Income against costs · Rs.[n] · Sales against purchases · What sold most · Who bought most · The queue today
- Actions/buttons: [record button] · This month · [record button] · Chart · Table
- Tabs: Last 7 days · Last 30 days · This month · Last 90 days · Last 12 months · Chart · Table
- Empty state: No sales in this period. / Nothing is owed to suppliers. / No expenses posted in this period. / No dated stock near its date.
- API calls:
  - `GET /api/account-config  ← tab Last 30 days`
  - `GET /api/core/billing/status  ← tab Last 30 days`
  - `GET /api/core/me  ← tab Last 30 days`
  - `POST /api/auth/refresh  ← tab Last 30 days`
- Tab views:
  - **Last 7 days**: headings Dashboard · Income against costs · Rs.[n] · Sales against purchases; fields 0; columns 
  - **Last 30 days**: headings Dashboard · Income against costs · Rs.[n] · Sales against purchases; fields 0; columns 
  - **This month**: headings Dashboard · Income against costs · Rs.[n] · Sales against purchases; fields 0; columns 
  - **Last 90 days**: headings Dashboard · Income against costs · Rs.[n] · Sales against purchases; fields 0; columns 
  - **Last 12 months**: headings Dashboard · Income against costs · Rs.[n] · Sales against purchases; fields 0; columns 
  - **Chart**: headings Dashboard · Income against costs · Rs.[n] · Sales against purchases; fields 0; columns 
  - **Table**: headings Dashboard · Income against costs · Rs.[n] · Sales against purchases; fields 0; columns PERIOD | INCOME | COSTS | NET

## `/reports` — Reports

- Headings: Reports
- Actions/buttons: [record button] · Collapse all · [record button]
- Form fields: Search reports [search]
- API calls: (none beyond shell)

## `/reports/balance-sheet` — Balance Sheet

- Headings: Balance Sheet
- Actions/buttons: CSV · Excel · Print · [record button] · Generate · Collapse all · Collapse Assets · Collapse Current Assets · Collapse Account Receivable · Collapse Closing Inventory · Collapse Non Current Assets · Collapse Liability · Collapse Current Liability · Collapse Non Current Liability · Collapse Equity · Collapse Capital
- Table columns: ACCOUNT | AMOUNT (RS.)
- Form fields: As of* [date]
- API calls:
  - `GET /api/accounting/reports/balance-sheet-tree ?{asOf}`

## `/reports/income-statement` — Income Statement

- Headings: Income Statement
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Collapse all · Collapse Direct Income · Collapse Cost Of Sales
- Table columns: ACCOUNT | AMOUNT (RS.)
- Form fields: From* [date] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/accounting/reports/income-statement-tree ?{from,to}`

## `/reports/gl-master` — GL Master Report

- Headings: GL Master Report
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Billing location · Transaction types
- Table columns: DATE | TXN TYPE | TXN NO | REFERENCE NO | ACCOUNT | SUBACCOUNT (PARENT) | GROUP TYPE | ACCOUNT CLASS | DEBIT | CREDIT
- Form fields: Billing Location [button] · From* [date] · Select all rows [checkbox] · To* [date] · Txn Type [button]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/accounting/reports/gl-master ?{from,location,to}`

## `/reports/gl-summary` — General Ledger Summary

- Headings: General Ledger Summary
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Account groups · Accounts
- Table columns: CODE / ACCOUNT | PARENT | GROUP TYPE | ACCOUNT CLASS | OPENING BALANCE | TRANSACTION DEBIT | TRANSACTION CREDIT | CLOSING BALANCE
- Form fields: Account [button] · From* [date] · Group [button] · Select Accounts Receivable (Trade) [checkbox] · Select Cash In Hand [checkbox] · Select Cost of Goods Sold [checkbox] · Select Inventory Asset [checkbox] · Select Nabil Bank [checkbox] · Select Opening Balance Equity [checkbox] · Select Sales Goods [checkbox] · Select Value Added Tax [checkbox] · Select all rows [checkbox] · To* [date]
- API calls:
  - `GET /api/accounting/chart-accounts`
  - `GET /api/accounting/fiscal-years`
  - `GET /api/accounting/reports/gl-summary ?{from,to}`

## `/reports/detail-general-ledger` — Detail General Ledger

- Headings: Detail General Ledger
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Accounts
- Table columns: 
- Form fields: Account [button] · From* [date] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/accounting/reports/detail-ledger ?{from,to}`

## `/reports/transaction-list` — Transaction List

- Headings: Transaction List
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Transaction types · Statuses
- Table columns: TRANSACTION DATE | TXN TYPE | TRANSACTION NO | REFERENCE NO | STATUS | AMOUNT | CREATED BY | APPROVED BY | APPROVED AT | CREATED AT | DESCRIPTION | ACTIONS
- Form fields: From* [date] · Search [search] · Select all rows [checkbox] · Status [button] · To* [date] · Txn Type [button]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/core/reports/transactions ?{from,page,perPage,to}`

## `/reports/customer-statement` — Customer Statement

- Headings: Customer Statement
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Customer · Group by
- Table columns: TXN DATE | TXN TYPE | TXN NO. | REFERENCE NO | DESCRIPTION | DEBIT | CREDIT | BALANCE
- Form fields: Customer [button] · From* [date] · Group By [button] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`

## `/reports/supplier-statement` — Supplier Statement

- Headings: Supplier Statement
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Supplier · Group by
- Table columns: TXN DATE | TXN TYPE | TXN NO. | REFERENCE NO | DESCRIPTION | DEBIT | CREDIT | BALANCE
- Form fields: From* [date] · Group By [button] · Supplier [button] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`

## `/reports/inventory-position` — Inventory Position

- Headings: Inventory Position
- Actions/buttons: CSV · Excel · Print · [record button] · Generate · Category · Warehouse
- Table columns: CODE/GOODS | CATEGORY | QTY | UOM | RATE | AMOUNT
- Form fields: Category [button] · Select all rows [checkbox] · Select row [checkbox] · Warehouse [button]
- API calls:
  - `GET /api/core/lookups`
  - `GET /api/core/reports/business/inventory-position ?{from,to}`
  - `GET /api/core/warehouses`

## `/reports/sales-register` — Sales Register

- Headings: Sales Register
- Actions/buttons: [record button] · CSV · Excel · Print · Generate
- Table columns: मिति | बीजक नम्बर | खरिदकर्ताको नाम | खरिदकर्ताको स्थायी लेखा नम्बर | मूल्य | कर | करयोग्य बिक्री — मूल्य | करयोग्य बिक्री — कर | निकासी — वस्तु | निकासी — देश | निकासी — प्रज्ञापनपत्र नम्बर | निकासी — मिति | जम्मा बिक्री/निकासी
- Form fields: From* [date] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/core/reports/business/sales-register ?{from,to}`

## `/reports/purchase-register` — Purchase Register

- Headings: Purchase Register
- Actions/buttons: [record button] · CSV · Excel · Print · Generate
- Table columns: मिति | बीजक नं. | प्रज्ञापनपत्र नं. | आपूर्तिकर्ताको नाम | आपूर्तिकर्ताको स्थायी लेखा नम्बर | करयोग्य खरिद (पूंजीगत बाहेक) — मूल्य | करयोग्य खरिद (पूंजीगत बाहेक) — कर | करयोग्य पैठारी (पूंजीगत बाहेक) — मूल्य | करयोग्य पैठारी (पूंजीगत बाहेक) — कर | पूंजीगत करयोग्य खरिद/पैठारी — मूल्य | पूंजीगत करयोग्य खरिद/पैठारी — कर | जम्मा खरिद मूल्य | कर छुट हुने वस्तु/सेवा खरिद मूल्य
- Form fields: From* [date] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/core/reports/business/purchase-register ?{from,to}`

## `/reports/sales-by-item` — Sales By Item

- Headings: Sales By Item
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Category
- Table columns: PRODUCT (CODE) | QUANTITY | AMOUNT | DISCOUNT | NET SALES | VAT AMOUNT | TOTAL AMOUNT
- Form fields: Category [button] · From* [date] · Product / Item [button] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/core/lookups`
  - `GET /api/core/reports/business/sales-by-item ?{from,to}`

## `/reports/sales-by-customer` — Sales By Customer

- Headings: Sales By Customer
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Customer · Contact Group
- Table columns: CONTACT | CONTACT GROUP | AMOUNT | DISCOUNT | NET SALES | VAT AMOUNT | TOTAL AMOUNT
- Form fields: Contact Group [button] · Customer [button] · From* [date] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/core/lookups`
  - `GET /api/core/reports/business/sales-by-customer ?{from,to}`

## `/reports/invoice-age` — Invoice Age

- Headings: Invoice Age
- Actions/buttons: [record button] · CSV · Excel · Print · Generate · Customer · Contact Group
- Table columns: INVOICE DATE | DUE DATE | #NO | REFERENCE NO | CUSTOMER | CONTACT GROUP | INVOICE AMOUNT | PAID | BALANCE | STATUS | AGE DAYS
- Form fields: Contact Group [button] · Customer [button] · From* [date] · To* [date]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/core/lookups`
  - `GET /api/core/reports/business/invoice-age ?{from,to}`

## `/management` — Management

- Headings: Management · SECTIONS · PARTY CATEGORIES
- Actions/buttons: [record button] · Active · Rename Wholesaler · Archive Wholesaler · Rename Retailer · Archive Retailer · Rename Wholesale · Archive Wholesale · Rename Retail · Archive Retail · Rename Supplier · Archive Supplier · Rename Distributor · Archive Distributor
- Form fields: New category name [text]
- API calls:
  - `GET /api/accounting/tax/tds-types`
  - `GET /api/core/cheque-statuses`
  - `GET /api/core/credit-terms`
  - `GET /api/core/finance/categories ?{recordType}`
  - `GET /api/core/lookups`
  - `GET /api/core/signatures`

## `/audit-log` — Audit Log

- Row open: clicked (/audit-log → /audit-log)
- Headings: Audit Log
- Actions/buttons: 
- Table columns: WHEN | WHAT | RECORD | BY | WHERE
- Form fields: From date [date] · Kind of record [select-one] · Search the audit log [search] · To date [date]
- API calls:
  - `GET /api/core/audit-logs ?{page,perPage}`

## `/staff` — Manage Staffs

- Row open: clicked (/staff → /staff)
- Headings: Manage Staffs
- Actions/buttons: Active · Roles · [record button]
- Table columns: STAFF | CONTACT | ROLE | WORKS IN | PERMISSIONS | STATUS | LAST ACTIVE | ACTIONS
- Form fields: Role filter [select-one] · Search name, email, or phone [search] · Status filter [select-one]
- Empty state: No staff yet.
- API calls:
  - `GET /api/core/staff-roles`
  - `GET /api/core/staffs ?{page,perPage}`
  - `POST /api/auth/refresh`

## `/settings` — How your organisation works

- Headings: How your organisation works · Number Prefixes · More settings
- Actions/buttons: Create New Prefix
- Empty state: No prefixes yet. Numbers typed by hand are saved exactly as entered until you add one.
- API calls: (none beyond shell)

## `/import-data` — Bring your existing data in

- Headings: Bring your existing data in · Parties · Inventory · Vendor Invoice
- Actions/buttons: 
- API calls:
  - `GET /api/core/imports/legacy/capabilities`

## `/import-data/parties` — Import Parties

- Headings: Import Parties · AI-Assisted Import · Use Our Template
- Actions/buttons: [record button]
- Form fields:  [file]
- API calls:
  - `GET /api/core/parties/import/capabilities`

## `/business-tools` — Printing Templates

- Headings: Printing Templates · Sales · A4 Full · A5 Compact · A4 Wide · Purchase · Number Prefixes
- Actions/buttons: [record button] · [record button] · [record button] · Create New Prefix
- Empty state: No prefixes yet. Numbers typed by hand are saved exactly as entered until you add one.
- API calls: (none beyond shell)

## `/storefront-design` — Storefront Design

- Headings: Storefront Design · Edit your site where it stands · Shop address
- Actions/buttons: Save
- Form fields: /shop/* [text]
- API calls:
  - `GET /api/pos/admin/entitlements`
  - `GET /api/pos/admin/storefront/v2`

## `/storefront-blog` — Journal

- Headings: Journal · Write a post · Posts
- Actions/buttons: View journal ↗ · Show Journal in the shop · Choose picture · [record button] · Publish post
- Form fields:  [file] · Excerpt (optional) [text] · Post* [textarea] · Published — visible on the shop [checkbox] · Title* [text]
- Empty state: Nothing written yet
- API calls:
  - `GET /api/pos/admin/blog`
  - `GET /api/pos/admin/entitlements`
  - `GET /api/pos/admin/webstore`

