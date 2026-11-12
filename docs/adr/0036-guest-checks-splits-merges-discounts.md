# ADR 0036: Guest checks, splits, merges and discounts

- Status: accepted (2026-11-12)
- Date: 2026-11-12
- Step: Billing & checkout (table service step 4, docs/modules/pos.md → Step 4). Builds on
  [ADR 0016](0016-table-service-before-tse.md) §3 (guest checks, not receipts), [ADR 0025](0025-bill-layout-and-stations.md)
  (bill layout) and [ADR 0033](0033-printers-print-queue-and-updates.md) (print queue).

## Context

The till prints a bill straight from the order, numbered with the order number. Restaurants need more: a numbered
guest check that can be reprinted with the same number and found again at a billing counter, separate checks for
guests who pay for their own items, a total divided equally between guests, one bill for two tables, and discounts
or comps with a reason. There is still no TSE, so Durby records no payment (ADR 0016 §3): everything here is a guest
check ("Zwischenrechnung – kein Kassenbeleg"). Tips depend on payments and wait for the fiscal module.

## Decisions

1. **A bill is the act of billing, a guest check is what is printed.**
   - **Bill (`pos_bills`).** It covers items of 1–10 open orders of one location; more than one order is a merge. Its
     contents are rows of its own:
     - `pos_bill_orders`: the orders it covers;
     - `pos_bill_items`: billed portions of order lines, with snapshots of name, price and rate;
     - `pos_bill_discounts`: the order discounts it takes in, per VAT rate.
   - **Guest check (`pos_guest_checks`).** It is numbered from the new series `pos.guestCheck` (`CHK-{YYYY}-{seq:6}`),
     with a `gross` snapshot. A single bill has one check. An equal split has one check per share, each with its
     amounts per VAT rate (`pos_guest_check_shares`). A reprint prints the same check, so it keeps its number.

2. **Append-only.** Bills, their rows, checks and shares are never updated or deleted, the same protection tickets
   have (no UPDATE/DELETE for `durby_app`, statement triggers, the append-only catalog test).
   - **Cancelling** a bill writes a `pos_bill_cancellations` row (one per bill, with a reason). Its checks then print
     "CANCELLED", and its items can be billed again.
   - **Cancelling needs `pos.bills.cancel`** (admin, manager; owner always). Cancelling and re-billing is a fraud risk,
     like voids.

3. **What is billed comes from the rows, never from a flag on the order.**
   - **Billed quantity.** A line's billed quantity is the sum of its portions on bills that are not cancelled. It never
     exceeds the line's net quantity.
   - **Order lock.** Every write that bills, voids or discounts takes the order row lock (`lockOrder`). A bill over
     several orders locks them in id order.
   - **Voids.** A void may only take unbilled portions; otherwise the answer is `409 pos.line_billed` (cancel the bill
     first).
   - **Closing.** Closing an order stays separate and doesn't require it to be billed: without payments, Durby can't
     know that the bill was settled.

4. **Splits.**
   - **By item.** The bill takes the chosen portions.
   - **Equally.** The bill takes everything unbilled on its orders and shares it into n checks (2–20). Each VAT rate's
     gross is divided by n in cents, and the remainder cents go to the first shares, so the shares add up exactly to
     the bill per rate. A share check lists its share per rate, not items.

5. **Discounts are order rows (`pos_order_discounts`), not bill rows.**
   - **What a discount is.** A discount takes a line or the whole order, as a percent or an amount, with a reason. A
     comp is a 100 % line discount. Its amount is fixed when it is given, from the unbilled items, and is stored per
     VAT rate (`pos_order_discount_parts`): a line discount has its line's rate, while a whole-order discount is spread
     pro rata over the rates, with the leftover cent on the rate with the largest share.
   - **Who and when.** Giving or removing one needs `pos.orders.discount` (admin, manager; owner always). Removing writes
     a counter-row (`voids_discount_id`). Discounts apply only to unbilled items.
   - **Billing a discount.**
     - A discounted line is billed whole, so a line discount never has to be prorated.
     - A whole-order discount goes onto a bill only when that bill takes everything still unbilled on the order;
       otherwise the answer is `409 pos.discount_needs_full_bill`.
     - The reasons are the setting `pos.discountReasons` (organization or location). While it is empty, the till
       offers built-in reasons from labels.

6. **Printing.** The bill printed from a till or the Android app is a guest check.
   - **Print jobs.** `pos_print_jobs.check_id` is added as nullable (expand), and a bill job carries the check to
     print. The receipt shows the check number where it showed the order number, "Share 2 of 4" on a share, discount
     lines, and "CANCELLED" on a cancelled check. The "Interim bill – not a fiscal receipt" notice stays on every check.
   - **Old jobs.** A bill job without a check (queued before this change) still prints from the order.

7. **Billing counter.** `/checkout` (nav "Checkout", `pos.bills.print`, feature `pos`) has three tabs:
   - open tables, with their unbilled amounts;
   - checks of the last 24 hours;
   - the history, by date and number.

   Each tab can reprint. The `billing` feature stays the separate invoicing module.

## Consequences

- The fiscal module will pay a guest check: payment, tip and TSE-signed receipt link to `pos_guest_checks`. Tips (tip
  per payment, tip report) are built then.
- An order with a cancelled bill keeps the cancellation in its history. Corrections are always new rows.
- A whole-order discount blocks splitting by item until it is removed. The till says so, and the alternative is
  splitting equally.
