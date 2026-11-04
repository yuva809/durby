# ADR 0028: Recipes, dish cost and stock consumption from table-service sales

- Status: accepted (2026-11-04)
- Date: 2026-11-04
- Step: inventory Step 2 (docs/modules/inventory.md → Step 2)

## Context

Restaurants want to know what a dish costs and earns, and want stock to go down when dishes are sold, without
counting by hand. Menu products live in catalog, ingredients in inventory, sales in pos (ADR 0016, 0027).

## Decisions

1. **Recipes belong to inventory** and point at catalog products by id **without a foreign key**: ADR 0024 decides
   "sold" by foreign-key violations on `products`; a recipe must not block deleting a never-sold product.
   Inventory checks products through catalog's public service and ignores recipes of products that are gone.
2. **Dish cost uses the current cost**: the organization-wide weighted average of stock on hand, else the last
   movement's unit cost. Margin is on the net price; the target food cost is a setting.
3. **Consumption is event-driven** (ADR 0013): pos emits `pos.kitchen_ticket.created` with ids, product ids and
   signed quantities; inventory books one consumption document per ticket in the outbox transaction. pos never
   imports inventory. The warehouse is the one marked as supplying the ticket's station at its location.
4. **Sales are never refused for stock**: consumption may take a level below zero whatever
   `inventory.allowNegativeStock` says; the sale already happened. Negative levels show in red as a signal to
   receive or count.
5. **Idempotent twice over**: the outbox's processed events and `UNIQUE (tenant_id, source_ticket_id)`.

## Consequences

- Stock only follows sales for products with recipes; drinks sold by the piece get a one-line recipe.
- The sales profit report (Step 4) reads consumption values as the cost of sales.
