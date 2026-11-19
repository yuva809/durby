# ADR 0063: Order History for approvals, requests from branches only, approving against what is on hand

- Status: accepted (2026-11-19)
- Date: 2026-11-19
- Builds on: ADR 0045 (branch requests), ADR 0053 (request cart), ADR 0059 (the branch's view)

## Context

At the distributor, owners and admins approve branch requests under "Stock Requests", while "Order History" in their
menu held customer sales orders: approvals were not where they looked. Owners and the warehouse could also open the
request cart and ask the warehouse for goods themselves. The approval dialog showed only what was asked, not what the
warehouse had, and its columns didn't line up.

## Decisions

1. **Order History is the branch requests**, in the operations menu, for everyone who reads them: owners and admins
   approve there, branches follow theirs (Stock Requests is merged into it). Customer orders keep their own item,
   **Sales Orders** (`/orders`), and their pages say so.
2. **Requests come from the branches only.** The request cart and "Request stock" are offered to those who ask for
   goods and don't approve them; `/requests/new` tells an approver to approve in Order History. The api refuses a
   request from someone holding `orders.requests.approve` (403 `orders.request_branch_only`).
3. **Approving against what is on hand**: the dialog shows Requested, On hand (the source warehouse's stock, read
   when it opens) and To send; a line short of stock starts at what is there and says how much is missing
   ("Short 2 pc"). The quantity dialogs (approve, pick, receive) have headings for every column, units spelled out,
   and fixed widths for the numbers.

## Consequences

- An owner who also runs a branch needs a branch account to send its requests.
- Restaurants and others without the operations menu keep Stock Requests under its name.
