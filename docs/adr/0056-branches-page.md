# ADR 0056: Branches page: address, archive, staff and warehouses per branch; approval switch

- Status: accepted (2026-11-18)
- Date: 2026-11-18
- Builds on: ADR 0044 (operations menu), ADR 0045 (branch stock requests), ADR 0053 (main warehouse)

## Context

The operations menu's Branches item showed the generic Settings → Locations list: names only. The distributor wants
each branch as a card with its address, the people working there and its warehouses, branches it closes kept but out
of the way, and a choice whether a branch's stock request waits for an owner or admin.

## Decisions

1. **Locations get an address and can be archived** (`locations.address` ≤ 200, `locations.archived_at`;
   expand-only). `PATCH /api/v1/locations/:id` takes `name`, `address` (null clears) and `archived`; still
   `platform.org.manage`, audited (`platform.location.updated`, snapshot with address and archivedAt).
   `GET /api/v1/locations` lists active locations, so every picker hides archived ones; `?includeArchived=true` adds
   them. Archiving keeps all data (stock, members, history); deleting stays possible only while nothing points at a
   location. Request destinations (ADR 0053) leave archived branches out.
2. **`/branches`** (`components/branches/branches-page.tsx`): a card per branch with its address, the active members
   limited to it with their roles (members of every location are not repeated on each card; needs
   `platform.users.read`), and "N warehouses" (active, not transit; needs inventory) linking to
   `/inventory/warehouses`. Search by name or address; "Show archived" with restore. Owners add, edit and archive.
   Only where the partner's brand uses the operations menu (`navLayout: 'operations'`, AsiaMight;
   `components/branches/branches-route.tsx`); elsewhere `/branches` stays the plain locations list.
3. **Setting `orders.requestsNeedApproval`** (boolean, default on; partner or organization), switched only on the
   Branches page by holders of `platform.settings.manage` ("Required" / "Not required"); the Settings list leaves it
   out, so organizations without the operations menu never see it. Off: a request
   is approved as it is sent: every line approved as asked, its transfer number taken, a second timeline step
   `approved` without a user (the setting decided, not a person), no notification to approvers. The warehouse finds it
   on its Picking list as before.

## Consequences

- Restaurants and others keep requests as they were: the setting defaults to on.
- A location-limited member of an archived branch keeps access to its data; archiving is not a way to lock people out
  (deactivate them in Manage Staff).
