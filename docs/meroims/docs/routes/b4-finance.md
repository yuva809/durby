# Route dossiers — b4-finance

Generated from `evidence/routes/b4-finance.json` (CDP driver: UI inventory + API calls, read-only, writes blocked at network layer)
and `evidence/captures/shapes-b4-finance.txt` (REA passive capture: value-free JSON shapes). Shell calls made on every page are omitted.
Blocked write attempts in this batch: 0

## `/accounts` — Manage Accounts

- Row open: clicked (/accounts → /accounts)
- Headings: Manage Accounts · ACCOUNTS · Cash · DETAIL GENERAL LEDGER · TRANSACTIONS
- Actions/buttons: [record button] · Name · Type · Active · [record button] · Archive Nabil Bank · Manage Amount
- Table columns: TXN DATE | TXN TYPE | TXN NO. | REFERENCE NO | DESCRIPTION | DEBIT | CREDIT | BALANCE
- Form fields: Search accounts… [search]
- Empty state: No transactions on this account yet.
- API calls:
  - `GET /api/accounting/reports/account-ledger/{id} ?{from,limit,to}`
  - `GET /api/core/accounts`
  - `GET /api/core/accounts/{id}/transactions`

## `/accounts/chart-of-account` — Chart of Account

- Headings: Chart of Account
- Actions/buttons: [record button] · Accounts · Groups · Tree · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · More actions
- Tabs: Accounts · Groups · Tree
- Table columns: ACCOUNT CODE | NAME | ACCOUNT TYPE | PARENT GROUP | BALANCE
- Form fields: Hide system accounts [checkbox] · Search by name, code or group… [search] · Show archived [checkbox]
- API calls:
  - `GET /api/accounting/chart-accounts`
  - `GET /api/accounting/chart-accounts/tree`
- Tab views:
  - **Accounts**: headings Chart of Account; fields 3; columns ACCOUNT CODE | NAME | ACCOUNT TYPE | PARENT GROUP | BALANCE
  - **Groups**: headings Chart of Account; fields 0; columns GROUP NAME | GROUP TYPE | GROUP PARENT | DESCRIPTION
  - **Tree**: headings Chart of Account; fields 1; columns ACCOUNT | AMOUNT (RS.)

## `/accounting-workbench` — Accounting Workbench

- Row open: clicked (/accounting-workbench → /accounting-workbench)
- Headings: Accounting Workbench · JV-2026-000056 · LINES · AUDIT TRAIL
- Actions/buttons: Journals · Manual Entry · Locks & Close · Tax Filing · [record button] · Mappings · Journal status · CSV · Excel · Print · More actions · Previous page · [record button] · [record button] · [record button] · [record button] · [record button] · [record button] · Next page · Close
- Tabs: Journals · Manual Entry · Locks & Close · Tax Filing · Subledgers · Mappings
- Table columns: JOURNAL | DATE | NARRATION | SOURCE | AMOUNT | STATUS  ‖  ACCOUNT | DESCRIPTION | DEBIT | CREDIT
- Form fields: From [date] · Select JV-2026-000047 [checkbox] · Select JV-2026-000048 [checkbox] · Select JV-2026-000049 [checkbox] · Select JV-2026-000050 [checkbox] · Select JV-2026-000051 [checkbox] · Select JV-2026-000052 [checkbox] · Select JV-2026-000053 [checkbox] · Select JV-2026-000054 [checkbox] · Select JV-2026-000055 [checkbox] · Select JV-2026-000056 [checkbox] · Select all rows [checkbox] · Status [button] · To [date]
- Detail panel/dialog: headings [panel title redacted] · LINES · AUDIT TRAIL; actions Close
- API calls:
  - `GET /api/accounting/cash-bank-mappings  ← tab Mappings`
  - `GET /api/accounting/chart-accounts`
  - `GET /api/accounting/chart-accounts  ← tab Mappings`
  - `GET /api/accounting/fiscal-years  ← tab Locks & Close`
  - `GET /api/accounting/journals ?{page,perPage}`
  - `GET /api/accounting/journals/{id}`
  - `GET /api/accounting/mappings  ← tab Mappings`
  - `GET /api/accounting/period-locks  ← tab Locks & Close`
  - `GET /api/accounting/reports/subledger-balances  ← tab Subledgers`
  - `GET /api/accounting/tax/filings  ← tab Tax Filing`
  - `GET /api/core/accounts  ← tab Mappings`
