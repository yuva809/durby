# Route dossiers — b1-commerce

Generated from `evidence/routes/b1-commerce.json` (CDP driver: UI inventory + API calls, read-only, writes blocked at network layer)
and `evidence/captures/shapes-b1-commerce.txt` (REA passive capture: value-free JSON shapes). Shell calls made on every page are omitted.
Blocked write attempts in this batch: 0

## `/sales/invoices` — Sales Invoice

- Row open: clicked (/sales/invoices → /sales/invoices)
- Headings: Sales Invoice
- Actions/buttons: Export period · Export Excel · Active · More actions · Close
- Table columns: NUMBER | DATE | PARTY | TOTAL | RECEIVED | BALANCE | ACTIONS  ‖  ITEM | QTY | RATE | DISCOUNT | AMOUNT
- Form fields: Date filter [date] · Search number, party, notes — or “cash” [search] · Status filter [select-one]
- Empty state: No payments recorded against this invoice.
- Detail panel/dialog: headings Sales Invoice; actions Close
- API calls:
  - `GET /api/core/accounts`
  - `GET /api/core/documents ?{page,perPage,type}`
  - `GET /api/core/documents/{id}`

## `/sales/invoices/create` — Create Sales Invoice

- Headings: Create Sales Invoice · ITEMS · ADJUSTMENTS · RECEIVE ACCOUNT · NOTES & IMAGES · TERMS & SIGNATURE
- Actions/buttons: Cash Sale · Party Sale · Enter the sales invoice number manually · Add Row · Duplicate row · Remove row · Add Discount · Add Tax · Add Charges · No account needed (on credit) · TDS is Disabled · Select TDS Account · Add image · Bold · Italic · Underline · Bullet list · Numbered list · Add Signature · Cancel · Save & Add New · Save as Draft · Save
- Tabs: Cash Sale · Party Sale
- Form fields:  [file] · % [text] · Amount [text] · Date [date] · No account needed (on credit) [button] · Notes [textarea] · Quantity [text] · Rate [text] · Receive total amount [checkbox] · Received amount [text] · Rs. [text] · Search customers… [text] · Search product, code, or barcode [text] · Select TDS Account [button] · Signature [select-one] · TDS Amount [text] · TDS Type [text]
- Empty state: No credit term – amount received.
- API calls:
  - `GET /api/accounting/tax/tds-types`
  - `GET /api/core/accounts`
  - `GET /api/core/credit-terms`
  - `GET /api/core/lookups`
  - `GET /api/core/signatures`

## `/sales/quotations` — Quotations

- Row open: clicked (/sales/quotations → /sales/quotations)
- Headings: Quotations
- Actions/buttons: Export period · Export Excel · Active
- Table columns: NUMBER | DATE | PARTY | TOTAL | STATUS | ACTIONS
- Form fields: Date filter [date] · Search number, party, or notes [search] · Status filter [select-one]
- Empty state: No quotations yet.
- API calls:
  - `GET /api/core/accounts`
  - `GET /api/core/documents ?{page,perPage,type}`

## `/sales/quotations/create` — Create Quotation

- Headings: Create Quotation · ITEMS · ADJUSTMENTS · NOTES & IMAGES · TERMS & SIGNATURE
- Actions/buttons: Enter the quotation number manually · Add Row · Duplicate row · Remove row · Add Discount · Add Tax · Add Charges · Add image · Bold · Italic · Underline · Bullet list · Numbered list · Add Signature · Cancel · Save & Add New · Save
- Form fields:  [file] · % [text] · Amount [text] · Date [date] · Notes [textarea] · Quantity [text] · Rate [text] · Rs. [text] · Search customers… [text] · Search product, code, or barcode [text] · Signature [select-one]
- API calls:
  - `GET /api/core/accounts`
  - `GET /api/core/credit-terms`
  - `GET /api/core/lookups`
  - `GET /api/core/signatures`

## `/sales/returns` — Sales Return

