# ADR 0033: Printers as a list, a print queue for the till, and in-app updates

- Status: accepted (2026-11-08)
- Date: 2026-11-08
- Step: Android app version 1.1 (docs/modules/android-app.md). Builds on [ADR 0032](0032-android-app-lan-printing.md);
  touches [ADR 0025](0025-bill-layout-and-stations.md) (stations), [ADR 0031](0031-direct-to-bill.md) (processing
  switches) and [ADR 0010](0010-settings.md) (forward-compatible reading).

## Context

Version 1 prints bills only, on one bill printer per location (setting `pos.printers`). Kitchen and bar tickets go
through Android's print screen, and orders taken on waiter phones never reach a printer. Restaurants differ: one has
a single printer for everything, another three (receipt, bar, kitchen), another two tills with a receipt printer each
or a kitchen ticket on two printers. Whatever we build must work for any of them, not one customer. A restaurant moving
from another till system keeps that system printing until Durby is switched on per printer, so a new printer must
never print by surprise. Version 1 also can't update itself.

## Decisions

1. **Printers are a list per location**, in their own table `pos_printers` (tenant table, RLS), not a setting: name,
   address, port, width, cutter, image mode, `enabled`, `prints_bills`. Names are unique per location among printers
   in use. Printers are archived, never deleted: print jobs and the audit keep pointing at them.
2. **What a printer prints**: bills (`prints_bills`) and/or the tickets of chosen stations (`pos_printer_stations`,
   many-to-many). One printer may serve several stations; one station may print on several printers.
3. **Stations by key.** Stations are a fixed pair today (`prep_station` enum: kitchen, bar). Printers link to a
   station by its key (text, checked against today's keys), so the later step "stations as a list" (Pizza, Dessert,
   a second bar) swaps that check for a foreign key to its table, whose keys include `kitchen` and `bar`, without
   touching printers.
4. **New printers start switched off** and print nothing until switched on, after a test print. `enabled` isn't
   accepted when a printer is added.
5. **Several receipt printers.** A bill goes to this device's default receipt printer if it still prints bills at
   the location, else to the only one, else the device asks once and keeps the answer as its default; with none, the
   Android print screen as in version 1. The default is a device setting (in the app's storage from version 1.1; until then
   in memory, so the till asks once per app start: the web never uses browser storage).
6. **Remote commands and print jobs reference a printer** (`printer_id`), not a slot. A test print names its printer
   (required by the api; a CHECK follows with the contract step, since the previous release still inserts test prints
   without one) and runs whether or not the printer is on; its page names the printer.
7. **Version 1's value is copied**: the migration turns each location's effective `pos.printers.bill` (location,
   brand or organization value) into a printer that is on and prints bills, named by its address, audited as the
   migration. The setting stays, read forward-compatibly, and the bill layout still carries it, so the previous
   release keeps printing during a deploy or after a rollback; a later contract step removes it.
8. **Forward-compatible reading.** A setting may declare a `read` schema that drops what the release doesn't know
   before the strict schema applies; writes stay strict (ADR 0010). `pos.printers` has one, and a printer's station
   keys are read the same way.
9. **Image mode only.** Every printer gets a picture. A text mode for impact printers is a later option.
10. **A print queue per printer** (`pos_print_jobs`, step 2): a sent ticket creates one job per printer that is on
    and serves its station, in the ticket's own transaction; a station with processing off sends no ticket
    (ADR 0031). A device with the app claims jobs with one atomic `UPDATE … RETURNING`, prints and reports. Running
    jobs needs `pos.bills.print`.
11. **Delivery by polling at 1.5 s while the app is open**, one small indexed query and no extra transaction per
    poll; server-sent events replace it in RT.1, with polling as the fallback. Target: a ticket on paper within about
    3 seconds.
12. **Never twice, never lost.** Retried by itself only when nothing can have printed (not reachable, or paper out or
    cover open before sending); a connection lost while sending, or no answer within 60 s, becomes "check printer"
    with Reprint. The app answers a job id it already sent from memory. Warnings on the Kitchen and Bar screens, the
    till and the order page when jobs wait. A job older than `pos.printJobMaxAgeSeconds` (default 600 s, per
    location, fixed per job when queued) is never printed by itself: the poll and the claim skip it, a late retry
    becomes "check printer" (`print.expired`), and only Reprint brings it back. This also covers jobs queued before
    the till runner exists. One open bill per order and printer: a second Print bill gets the waiting job.
