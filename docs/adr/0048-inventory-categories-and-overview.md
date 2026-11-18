# ADR 0048: Stock item categories, category images and the operations inventory page

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0027 (inventory), ADR 0038 (variants), ADR 0043 (category order), ADR 0044 (operations menu)

## Context

The operations menu (ADR 0044, the distribution partner's site) showed Inventory with a submenu of setup pages, and
its Product Category page was the restaurant's: categories of menu products, each with a kitchen/bar station. A
distribution business files its stock items by category, wants the inventory page to open on those categories as tiles,
and has no till, so the station means nothing there.

## Decisions

1. **One category list per organization.** Stock items get an optional `category_id` into `product_categories`, the
   same list the catalog uses. Categories gain:
   - a `description` (up to 500 characters);
   - a `parent_id`, one level deep. The parent must be an active top-level category other than itself, and a category
     with secondary categories stays top level. The service checks this.
   - a tile image.

   The station stays in the database (the till still prints by it) but is no longer required.

2. **Images live in Postgres.** `product_category_images` holds the bytes (RLS, cascade with the category).
   - The browser resizes to at most 800 px WebP, lowering quality until it fits 300 KB.
   - The api takes WebP, PNG or JPEG, checked by the file's first bytes, never trusting the declared type. Raw bodies
     go to `PUT /catalog/categories/:id/image` through a body parser that only accepts those types and only up to
     300 KB; JSON keeps its default limit.
   - The category's `imageVersion` changes with the image. `GET …/image` is read with the token and cacheable for a
     year, since the version is in its URL.
   - Idempotency fingerprints a raw upload by its bytes' hash.
3. **Audit.** Categories log `parentId` and `imageVersion`, never the image bytes or the description (free text, as
   for products). Stock items log `categoryId`. An image change is a category update.
4. **Module boundaries.** Inventory checks a category through `CatalogService.assertActiveCategory` (exists, not
   archived). Variants take their parent item's category.
5. **The operations menu's Inventory is one item.**
   - Its page opens on filters (category, stock level, warehouse), then the categories as tiles. A top-level
     category's count includes its secondary ones.
   - A tile lists its items with quantity and value; chips narrow to a secondary category.
   - "Find a category or product" searches both.
   - Export downloads what is listed as CSV with a byte order mark, which Excel opens. It is built in the browser from
     what the page already has; no export endpoint and no new library.
   - More holds the old tabs (receive, adjust, transfer, history, items, warehouses) and the setup pages (variants,
     attributes, units, adjustments, bills of materials, production).
   - Add New Item files the item under a category.
   - The default menu keeps the tabbed page.
6. **The category dialog** asks for name, description, secondary category and tile image. Where items print shows only
   to organizations with the till (`pos`). The Product Category page shows each category's image or colour and
   description, with secondary categories under their parent. Only top-level categories drag. Without the till it
   counts stock items, with it menu products.

## Consequences

- Tile colours without an image come from the table palette tokens, picked by the category id.
- Images are small and few (one per category), so Postgres is fine; moving them to object storage later only changes
  the image service.
- Not in this step: the full-page Add Item form (image, brand, pack size, perishable/expiry), vendor invoice import,
  and a category column in the item import.