- Row open: clicked (/sales/returns → /sales/returns)
- Headings: Sales Return
- Actions/buttons: Export period · Export Excel · Active
- Table columns: NUMBER | DATE | PARTY | TOTAL | STATUS | ACTIONS
- Form fields: Date filter [date] · Search number, party, or notes [search] · Status filter [select-one]
- Empty state: No sales returns yet.
- API calls:
  - `GET /api/core/accounts`
  - `GET /api/core/documents ?{page,perPage,type}`

## `/sales/returns/create` — Create Sales Return

- Headings: Create Sales Return · ITEMS · ADJUSTMENTS · PAID FROM · NOTES & IMAGES · TERMS & SIGNATURE
- Actions/buttons: Cash Return · Party Return · Enter the sales return number manually · Add Row · Duplicate row · Remove row · Add Discount · Add Tax · Add Charges · Select account… · Add image · Bold · Italic · Underline · Bullet list · Numbered list · Add Signature · Cancel · Save & Add New · Save
- Tabs: Cash Return · Party Return
- Form fields:  [file] · % [text] · Amount [text] · Amount paid [text] · Date [date] · Notes [textarea] · Pay the full amount [checkbox] · Quantity [text] · Rate [text] · Rs. [text] · Search customers… [text] · Search product, code, or barcode [text] · Select account… [button] · Signature [select-one]
- API calls:
  - `GET /api/core/accounts`
  - `GET /api/core/credit-terms`
  - `GET /api/core/lookups`
  - `GET /api/core/signatures`

## `/sales/payment-in/{id}` — Payment In

- Row open: clicked (/sales/payment-in → /sales/payment-in/{id})
- Headings: Payment In · ALLOCATIONS
- Actions/buttons: Send Email · View Print Preview · Void · Print
- Table columns: TYPE | DATE | ENTRY NO | AMOUNT  ‖  ACCOUNT | DESCRIPTION | DEBIT | CREDIT
- API calls:
  - `GET /api/accounting/journals/by-source/{id}`
  - `GET /api/core/payments ?{direction,page,perPage}`
  - `GET /api/core/payments/{id}`
  - `GET /api/core/payments/{id}/allocations`

## `/sales/payment-in/create` — Add Payment In

- Headings: Add Payment In
- Actions/buttons: Select bank account · Split Payment · Bank Charge is Disabled · Select Bank Charge Account · TDS is Disabled · Select TDS Account · Attach file · Save
- Form fields:  [file] · Amount * [text] · Bank Charge Amount [text] · Notes [textarea] · Payment Code [text] · Payment Mode [select-one] · Payment Reference# [text] · Received Date * [date] · Search or select party [text] · Select Bank Charge Account [button] · Select TDS Account [button] · Select bank account [button] · TDS Amount [text] · TDS Type [text]
- API calls:
  - `GET /api/accounting/tax/tds-types`
  - `GET /api/core/accounts`
  - `GET /api/core/cheque-statuses`

## `/purchases/bills/create` — Create Purchase Bill

- Headings: Create Purchase Bill · ITEMS · ADJUSTMENTS · PAY ACCOUNT · NOTES & IMAGES · TERMS & SIGNATURE
- Actions/buttons: Cash Purchase · Party Purchase · Enter the purchase bill number manually · Add Row · Duplicate row · Remove row · Add Discount · Add Tax · Add Charges · No account needed (on credit) · TDS is Disabled · Select TDS Account · Add image · Bold · Italic · Underline · Bullet list · Numbered list · Add Signature · Cancel · Save & Add New · Save
- Tabs: Cash Purchase · Party Purchase
- Form fields:  [file] · % [text] · Amount [text] · Date [date] · No account needed (on credit) [button] · Notes [textarea] · Paid amount [text] · Pay total amount [checkbox] · Quantity [text] · Rate [text] · Rs. [text] · Search product, code, or barcode [text] · Search suppliers… [text] · Select TDS Account [button] · Signature [select-one] · TDS Amount [text] · TDS Type [text]
- Empty state: No credit term – amount received.
- API calls:
  - `GET /api/accounting/tax/tds-types`
  - `GET /api/core/accounts`
  - `GET /api/core/credit-terms`
  - `GET /api/core/lookups`
  - `GET /api/core/signatures`

