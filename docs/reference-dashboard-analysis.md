# Reference dashboard analysis (MerolIMS `app-dev.meroims.com/`)

Scope: the dashboard page and its navigation shell only. Reference is used to understand observable design patterns; Durby gets an original implementation (no copied code, assets, branding or wording).

## Method and limits

| Item | Detail |
| --- | --- |
| Tools used | REA `list_browser_targets`, `capture_web_screenshot` (2400×1442 PNG), `inspect_web_page` (DOM + accessibility tree, passive) against a user-signed-in Chrome on `127.0.0.1:9223`. Earlier research in `docs/meroims/` used as secondary evidence. |
| Session | Signed in by the user; no login or access-control bypass. Nothing was clicked, so no records were created. |
| Not observed | REA is passive: no scrolling, clicking or filter changes were performed by me. Lower sections (below the KPI row) are known from the accessibility tree only, not from a screenshot. Hover tooltips, loading/error/empty-state transitions and responsive behaviour are **unverified**. |
| Confidence | **High** = visible in screenshot and a11y tree; **Med** = a11y tree/labels only; **Low** = inferred. |

## Shell (High, from screenshot)

- Left sidebar ≈ 240 css px wide (estimate: 480 px at 2× in the capture), light grey, collapsible via a chevron button ("Toggle sidebar"). Header: logo + product name + subtitle, then a full-width "Switch Profile" button.
- Nav groups (uppercase small headings): PLATFORM (Dashboard), BUSINESS OPERATIONS (Branches & Warehouses, Inventory, Sales, Purchase; expandable), POINT OF SALE (Retail Till, POS), RESTAURANT (Restaurant Till, Tables & QR, Waiter View, Kitchen, Bar), WEB STORE, FINANCIAL MANAGEMENT (Expenses, Accounting), ADMINISTRATION & REPORTS (Management, Opening Balance, Reports, Audit Log, Manage Staffs), TOOLS & UTILITIES (Import Data, Business Tools, Feedback). Active item: tinted pill, accent text. User menu at the bottom (org avatar + name).
- Top bar: pill search ("Search items, parties, bills, entries…", `searchbox`), "Quick Add" pill button, bell with numeric badge (2).
- Under the bar: a trial banner (days remaining + "Choose a plan" CTA).
- Main column: padded, content width ≈ 720 css px at the captured viewport (≈ 1440 px wide window, estimate).

## Header block (High)

- Overline: org name · "AS OF <date>". Title "Dashboard". Range line: `<from> – <to> · compared with <prior from> – <prior to>` (prior range = same length immediately before).
- Period tablist (segmented control): Last 7 days, Last 30 days (default), This month, Last 90 days, Last 12 months.
- Quick actions (links): New invoice (primary, filled), Payment in, Purchase bill, Inventory, Accounts (outlined pills, icon + label).
- Observed oddity: header dates are in a different calendar (2083-…) than chart labels ("Oct 1 …"). Durby must use one calendar/timezone consistently.

## Needs attention (High)

Titled section with an item count ("1 item"); each item is a card with a status dot, title and detail, e.g. "Low stock — 4 items under threshold" (links to inventory filtered to low stock).

## KPI cards (High for values and layout; click behaviour Med)

Two rows of four, joined in a single rounded container with dividers (not separate cards). All eight are `link`s, so they are clickable; destinations are in the route table below.

| KPI | Main value | Supporting text | Delta vs prior | Sparkline |
| --- | --- | --- | --- | --- |
| Revenue | Rs. 15,880 | "11 invoices · avg Rs. 1,444" | −64.8 % (red pill, down arrow) "vs prior 30 days" | area sparkline ("Daily sales"), end dot |
| Gross profit | Rs. 7,691 | "48.4% margin" | none | none |
| Net profit | Rs. 7,691 | "48.4% net margin" | −65.2 % | area sparkline ("Net result per period") |
| Cash & bank | Rs. 1,00,000 | "1 account · today" | none (point-in-time) | none |
| Receivables | Rs. 2,42,000 | "0 open invoices · 0 parties" | none | none |
| Payables | Rs. -5,30,000 | "0 open bills · 0 suppliers" | none | none |
| Stock value | Rs. 84,40,007 | "157 items · 37.9K units · at cost" + "4 LOW" badge | none | none |
| Purchases | Rs. 0 | "0 bills" | "vs prior 30 days" (no %) | none |

