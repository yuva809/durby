# ADR 0020: A module's own permission key may edit its own settings at a location

- Status: accepted (2026-11-01)
- Date: 2026-11-01
- Step: Reservations R1.5c. Amends [ADR 0010](0010-settings.md) §6. Spec:
  [reservations](../modules/reservations.md) → Web

## Context

Settings writes need `platform.settings.manage` (ADR 0010 §6), which only Owner and Admin hold. Reservations has
per-location policy (service hours, slot interval, turn times, pacing, …) that the restaurant manager sets up, not
the owner: the first customer runs four branches with different hours, and managers hold
`reservations.setup.manage` but not `platform.settings.manage`. Granting managers `platform.settings.manage` would let
them change every platform setting (currency, negative stock, locale, opening hours) at their locations.

## Decisions

1. **Delegated writes.** A module may expose writes of its **own** settings (keys `module.*` with its module prefix)
   at **location** scope under its **own** permission key. It calls `SettingsAdmin.set` / `remove` with that key as
   the delegated permission; SettingsAdmin checks the key at the location instead of `platform.settings.manage`, and
   everything else stays one code path: registry validation, allowed scopes, "no JSON null", in-use checks, audit
   (`platform.setting_value.*`, the user as actor) and `config.settings.changed`.
2. **Guards in SettingsAdmin, not in the module.** A delegated write is refused (programming error, 500) unless the
   permission's module prefix equals the key's module prefix and the scope is a location. Platform-wide keys
   (`openingHours`, `closedDates`, `timezone`, `locale`, …) have no module prefix, so they can never be delegated;
   organization and brand values stay on `platform.settings.manage`.
3. **The module route still follows rule 10**: `@RequirePermission(<module key>)`, `@RequireFeature`, an allow-list
   of its keys in the route's schema, and the location check (404 where the caller can't read, 403 where they can't
   manage).
4. **First use:** `GET/PUT/DELETE /reservations/settings[/:key]?locationId` under `reservations.setup.manage`.

_Rejected:_ a per-key `managePermission` in the settings registry with the platform settings api checking it: the
platform route would need a dynamic permission marker (rule 10 wants one declared key per route), and every client of
`/settings` would have to learn which keys a user may touch.
_Rejected:_ granting managers `platform.settings.manage` at their locations: too broad (see Context).

## Consequences

- The general settings api and the General tab are unchanged; module settings at a location are edited on the
  module's own page.
- Audit rows look the same as platform writes; the action key and actor tell who changed what.
- Another module adopting this needs no ADR, only its own routes and tests (delegated key, allow-list, location).