## `/purchases/returns` — Purchase Return

- Row open: clicked (/purchases/returns → /purchases/returns)
- Headings: Purchase Return
- Actions/buttons: Export period · Export Excel · Active
- Table columns: NUMBER | DATE | PARTY | TOTAL | STATUS | ACTIONS
- Form fields: Date filter [date] · Search number, party, or notes [search] · Status filter [select-one]
- Empty state: No purchase returns yet.
- API calls:
  - `GET /api/core/accounts`
  - `GET /api/core/documents ?{page,perPage,type}`

## `/purchases/returns/create` — Create Purchase Return

- Headings: Create Purchase Return · ITEMS · ADJUSTMENTS · RECEIVED INTO · NOTES & IMAGES · TERMS & SIGNATURE
- Actions/buttons: Cash Return · Party Return · Enter the purchase return number manually · Add Row · Duplicate row · Remove row · Add Discount · Add Tax · Add Charges · Select account… · Add image · Bold · Italic · Underline · Bullet list · Numbered list · Add Signature · Cancel · Save & Add New · Save
- Tabs: Cash Return · Party Return
- Form fields:  [file] · % [text] · Amount [text] · Amount received [text] · Date [date] · Notes [textarea] · Quantity [text] · Rate [text] · Receive the full amount [checkbox] · Rs. [text] · Search product, code, or barcode [text] · Search suppliers… [text] · Select account… [button] · Signature [select-one]
- API calls:
  - `GET /api/core/accounts`
  - `GET /api/core/credit-terms`
  - `GET /api/core/lookups`
  - `GET /api/core/signatures`

## `/purchases/payment-out` — Payment Out

- Row open: clicked (/purchases/payment-out → /purchases/payment-out)
- Headings: Payment Out
- Actions/buttons: 
- Table columns: DATE | PAYMENT NUMBER | PARTY | AMOUNT | METHOD | ALLOCATIONS | STATUS | ACTIONS
- Form fields: Status [select-one]
- Empty state: No payments recorded yet.
- API calls:
  - `GET /api/core/payments ?{direction,page,perPage}`

## `/purchases/payment-out/create` — Add Payment Out

- Headings: Add Payment Out
- Actions/buttons: Select bank account · Split Payment · Bank Charge is Disabled · Select Bank Charge Account · TDS is Disabled · Select TDS Account · Attach file · Save
- Form fields:  [file] · Amount * [text] · Bank Charge Amount [text] · Notes [textarea] · Payment Date * [date] · Payment Mode [select-one] · Payment Number [text] · Payment Reference# [text] · Search or select party [text] · Select Bank Charge Account [button] · Select TDS Account [button] · Select bank account [button] · TDS Amount [text] · TDS Type [text]
- API calls:
  - `GET /api/accounting/tax/tds-types`
  - `GET /api/core/accounts`
  - `GET /api/core/cheque-statuses`

## `/expenses` — Expenses

- Row open: clicked (/expenses → /expenses)
- Headings: Expenses
- Actions/buttons: 
- Table columns: NUMBER | DATE | CATEGORY | ACCOUNT | NOTES | AMOUNT | ACTIONS
- Form fields: Account filter [select-one] · Category filter [select-one] · Date filter [date] · Search number, notes, or category [search]
- Empty state: No expenses yet.
- API calls:
  - `GET /api/core/accounts`
  - `GET /api/core/finance/categories ?{recordType}`
  - `GET /api/core/finance/records ?{page,perPage,recordType}`

## `/expenses/create` — Add Expense

- Headings: Add Expense
- Actions/buttons: Select Account · Remove line · Add Line · TDS is Disabled · Select TDS Account · Cancel · Save
- Table columns: ACCOUNT | AMOUNT | TAX
- Form fields: Amount [text] · Date* [date] · Due Date [date] · Notes [textarea] · Party Invoice Reference No [text] · Select Account [button] · Select Supplier / Party… [text] · Select TDS Account [button] · TDS Amount [text] · TDS Type [text] · Tax [select-one]
- API calls:
  - `GET /api/accounting/tax/tds-types`