Formatting: `Rs.` prefix, Indian digit grouping (1,00,000), compact units (37.9K). Deltas only on period flow metrics, not on balances.

Data inconsistencies in the reference (do not replicate): receivables show 2,42,000 with "0 open invoices"; payables are negative; cash-flow closing (1,61,000) ≠ cash position (1,00,000). Treat the reference as dev data, not a model of correct accounting.

## Widgets (a11y tree; chart geometry Med, tooltips unverified)

| Widget | Content observed | Chart type | Switch / links |
| --- | --- | --- | --- |
| Profit & loss — Income against costs | Series Income, Costs, Net; buckets by week ("Oct 1 to Oct 7: income …, costs …, net …") with Y axis 0–10.0K | Grouped bars per bucket plus net (Med) | Chart/Table tabs; link "Statement" |
| Cash position | Total Rs. 1,00,000.00; "BALANCES TODAY" per account (Cash: Rs. 1,00,000.00) | Headline + list | "Accounts" link |
| Cash flow | Opening 45.1K, Money in +115.9K, Money out 0, Closing 161.0K, Y axis 0–200.0K | Waterfall / step bars (Med; segments are separate buttons) | "Report" link |
| Sales against purchases | Series Sales, Purchases per period, Rs. 15,880.00 | Paired bars or lines (Low: only the image alt text and legend were read) | Chart/Table tabs; "Sales register" link |
| Sales by category | Total Rs. 15,880.00; top 5 + "Other" with % and amount (Seafood Special 25.5 %, …, Other 26.4 %) | Donut (graphics-symbol segments + legend list) (Med) | "By item" link |
| Receivables | Total, "NOTHING OVERDUE", BY AGE buckets 0-30/31-60/61-90/90+, LARGEST DEBTORS (empty text "No customer owes anything.") | Stacked age bar + list | "Aging" link |
| Payables | Total, "NOTHING PAST DUE", same buckets, LARGEST CREDITORS (empty text) | same | "Aging" link |
| Where the money went | Total costs Rs. 8,189.00, −64.5 %, ranked rows "1 Cost of Goods Sold Rs. 8,189.00 100% of costs" | Ranked bars | "Statement" link |
| Top products — What sold most | Top 5: rank, name, amount, "N sold" | Ranked list | "By item" link |
| Top customers — Who bought most | Rank, name, amount, "N invoices" ("Cash sale" is the walk-in bucket) | Ranked list | "By customer" link |
| Branch performance — Sales by branch | Per branch: invoices, % of sales, delta, amount; legend "This period" / "Period before" | Paired bars | "Branches" link |
| Inventory health | Stock value; In stock 153 / Low stock 4 / Out of stock 0 (links to filtered inventory); dated-stock empty text; watch list "name (SKU) 10 of 15 67 %" (stock cover vs threshold) | Stacked "Items by stock cover" bar + list | "Inventory" link; rows link to product |
| Operations — The queue today | Stock requests awaiting a decision, Shipments on the road, POS orders pending, Service visits due (each count, all 0) | Definition list | each links to its list |

Empty states are written as sentences per widget ("Nothing is owed to suppliers.", "No dated stock near its date."), not generic blanks (High).

## Interaction and period behaviour

- Verified from labels: period tabs exist; range text shows both the current and prior range; delta pills say "vs prior 30 days" (text includes the period length).
- **Unverified (needs a live click-through):** whether each tab refetches everything, whether balances (cash, receivables, stock) stay fixed, the comparison rule for "This month", and the bucket size per period.
- Drill-down routes (from `docs/meroims/docs/02-navigation-and-route-map.md`, OBS): accounting reports with `from/to/asOf` query params, sales/purchase registers, `inventory?stock=low_stock|out_of_stock`, sales-by-item/customer, stock requests.

## Data dependencies (what a faithful dashboard needs)

Invoices/orders with lines and tax, COGS per line, payments with method and account, expenses, purchase bills, supplier/customer balances with due dates (aging), cash/bank accounts and opening balance, stock levels with thresholds, branches, pending POS/kitchen orders, daily/weekly bucketed series for each period plus the prior period.

## Unverified assumptions

- Chart types for Sales against purchases and Cash flow beyond labels.
- Tooltip contents, hover and focus states, keyboard behaviour.
- Responsive/tablet layout and sticky elements (topbar looks fixed; unconfirmed).
- Anything about the reference's internal stack or API. None is claimed.