13. **Which devices print**: any device with the app at its location unless its device setting "This device prints"
    is off (default on). Browsers never print jobs. A bill from a device without the app is queued for the receipt
    printer that device chose.
14. **In-app updates**: `/downloads/android/latest.json` on the staging server (version code, name, APK address,
    SHA-256); the app offers "Update now", checks the SHA-256 and hands the APK to Android's installer. APKs are built
    and signed locally. Version 1.1 itself is installed by hand once.

## Steps

1. Printers as a list: `pos_printers`, `pos_printer_stations`, `printer_id` on remote commands, the copy of version 1
   values, the api, Settings → Printers, bills by the resolution order.
2. `pos_print_jobs`, its api and the warnings' status.
3. The till runner on every page in the app, ticket layout, warnings, bills from devices without the app.
4. App 1.1.0: Settings → This device ("This device prints", default receipt printer), screen kept on while Durby is
   open, the updater; emulator run with several virtual printers.

Later, its own step: stations as a list.

## Consequences

- A printer switched on in Durby prints alongside the previous till system for that station: switch that system's
  printing off for it at the same time.
- Polling costs one small request per till every 1.5 s; RT.1 removes it.

### Rollback

- **After this release, printer edits go to `pos_printers` only.** Nothing writes `pos.printers` any more (Settings →
  Printers no longer edits it), so the setting keeps the last value version 1 saved.
- **A rollback to the previous release restores that last `pos.printers` value**: bills print on the printer as it was
  before this release. Printers added, renamed, re-addressed, switched off or archived since are not seen by the
  previous release; its Settings → Printers shows and edits the old value again.
- **The schema stays** (expand only, ADR 0004): `pos_printers`, `pos_printer_stations` and
  `pos_printer_commands.printer_id` remain and the previous release ignores them. Rolling forward again shows the
  printers as they were before the rollback; edits made to `pos.printers` during the rollback are not copied again
  (the copy runs once, only for locations without a printer).
- **The print object is unchanged** (no file under `apps/android` changed): the version 1 app keeps working with this
  release's web. Checked on the emulator (2026-11-08) with the version 1 build of commit `035bcbb`: a bill on a
  migrated printer, Find printer, and a remote test print from a browser. A test print the previous release queued
  in its last 5 minutes (no printer) answers "no printer" here and is sent again from Settings.
- **The contract step** (after version 1.1 has run for a while) stops serving `pos.printers` in the bill layout,
  unregisters the setting, removes its values and adds the CHECK that a test print names its printer.

## Amendment (2026-11-09): app 1.1 device settings and screen on

- **Screen on only on devices that print.** The screen stays on while Durby is in front **and** "This device prints"
  is on, not on every device with Durby open (step 4 above): waiters' phones with printing off sleep as usual and
  don't drain their battery. A till keeps polling because its screen never turns off.
- **Device settings through the print object.** "This device prints", the till location ("Prints for") and the
  default receipt printer per location are stored by the app (`deviceSettings` / `setDeviceSettings`, protocol 1) and
  edited on a Durby page, Settings → This device, shown only inside the app. The web still never uses browser
  storage. A device with printing off runs neither print jobs nor remote commands.
- **Features, not versions.** `info` names what an app can do (`parallel`, `deviceSettings`, `nothingPrinted`); the
  web gives an app without `features` (1.0) the version 1 behaviour. The protocol version stays 1.
- **Parallel sending in the app**: one thread per printer address (at most 16, the rest share one), so one printer's
  jobs stay in order while different printers print at the same time; `nothingPrinted` reports a job that failed
  before any of its bytes were written.
- **The updater never installs by itself.** "Update available" is a small notice above the page with "Update now"
  and "Later", never a dialog, so it doesn't interrupt service on a till; "Later" hides it until the next check
  (each app start and every 6 hours). Before Android's installer asks the user, the app checks the SHA-256 from
  `latest.json`, the package and version code, and that the APK is signed with the installed app's certificate.