- Tab views:
  - **Journals**: headings Accounting Workbench · JV-2026-000056 · LINES · AUDIT TRAIL; fields 14; columns JOURNAL | DATE | NARRATION | SOURCE | AMOUNT | STATUS
  - **Manual Entry**: headings Accounting Workbench; fields 10; columns ACCOUNT | DESCRIPTION | DEBIT | CREDIT
  - **Locks & Close**: headings Accounting Workbench · FISCAL YEARS · PERIOD LOCKS; fields 6; columns 
  - **Tax Filing**: headings Accounting Workbench; fields 2; columns PERIOD | OUTPUT VAT | INPUT VAT | NET PAYABLE | STATUS
  - **Subledgers**: headings Accounting Workbench · CUSTOMERS (RECEIVABLES) · SUPPLIERS (PAYABLES); fields 0; columns 
  - **Mappings**: headings Accounting Workbench · POSTING ROLES · CASH / BANK ACCOUNTS; fields 23; columns 

## `/accounting` — Accounting Reports

- Headings: Accounting Reports · TRIAL BALANCE
- Actions/buttons: Trial Balance · Profit & Loss · Balance Sheet · [record button] · Cash Flow · Day Book · CSV · Excel · Print
- Table columns: CODE | ACCOUNT | TYPE | DEBIT | CREDIT
- Form fields: From [date] · Show BS (Nepali) dates [checkbox] · To [date]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/accounting/reports/trial-balance ?{from,to}`

## `/cheque-register` — Cheque Register

- Headings: Cheque Register
- Actions/buttons: Direction · Status · [record button] · CSV · Excel · Print
- Table columns: CHEQUE # | DIRECTION | BANK NAME | PAYEE | CHEQUE DATE | AMOUNT | STATUS
- Form fields: Direction [button] · Select all rows [checkbox] · Status [button]
- API calls:
  - `GET /api/accounting/cheques`

## `/cheque-register/new` — Record Cheque

- Headings: Record Cheque
- Actions/buttons: Direction · [record button] · Save
- Form fields: Amount ** [text] · Bank Name [text] · Cheque Date [date] · Cheque Number [text] · Direction [button] · Notes [textarea] · Payee [text] · Received from (party or account) [button]
- API calls:
  - `POST /api/auth/refresh`

## `/quick-receipt` — Quick Receipt

- Headings: Quick Receipt
- Actions/buttons: Quick Receipt status · [record button] · CSV · Excel · Print
- Table columns: DATE | REFERENCE | ROWS | TOTAL | STATUS | NOTE
- Form fields: Select all rows [checkbox] · Status [button]
- API calls:
  - `GET /api/accounting/quick-receipts ?{page,perPage}`

## `/quick-payment` — Quick Payment

- Headings: Quick Payment
- Actions/buttons: Quick Payment status · [record button] · CSV · Excel · Print
- Table columns: DATE | REFERENCE | ROWS | TOTAL | STATUS | NOTE
- Form fields: Select all rows [checkbox] · Status [button]
- API calls:
  - `GET /api/accounting/quick-payments ?{page,perPage}`

## `/bank-reconciliation` — Bank Reconciliation

- Headings: Bank Reconciliation · STATEMENTS
- Actions/buttons: Import Statement
- Empty state: No statements yet — import your first one.
- API calls:
  - `GET /api/accounting/reconciliation/statements`
  - `GET /api/core/accounts`

## `/opening-balance` — Opening Balance

- Headings: Opening Balance
- Actions/buttons: Account · [record button] · All · GL accounts · Cash & Bank · Customers · Suppliers
- Tabs: Account · Product
- Table columns: NAME (CODE) | ACCOUNT TYPE | PARENT GROUP | OPENING
- Form fields: As of* [date] · Search opening balances [search]
- API calls:
  - `GET /api/accounting/fiscal-years`
  - `GET /api/accounting/opening-balances ?{asOf}`
  - `GET /api/core/accounts`
  - `GET /api/core/parties ?{page,partyType,perPage}`
  - `GET /api/core/stock/opening  ← tab Product`
- Tab views:
  - **Account**: headings Opening Balance; fields 2; columns NAME (CODE) | ACCOUNT TYPE | PARENT GROUP | OPENING
  - **Product**: headings Opening Balance; fields 2; columns LOCATION | WAREHOUSE | QUANTITY | RATE | AMOUNT

