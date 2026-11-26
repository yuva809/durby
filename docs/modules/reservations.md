# Reservations module: bookings, host stand, waitlist

> Status: **approved** 2026-10-31 (decisions Q1–Q9 and gaps 1–6 in [Decisions](#decisions-2026-10-31)). Building
> from R0.1. Decisions: [ADR 0019](../adr/0019-reservations-exclusion-constraint-and-redis-holds.md) (double
> booking, holds); public tenant resolution and realtime get ADRs in their steps (R2.1, RT.1).

## Decisions (2026-10-31)

| #   | Decision                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Public page at `/b/{slug}` on the partner domain. The server resolves the slug and sets the tenant context; a client-sent organization id is never trusted. Public routes are rate-limited and carry a honeypot field. Needs an ADR amending hard rule 1 (R2.1).                                                                         |
| Q2  | Audit gets a `guest` actor kind for online and self-service actions.                                                                                                                                                                                                                                                                     |
| Q3  | Seating does **not** open an empty pos order. No `reservations → pos` consumer.                                                                                                                                                                                                                                                          |
| Q4  | Realtime is SSE over `fetch` streaming + Redis pub/sub with polling as fallback; it ships after R1 (step RT.1) and never blocks it.                                                                                                                                                                                                      |
| Q5  | Tables are read through a pos read port (`PosFloorReader`); no floor module split.                                                                                                                                                                                                                                                       |
| Q6  | Two feature keys: `reservations` (staff/host) and `reservations.online` (widget), both in the `full` plan only (amended 2026-10-31: "Growth"/"Pro" don't exist). A standalone add-on is an [open question](#open-questions).                                                                                                             |
| Q7  | `pos_orders.covers` (nullable). The web pre-fills it from the seated reservation when the waiter opens the table (frontend composition; pos never reads reservations).                                                                                                                                                                   |
| Q8  | Guest retention is per organization (`reservations.guestRetentionMonths`), default 12 months after the guest's last visit.                                                                                                                                                                                                               |
| Q9  | Guest notices by email or in person for the MVP, behind a `GuestNotifier` channel interface (SMS later as another channel).                                                                                                                                                                                                              |
| G1  | Seating a walk-in from the host screen creates a reservation (source `walk_in`). Availability treats tables with an open pos order as occupied now (via `PosFloorReader`).                                                                                                                                                               |
| G2  | A `seated` booking keeps blocking its table past its planned end until finished / `pos.order.closed` (availability + write check, see [Overrun](#overrun)).                                                                                                                                                                              |
| G3  | Opening hours are platform settings added in **R0** (`openingHours`, `closedDates`); `reservations.serviceHours` only narrows them.                                                                                                                                                                                                      |
| G4  | `btree_gist`: `durby_migrator` owns the database and the extension is trusted, so the migration's `CREATE EXTENSION IF NOT EXISTS` works without a superuser. Verified locally (PG 18, same role setup as staging); the staging check is the first task of R1.3. Fallback: create it once as superuser in `infra/staging/postgres-init`. |
| G5  | **pos never imports reservations.** The `/host` screen and the `/service` floor are composed in the web app from both APIs.                                                                                                                                                                                                              |
| G6  | R1 `/host` ships on 30 s polling. SSE (RT.1) needs proxy buffering off (Caddy `flush_interval -1` on the stream route) and a heartbeat comment every 15 s.                                                                                                                                                                               |

Restaurants take table bookings (by staff now, online later), run the door from a host screen and hand seated
parties to table service (`pos`). Code (planned): `apps/api/src/modules/reservations/`. Domain logic is modelled on
OpenResto (MIT; ideas only, no code); the floor-plan UX takes cues from OrderRestro (AGPL; no code). Unlike
OrderRestro, **booking a table never changes the table**: "reserved" is derived at read time.

## Roadmap

| Step | Delivers                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| R0   | Prerequisites: zoned-time helpers, opening hours, `PosFloorReader`, `pos.order.closed` event, `pos_orders.covers`.                          |
| R1   | Feature, permissions, Host role, table rules + combinations, availability engine, staff bookings, status flow with undo, `/host` (polling). |
| RT   | Realtime: SSE + Redis pub/sub replaces polling on `/host` and `/service` (after R1, never blocks it).                                       |
| R2   | Public booking page, Redis holds, confirmation mail with `.ics`, reminder, guest self-cancel, retention anonymisation.                      |
| R3   | Waitlist with "table ready" notice; KPIs (covers, no-show rate, turn time).                                                                 |

## Entities

```
Organization (tenant)
 └─ Location
     ├─ DiningTable (pos)          read through pos's public API; FK target only
     │   └─ ReservationTableRule   reservation_table_rules        booking mode, party range per table
     ├─ ReservationCombination     reservation_combinations       tables that can be pushed together
     │   └─ …Member                reservation_combination_tables
     ├─ Reservation                reservations                   current state of a booking
     │   ├─ ReservationTable       reservation_tables             assigned tables + period (exclusion constraint)
     │   ├─ ReservationStatusChange reservation_status_changes    append-only history (undo appends)
     │   └─ ReservationGuest       reservation_guests             guest of the organization; minimal, anonymisable
     ├─ GuestMarketingConsent      guest_marketing_consents       append-only grant / withdraw (R2)
     └─ WaitlistEntry              waitlist_entries               a waiting party (R3, ADR 0084)

     └─ ReservationBookingPage     reservation_booking_pages      slug → location; one per location (R2.1, ADR 0085)
```

All tables follow ADR 0005: `tenant_id` FK to organizations, `UNIQUE (tenant_id, id)`, composite tenant FKs,
`ENABLE` + `FORCE ROW LEVEL SECURITY` with `tenant_isolation`, UUID v7 ids, `timestamptz` UTC.

**FKs into `dining_tables`.** `reservation_table_rules`, `reservation_combination_tables` and `reservation_tables`
reference `(tenant_id, table_id) → dining_tables` with `RESTRICT`. That is referential integrity, not a query of pos's
tables; the precedent is `pos_order_lines → products` (catalog). The module **reads** tables only through pos's
`index.ts` (R0). Tables are archived, never deleted, so `RESTRICT` never fires in practice.

### Prisma models (sketch)

```prisma
enum ReservationStatus {
  requested   // online party above instantMaxParty: the host accepts or declines (Requests, R2); blocks no table
  pending     // online within instantMaxParty while autoConfirm is off: tables allocated and blocking; the host
              // confirms or declines; expires after online.pendingExpiryMinutes (Pending, R2)
  booked
  arrived
  seated
  finished
  no_show
  cancelled
  declined    // a request or pending booking the host declined
  expired     // a pending booking nobody confirmed in time (tables released)
  @@map("reservation_status")
}

enum ReservationSource {
  staff
  online
  walk_in
  @@map("reservation_source")
}

enum TableBookingMode {
  all           // staff and online
  staff_only    // never offered online
  walk_in_only  // never reserved; walk-ins only
  @@map("table_booking_mode")
}

model ReservationTableRule {
  tenantId    String           @map("tenant_id") @db.Uuid
  tableId     String           @map("table_id") @db.Uuid
  locationId  String           @map("location_id") @db.Uuid
  bookingMode TableBookingMode @default(all) @map("booking_mode")
  minParty    Int              @default(1) @map("min_party")
  maxParty    Int?             @map("max_party")   // null = the table's seats
  updatedAt   DateTime         @updatedAt @map("updated_at") @db.Timestamptz(6)
  // FK (tenant_id, table_id) → dining_tables, (tenant_id, location_id) → locations
  @@id([tenantId, tableId])
  @@map("reservation_table_rules")
}

model ReservationCombination {
  id          String   @id @default(dbgenerated("uuidv7()")) @db.Uuid
  tenantId    String   @map("tenant_id") @db.Uuid
  locationId  String   @map("location_id") @db.Uuid
  name        String                           // "T4+T5"
  minParty    Int      @map("min_party")
  maxParty    Int      @map("max_party")
  onlineBookable Boolean @default(true) @map("online_bookable")
  archivedAt  DateTime? @map("archived_at") @db.Timestamptz(6)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  tables      ReservationCombinationTable[]
  @@unique([tenantId, id])
  @@unique([tenantId, locationId, id])
  @@map("reservation_combinations")
}

model ReservationCombinationTable {
  tenantId      String @map("tenant_id") @db.Uuid
  combinationId String @map("combination_id") @db.Uuid
  locationId    String @map("location_id") @db.Uuid
  tableId       String @map("table_id") @db.Uuid
  // FKs (tenant_id, location_id, combination_id) → combinations; (tenant_id, table_id) → dining_tables
  @@id([tenantId, combinationId, tableId])
  @@map("reservation_combination_tables")
}

model ReservationGuest {
  id           String    @id @default(dbgenerated("uuidv7()")) @db.Uuid
  tenantId     String    @map("tenant_id") @db.Uuid
  name         String?                         // null once anonymised
  email        String?                         // lower-cased; required online, optional for staff
  phone        String?                         // E.164
  locale       String                          // for guest mails (en | de)
  lastVisitAt  DateTime? @map("last_visit_at") @db.Timestamptz(6) // set when a reservation finishes (Q8)
  anonymisedAt DateTime? @map("anonymised_at") @db.Timestamptz(6)
  // partial UNIQUE (tenant_id, email) WHERE email IS NOT NULL AND anonymised_at IS NULL: one guest per email,
  // reused by later bookings, so "12 months after the last visit" counts across visits. No email → new guest.
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  @@unique([tenantId, id])
  @@map("reservation_guests")
}

model Reservation {
  id             String            @id @default(dbgenerated("uuidv7()")) @db.Uuid
  tenantId       String            @map("tenant_id") @db.Uuid
  locationId     String            @map("location_id") @db.Uuid
  number         String                                   // RES-2026-000123, series reservations.booking
  guestId        String            @map("guest_id") @db.Uuid
  partySize      Int               @map("party_size")    // 1–100
  startsAt       DateTime          @map("starts_at") @db.Timestamptz(6)
  endsAt         DateTime          @map("ends_at") @db.Timestamptz(6)   // start + turn time; > starts_at
  status         ReservationStatus
  source         ReservationSource
  guestNote      String?           @map("guest_note")    // free text: never in audit, events or logs
  staffNote      String?           @map("staff_note")
  manageTokenHash String?          @unique @map("manage_token_hash") // R2 self-cancel link
  createdByUserId String?          @map("created_by_user_id") @db.Uuid // null for online; no FK (ADR 0016 §8)
  arrivedAt      DateTime?         @map("arrived_at") @db.Timestamptz(6)
  seatedAt       DateTime?         @map("seated_at") @db.Timestamptz(6)
  finishedAt     DateTime?         @map("finished_at") @db.Timestamptz(6)
  cancelledAt    DateTime?         @map("cancelled_at") @db.Timestamptz(6)
  noShowAt       DateTime?         @map("no_show_at") @db.Timestamptz(6)
  reminderSentAt DateTime?         @map("reminder_sent_at") @db.Timestamptz(6)
  createdAt      DateTime          @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime          @updatedAt @map("updated_at") @db.Timestamptz(6)
  tables         ReservationTable[]
  changes        ReservationStatusChange[]
  @@unique([tenantId, id])
  @@unique([tenantId, number])
  @@index([tenantId, locationId, startsAt])
  @@index([tenantId, status, endsAt])        // retention, no-show suggestions
  @@map("reservations")
}

model ReservationTable {
  tenantId      String  @map("tenant_id") @db.Uuid
  reservationId String  @map("reservation_id") @db.Uuid
  locationId    String  @map("location_id") @db.Uuid
  tableId       String  @map("table_id") @db.Uuid
  /// tstzrange(starts_at, ends_at, '[)'); kept equal to the reservation by trigger. Unsupported in Prisma.
  period        Unsupported("tstzrange")
  /// status in (pending, booked, arrived, seated); kept by trigger.
  blocking      Boolean
  @@id([tenantId, reservationId, tableId])
  @@map("reservation_tables")
}

model ReservationStatusChange {
  id            String            @id @default(dbgenerated("uuidv7()")) @db.Uuid
  tenantId      String            @map("tenant_id") @db.Uuid
  reservationId String            @map("reservation_id") @db.Uuid
  fromStatus    ReservationStatus? @map("from_status")  // null on creation
  toStatus      ReservationStatus  @map("to_status")
  undoesId      String?           @map("undoes_id") @db.Uuid   // the change this one reverts
  actorUserId   String?           @map("actor_user_id") @db.Uuid // null = guest or system
  actorKind     String            @map("actor_kind")   // user | guest | system
  createdAt     DateTime          @default(now()) @map("created_at") @db.Timestamptz(6)
  @@unique([tenantId, id])
  @@index([tenantId, reservationId, createdAt])
  @@map("reservation_status_changes")
}
```

`reservation_status_changes` and `guest_marketing_consents` are append-only like `pos_kitchen_tickets` (no
UPDATE/DELETE grant for `durby_app`, statement triggers, covered by the append-only catalog test). `reservations`
itself is a mutable current-state row: its history is the status-change log plus the audit log.

### SQL the Prisma schema can't express (hand-written in the R1 migration)

```sql
-- Needs btree_gist for `=` on uuid inside a GiST index. Trusted extension since PG 13 and durby_migrator owns
-- the database, so no superuser is needed (verified locally on PG 18; staging check in R1.3, ADR 0019 risk 1).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE reservation_tables (
  tenant_id      uuid      NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  reservation_id uuid      NOT NULL,
  location_id    uuid      NOT NULL,
  table_id       uuid      NOT NULL,
  period         tstzrange NOT NULL,
  blocking       boolean   NOT NULL,
  PRIMARY KEY (tenant_id, reservation_id, table_id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservations (tenant_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, table_id) REFERENCES dining_tables (tenant_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT reservation_tables_period_check
    CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
           AND NOT lower_inf(period) AND NOT upper_inf(period)),
  -- THE guarantee: no table is in two blocking reservations whose periods overlap.
  -- '[)' ranges: 19:00–21:00 and 21:00–23:00 do not overlap (back-to-back turns are fine).
  CONSTRAINT reservation_tables_no_overlap
    EXCLUDE USING gist (tenant_id WITH =, table_id WITH =, period WITH &&) WHERE (blocking)
);

-- The table is at the reservation's location (and the dining table's): composite FK checks both.
ALTER TABLE reservation_tables
  ADD CONSTRAINT reservation_tables_table_location_fkey
  FOREIGN KEY (tenant_id, location_id, table_id) REFERENCES dining_tables (tenant_id, location_id, id);
-- ↑ uses the existing unique index dining_tables (tenant_id, id, location_id) from the pos_orders
-- migration: a FK matches a unique index by column set, in any order (checked in R0.3).

CREATE INDEX reservation_tables_reservation_idx ON reservation_tables (tenant_id, reservation_id);

-- period / blocking follow the reservation, in the same statement, so they can never drift.
CREATE FUNCTION reservations_sync_tables() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE reservation_tables
       SET period   = tstzrange(NEW.starts_at, NEW.ends_at, '[)'),
           blocking = NEW.status IN ('pending', 'booked', 'arrived', 'seated')
     WHERE tenant_id = NEW.tenant_id AND reservation_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reservations_sync_tables AFTER UPDATE OF starts_at, ends_at, status ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_sync_tables();

-- Inserts must match the reservation too (the service sets them; this rejects a drift bug).
CREATE FUNCTION reservation_tables_check_insert() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE r reservations%ROWTYPE;
BEGIN
  SELECT * INTO r FROM reservations WHERE tenant_id = NEW.tenant_id AND id = NEW.reservation_id;
  IF NEW.period <> tstzrange(r.starts_at, r.ends_at, '[)')
     OR NEW.blocking <> (r.status IN ('pending', 'booked', 'arrived', 'seated'))
     OR NEW.location_id <> r.location_id THEN
    RAISE EXCEPTION 'reservation_tables row does not match its reservation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reservation_tables_check_insert BEFORE INSERT OR UPDATE ON reservation_tables
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION reservation_tables_check_insert();

ALTER TABLE reservation_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reservation_tables
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE reservations ADD CONSTRAINT reservations_period_check CHECK (ends_at > starts_at);
ALTER TABLE reservations ADD CONSTRAINT reservations_party_check CHECK (party_size BETWEEN 1 AND 100);
```

The trigger functions are `SECURITY INVOKER` (the default): they run as `durby_app` under RLS, so they see only the
tenant's rows. The api maps SQLSTATE `23P01` (exclusion violation) on `reservation_tables_no_overlap` to
`409 reservations.table_unavailable`.

**What the constraint does not cover** (by design, see ADR 0019): tables with an open pos order but no reservation
(a waiter seated a walk-in at the till), a `seated` party past its planned end (overrun), and holds (Redis). The
availability engine treats all three as occupied, and every write (create, seat, move, extend, walk-in) re-runs that
check for its tables inside its transaction (`reservations.table_occupied`, 409).

## Status flow

```
 (online, party > instantMaxParty)       (online, party ≤ instantMaxParty, autoConfirm off)
 requested ──accept──┐                   pending ──confirm──┐
     │               ▼                      │               ▼
     │             booked ──arrive──▶ arrived ──seat──▶ seated ──finish──▶ finished
     │               │  └──────────────seat──────────────▶  │        ▲ pos.order.closed
     ├──decline──▶ declined ◀──decline──┤                   │
     │                                  └──(expiry)──▶ expired
     └──cancel───────┴──cancel──▶ cancelled                 │
                     └──no-show──▶ no_show           (walk-in: created as seated)
```

- **Blocking** statuses (hold the table in the constraint, count as covers for pacing): `pending`, `booked`,
  `arrived`, `seated`. A `requested` booking blocks **no** table: it is a question to the host, not a seat.
  `pending`, `booked` and the later statuses can also be cancelled.

### Requests and pending bookings (R2)

`reservations.online.instantMaxParty` is a **threshold for instant booking, not a block**. Online, a party up to that
size (or any size with `'off'`) gets tables at once: `booked`, or `pending` while `reservations.autoConfirm` is off. A
larger party is never turned away by the widget: it gets a booking with status **Requested** for the slot it chose,
with no table and no hold, and the page says the restaurant will confirm.

**Pending** (within the threshold, auto-confirm off): the booking is made like a confirmed one, with tables allocated,
blocking in the exclusion constraint and counted in covers, so the widget never offers a slot that is already full of
pending bookings. The host **confirms** (`POST /reservations/:id/confirm`, `pending → booked`) or **declines**
(`pending → declined`, tables released) on `/host`. A pending booking nobody confirms within
`reservations.online.pendingExpiryMinutes` (default 120) **expires**: `pending → expired`, its tables are released and
the guest gets a mail. The expiry is a delayed outbox event (`reservations.pending.expiry_due`, R2.0) scheduled when
the booking is made; the handler does nothing if the booking is no longer pending.

**Requested** (above the threshold):

- **Capacity stays separate.** Whatever this setting says, the widget offers only slots where some table or
  combination that may be booked online fits the party at that time (engine → Candidates and table choice). A request is for a slot that
  could seat the party when it was made.
- **Larger than every table and combination.** When no table or combination of the location (that may be booked
  online) can take the party at all, every slot is `full (no_table)`. The widget then doesn't show an empty list: it
  offers **"Large group? Send a request"**, a Requested booking for the date and a time the guest names, with no slot
  and no table (the host arranges it, e.g. by joining tables ad hoc). The engine doesn't change; the widget reads
  the all-`no_table` day plus the party size (R2.3, R2.6).
- **Host screen.** Requests show in their own list on `/host` and on the timeline (marked, no table). **Accept**
  (`POST /reservations/:id/accept`) runs allocation then: the engine's best fit, or tables the host picks, checked by
  the exclusion constraint like any booking; `requested → booked`. If nothing fits anymore it answers 409
  `reservations.table_unavailable` and the host picks another time or declines. **Decline**
  (`POST /reservations/:id/decline`, optional reason key): `requested → declined`.
- **Mail.** Making a request sends "request received"; accept sends the confirmation (with `.ics`), decline sends
  the decline mail, all in the guest's locale (R2.4). Requests don't expire on their own in the MVP; the list shows
  their age.
- **Mail for pending:** making one sends "booking received, the restaurant will confirm"; confirm sends the
  confirmation (with `.ics`), decline and expiry send their mails.
- **KPIs** (R3) count requests, pending, confirmed, declined and expired separately; requested, declined and expired
  bookings are never covers.
- **Finish** sets `ends_at = max(now, starts_at + 1 min)`, which frees the rest of the period at once.
- **Seat** may change tables (re-check constraint) and moves `starts_at` to now if the party is seated early; a late
  seat keeps the end: a booking cannot silently push into the next one. **Extend** (PATCH `endsAt`) re-checks.
- **Walk-in** (`POST /reservations/walk-ins`): created `seated`, source `walk_in`, period `[now, now + turn)`. If that
  collides with the table's next booking the api answers 409 with `details.nextStartsAt`; the host may send an
  explicit `endsAt` (≥ now + 15 min) to seat them until then.

### Overrun

A `seated` reservation keeps the table until it is finished (host action or `pos.order.closed`), even after
`ends_at`. Its stored period does not grow (the constraint can't see the future); instead, wherever occupancy is
evaluated, a seated reservation with `ends_at ≤ now` occupies `[starts_at, overrunEnd)` with
`overrunEnd = ceilToSlot(now) + slotIntervalMinutes` — a rolling window that moves forward until the party leaves.
Example (15-min slots): the 19:00–21:00 party is still seated at 21:05 → the table is not offered at 21:00 or 21:15,
is offered from 21:30, and that moves on to 21:45 at 21:16. A booking already on the table at 21:00 isn't touched:
the floor marks the table `overrun` and the timeline flags the 21:00 booking "table still occupied" so the host
moves it. Why this is not racy: overrun can only be ended concurrently (finish), never started by another writer.

- **No-show** is a manual action, suggested on the host screen once `starts_at + reservations.noShowGraceMinutes` has
  passed. No automatic no-shows in the MVP.
- **Undo** (5 minutes, constant `UNDO_WINDOW_MS`): reverts the latest change of the reservation if it is not itself
  an undo, was made ≤ 5 min ago, and the target state is still possible (e.g. undoing `no_show → booked` re-blocks
  the tables: 409 if someone booked them meanwhile). Appends a change with `undoes_id`; audited as
  `reservations.reservation.status_undone`. Undoing `seated` emits nothing to pos: the open order (if any) stays.

## Availability engine (R1.4)

**Pure core, separate loader.** `availability(input)` in `apps/api/src/modules/reservations/availability/engine.ts`
takes plain data and returns slots; no database, no clock (`now` is an input), so DST days, overruns and pacing are
fast unit tests. A loader (`AvailabilityLoader`, `availability/loader.ts`) reads one location and one local day in
**one fixed batch of queries**, independent of how many bookings or slots there are: the location's settings
(`SettingsService.all`: the location, then the stored values; an unknown or foreign location is
`404 reservations.location_not_found`), then the tables and open pos orders (`PosFloorReader`), table
rules, combinations (not archived, with their tables) and the blocking bookings that can touch a slot of the day
(`starts_at < end of the local day + the party's turn time`, and `ends_at > start of the day` or `seated`, for
overrun). All 9 queries run in **one read-only `REPEATABLE READ` transaction** (one pooled connection per call, one
consistent snapshot; `PosFloorReader` and `SettingsService.all` take the caller's `tx`); `reservations-availability.e2e.spec.ts`
pins the operations and shows the count doesn't grow with bookings. No query per slot or per booking.
`GET /reservations/availability` (staff channel, `now` from `Clock`) checks `reservations.bookings.read` at the
location first; `excludeReservationId` (moving a booking) comes with the bookings API in R1.6.

```
availability({
  date: '2026-11-14', timeZone: 'Europe/Berlin', now, channel: 'staff' | 'online', partySize,
  settings: { openingHours, closedDates, serviceHours, slotIntervalMinutes, turnTimes, maxCoversPerSlot,
              lastBookingOffsetMinutes, instantMaxParty },
  tables:       [{ id, name, seats, sortOrder, bookingMode, minParty, maxParty | null }],    // not archived
  combinations: [{ id, name, tableIds, minParty, maxParty, onlineBookable }],              // not archived
  bookings:     [{ id, status, partySize, start, end, tableIds }],   // pending/booked/arrived/seated only
  openOrders:   [{ tableId, openedAt, covers | null }],              // PosFloorReader, now
}) → { date, turnMinutes, closed, slots: [{ start, end, status: 'available' | 'request' | 'full',
                                           reason?: 'no_table' | 'pacing', allocation?: Allocation }] }
// Allocation = { kind: 'table', tableId } | { kind: 'combination', combinationId, tableIds }
```

### Slots

1. **Closed date:** `date` in `closedDates` → `closed: true`, no slots.
2. **Windows:** the opening-hours windows of the date's weekday (`serviceWindowsOn`, R0.2), as instants. If
   `serviceHours` isn't `'openingHours'`, each is intersected with the reservation-hours windows of the same date (it
   can only narrow). Windows past midnight belong to the day they start.
3. **Grid, on the wall clock:** per window, local times `from`, `from + interval`, `from + 2·interval`, … (crossing
   midnight into the next date when needed), each converted with `zonedInstant`: a time skipped by spring forward has
   no slot; a time repeated by fall back has one slot, at the earlier instant. Duplicates are dropped.
4. **Last booking:** a slot starts no later than window end − `lastBookingOffsetMinutes` (elapsed minutes). A
   booking may run past closing; the offset decides how late it may start.
5. **Not in the past:** slots starting before `now` are left out.
6. **Duration:** `turnMinutes = turnTimeFor(partySize, turnTimes)`; a slot's booking is `[start, start + turn)`.

### Busy intervals per table (computed once per call, not per slot)

- **Bookings** (`pending`, `booked`, `arrived`, `seated`): `[start, end)` on each of their tables.
- **Seated overrun:** a `seated` booking whose `end ≤ now` occupies `[start, overrunEnd)` instead, with
  `overrunEnd = ceilToGrid(now) + interval`. `ceilToGrid` rounds `now` up to the next multiple of the slot interval
  on the local wall clock, counted from local midnight (21:05 → 21:15 with 15-minute slots). The window moves forward
  with `now` until the party is finished: at 21:05 the 19:00–21:00 party blocks 21:15 and frees 21:30.
- **Open pos orders** (walk-ins seated at the till, no booking on that table now):
  `[now, max(openedAt + turnTimeFor(covers ?? seats), overrunEnd))`. Rolling the same way while the order stays
  open; a table with both a seated booking and an open order counts once (the booking).

### Candidates and table choice

- **Channel:** staff may book `all` and `staff_only` tables; online only `all` tables and combinations with
  `onlineBookable`. `walk_in_only` tables are never candidates, and neither is a combination that contains one.
- **Fit:** a single table fits when `minParty ≤ party ≤ (maxParty ?? seats)`; a combination when
  `minParty ≤ party ≤ maxParty`.
- **Free:** no busy interval of the table (every member, for a combination) overlaps `[start, start + turn)`.
  Intervals are half-open: 18:00–20:00 then 20:00–22:00 is fine.
- **Choice, deterministic:**
  1. **Single tables first.** Among free, fitting tables: smallest capacity (`maxParty ?? seats`), then fewest
     seats, then `sortOrder`, then name, then id. So 2 guests get a 2-top before a 4-top, never a 6-top while a
     smaller table is free.
  2. **Combinations only when no single table is free and fits.** Among free, fitting combinations: smallest
     `maxParty`, then fewest tables, then name, then id. A combination's own `minParty` keeps small parties off big
     combinations.

### Status per slot

1. **Pacing:** if `maxCoversPerSlot` is a number and the party sizes of bookings starting in
   `[slot, slot + interval)` plus this party exceed it → `full`, `reason: 'pacing'` (staff may override with
   `force`, R1.6; online may not).
2. **No candidate** → `full`, `reason: 'no_table'`.
3. **Online above `instantMaxParty`** (not `'off'`) → `request`, with the allocation as a hint only (a request
   holds no table). Size never removes a slot; capacity does: a slot no table or combination fits stays `full`.
4. Otherwise `available`, with the allocation.

`full` slots stay in the list (with their reason), so the host sees the shape of the evening; the online widget
shows only `available` and `request`.

## Derived floor state (never stored)

`GET /reservations/floor?locationId=&at=` (or `&date=`) combines, at `at`. The pure core is
`deriveFloor(input)` in `reservations/floor/derive.ts` (no database, no clock, like the engine); the floor service
reads its input in **one** read-only `REPEATABLE READ` transaction (location check, settings, tables, rules, the day's
blocking bookings, open orders), so a request takes 2 transactions (guards + floor).

**Which moment (R1.8a).** No `at` and no `date` → now. `at` → that instant. `date` → today's date means now; another
date means the start of its first service window (opening hours narrowed by `reservations.serviceHours`, as in the
engine), or the start of the day when it has none. The response echoes `at`, the local `date`, `live` and the date's
`serviceWindows` (the time selector on `/host` offers those). **Live** means the local date of `at` is today at the
location: only then do open pos orders, overrun and `arriving` count. Another day shows **bookings only** (a plan of
the day): no open orders, no overrun, an `arrived` booking reads as `reserved`.

| State           | When (first that applies)                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `occupied`      | a `seated` booking's period contains `at`; live: also an overrunning seated party or an open pos order (Overrun) |
| `arriving`      | live: an `arrived` booking is assigned to the table (guest waiting at the door)                                  |
| `reserved`      | a `pending`/`booked` booking's period contains `at` (live: the party is late), or not live and `arrived`         |
| `reserved_soon` | the next blocking booking starts within `reservations.floorHorizonMinutes` (default 60) after `at`               |
| `free`          | otherwise; `walk_in_only` tables carry a badge (`walkInOnly`)                                                    |

Each table also carries:

- `current`: what the state comes from (`occupied`, `arriving`, `reserved`): `{ reservationId | null, partySize |
null, guestName | null, since, until | null }`. An open order has no reservation (`partySize` = its covers, `since` =
  opened); a seated booking with an open order counts once, as the booking.
- `next`: the earliest other blocking booking on the table that hasn't ended at `at`:
  `{ reservationId, startsAt, partySize, guestName, tableStillOccupied }`. `tableStillOccupied` (live only) is the
  Overrun flag: the table is `occupied` by something else (an overrunning party, a till order without a booking) whose
  occupancy reaches past `next.startsAt`, so the host moves that booking.
- `overrun` (live): a seated party is past its `ends_at`.
- `occupied`, `occupiedSince`, `covers` (R1.1 fields): `state === 'occupied'`, `current.since`, the order's covers
  or the seated party size.

Open orders come from pos's read port (`PosFloorReader.openOrders(locationId)`), never from `pos_orders` directly.

**Booking fields for `/host` (R1.8a).** Every booking response (list, get, writes) adds `lastChange: { id, toStatus,
actorKind, sourceOrderId, createdAt }` (the "auto-seated from till" / "finished at the till" badges: `actorKind =
system` with a `sourceOrderId`) and `tablesNotInService`: the tables of a blocking booking that pos has archived
(`PosFloorReader.tables(ids)`), else `[]`. `lastChangeId` stays.

**Archived tables (R1.8).** pos may archive a table that still has future blocking bookings: pos never checks
reservations (G5). `/host` flags each such booking "table not in service, move booking" (a blocking reservation
whose table `PosFloorReader.tables(ids)` reports archived: the booking's `tablesNotInService`) so the host moves it;
the availability engine already ignores archived tables.

**Composition (G5).** The dependency is one-way: reservations imports `pos/index.ts`; pos never imports
reservations and its endpoints know nothing of bookings. The `/service` floor (pos) shows reservation badges
("19:30 · 4p") by calling `GET /reservations/floor` from the web app when the organization has `reservations` and the
user holds `reservations.bookings.read`; the `/host` floor calls only the reservations api, which already includes
pos occupancy through the read port.

## Integration with pos (outbox events)

| Event                                                           | Producer     | Payload (v1)                                              | Consumer                                                                                                              |
| --------------------------------------------------------------- | ------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pos.order.opened` (R1.7)                                       | pos          | `orderId`, `locationId`, `tableId`, `openedAt`            | reservations `reservations.seatOnOrderOpened`: seats the booking expected at that table (restaurants without a host)  |
| `pos.order.closed`                                              | pos (R0)     | `orderId`, `locationId`, `tableId`                        | reservations `reservations.finishOnOrderClosed`: finishes the `seated` reservation holding that table at `occurredAt` |
| `reservations.reservation.created`/`.status_changed`/`.updated` | reservations | `reservationId`, `locationId`, `status`, `startsAt` (ISO) | none in R1; realtime fan-out in RT.1; later CRM/KPIs                                                                  |
| `reservations.reminder.due` (R2)                                | reservations | `reservationId`                                           | reservations `reservations.sendReminder` (delayed via `available_at`, R2.0)                                           |
| `reservations.guest.retention_due` (R2)                         | reservations | `guestId`                                                 | reservations `reservations.anonymiseGuest` (delayed, R2.0)                                                            |
| `reservations.pending.expiry_due` (R2)                          | reservations | `reservationId`                                           | reservations `reservations.expirePending` (delayed by `online.pendingExpiryMinutes`, R2.0): `pending → expired`       |

No event flows from reservations to pos (Q3): seating doesn't open an order. The waiter's first send opens it as
today, with `covers` pre-filled by the web app from the seated reservation (Q7).

Payloads carry ids, enums and timestamps only (ADR 0013): no guest name, email, phone or notes. The finish handler
tolerates order: if the reservation is already finished/cancelled it does nothing; if the event refers to an order
opened before the seating it does nothing (compare `occurredAt` with `seated_at`). "BillClosed" in the brief = this
event: pos has no bill/guest-check entity yet (pos.md step 4), closing the order is what frees the table today.

## Permissions

The brief names `reservations.view`, `reservations.manage`, `waitlist.manage`; CLAUDE.md requires
`module.entity.action`, so the keys are:

| Key                            | Scope    | Grants                                                      | admin | manager | staff | waiter | cashier | host |
| ------------------------------ | -------- | ----------------------------------------------------------- | ----- | ------- | ----- | ------ | ------- | ---- |
| `reservations.bookings.read`   | location | list bookings, availability, host floor                     | ✓     | ✓       |       | ✓      |         | ✓    |
| `reservations.bookings.manage` | location | create, edit, arrive, seat, no-show, cancel, undo, walk-ins | ✓     | ✓       |       | ✓      |         | ✓    |
| `reservations.waitlist.manage` | location | waitlist entries, notify, seat from waitlist (R3)           | ✓     | ✓       |       | ✓      |         | ✓    |
| `reservations.setup.manage`    | location | table rules, combinations, booking page                     | ✓     | ✓       |       |        |         |      |

Owner gets all automatically. Host also gets `pos.tables.read` ✓ and denies every other pos/catalog write key;
`catalog.products.read` deny, `pos.orders.read` deny (the host floor shows occupancy, not orders). **Host system
role**: two migrations as in ADR 0016 §7 (enum value, then backfill in every organization), `SYSTEM_ROLES` +
`SystemRoles.ensure`, labels, ADR 0007 amendment. Guest-facing routes are `@Public()`; the slug resolves the tenant
server-side (Q1, ADR in R2.1).

## Features (Q6)

| Key                   | dependsOn      | Limits     | Gates                                             |
| --------------------- | -------------- | ---------- | ------------------------------------------------- |
| `reservations`        | `pos`          | `noLimits` | staff bookings, `/host`, `/reservations`, setup   |
| `reservations.online` | `reservations` | `noLimits` | public page, holds, guest mails, self-cancel (R2) |

Labels `platform.features.reservations{,Online}.{name,description}`. Both go into the **`full` plan only**, by
migration with a `platform.plan.features_changed` audit row per organization on it (ADR 0009). Not into
`inventory` or `inventory_billing`: those plans have no `pos`, and reservations needs pos tables. Other
organizations get them through the `entitlements` CLI override until a plan covers them. Every route has
`@RequireFeature(...)`; outbox handlers and delayed jobs check the feature too and do nothing when it's off.

## Settings (ADR 0010; scopes partner, organization, brand, location unless noted; none data-bound)

| Key                                     | Schema                                                                                                         | Default                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `openingHours` (platform, R0)           | strict `{ mon … sun: [{ from: 'HH:mm', to: 'HH:mm' }] }`, ≤ 4 windows/day, `to` ≤ `from` = past midnight       | every day `11:00–23:00`    |
| `closedDates` (platform, R0)            | ≤ 366 ISO dates `YYYY-MM-DD`, unique                                                                           | `[]`                       |
| `reservations.serviceHours`             | `'openingHours'` or the shape of `openingHours`; a schedule only narrows the opening hours (engine intersects) | `'openingHours'`           |
| `reservations.slotIntervalMinutes`      | `15 \| 30 \| 60`                                                                                               | `15`                       |
| `reservations.turnTimes`                | `[{ fromParty, toParty \| null, minutes 1–720 }]`, 1–10 bands, contiguous from 1, last open (`null`)           | 1–2: 90, 3–4: 120, 5+: 150 |
| `reservations.maxCoversPerSlot`         | `'off'` or int 1–1000                                                                                          | `'off'`                    |
| `reservations.lastBookingOffsetMinutes` | int 1–480 (minutes before closing)                                                                             | `60`                       |
| `reservations.online.instantMaxParty`   | `'off'` or int 1–100: instant online booking up to this party size; larger ones become requests (R2)           | `10`                       |
| `reservations.autoConfirm`              | boolean                                                                                                        | `true`                     |
| `reservations.holdMinutes`              | int 1–15                                                                                                       | `5`                        |

Registered in R1.2 with these defaults, so a new location takes bookings without setup. **No `null` values:** a stored
setting is never JSON `null` (ADR 0010: deleting the row inherits), so "no limit" and "the opening hours" are the
values `'off'` and `'openingHours'`; a location can set them under an organization that set something else.

Added by the steps that first use them (same rules, no migration needed):

| Key                                        | Schema                                                                                     | Default | Step                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | ------- | --------------------------- |
| `reservations.orderMatchWindowMinutes`     | int 5–120: a till order belongs to a booking when opened within ±this of its start         | `30`    | R1.7                        |
| `reservations.minLeadMinutes`              | int 0–10080: online slots start at least this long after now (engine, online channel only) | `60`    | R2.2, **before the widget** |
| `reservations.maxAdvanceDays`              | int 1–365: online bookings at most this many days ahead                                    | `60`    | R2.2, before the widget     |
| `reservations.noShowGraceMinutes`          | int 0–120                                                                                  | `15`    | R1.9                        |
| `reservations.floorHorizonMinutes`         | int 15–240                                                                                 | `60`    | R1.8a                       |
| `reservations.reminderLeadHours`           | int 0–168 (0 = off)                                                                        | `24`    | R2.5                        |
| `reservations.selfCancelCutoffMinutes`     | int 0–10080                                                                                | `120`   | R2.3                        |
| `reservations.guestRetentionMonths`        | int 1–120; scopes partner, organization (Q8)                                               | `12`    | R2.5                        |
| `reservations.online.pendingExpiryMinutes` | int 5–10080: unconfirmed pending bookings expire after this                                | `120`   | R2.3                        |

Read at the reservation's location (`SettingsService.all({ locationId })`), so Location → Brand → Organization →
Partner → default applies. `timezone` (existing key, all scopes) is read at the location too. Labels:
`platform.settings.<camelCasedKey>.{name,description}` (`settingLabelBase`). `openingHours` and `closedDates` are
platform-wide keys (no module prefix) so pos, reports and the public page can use them too.

## Number series

`reservations.booking` (feature `reservations`, prefix `RES`, `RES-{YYYY}-{seq:6}`, yearly), allocated last in the
create transaction; `UNIQUE (tenant_id, number)`. The number is the guest-facing reference.

## API (`/api/v1`, `@RequireFeature('reservations')`)

Staff (R1). Location-scoped keys are checked at the reservation's / table's location; others' rows are 404.

| Method + path                             | Permission                     | Idempotency                 | Body / query                                                                                                               |
| ----------------------------------------- | ------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /reservations/tables`                | `reservations.bookings.read`   |                             | `?locationId=`: pos tables merged with rules                                                                               |
| `PUT /reservations/tables/:tableId/rule`  | `reservations.setup.manage`    | response                    | `{ bookingMode, minParty, maxParty? }`                                                                                     |
| `GET /reservations/combinations`          | `reservations.bookings.read`   |                             | `?locationId=&includeArchived=`                                                                                            |
| `POST /reservations/combinations`         | `reservations.setup.manage`    | `completion: 'transaction'` | `{ locationId, name, tableIds (2–8, same location), minParty, maxParty, onlineBookable? }`                                 |
| `PATCH /reservations/combinations/:id`    | `reservations.setup.manage`    | response                    | same fields, `archived?`                                                                                                   |
| `GET /reservations/availability`          | `reservations.bookings.read`   |                             | `?locationId=&date=YYYY-MM-DD&partySize=&excludeReservationId=`                                                            |
| `GET /reservations`                       | `reservations.bookings.read`   |                             | `?locationId=&date=` (local day) or `from=&to=`; `status=`                                                                 |
| `GET /reservations/:id`                   | `reservations.bookings.read`   |                             | includes status history                                                                                                    |
| `POST /reservations`                      | `reservations.bookings.manage` | `completion: 'transaction'` | `{ locationId, startsAt, partySize, tableIds?, guest: { name, email?, phone?, locale? }, guestNote?, staffNote?, force? }` |
| `PATCH /reservations/:id`                 | `reservations.bookings.manage` | response                    | `{ startsAt?, endsAt?, partySize?, tableIds?, guest?, guestNote?, staffNote? }`                                            |
| `POST /reservations/:id/accept`           | `reservations.bookings.manage` | `completion: 'transaction'` | requested → booked: allocates tables (or `tableIds`), mails the confirmation (R2)                                          |
| `POST /reservations/:id/confirm`          | `reservations.bookings.manage` | `completion: 'transaction'` | pending → booked (tables already held), mails the confirmation (R2)                                                        |
| `POST /reservations/:id/decline`          | `reservations.bookings.manage` | `completion: 'transaction'` | requested or pending → declined (pending releases its tables), mails the decline (R2)                                      |
| `POST /reservations/:id/arrive`           | `reservations.bookings.manage` | `completion: 'transaction'` |                                                                                                                            |
| `POST /reservations/:id/seat`             | `reservations.bookings.manage` | `completion: 'transaction'` | `{ tableIds? }`                                                                                                            |
| `POST /reservations/:id/finish`           | `reservations.bookings.manage` | `completion: 'transaction'` |                                                                                                                            |
| `POST /reservations/:id/no-show`          | `reservations.bookings.manage` | `completion: 'transaction'` |                                                                                                                            |
| `POST /reservations/:id/cancel`           | `reservations.bookings.manage` | `completion: 'transaction'` |                                                                                                                            |
| `POST /reservations/:id/undo`             | `reservations.bookings.manage` | `completion: 'transaction'` | `{ changeId }` (the change the client saw; 409 if it isn't the latest)                                                     |
| `POST /reservations/walk-ins`             | `reservations.bookings.manage` | `completion: 'transaction'` | `{ locationId, partySize, tableIds, name?, endsAt? }` → `seated`, source `walk_in`                                         |
| `POST /reservations/guests/:id/anonymise` | `reservations.setup.manage`    | `completion: 'transaction'` | erasure on request (R1.9, GDPR below): `{ id, anonymisedAt }`; again on an anonymised guest: 200, nothing written          |
| `GET /reservations/floor`                 | `reservations.bookings.read`   |                             | `?locationId=` (required) `&at=` or `&date=`: the derived floor (Derived floor state, R1.8a); polled every 30 s in R1      |
| `GET /reservations/stream`                | `reservations.bookings.read`   |                             | `?locationId=`: server-sent events, topic `reservations` (RT.1, ADR 0044)                                                  |

pos changes (R0.4–R0.5, in pos.md): `pos_orders.covers int NULL CHECK (covers BETWEEN 1 AND 100)`;
`POST /pos/tables/:tableId/tickets` takes `covers?` (used only when it opens the order, else ignored); `PATCH /pos/orders/:id { covers }`
(`pos.orders.take`, `@Idempotent()`); order snapshots add `covers`.

Status actions append a status change, hence `completion: 'transaction'` (rule 8). Every write audits.

Guest-facing (R2, Q1). The page lives at `https://<partner domain>/b/{slug}`; the api routes are `@Public()`. A
public guard looks the slug up in the platform table `public_booking_pages` (slug → organization, location,
enabled) and sets the tenant context with a fixed guest actor id, like invitation acceptance does with the
organization its token proves. No route accepts an organization or location id from the client.
`reservations.online` is then checked for that organization (404 when off, so disabled pages are
indistinguishable from unknown ones). Every public route is rate-limited per IP and per page (platform/rate-limit);
writes carry a honeypot field (`website`, must be empty; a filled one gets a fake 201 and no booking).

| Method + path                                    | Idempotency                                                  | Notes                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `GET /public/booking/:pageSlug`                  |                                                              | location name, party limits, theme hints                                                           |
| `GET /public/booking/:pageSlug/availability`     |                                                              | `?date=&partySize=`; online channel                                                                |
| `POST /public/booking/:pageSlug/holds`           | `@IdempotencyExempt('hold replaced by key, expires by TTL')` | `{ startsAt, partySize, replaceHoldId?, website }` → `{ holdId, expiresAt }`                       |
| `DELETE /public/booking/:pageSlug/holds/:holdId` | `@IdempotencyExempt('deleting a hold twice is a no-op')`     |                                                                                                    |
| `POST /public/booking/:pageSlug/reservations`    | `completion: 'transaction'`                                  | `{ holdId, guest: { name, email, phone?, locale }, guestNote?, marketingOptIn: boolean, website }` |
| `GET /public/booking/manage`                     |                                                              | token in `Authorization: Bearer`, read from URL fragment by the page                               |
| `POST /public/booking/manage/cancel`             | `completion: 'transaction'`                                  | same token; before `selfCancelCutoffMinutes`                                                       |

The manage link is `https://<partner domain>/b/manage#<token>`: the token lives in the fragment, which browsers
don't send to servers or put in Referer/logs (ARCHITECTURE "no access tokens in URLs"). The token embeds the
organization id like invitation tokens (`issueInvitationToken`), and its hash is checked under that tenant's RLS.

### R1.5 setup API

- **`GET /reservations/tables?locationId=`** (`reservations.bookings.read`): the location's tables in service from
  `PosFloorReader.tablesAt`, each merged with its rule; a table without a rule shows the defaults
  (`bookingMode: 'all'`, `minParty: 1`, `maxParty: null` = seats).
- **`PUT /reservations/tables/:tableId/rule`** (`reservations.setup.manage` at the table's location, `@Idempotent()`):
  creates or replaces `{ bookingMode, minParty, maxParty | null }`. Unknown, archived or another tenant's table, or one at a
  location where the caller can't read bookings → `404 reservations.table_not_found`; reads but can't manage → 403.
- **`GET /reservations/combinations?locationId=&includeArchived=`** (`reservations.bookings.read`): with their tables
  (ids in a stable order).
- **`POST /reservations/combinations`** (`reservations.setup.manage`, `completion: 'transaction'`):
  `{ locationId, name (1–60, trimmed), tableIds (2–8, distinct), minParty, maxParty, onlineBookable? (true) }`; every
  table at that location and in service, else `404 reservations.table_not_found`.
- **`PATCH /reservations/combinations/:id`** (`reservations.setup.manage`, `@Idempotent()`): the same fields, all
  optional, plus `archived: boolean` (sets or clears `archived_at`). New `tableIds` replace the table list. Unknown / another
  tenant's / at a location the caller can't read → `404 reservations.combination_not_found`; reads but can't manage → 403.
- **Ranges:** party sizes 1–100 (`MAX_PARTY_SIZE`), `minParty ≤ maxParty`; a rule's `minParty` may not exceed the
  table's capacity (`maxParty`, or seats when null). Otherwise `422 reservations.party_range_invalid`. A max party may
  exceed seats (an extra chair) and a combination isn't capped by its tables' seats; the UI warns.
- **Existing bookings** keep their own table ids: editing or archiving a combination or rule never changes them.
- Audit `reservations.table_rule.updated` and `reservations.combination.created` / `.updated` in the change's
  transaction (allow-listed fields, see Audit). No outbox events: nothing consumes setup changes.

### R1.5c location settings API (ADR 0020)

- **`GET /reservations/settings?locationId=`** (`reservations.setup.manage` at the location): every registered
  `reservations.*` key that allows location scope, resolved there with its source (`location` when set here, else the
  level it inherits from), plus the location's resolved `openingHours` (read-only, to explain service hours).
- **`PUT /reservations/settings/:key?locationId=`** `{ value }` and **`DELETE`** (inherit), both
  `reservations.setup.manage` at the location, `@Idempotent()`. `:key` must be one of those keys (else 400);
  `openingHours`, `closedDates`, `timezone` and every other key stay on `platform.settings.manage`. Writes go through
  `SettingsAdmin` with the delegated key: same validation (`422 settings.invalid_value`), audit
  (`platform.setting_value.*`) and `config.settings.changed` as the settings api.
- **Service hours wider than opening hours** are saved (the engine intersects, so the extra part is never offered); the
  tab shows which parts fall outside per weekday (`windowsOutside` in `packages/shared/src/time`).

### R1.6 bookings API (staff)

Decisions (2026-11-01). Requested/pending flows (accept, confirm, decline) stay in R2.

- **Write-time checks** (create, move, seat, walk-in), in the booking's own transaction, in this order: tables at the
  location and in service (staff may book `all` and `staff_only` tables; `walk_in_only` only for walk-ins) →
  `404 reservations.table_not_found` / `409 reservations.table_walk_in_only`; the party fits the table rules or the
  combination → `409 reservations.party_size_out_of_range`; no open pos order and no overrunning seated party on
  those tables → `409 reservations.table_occupied`; pacing → `409 reservations.pacing_exceeded`; reservation hours
  and last booking time → `409 reservations.outside_service_hours`; finally the exclusion constraint (`23P01` →
  `409 reservations.table_unavailable`). **Seat** re-runs the occupancy checks too, with or without new `tableIds`.
- **`force` (Q2):** staff may override pacing and reservation hours only, audited as
  `reservations.reservation.rules_overridden` naming the rules. Table conflicts, occupancy and party size are never
  forced.
- **No bookings in the past (Q4):** create or move to a start more than 15 min before now →
  `409 reservations.starts_in_past`. Parties already in the restaurant are walk-ins.
- **Any minute (Q6):** staff may start a booking at any minute (19:10); the slot grid only decides what is offered
  online. Without `tableIds` the engine's table choice runs at that exact start. `endsAt` defaults to start + turn
  time; moving keeps the length unless `endsAt` is sent.
- **No-show (Q5)** only once `starts_at` has passed (`409 reservations.invalid_transition` before).
- **Walk-ins:** guest name and phone optional (no guest data → a guest row with no name, email or phone).
- **Several chosen tables:** exactly a defined (not archived) combination uses its own party range; any other set
  of tables takes up to their capacities added up.
- **Guests:** see GDPR → guests are reused (email first, then phone). **PATCH `guest`** corrects the booking's guest:
  an email that belongs to another live guest links the booking to that guest (filling its blanks); otherwise the
  given fields replace the current guest's. A phone never relinks (families share numbers).
- **PATCH** works on `pending`, `booked`, `arrived` and `seated` bookings (else `409 reservations.invalid_transition`)
  and re-runs the checks only when time, tables or party size change; `force` applies to those changes.
- **Status actions (R1.6c)**, `POST /reservations/:id/{arrive,seat,finish,no-show,cancel}`, each
  `completion: 'transaction'`, appending a status change, auditing `reservations.reservation.status_changed` and
  writing `reservations.reservation.status_changed`: `arrive` booked → arrived; `seat` booked/arrived → seated (optional
  `tableIds`); `finish` seated → finished (`ends_at = max(now, starts_at + 1 min)`, the guest's `last_visit_at = now`);
  `no-show` booked/arrived → no_show, only once `starts_at` has passed (Q5); `cancel` pending/booked/arrived →
  cancelled. Anything else → `409 reservations.invalid_transition` (`details.from`, `details.to`).
- **Seat** re-runs the table checks (fit, open pos order, overrunning party, booked) with or without new `tableIds`,
  never the rules (the party is here). An **early** seat shifts the booking to start now and keeps its length; a late
  seat keeps start and end.
- **Undo** (`POST /reservations/:id/undo { changeId }`): `changeId` must be the latest change, made ≤ 5 min ago
  (`UNDO_WINDOW_MS`), not itself an undo and not the creation, else `409 reservations.undo_expired`. It restores the
  previous status, times and tables, which each status change records (`previous_starts_at`, `previous_ends_at`,
  `previous_table_ids`); back to a blocking status re-runs the table checks (409 when the table was taken meanwhile).
  Appends a change with `undoes_id`, audited as `reservations.reservation.status_undone`.
- **Walk-ins** (`POST /reservations/walk-ins { locationId, partySize, tableIds, name?, phone?, endsAt? }`): `seated`,
  source `walk_in`, `[now, endsAt ?? now + turn)`; `walk_in_only` tables allowed; guest name and phone optional (the
  same guest matching). A collision with the table's next booking → `409 reservations.table_unavailable` with
  `details.nextStartsAt`; the host may send `endsAt` (≥ now + 15 min, ≤ 12 h) to seat them until then. Rules don't
  apply (they are here).
- Every response carries `lastChangeId` (the change an undo would revert).
- **Phone:** `normalisePhone(input, country)` in `packages/shared` (libphonenumber-js, `min` metadata) with the
  location's `country` setting; invalid → `422 reservations.phone_invalid` (`details.field`).

### Waitlist (R3, as built; ADR 0084)

A party waits on the list of one location: `waiting → notified → seated | left | removed`; `left` can return on the
same local day. The order is the order of adding. No table is held. Other location or tenant: `404`.

| Method + path                            | Permission                                                      | Body / query                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /reservations/waitlist`             | `reservations.bookings.read`                                    | `?locationId=`: `open`, `ended` (today), `holdMinutes`, `readyText` per language                |
| `POST /reservations/waitlist`            | `reservations.waitlist.create`                                  | `{ locationId, name, partySize, phone?, email?, locale?, quotedMinutes?, note? }`               |
| `PATCH /reservations/waitlist/:id`       | `reservations.waitlist.edit`                                    | the same fields; `null` clears phone, email, minutes, note                                      |
| `POST /reservations/waitlist/:id/notify` | `reservations.waitlist.edit`                                    | `{ channel: 'email' \| 'in_person' }`; answers `noticeResult: pending`, stored when known       |
| `POST /reservations/waitlist/:id/seat`   | `reservations.waitlist.edit` and `reservations.bookings.create` | `{ tableIds, partySize?, endsAt? }`: a walk-in with the party's name, phone, email and language |
| `POST …/:id/leave`, `POST …/:id/return`  | `reservations.waitlist.edit`                                    |                                                                                                 |
| `DELETE /reservations/waitlist/:id`      | `reservations.waitlist.delete`                                  | `removed` (added by mistake)                                                                    |

All writes use `completion: 'transaction'`, lock the entry, audit `reservations.waitlist_entry.*` (entity
`waitlist_entry`: `id`, `locationId`, `partySize`, `quotedMinutes`, `status`, `noticeChannel`, `noticeCount`,
`reservationId`; never names, contacts or notes) and write `reservations.waitlist.changed` `{ entryId, locationId }`,
published to the `reservations` stream.

Errors: `reservations.waitlist_entry_not_found` (404); `reservations.waitlist_closed` (409, `details.status`),
`.waitlist_no_email`, `.waitlist_notice_limit` (3 emails per party), `.waitlist_notice_too_soon` (one minute per address;
not after a failed email), `.waitlist_return_expired` (409).

Setting `reservations.waitlistHoldMinutes` (int 5–60, default 10, all scopes): said in the notice; after it the host
screen marks the party.

Email: the guest's language, text only, no link: the organization's name, with the branch's when several are in service.
`reservations.email.tableReady.*`.

Privacy: contact data only on the entry. The worker's hourly pass closes entries open for 24 hours (`left`, audited as
`job.waitlist`) and erases name, phone, email and note 24 hours after an entry ended. Erasing a guest erases the entry it
was seated from.

**Web** (`components/reservations/waitlist-panel.tsx`, `waitlist-dialog.tsx`, `lib/reservations/waitlist.ts`): on `/host`,
today only; a third column on wide screens, below the lists otherwise. Waiting time against the quoted one, **Table
ready** (email), **Call** and **Message** (`tel:`, `sms:` with the text ready, from the host's own phone), **Told the
guest**, **Seat** (the walk-in dialog with the smallest free table that fits), **Left**, change and remove; today's ended
parties folded with **Back on the list**.

### Online booking page (R2.1, as built; ADR 0085)

A location's page is `/b/{slug}` on the domain of its organization's partner (Durby's own domain for Durby
restaurants). Settings → Reservations shows the address (suggested from the names), on/off and the link to copy.

| Method + path                                             | Access                                     | Notes                                                                                                |
| --------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `GET /reservations/booking-page?locationId=`              | `reservations.bookings.read`               | `{ page, suggestedSlug, online }`                                                                    |
| `PUT /reservations/booking-page`                          | `reservations.setup.edit`, `@Idempotent()` | `{ locationId, slug, enabled }`; `409 booking_slug_taken`; audit `reservations.booking_page.updated` |
| `GET /public/booking/:slug`                               | `@Public()`                                | restaurant, location, time zone, locale, currency, `instantMaxParty`                                 |
| `GET /public/booking/:slug/availability?date=&partySize=` | `@Public()`                                | online channel; slots `{ start, end, status }` only                                                  |

Slugs: 3–60 lower-case letters, digits and single hyphens, unique across all organizations, some words reserved.
Public answers: `404 reservations.booking_page_not_found` for every refusal (unknown, off, archived location, no
`reservations.online`, another partner's domain); rate-limited per address and per page; `Cache-Control: no-store`.

### Holds and the online booking window (R2.2, as built; ADR 0019 §4–5)

While a guest fills in the form, the tables of the chosen time are held in Redis for `reservations.holdMinutes`
(default 5): `resv:hold:{tenant}:{holdId}` (JSON without personal data) and one sorted set per **location**
`resv:holds:{tenant}:{locationId}` (member `holdId|tableId|startMs|endMs`, score = expiry), so the conflict check and
the availability read each touch one key. One Lua script drops expired members, refuses an overlapping live hold on
any of the tables, frees the guest's replaced hold (same page only) and writes the new one: all or nothing.

| Method + path                                                                         | Notes                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /public/booking/:slug/holds` `{ startsAt, partySize, replaceHoldId?, website }` | `@IdempotencyExempt`; the online engine's allocation for that start (other guests' holds count as busy); only an `available` slot; else `409 reservations.table_unavailable`. A filled `website` (honeypot) gets a believable answer and nothing is held. |
| `DELETE /public/booking/:slug/holds/:holdId`                                          | `@IdempotencyExempt`, 204, twice is fine; only a hold of that page                                                                                                                                                                                        |

Holds are advisory: only the online channel sees them; staff availability and staff booking ignore them, and the
exclusion constraint still decides at booking (R2.3). Redis down → `503 reservations.holds_unavailable` for online
booking. Settings `reservations.minLeadMinutes` (0–10080, default 60) and `reservations.maxAdvanceDays` (1–365, default 60) shape the online channel only; the public page response carries `lastBookableDate`.

### Guest booking and the manage link (R2.3a, as built)

| Method + path                                                                                                                        | Notes                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /public/booking/:slug/reservations` `{ holdId, guest: { name, email, phone?, locale? }, guestNote?, marketingOptIn, website }` | the hold's tables, time and party; `booked`, or `pending` with `reservations.autoConfirm` off; source `online`; guest matched by email; `409 hold_not_found` / `table_unavailable`; answer with `manageToken` (shown once) |
| `GET /public/booking/manage`                                                                                                         | `Authorization: Bearer <token>` (the page reads it from `/b/manage#<token>`): number, status, names, times, `canCancel`, `cancelUntil`, `pageSlug`                                                                         |
| `POST /public/booking/manage/cancel`                                                                                                 | until `reservations.selfCancelCutoffMinutes` (default 120) before the start, else `409 self_cancel_closed`; twice answers the same                                                                                         |

- **No signed-in user, so no idempotency store:** the booking route is idempotency-exempt and claims its hold in Redis;
  the same hold again (double click, retry) gets the same answer for 15 minutes, never a second booking.
- Manage token `<organizationId>.<secret>` (like invitations); only the secret's hash is stored
  (`reservations.manage_token_hash`); erasing the guest clears it, so the link stops working. The partner-domain rule
  of R2.1 applies.
- Audit actor: system key `guest.online` ("Guest (online)") instead of a new actor kind (no change to `audit_logs`);
  status changes carry actor kind `guest`.
- Marketing consent: append-only `guest_marketing_consents` (granted, source `online_booking`), only when ticked.
- "Change" = cancel and book again (`pageSlug`). Mails with the manage link: R2.4. Staff see an **Online** badge.

### Requests and confirmations (R2.3b, as built)

| Method + path                                                                                               | Notes                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /public/booking/:slug/requests` `{ startsAt, partySize, guest, guestNote?, marketingOptIn, website }` | a `request` slot, or any grid start when the party is larger than every online table; `requested`, no table; manage link as for bookings; the same request again answers the same for 15 minutes |
| `POST /reservations/:id/accept` `{ tableIds? }`                                                             | `reservations.bookings.edit`; `requested → booked`, the engine's best fit or the chosen tables; `409 table_unavailable` writes nothing                                                           |
| `POST /reservations/:id/confirm`                                                                            | `pending → booked`                                                                                                                                                                               |
| `POST /reservations/:id/decline`                                                                            | `requested`/`pending → declined`; a pending booking frees its tables                                                                                                                             |

Answers to online bookings can't be undone (the guest is told, R2.4). A pending booking writes the delayed event
`reservations.pending.expiry_due` (`reservations.online.pendingExpiryMinutes`, default 120); its handler
`reservations.expirePending` expires it only if still pending (actor `job.outbox`, status change kind `system`).
`/host` shows a **Requests** list (oldest first, with age) with Accept / Confirm / Decline, "No table yet" on requested
rows and "Requests n" in the counts.

### Under load (R1.6 follow-up)

- A booking write claims its tables first and allocates its number only after the table rows are in (a temporary
  `~…` number until then, in the same transaction): concurrent losers of a table (`23P01`) never queue on the
  per-tenant number series counter.
- Booking write transactions set `lock_timeout = 3s`, shorter than Prisma's 5 s transaction timeout.
- Overload on the bookings routes — no pooled connection in time or an expired transaction (Prisma `P2028`), a lock
  timeout (`55P03`), a deadlock Postgres resolved (`40P01`) — answers `503 reservations.busy` with `Retry-After: 2`.
  5xx answers aren't stored by the idempotency layer, so retrying with the same key books once.
- Not covered yet: the same timeouts inside guards and global interceptors (before the bookings code runs) still
  answer 500 (platform-wide mapping, open).

### R1.7 the till seats and finishes bookings

Restaurants without a host: the waiter opens the order at the till and nobody presses Seat. pos emits
`pos.order.opened` (when a send opens an order) and `pos.order.closed`; reservations reacts in two outbox handlers,
as the system (`job.outbox`), with the till order on the status change (`source_order_id`) and in the audit snapshot
(`sourceOrderId`). pos never imports reservations.

- **Party order:** a till order belongs to a booking when it opened within ±`reservations.orderMatchWindowMinutes`
  (default 30) of the booking's start (before an early seat moved it). An older order is the previous party's, a
  much later one a walk-in's.
- **`reservations.seatOnOrderOpened`:** the one `booked`/`arrived` booking holding that table whose start is within
  the window of `openedAt` is seated (an early party starts at `openedAt`, keeping its length), if its tables are
  free apart from its own order. None or several → nothing.
- **`reservations.finishOnOrderClosed`:** the one `seated` booking holding that table is finished at the close (end
  `max(closedAt, start + 1 min)`, the guest's `last_visit_at`) when the closed order is its party's and none of its
  tables still has an open order (separate bills: the last close finishes it). Several seated → nothing and a warning.
  An order moved to another table (pos can't yet) would finish the booking on the table it closed on.
- **Manual seat and undo** don't count the party's own open order as occupying its table; any other open order still
  `409 reservations.table_occupied` (e.g. a walk-in's order 75 min after a no-show's start).
- **Duplicates and late events:** `processed_events` applies an event once per handler; on top of that a handler
  ignores an event when the booking has a status change made after it (an undo, a host action; compared by UUID v7 id, both from the database clock, not by app-set timestamps), so an auto-seat or
  auto-finish the host undid stays undone. Both are undoable like any change.
- **Feature off** for the organization → the handlers do nothing.
- **R1.8 `/host`:** a booking seated or finished by the system shows an "auto-seated from till" / "finished at the
  till" badge (from the latest change's `actorKind = system` and `sourceOrderId`) with its undo while possible.
- **Covers pre-fill** stays web-only in R1.9.

## Errors

| Code                                   | Status | When                                                                                         |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `reservations.reservation_not_found`   | 404    | unknown, another tenant's, a location the caller can't read                                  |
| `reservations.table_not_found`         | 404    | a table not at the location / archived / unreadable                                          |
| `reservations.combination_not_found`   | 404    |                                                                                              |
| `reservations.guest_not_found`         | 404    | unknown, another tenant's, or no booking at a location the caller reads                      |
| `reservations.table_unavailable`       | 409    | exclusion violation or engine found no free table; `details.tableIds`                        |
| `reservations.table_occupied`          | 409    | an open pos order or an overrunning seated party holds the table now                         |
| `reservations.table_walk_in_only`      | 409    | booking a `walk_in_only` table                                                               |
| `reservations.party_size_out_of_range` | 409    | table/combination can't take the party (staff may not `force` this)                          |
| `reservations.party_range_invalid`     | 422    | a rule or combination with min > max, or a rule whose min party exceeds the table's capacity |
| `reservations.pacing_exceeded`         | 409    | covers per slot reached (staff: retry with `force`)                                          |
| `reservations.starts_in_past`          | 409    | create or move to a start more than 15 min ago (parties already here are walk-ins)           |
| `reservations.phone_invalid`           | 422    | a guest phone number that isn't a valid number for the location's country (or international) |
| `reservations.outside_service_hours`   | 409    | outside the reservation hours or after the last booking time (staff: retry with `force`)     |
| `reservations.invalid_transition`      | 409    | e.g. seat a cancelled booking; `details.from`, `details.to`                                  |
| `reservations.undo_expired`            | 409    | older than 5 min, or not the latest change                                                   |
| `reservations.table_not_in_service`    | 409    | seat or undo onto the booking's own table that pos archived since; `details.tableIds`        |
| `reservations.hold_not_found`          | 409    | expired / unknown / other page (R2)                                                          |
| `reservations.holds_unavailable`       | 503    | Redis down (R2): online booking pauses, staff booking unaffected                             |
| `reservations.self_cancel_closed`      | 409    | past the cut-off (R2)                                                                        |

Labels `reservations.errors.<camelCase>`.

## Audit (actions in `AUDIT_ACTIONS`)

| Action                                      | Entity                    | Snapshot fields (allow-list)                                                                    |
| ------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `reservations.reservation.created`          | `reservation`             | `id`, `number`, `locationId`, `partySize`, `startsAt`, `endsAt`, `status`, `source`, `tableIds` |
| `reservations.reservation.updated`          | `reservation`             | same                                                                                            |
| `reservations.reservation.status_changed`   | `reservation`             | same                                                                                            |
| `reservations.reservation.status_undone`    | `reservation`             | same                                                                                            |
| `reservations.reservation.rules_overridden` | `reservation`             | same, plus `overriddenRules` (`pacing`, `serviceHours`): staff `force` (R1.6, Q2)               |
| `reservations.guest.anonymised`             | `reservation_guest`       | `id`, `anonymisedAt` (R1.9)                                                                     |
| `reservations.table_rule.updated`           | `reservation_table_rule`  | `tableId`, `bookingMode`, `minParty`, `maxParty`                                                |
| `reservations.combination.created/updated`  | `reservation_combination` | `id`, `locationId`, `name`, `tableIds`, `minParty`, `maxParty`, `onlineBookable`, `archivedAt`  |

Guest name, email, phone and notes never enter snapshots. Online and self-service actions are recorded with a new
`guest` actor kind (Q2; `auditActor.guest()`, no id stored, ADR 0008 amendment in R2.1); handlers use `system`.

## GDPR

- **Minimal fields:** name (online required, staff optional), email (online required for confirmation), phone
  optional, locale. No birthday, address, allergies-as-profile. Notes are per booking and erased with the guest.
- **Phone numbers** are stored in E.164 (`+493012345670`, CHECK on `reservation_guests.phone`). The api accepts
  what people type: local numbers ("030 1234567", "0176 12345678") are read with the country of the booking's
  location, international ones ("+44 20 …", "0044 …") as they are. Parsed and validated with `libphonenumber-js`
  (MIT, no dependencies, `min` metadata), in `packages/shared` so the web can check before sending too. A number
  it can't make valid E.164 of is `422 reservations.phone_invalid` (`details.field`), never stored as typed. The
  country is a new platform setting `country` (ISO 3166-1 alpha-2, every scope, default `DE`), added in R1.6.
- **Marketing opt-in** is never bundled with booking: a separate unchecked box; stored as an append-only
  `guest_marketing_consents (guest_id, granted boolean, wording_key, wording_version, source, created_at)`. No
  marketing feature consumes it yet.
- **Guests are reused** within the organization, so their history (and retention clock) spans visits (R1.6): a
  booking's guest matches a live (not anonymised) guest by **email** (case-insensitive; at most one per email) first,
  else by **phone** (normalised E.164; phone is not unique, families share a number: the most recently seen guest
  wins, `coalesce(last_visit_at, created_at)` newest first). A match only fills fields it doesn't have yet (name,
  email, phone), never overwrites. Neither matches → a new guest. `last_visit_at` is set when one of their
  reservations finishes.
- **Retention (Q8, as built 2026-11-26):** the worker's hourly retention pass (`bookings/guest-retention.ts`,
  `OutboxCleanup.register('guestRetention')`), per organization, up to 500 guests a pass: a guest is due when the
  latest of `last_visit_at`, their latest booking's end and their own `created_at` lies
  `reservations.guestRetentionMonths` (1–120, default 12; partner and organization only) back, and none of their
  bookings is still to come or running (`requested`, `pending`, `booked`, `arrived`, `seated` ending after now). Then it
  erases exactly what erasure on request erases (`eraseGuest`): name, email, phone, the bookings' notes and manage
  links, waitlist entries seated as their bookings; `anonymised_at` set; audit `reservations.guest.anonymised` as
  `job.guest_retention`. Bookings, statuses, `last_visit_at` and consents (guest id only) stay. **Deviation:** the spec
  planned a per-guest delayed event (`reservations.guest.retention_due`) rescheduled on every visit or booking; the pass
  computes the date when it runs, so there is nothing to reschedule or to forget, and the result is the same within an
  hour.
- **Erasure on request (R1.9, before the retention job of R2.5):** `POST /reservations/guests/:id/anonymise` under
  `reservations.setup.manage` (a manager or above, not the Host), from the booking edit dialog on `/reservations`
  after a confirm dialog. Irreversible. In one transaction, with the guest row locked: nulls `name`, `email` and
  `phone`; nulls `guest_note`, `staff_note` and `manage_token_hash` on all their reservations; sets `anonymised_at`;
  audits `reservations.guest.anonymised` (entity `reservation_guest`, snapshot `id` and `anonymisedAt` only).
  Bookings, statuses, party sizes and `last_visit_at` stay (counts, KPIs); `locale` stays (not personal).
  - **Who may:** the guest must have a booking at a location where the caller reads bookings (else
    `404 reservations.guest_not_found`), and the caller needs `reservations.setup.manage` at **every** location the
    guest has bookings at (else 403): erasing data other branches use is not one branch manager's call.
  - **Already anonymised:** 200 with the same body, no second audit row.
  - **Afterwards:** an anonymised guest never matches a new booking (matching reads live guests only), and their
    blanks are never filled again (fill-blanks writes only to live guests). A staff edit that adds guest details to
    a booking of an anonymised guest links that booking to a new (or matching live) guest instead.
  - Booking responses carry `guest.anonymisedAt`; the web shows "Guest data erased" in place of the name.
- Audit and events never hold personal data, so they need no erasure.

## Web

- **`/host`** (nav "Host", feature `reservations`, `reservations.bookings.read`), built for a tablet at the door:

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ Host  [Location ▾]   Sat 14 Nov  ◀ Today ▶      Covers 64/120 · Booked 22 · Seated 9   [+ Booking] [+ Walk-in] │
├──────────────────────────────┬──────────────────────────────────────────┬─────────────────┤
│ TIMELINE (today)             │ FLOOR  [All] [Dining room] [Terrace]     │ WAITLIST (R3)   │
│ 17:00 ───────────────────────│  ┌────┐ ┌────┐  ┌──────┐                 │ 1 Müller   2p   │
│ ● 18:30 Weber    4p  T4  ✓arr│  │ T1 │ │ T2 │  │  T4  │ ← seated 18:41  │   waiting 12m   │
│   [Seat] [No-show] [⋯]       │  │free│ │19:00│ │ occ. │   overrun 5m    │   [Notify][Seat]│
│ ○ 19:00 Schmidt  2p  T2      │  └────┘ └────┘  └──────┘                 │ 2 Ali     4p    │
│   [Arrive] [Seat] [Cancel]   │  ┌──────────┐ ┌────┐                     │   notified 2m   │
│ ○ 19:15 Klein    6p  T5+T6   │  │  T5+T6   │ │ T7 │ walk-in only        │                 │
│ ⚠ 18:00 Braun 2p  late 25m   │  └──────────┘ └────┘                     │ [+ Add to list] │
│   [No-show] [Arrive]         │ Legend: free · reserved soon · arriving · occupied · overrun   │
├──────────────────────────────┴──────────────────────────────────────────┴─────────────────┤
│ Toast: "Weber seated at T4"  [Undo 4:52]                                                  │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Click a timeline row → detail drawer (guest, notes, history, edit time/tables/party). Drag a booking onto a
floor table = seat there (R1 stretch; buttons first). Seat from the floor: tap a free table → "Seat walk-in" or
"Seat next booking". **R1 refresh:** every 30 s while visible (`useNow(30_000, reload)` like `/service`) and right
after each own action. **RT.1** swaps in the SSE stream (fetch streaming with the bearer header, `event: changed`
with ids only → re-fetch what the page shows; `: ping` heartbeat every 15 s; Caddy `flush_interval -1` and
`X-Accel-Buffering: no` on the stream route); on disconnect it falls back to polling until reconnected. As built: docs/platform/realtime.md.

**As built in R1.8b** (`components/reservations/host-page.tsx`; the waitlist column, drag-to-seat and the detail
drawer come later):

- **Header:** location picker (more than one location), ◀ / Today / ▶ and a date field, the day's counts (covers of
  blocking bookings, booked, seated), **+ Booking** and **+ Walk-in** (both with `reservations.bookings.manage`, today
  only for walk-ins).
- **Which moment:** today is live (`GET /reservations/floor?locationId=`, now). Another day shows a time selector
  (every 15 minutes through the day's `serviceWindows`, default the first window's start = the floor's `at`) and the
  floor as a plan (`?at=`, bookings only); no actions on the floor then. Times show in the location's `timeZone` (floor
  response).
- **Timeline:** `GET /reservations?locationId=&date=`, by start. Per status: booked → Arrive, Seat, No-show (after
  start), Cancel; arrived → Seat, No-show (after start), Cancel; pending → Cancel; seated → Finish. Cancel and No-show
  confirm first. Flags: **"Table not in service, move booking"** (`tablesNotInService`) and **"Table still occupied"**
  (the floor's `next.tableStillOccupied` for that booking), both with **Change tables** (PATCH `tableIds`, or Seat with
  `tableIds` when seating); a 409 `table_not_in_service` on Seat opens the same dialog. Badges **"Auto-seated from
  till"** / **"Finished at the till"** (`lastChange.actorKind = system` with `sourceOrderId`) with **Undo** while the
  change is undoable (5 min, not an undo, not the creation).
- **Floor:** tables by area with their state, current party, next booking, `overrun` and walk-in-only badges. Today, a
  free table offers **Seat walk-in** (dialog with that table) and **Seat next booking** (its `next`, when booked or
  arrived).
- **+ Booking** (phone booking): date, time, party size, name, phone, guest note, staff note; tables optional (the
  engine picks). `409 pacing_exceeded` / `outside_service_hours` shows the reason and **Book anyway** (same request
  with `force: true`); other errors show their label.
- **+ Walk-in:** party size, tables, optional name and phone. `409 table_unavailable` offers **Seat until HH:MM** (the
  earliest `next.startsAt` of the chosen tables, when ≥ 15 min away) with `endsAt`.
- **Undo bar** after each own status action ("Weber: seated", Undo with the remaining minutes) until the window ends.
- **Refresh:** both lists every 30 s while visible and after each own action.
- API additions for the screen: the floor response carries the location's `timeZone`; `lastChange` carries `fromStatus`
  and `undoesId` (whether it can be undone).

- **`/service` floor (pos)** adds reservation badges and the "occupied by booking" state by also calling
  `GET /reservations/floor` (only with the feature and `reservations.bookings.read`); the till pre-fills `covers`
  from the seated reservation's party size. No pos api change beyond `covers` (G5, Q7).

- **`/reservations`** (nav "Reservations"): list by day, search by name/number, create/edit dialog using the
  availability endpoint (slots grid, auto-allocated tables, "choose tables" override).

**As built in R1.9** (approved 2026-11-04; `components/reservations/reservations-page.tsx`, `host-dialogs.tsx`, `lib/reservations/service.ts`):

- **`/reservations`** (nav "Reservations", `reservations.bookings.read`): location picker, a date range (one day by
  default, up to 31 days: one `GET /reservations?locationId=&date=` per day), search by guest name or number on the
  client, rows by start with status, party, tables and guest. With `reservations.bookings.manage` a row opens
  **Edit** (date, time, party, tables, guest name, phone, email, notes; PATCH, same `force` flow as + Booking) and
  **Cancel** (confirm). With `reservations.setup.manage` the edit dialog also has **Erase guest data** (confirm dialog
  naming what is erased and that it can't be undone).
- **Booking dialog** (shared by `/host` + Booking and `/reservations`): after date and party size it shows the day's
  **free times** (`GET /reservations/availability`, slots that are `available`, with the tables the engine would
  pick) and **Choose tables** to pick them by hand. A typed time still works as in R1.8b.
- **`/service` badges** (web only, G5): with the feature and `reservations.bookings.read`, the pos floor also loads
  `GET /reservations/floor?locationId=` and shows the next booking on a table ("19:30 · 4 p.") and "From booking"
  on a table seated from one. A failed reservations call hides the badges; the till works as before.
- **Covers pre-fill** (Q7, web only): opening the till on a table whose floor entry has a seated booking pre-fills
  covers with its party size; the waiter can change it.
- **`/host` fix:** Arrive and Seat show only once a booking starts within `floorHorizonMinutes` (or has started).
- **Seed and smoke:** `seed-dev` adds `host@durby.local` (Host role); the Playwright web server also runs the outbox
  worker (ready on its `outbox.worker_started` log line); `e2e/reservations.spec.ts`: the host books on `/host`
  (Berlin's current time, "Book anyway" outside the opening hours), arrives, seats, undoes, seats again; the waiter
  sees "From booking" on `/service`, the till pre-fills 2 guests, sends a ticket and closes the order; `/host` then
  shows Finished with "Finished at the till".
- **Defaults:** the booking dialog's time is the next quarter hour; the floor response carries `horizonMinutes`. An
  erased guest reads "Guest data erased" on `/host` and `/reservations`.
- **Settings → Reservations** tab (feature `reservations`, `reservations.setup.manage`; R1.5b): a location picker,
  then **Tables** (one row per table in service: booking mode, min party, max party, saved per row) and
  **Combinations** (list, create/edit dialog with table checkboxes, archive/restore, "show archived"). The rules live
  here, not on pos's `/tables` grid (gated by pos keys). The UI warns, without blocking, when a max party exceeds a
  table's seats or a combination's total seats.
- **R1.5c (before R1 ships):** the same tab edits the picked location's `reservations.*` settings ("inherit" / "set
  here"), gated by `reservations.setup.manage`, so a manager configures each branch without
  `platform.settings.manage`. `openingHours` and `closedDates` stay on `platform.settings.manage` (General tab and
  the settings api). A service-hours schedule that would widen past the opening hours shows why (the engine only
  intersects, so the wider part would never be offered). Organization-level values stay on the General tab.
- Every string is a label key (`reservations.*`, `en` + `de`); colors via semantic tokens; data via shared Zod
  schemas in `packages/shared/src/api/reservations.ts`.
- **Public page** (R2): `/(public)/b/[slug]` in `apps/web`, themed by the partner domain: date → party → slot
  (hold countdown) → details + consent → confirmation. `/(public)/b/manage` reads the fragment token.

## Guest notices (Q9)

`GuestNotifier` (reservations-internal port) with channels: `email` (MVP, via platform/mail) and `in_person` (no
send; the host screen shows "tell the guest" and records the notice). SMS or push become further channels later
without touching callers. Built with the waitlist (ADR 0084): email, or told in person.

## Mail (R2)

Confirmation, reminder and cancellation mails, in the guest's locale, rendered with the organization's labels
(`LabelService`, `format: 'html'` for HTML parts), with an `.ics` attachment (`METHOD:PUBLISH`, `UID =
<reservation id>@<partner domain>`, `DTSTART/DTEND` in UTC, `SEQUENCE` bumped on change; cancellation sends
`METHOD:CANCEL`). Needs `MailMessage` to grow `html?` and `attachments?` (platform/mail, R2 step). Sent after
commit through `MailDispatcher`; reminder from the delayed outbox handler (at-least-once: `reminder_sent_at`
written in the handler transaction; a crash between send and commit can send twice, which is accepted).

## Test plan

Unit (Vitest, written first):

- Zoned time: wall-clock → instant and back for Europe/Berlin across **2026-03-29** (02:00–02:59 missing) and
  **2026-10-25** (02:00–02:59 twice); day bounds of both days are 23 h / 25 h; slots of a 17:00–23:00 window are
  identical before and after the switch in local time and shift by one hour in UTC; window past midnight.
- Engine: turn-time lookup, pacing per slot, `lastBookingOffset`, min lead / max advance, online vs staff filters,
  `walk_in_only` never allocated, best-fit order (smallest table, then combination), combination blocked when one
  member is blocked, holds excluded online only, back-to-back `[)` periods allowed, closed dates, service hours
  narrowing opening hours.
- **Overrun (G2):** 19:00–21:00 party seated, not finished; at now = 21:05 (15-min slots) the table is not offered
  for 21:00 or 21:15 but is for 21:30; at 21:16 not for 21:30; finished at 21:20 → offered from 21:30 again; a
  21:00 booking already on the table is flagged, not moved; the same party at 20:55 doesn't block 21:00.
- **Open pos order (G1):** table with an order opened at 20:00 and turn 105 min → busy until 21:45; at 21:50 still
  open → busy until the next slot + interval; no order → free; seated reservation and open order on the same
  table count once.
- Status machine: every allowed / rejected transition; undo window boundaries (4:59 ok, 5:01 rejected), undo of
  an undo rejected, undo re-blocking a taken table rejected.
- Token: manage token embeds org id, hash compare constant-time.

Integration (Testcontainers Postgres, `test/reservations-*.int.spec.ts`):

- **Exclusion constraint**: two overlapping blocking rows on one table → `23P01`; touching periods ok; a
  cancelled (non-blocking) row doesn't block; status change back to blocking on an overlapped table fails; two
  tenants with the same table id pattern don't interfere (constraint includes `tenant_id`).
- **Race**: 20 parallel `POST /reservations` for the same table and slot → exactly one 201, the rest 409.
- **Write-time occupancy**: creating a 21:00 booking on a table whose 19:00 party is seated and overrunning → 409
  `reservations.table_occupied`; same for a table with an open pos order; walk-in onto it → 409.
- **Boundaries**: `pos` source never imports `modules/reservations` (boundaries lint + `test/boundaries.spec.ts`).
- Sync trigger: updating `starts_at/ends_at/status` updates `period/blocking`; inserting a mismatching row fails.
- RLS coverage test (existing) passes; append-only catalog test covers the two append-only tables.
- **Cross-tenant isolation** (e2e): tenant B can't list, read, update, seat, undo, see availability conflicts from,
  or stream events of tenant A's reservations, rules or combinations (404 / empty), and can't book A's table ids.
- Outbox: `pos.order.closed` finishes the seated reservation; redelivery and out-of-order delivery are no-ops.
- Permissions: route-marker snapshot; Host role grants; location-limited host sees only their locations.
- Holds (R2, real Redis container): two holds on one table/slot → one wins; TTL expiry frees; booking consumes hold;
  Redis down → 503 online, staff unaffected.
- Retention: guest anonymised after the delay; KPIs unchanged.

E2E smoke (Playwright): staff creates a booking, host arrives + seats it, undo restores, closing the pos order
finishes it.

## Build order (one PR each; tests listed are written first)

**Status (2026-11-11).** Done and merged: R0 (#35), R1.1 (#40), R1.2 (#41), R1.3 (#44), R1.4 (#45), R1.5a (#47),
R1.5b (#48), R1.5c (#49), R1.6a (#50), R1.6b (#51, reached main via #52), R1.6c (#52), R1.7 (#53), R1.7b (#61),
R1.8a (#62), the per-module label split (#65, ADR 0022), R1.8b (#73), users' language (#74), R1.9 (#76, with the
manual guest anonymise moved forward from R2.5). Overload follow-ups merged: #54, #55 (ADR 0021), #56, #57;
build-order status #60. R1.9's smoke test is green in CI, so the pilot can start. **In progress: RT.1** (ADR 0044,
built during the pilot); RT.2 follows once the pilot has started.

| #     | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Tests first                                                                                                                                                                                                                                                                                                                            | Done when                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| R0.1  | `packages/shared/src/time/zoned.ts`: wall-clock ↔ instant in an IANA zone (`zonedInstant`, `zonedParts`, `zonedDayBounds`, `calendarMonthIn`), DST-safe, `Intl` only; numbering and web audit filters use it                                                                                                                                                                                                                                                                                                             | DST unit tests (both 2026 switches, 23/25 h days, missing/duplicate wall times)                                                                                                                                                                                                                                                        | numbering + web audit filters use it; lint, typecheck, test green                                                   |
| R0.2  | Platform settings `openingHours`, `closedDates` (+ labels, schema), and `serviceWindowsOn(date, hours, closedDates, tz)` in shared time                                                                                                                                                                                                                                                                                                                                                                                  | schema tests (overlaps, past midnight, ≤ 4 windows), window expansion across DST                                                                                                                                                                                                                                                       | api stores them per location; settings page edits them at organization scope (location picker: R1.5)                |
| R0.3  | pos read port `PosFloorReader` in `pos/index.ts` (`tablesAt(locationId)`, `table(id)`, `openOrders(locationId)` → `{ tableId, orderId, openedAt, covers }`); no migration: the composite-FK target index already exists (pos_orders migration)                                                                                                                                                                                                                                                                           | unit/e2e: port respects RLS, location access and archived tables                                                                                                                                                                                                                                                                       | consumer test compiles against `index.ts` only; boundaries lint green                                               |
| R0.4  | `pos.order.closed` v1 event (`orderId`, `locationId`, `tableId`) written in `OrdersService.close`; pos.md + events registry                                                                                                                                                                                                                                                                                                                                                                                              | e2e: closing writes exactly one event; closing twice writes none                                                                                                                                                                                                                                                                       | outbox e2e green                                                                                                    |
| R0.5  | `pos_orders.covers` (nullable, expand-only) + `covers?` on first send + `PATCH /pos/orders/:id`; till field                                                                                                                                                                                                                                                                                                                                                                                                              | e2e: covers stored, range-checked, audited; replay-safe                                                                                                                                                                                                                                                                                | waiter sets covers on the till                                                                                      |
| R1.1  | Features `reservations`, `reservations.online` (+ migration adding both to `full`), permission keys, Host system role (2 migrations), labels, ADR 0007 amendment; first `GET /reservations/floor` (occupancy from `PosFloorReader`, so Host needs no pos order key)                                                                                                                                                                                                                                                      | registry tests, rbac migration int test, route-marker snapshot                                                                                                                                                                                                                                                                         | Host role exists in every org; `/me` shows the keys                                                                 |
| R1.2  | Reservations settings keys (table above) with labels                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | settings registry test, schema tests for `serviceHours`/`turnTimes`                                                                                                                                                                                                                                                                    | settings page lists them; values resolve per location                                                               |
| R1.3  | First: run the `btree_gist` check on staging (G4). Schema: rules, combinations, reservations, guests, `reservation_tables` (raw SQL above), status changes; number series                                                                                                                                                                                                                                                                                                                                                | **constraint int tests, race test, trigger tests**, RLS coverage, append-only catalog                                                                                                                                                                                                                                                  | migration SQL reviewed; `pnpm test` green on Testcontainers                                                         |
| R1.4  | Availability engine (pure)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | engine unit tests (spec → Test plan)                                                                                                                                                                                                                                                                                                   | 100 % branch coverage on the engine                                                                                 |
| R1.5a | Table rules + combinations API (below: R1.5 setup API)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | e2e: rules and combinations end to end incl. defaults, validation 400/422, 404s, location-limited 404, staff/cashier 403, feature off 403, idempotent replay, audit rows, **cross-tenant isolation**                                                                                                                                   | all routes in snapshot                                                                                              |
| R1.5b | Settings → Reservations tab: tables (rules) and combinations per location                                                                                                                                                                                                                                                                                                                                                                                                                                                | component tests (visibility, save rule, combination dialog, error labels)                                                                                                                                                                                                                                                              | manager configures a location in the browser                                                                        |
| R1.5c | The same tab edits the location's `reservations.*` settings (inherit / set here) under `reservations.setup.manage`; service hours wider than opening hours explained                                                                                                                                                                                                                                                                                                                                                     | e2e: manager sets and inherits at a location, can't set `openingHours`/`closedDates` or another location; component tests                                                                                                                                                                                                              | a manager sets different hours per branch                                                                           |
| R1.6a | Phone normalisation (`libphonenumber-js` in shared), platform setting `country` (default DE); index `reservation_guests (tenant_id, phone) WHERE anonymised_at IS NULL` for guest matching                                                                                                                                                                                                                                                                                                                               | unit tests: DE landline and mobile, +/00 international, another country, invalid; settings registry; migration drift test                                                                                                                                                                                                              | `normalisePhone` used by web and api                                                                                |
| R1.6b | Bookings API: create, list, get, PATCH (move/extend/tables/party/guest/notes), availability `excludeReservationId`; write-time checks; guest matching; audit; `reservations.reservation.created/updated` events                                                                                                                                                                                                                                                                                                          | e2e per route, write-time occupancy, 20-way race → one 201, guest matching (phone-only twice → same guest, email beats phone), idempotent replay, **cross-tenant isolation**                                                                                                                                                           | routes in snapshot; replay returns the same booking                                                                 |
| R1.6c | Status actions (arrive, seat, finish, no-show, cancel) + undo, walk-ins; `status_changed` events                                                                                                                                                                                                                                                                                                                                                                                                                         | state-machine unit tests incl. undo window 4:59/5:01, e2e per route, seat re-checks occupancy, **cross-tenant isolation**                                                                                                                                                                                                              | routes in snapshot                                                                                                  |
| R1.7  | pos integration: `reservations.finishOnOrderClosed` handler (sets `last_visit_at`)                                                                                                                                                                                                                                                                                                                                                                                                                                       | handler int tests: redelivery, out-of-order, feature disabled                                                                                                                                                                                                                                                                          | closing the order on the till finishes the booking                                                                  |
| R1.7b | Fewer transactions per booking request (ADR 0021 follow-up): entitlements and membership guards in one transaction, the location check inside the booking transaction, settings resolved in one transaction; platform-wide `lock_timeout` 4 s set per transaction with the tenant context (ADR 0021 updated). Idempotency (ADR 0014) unchanged                                                                                                                                                                           | e2e pins ≤ 3 transactions per `POST /reservations`; a lock wait past 4 s answers 503 `platform.busy`; full suite green                                                                                                                                                                                                                 | ≤ 3 transactions per booking, pinned in a test                                                                      |
| R1.8a | Derived floor endpoint (`deriveFloor`, pure) with `at=`/`date=`, live states today and bookings only on other days, `next.tableStillOccupied`; booking responses add `lastChange` and `tablesNotInService` (`PosFloorReader.tables`); setting `reservations.floorHorizonMinutes`                                                                                                                                                                                                                                         | derive unit tests (every state, overrun, open orders, horizon edge, combination, other day: bookings only); e2e: fixtures, `at`/`date`, archived table flag, auto-seat `lastChange`, 404/403, **cross-tenant isolation**, 2 transactions per floor request                                                                             | floor matches the state table for fixtures                                                                          |
| R1.8b | `/host` screen: location, date and time selector (default first service window; live only today), timeline with actions, floor, walk-in dialog, "+ Booking" dialog (phone booking: date, time, party, name, phone, notes; tables optional, the engine picks; pacing / hours 409 offers "book anyway" with `force`), auto-seated / finished-at-till badges with undo, "table not in service" flag + change-tables dialog, undo bar; 30 s polling                                                                          | component tests (Vitest) incl. other-day plan view; browser check at 1024×768 and 768×1024, en and de, on a throwaway container                                                                                                                                                                                                        | a host runs the door on a tablet                                                                                    |
| R1.9  | `/reservations` list (search, by day, edit, cancel); booking dialog free times + choose tables; `/service` floor badges + covers pre-fill (web only); Arrive/Seat within the floor horizon; manual guest anonymise (`POST /reservations/guests/:id/anonymise`, moved forward from R2.5); host seed user; worker in the Playwright run                                                                                                                                                                                    | component tests (Vitest), Playwright smoke                                                                                                                                                                                                                                                                                             | smoke passes: book → arrive → seat → undo → close order → finished                                                  |
| RT.1  | Realtime (ADR 0044, docs/platform/realtime.md): `platform/realtime` (SSE over fetch streaming, one Redis subscriber per api process, channel per tenant + location + topic, 15 s ping, ends at token expiry and on revocation), outbox handlers `reservations.publish*` and `pos.publish*`, worker woken by `pg_notify` on commit; `GET /reservations/stream`, `GET /pos/stream`; `/host`, `/reservations` and `/service` reload on hints, polling as fallback; Caddy: no `encode`, `flush_interval -1` on stream routes | e2e: tenant B's stream never receives A's events, nor another location's; permission, feature and location checked on connect; heartbeat; token expiry; revocation; 50 open streams hold no pool connection. int: commit wakes the worker. Playwright: second tablet in < 2 s; api restart → reconnect + reload without a page refresh | staging shows a change on a second tablet in < 2 s                                                                  |
| RT.2  | After the pilot has started: events `pos.print_job.queued` (print job queued for a printer at a location) and a ticket-bumped event (a kitchen or bar ticket changed status); topics `pos.print` and `pos.kitchen` on `GET /pos/stream`; the till print runner (ADR 0033 §11, today 1.5 s polling) claims on a hint, and the kitchen and bar boards (today 5 s) reload on hints; polling stays as fallback                                                                                                               | e2e: a queued job reaches the till stream of its location only; a bumped ticket reaches the board stream. web: print runner claims on a hint and still polls when disconnected                                                                                                                                                         | a ticket on paper within about 3 s with the runner idle-polling slowed down; staging kitchen board updates in < 2 s |
| R2.0  | **Built 2026-11-26.** Outbox delayed events: `OutboxService.add(tx, event, { availableAt })`; lag reporter measures from `available_at` (ADR 0013 amendment)                                                                                                                                                                                                                                                                                                                                                             | int: event not claimed before `available_at`; lag ignores future events                                                                                                                                                                                                                                                                | outbox tests green                                                                                                  |
| R2.1  | **Built 2026-11-26 (ADR 0085; tenant table + definer lookup instead of a platform table).** ADR: public tenant resolution (amends hard rule 1, CLAUDE.md) + `guest` audit actor; platform `public_booking_pages`, public guard, rate limits, honeypot                                                                                                                                                                                                                                                                    | e2e: unknown/disabled page 404, client org ids ignored, other tenant unreachable, limits                                                                                                                                                                                                                                               | ADR accepted; public GET availability works on staging partner domain                                               |
| R2.2  | **Built 2026-11-26 (one hold set per location, not per table).** Redis holds (Lua) + public hold routes; settings `minLeadMinutes` and `maxAdvanceDays`, applied by the engine to the online channel (must land before the widget, R2.3/R2.6)                                                                                                                                                                                                                                                                            | int tests with Redis container: contention, TTL, replace, Redis down                                                                                                                                                                                                                                                                   | two browsers can't hold the same slot                                                                               |
| R2.3  | **R2.3a built 2026-11-26 (guest books, manage link, self-cancel, consent); R2.3b built 2026-11-26 (requests, pending confirm/decline/expiry).** Public booking + manage token + self-cancel; marketing consent table; Requests: parties above `instantMaxParty` become `requested` (no table), accept/decline; pending: within it while `autoConfirm` is off (tables blocking), confirm/decline, expiry (`online.pendingExpiryMinutes`, delayed event); `declined`/`expired` statuses; both on `/host`                   | e2e: hold required, consent stored separately, cut-off, token in fragment only; a request blocks no table, a pending booking blocks and counts as covers, expiry releases tables and skips confirmed ones, accept re-checks capacity (409), decline                                                                                    | guest books and cancels on staging                                                                                  |
| R2.4  | Mail: `MailMessage.html` + `attachments`; confirmation/cancel mails with `.ics`; request received / accepted / declined, pending received / confirmed / declined / expired mails; labels en/de                                                                                                                                                                                                                                                                                                                           | `.ics` snapshot tests (UTC, UID, SEQUENCE, CANCEL), SmtpMailer int test with attachment                                                                                                                                                                                                                                                | Mailpit shows mail + valid `.ics` (imports in Apple/Google Calendar)                                                |
| R2.5  | Reminder (delayed event) + retention anonymisation (delayed event; the manual anonymise of R1.9 is its routine)                                                                                                                                                                                                                                                                                                                                                                                                          | handler int tests: rescheduled/cancelled bookings skip, setting change reschedules                                                                                                                                                                                                                                                     | anonymised guest has no PII; KPIs unchanged                                                                         |
| R2.6  | Public web page `/(public)/b/[slug]` and `/b/manage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | component tests, Playwright: full online flow                                                                                                                                                                                                                                                                                          | lint, typecheck, test green; a11y check passes                                                                      |

R3 (waitlist, KPIs) gets its own plan after R2.

## Open questions

- **Standalone reservations add-on.** Today both features are in `full` only, because reservations reads pos
  tables (`dependsOn: ['pos']`). Selling reservations without table service would need either a plan with `pos`
  tables but not the till, or moving dining tables/areas out of `pos` into a module both depend on. Decide before
  pricing a reservations-only product; until then organizations outside `full` get it by entitlements override.
