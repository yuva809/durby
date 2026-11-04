# ADR 0025: Bill layout settings, the waiter on the bill, and a bar station

- Status: accepted (2026-11-04); amends ADR 0016 decision 8
- Date: 2026-11-04
- Step: table service printing (docs/modules/pos.md → Printing, Stations)

## Context

Restaurants want the printed bill to look like the slips they know from other tills: their logo, name and contact
details on top, then who served, the table and guests, the bill number, the items and the total, then a thank-you in
their own words. They also run a bar next to the kitchen: drinks should print on a bar ticket, food on a kitchen
ticket. Until now the bill printed only the organization's name, every send was one kitchen ticket, and ADR 0016 §8
kept the waiter off everything printed.

## Decisions

1. **Header and footer are settings, the middle is code.** `pos.billHeader` (`logo`, `name`, `phone`, `email`,
   `website`) and `pos.billFooter` (`lines`, up to 4) are ADR 0010 settings at organization or location scope, edited
   with `platform.settings.manage`. Empty fields are left out; no `name` prints the organization's name, no `lines`
   prints the `pos.bill.thanks` label. The middle (waiter, table and guests, bill number, items, total) and the end
   ("Powered by" the theme's product name, date and time) are the same for every organization.
2. **The logo lives in the setting** as a `data:image/png|jpeg|webp` URL of at most 200 000 characters, shrunk to a
   small grayscale image by the browser before saving (thermal printers print black only). No file storage is needed
   for it; a logo is not a secret. A later file store can replace it with an expand/contract change of the schema.
3. **The bill names the waiter** (amends ADR 0016 §8): the order response carries `waiterName`, the display name of the
   member who opened the order (none when it has no display name), read through the platform port `MemberNames`. User ids are
   still never returned, and kitchen and bar tickets still don't name anyone.
4. **Stations per category.** `product_categories.station` is `kitchen` (default) or `bar`. A send splits its lines by
   their category's station into one ticket per station (kitchen first, consecutive sequence numbers, one
   transaction); a void splits by the station of the ticket that sent each voided line. `pos_kitchen_tickets.station`
   is a snapshot: changing a category later doesn't move old tickets. The send response keeps `ticketId` (the first
   ticket) and adds `ticketIds`.
5. **Each station prints as its own print job**, kitchen first, the next after the previous print dialog closes, so
   each can be sent to its own printer while printing stays browser printing (ADR 0016 §6).

## Consequences

- One expand migration: enum `prep_station`, the two `station` columns with default `kitchen`. Older releases ignore
  them; their sends keep making kitchen tickets.
- A per-product station (a drink in a food category) would be a nullable `products.station` override later.
- Printers per station need a print bridge; until then the browser asks for each job.
