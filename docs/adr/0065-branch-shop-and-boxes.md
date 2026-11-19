# ADR 0065: A branch shops per category, by the box or the piece

- Status: accepted (2026-11-19)
- Date: 2026-11-19
- Builds on: ADR 0053 (request cart), ADR 0055 (pack size), ADR 0059 (the branch's view), ADR 0062 (best before)

## Context

A branch opens a category on its Inventory page to order from it, as it knows from its old app: brand, product,
pack size, how much there is, unit, best before and a cart button per line. Goods come in boxes (12 × 300 g), and a
branch orders some by the box and some by the piece.

## Decisions

1. **A category is a shopping list for a branch** (someone who sends requests, i.e. who may and doesn't approve):
   Brand · Product · Pack size · Quantity (what the main warehouse has) · Unit · Best before (the main warehouse's
   earliest) · cart. The request cart's availability carries brand and pack size for it. The cart is the request
   cart's own (kept in the browser per branch); "Open cart" goes on to send it.
2. **By the box or the piece**: an item counted in pieces with a pack count above 1 offers Box (its count) or pc.
   By the box, − and + move whole boxes, the quantity shows boxes and "= 24 pc" what that is; the cart and the
   request keep pieces, so nothing else changes. A box is added only while a whole box is there. The choice is kept
   per item beside the cart. Both the category list and the cart page use the same control.

## Consequences

- Items counted in boxes (unit `box`) are ordered in boxes only; the choice is for items counted in pieces.
