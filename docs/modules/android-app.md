# Android app

A minimal Kotlin app that loads the Durby website and prints bills over LAN (ADR 0032). Version 1: one bill printer per
location, 58 mm / 384 dots first. Status: version 1 in progress (ADR 0032 §14–15); the app checks the device itself, no separate A0 call.

## Parts

| Part                                  | Where                                                           |
| ------------------------------------- | --------------------------------------------------------------- |
| App: WebView, printing, device screen | `apps/android/` (`tech.durby.pos`, minSdk 28, targetSdk 35)     |
| Print protocol (Zod)                  | `packages/shared/src/native-print.ts`                           |
| Printer setting                       | `packages/shared/src/settings.ts` (`pos.printers`)              |
| Web: detection, rendering, messages   | `apps/web/lib/print/`, `apps/web/components/pos/order-page.tsx` |
| Web: Settings → Printers              | `apps/web/components/settings/printers-page.tsx`                |
| Virtual printer for tests             | `tools/virtual-printer/`                                        |

## Printers (ADR 0033)

**Settings → Printers**: pick a location; its printers are a list with **Add printer**. Each printer has a name
(unique per location among printers in use), address, port (default 9100), width in dots (default 576, 80 mm: most
restaurant printers in Germany; 58 mm is 384), cutter, image mode, **Prints bills**, **Prints tickets for** (the
stations, by key: Kitchen, Bar), **Switched on**, Find printer, test print and Archive. One printer may serve several
stations; one station may print on several printers. A new printer starts switched off and is switched on after its
test print. Reading needs `platform.settings.read`, changing `platform.settings.manage`, and the `pos` feature.
**Find printer** and **Send test print** run in the app; in a browser they are sent to the location's till (remote
commands below). The test page names the printer and prints a line across the full width (`|<---->|`), asking for
both ends to be on the paper: an 80 mm picture on 58 mm paper loses its right edge, where bills put the prices.
Labels `pos.printerSettings.*`, en and de.

| Endpoint                         | Who                                       | What                                                                     |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `GET /pos/printers?locationId=`  | `platform.settings.read`                  | The location's printers in use, by name                                  |
| `POST /pos/printers`             | `platform.settings.manage` (Owner, Admin) | Adds one, always switched off (`enabled` isn't accepted)                 |
| `PATCH /pos/printers/:id`        | `platform.settings.manage`                | Any of name, address, port, width, cutter, mode, bills, stations, on/off |
| `POST /pos/printers/:id/archive` | `platform.settings.manage`                | Archives it: off, out of the lists, its name free again                  |

Every write takes an `Idempotency-Key` and is audited (`pos.printer.created`, `.updated`, `.archived`). Errors:
`pos.printer_not_found`, `pos.printer_name_taken`, `pos.printer_required`. `GET /pos/bill-layout` carries the
location's printers in use (`printerList`, on or off) for the till.

**Which printer a bill goes to:** this device's default receipt printer if it is still on and prints bills at the
location, else the only such printer, else the till asks once ("Which printer?") and keeps the answer as this device's
default; with none, the Android print screen. The default is a device setting: app 1.1 keeps it in its own storage
(Settings → This device); with app 1.0 it is held in memory, so the till asks once per app start (the web never uses
browser storage).

**Version 1's setting** `pos.printers` (`{ bill }`) was copied into a printer per location by the migration
`pos_printers` (on, prints bills, named by its address). It stays registered and in the bill layout for the previous
release until a contract step removes it, and is read forward-compatibly: the setting's `read` schema drops keys and
fields this release doesn't know. Image mode only; a text mode for impact printers is a later option.

## Print jobs (ADR 0033 §10–12)

A sent ticket queues one job per printer of its location that is on and serves its station, in the ticket's own
transaction (`pos_print_jobs`; a station with processing off sends no ticket, a ticket straight to the bill prints
nowhere). Never two jobs for the same ticket on the same printer (unique index). A device without the app queues a bill
for a receipt printer it chose. A till with the app polls every 1.5 s, claims the oldest due job (one atomic `UPDATE …
RETURNING`, exactly one till wins), prints it and answers with the print object's code.

| Endpoint                                 | Who                                    | What                                                              |
| ---------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `GET /pos/print-jobs/due?locationId=`    | `pos.bills.print` at the location      | Due job ids, oldest first: one indexed read, no write             |
| `POST /pos/print-jobs/claim`             | `pos.bills.print` at the location      | `{ locationId }` → `{ job \| null }`                              |
| `POST /pos/print-jobs/:id/result`        | the till that holds it                 | `{ code, nothingPrinted? }` → printed, retry, needs check, failed |
| `POST /pos/print-jobs/:id/reprint`       | `pos.bills.print` at its location      | A job that may have printed, couldn't print or went unanswered    |
| `POST /pos/print-jobs/bill`              | `pos.bills.print` at the order's place | `{ orderId, printerId }`: a receipt printer that is on            |
| `GET /pos/print-jobs/status?locationId=` | `pos.orders.read` at the location      | For the warnings: till last seen, waiting, retrying, attention    |

**Answers** (`printJobOutcome`): `print.sent` → printed. Not reachable, paper out, cover open → back to the queue after
5 s, doubling to at most a minute (nothing reached the paper). Timeout or disconnected → needs check (it may have
printed), unless the app says `nothingPrinted` (version 1.1). No printer, an address outside the rules, a broken picture
→ failed. A claimed job without an answer for 60 s shows as stale (needs check); a late `print.sent` still counts.
Reprint puts it back to the queue; a printed job is never reprinted by the queue. Every change is audited
(`pos.print_job.queued`, `.claimed`, `.answered`, `.reprinted`).

**Maximum age** (`pos.printJobMaxAgeSeconds`, default 600, settable per location): a job not printed within it is
never printed by itself, so nothing old comes out when a printer is back. Each job stores its `expires_at` when queued
(the poll reads no settings). The poll and the claim leave expired jobs out; a retry that would come after the expiry
stores needs check with `print.expired`; a pending job past it is shown as needs check with `print.expired`
(`expired: true`). Reprint gives it a new window of the same length.

**One open bill per order and printer** (unique index on pending or claimed bill jobs): a second Print bill while one
is waiting or printing gets the same job, also when two taps arrive at once; after it printed, the next tap is a new
bill. A waiting bill past its maximum age is queued again by the tap.

Times the queue compares (`not_before`, `created_at`) come from the database's clock, as do the poll and the claim.

**Till last seen** comes from the poll, as a Redis timestamp per location (an hour), so the poll stays one read with no
database write. The poll does no location lookup either: a location of another organization just has no jobs there
(RLS). Errors: `pos.print_job_not_found`, `pos.print_job_not_claimed`, `pos.print_job_not_reprintable`.

## Till runner and warnings (ADR 0033, step 3)

**Runner** (`PrintJobRunner`, mounted on every signed-in page): inside the app only, for members who may print bills,
it polls the till's location every 1.5 s, claims the due jobs (oldest first), loads each order, draws the kitchen/bar
ticket (`KitchenTicketView`) or the bill (`Receipt`) at the printer's width, prints it through the print object (a
new job id per claim) and answers. One lane per printer: a printer's jobs in order, different printers at the same
time, so a bar ticket doesn't wait for the kitchen printer. Pictures are drawn one at a time (one hidden page). An app
that doesn't answer in time counts as a timeout (needs check). The till's location is the device setting "Prints for"
(app 1.1), else the one its floor or order page showed last (held in memory). A device with "This device prints" off
runs no jobs and no remote commands: it never polls.

**With the v1 app (1.0.0).** The runner sends version 1's `print` message, unchanged (protocol 1, same fields, answer
codes from the v1 set), so kitchen and bar printing works with the app installed at customers today. Differences:

- The v1 app sends one job at a time (one print thread). Jobs for different printers queue in the app; the web
  still draws the next picture while the app sends. A job takes the app at most about 14 s (3 s connect, 10 s write
  watchdog), and the web waits 30 s for an answer, so with up to 3 printers a waiting job is answered in time even if
  the other two hang. With 4 or more hanging printers a waiting job can run out of time: it shows as "may have
  printed" (check, then reprint), never a silent second print. Version 1.1 sends to different printers in parallel.
- v1 doesn't say whether anything was sent before a connection broke (`nothingPrinted`): a timeout or a drop is
  always "may have printed" there.
- v1 has no "This device prints" switch and doesn't keep the screen on. A WebView in the background (screen off,
  another app in front, the app's offline screen) stalls drawing: claimed jobs then show as "may have printed" after
  60 s. Keep the till's screen on with the app in front (Android display settings) until 1.1.

**With app 1.1** (`features` in `info`, see Print protocol): different printers print at the same time (one thread
per printer address in the app), `nothingPrinted` sends a job that failed before any byte left the device back to the
queue by itself, **Settings → This device** keeps "This device prints", "Prints for" and the receipt printer in the
app, and a device that prints keeps its screen on while Durby is in front.

**Rollout until 1.1 (step 4).** Every device with the app whose signed-in member may print bills runs jobs. So only
the till may have the app installed; waiters' phones use the browser. With 1.1 on every device, switch "This device
prints" off on waiters' phones instead. With the app on two devices, both poll: each
job still prints once (one claim wins), but on whichever device claimed it, and a phone in a pocket stalls its jobs
until they show as "may have printed".

**The sending device** leaves tickets a printer of the location prints to the till: the send response names them
(`printQueuedIds`); the rest print on the device as before. **Print bill on a device without the app** queues the bill
for a receipt printer (choose once if there are several; a second tap gets the waiting job) and says "Sent to … The
till prints it."; with no receipt printer, the print screen as before. Inside the app the bill still prints directly.

**Warnings** (`PrintWarnings`): on the floor page and the order page (the location, `pos.orders.read`) and on the
kitchen and bar screens (their own tickets only: `GET /pos/stations/{kitchen|bar}/print-status`, with
`pos.kitchen.use` / `pos.bar.use`, and `POST /pos/stations/{station}/print-jobs/:id/reprint`). They show jobs waiting
without a till (no till polled in the last 30 s; "the till was signed out" when the sign-in of the till that polled
last has ended, `tillSignedOut`, read through platform auth's `SessionStatus`), printers being retried with the
reason, and jobs to check (may have printed, couldn't print, too old) with Reprint. Read every 10 s while the page is
visible.

**Sweep**: the worker's hourly retention pass stores pending jobs past `expires_at` as `needs_check` with
`print.expired` (audited as the system actor `job.print_jobs`, idempotent). The migration
`pos_print_jobs_expired` lets such a job be needs check without a claim.

## Print flow

1. **Print bill** on a table, as today. The bill renders into `#print-root`.
2. If the print object is there and the location has a bill printer, the web clones the bill, lays it out at
   `widthDots / 2` css px, rasterizes it (text thresholded, logo dithered) and calls `print`. The converter copies
   every style but heights: text can measure a hair wider on screen than in the picture, so a line that wraps on
   screen may fit in the picture, and a copied height left an empty line on paper. The picture is drawn with room to
   spare and its blank end cut 16 dots below the last line.
3. The app validates the printer settings, builds the ESC/POS job and sends it over one TCP connection.
4. The web shows **sent** or the failure. On failure: **Retry** (same job id) and **Print with Android** (the print
   screen).

No printer configured: a message linking to Settings → Printers for those who can edit it. Outside the app: `window.print()`, unchanged.

## Print protocol

Page to app, through the origin-restricted object. JSON, version 1:

```json
{
  "version": 1,
  "type": "print",
  "jobId": "uuid",
  "printer": {
    "host": "192.168.64.20",
    "port": 9100,
    "widthDots": 384,
    "cutter": true,
    "imageMode": "gsV0"
  },
  "image": {
    "width": 384,
    "height": 1452,
    "data": "<base64, 1 bit per dot, row-major, MSB left, 1 = black>"
  }
}
```

Other types: `info` (app version, protocol version, from 1.1 `features`), `discover`, and from 1.1 `deviceSettings`
and `setDeviceSettings`.

**Features (app 1.1).** `info` answers `features`: `parallel` (one lane per printer), `deviceSettings`,
`nothingPrinted`. The web decides by these, never by the version number; an app without `features` (1.0) gets the
version 1 behaviour, and a later app's unknown names are ignored. The protocol version stays 1: every new message and
field is optional for the other side.

**Device settings (app 1.1).** `{ "version": 1, "type": "deviceSettings" }` reads and
`{ "version": 1, "type": "setDeviceSettings", "settings": { … } }` writes
`{ "prints": true, "tillLocationId": "uuid" | null, "receiptPrinters": { "<location id>": "<printer id>" } }` (at most
50; `nativeDeviceSettingsSchema`). Both answer `{ "type": "deviceSettings", "settings", "refused"? }` with what is
stored; a write the schema doesn't allow stores nothing and answers `refused: true` (never a print answer, which would
fail the page's oldest waiting print). Stored in the app's private preferences; ids are checked against the location's
printers by the page every time.

`discover` (`{ "version": 1, "type": "discover" }`) scans the device's own /24, if it is private, on ports
9100–9102 (connect timeout 300 ms, 32 at a time, up to about 10 s) and answers
`{ "type": "discover", "subnet": "192.168.64.0/24" | null, "printers": [{ "host", "port", "status" }] }` with
`status` `online`, `paper_out`, `cover_open` or `no_status` (the printer accepts connections but doesn't answer
status queries). The device's own address and the network and broadcast addresses are skipped.

In version 1 `print` must carry `printer` (the location's, from `GET /pos/bill-layout`); `info` answers the app
version and protocol only. A test print is an ordinary `print` of a small test bill the web draws (labels, so it is
in the location's language). `printScreen` is sent only by the app's own script that replaces `window.print()`
on allow-listed pages; the app answers by opening Android's print screen for the page.

Answer: `{ "jobId", "state": "sent" | "failed", "code" }`; from 1.1 also `"nothingPrinted": true` when the job failed
before any of its bytes were written (connect failed or timed out, the status queries failed, paper out, cover open,
address refused). The runner passes it on (`POST /pos/print-jobs/:id/result`), so a timeout before sending is retried
by the queue instead of "may have printed".

| Code                         | Meaning                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `print.sent`                 | All bytes written and flushed. Not proof of paper.                                |
| `print.no_printer`           | No printer set for the location (web) or none sent with the job. Nothing is sent. |
| `print.host_not_allowed`     | Not a private IPv4 literal. Nothing is sent.                                      |
| `print.port_not_allowed`     | Not 9100–9102. Nothing is sent.                                                   |
| `print.payload_invalid`      | Size or width doesn't match the data, or over 2 MB.                               |
| `print.printer_unreachable`  | Refused, or no route.                                                             |
| `print.printer_timeout`      | No connection in 3 s, or writing stalled for 10 s.                                |
| `print.printer_disconnected` | The connection dropped during the job. Outcome unknown.                           |
| `print.paper_out`            | The status query says so. Only when the printer answers.                          |
| `print.cover_open`           | The status query says so. Only when the printer answers.                          |

**Duplicates.** One job id per tap; **Retry** reuses it. An id that was sent answers `print.sent` again without
printing (the app remembers the last 500, until it restarts). A failed id may be retried: nothing printed for most
codes, but after `print.printer_disconnected` or a write timeout the bill may have printed, so the web says to check
the paper before **Retry**. The app never retries by itself.

## Remote commands (ADR 0032 §15)

| Endpoint                                        | Who                                         | What                                                                                                   |
| ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /pos/printer-commands`                    | `platform.settings.manage` (Owner, Admin)   | `{ locationId, kind: find_printers \| test_print, printerId? }`, 5 min; a test print needs `printerId` |
| `GET /pos/printer-commands?locationId=`         | `platform.settings.read`                    | The location's last 10 commands with status and result                                                 |
| `GET /pos/printer-commands/pending?locationId=` | `pos.bills.print` at the location           | Open commands; the till polls this every 15 s, in the app only                                         |
| `POST /pos/printer-commands/claim`              | `pos.bills.print` at the location           | One atomic `UPDATE … WHERE status = 'pending' AND expires_at > now() RETURNING`: exactly one till wins |
| `POST /pos/printer-commands/:id/result`         | the till that claimed it, before it expires | `{ result: { subnet, printers } \| { code } }` → done or failed                                        |

Every write takes an `Idempotency-Key` and is audited (`pos.printer_command.requested`, `.claimed`, `.completed`);
the audit log is the lasting record. A test print goes to its printer (on or off) and names it on the page. Errors:
`pos.printer_command_not_found`, `pos.printer_command_expired`, `pos.printer_command_not_claimed`.

## Device screens

- **Device check** (every start, before Durby loads): WebView 111 or newer and the print link. OK → Durby's sign-in,
  nothing shown. Not OK → one screen, German and English: device model, Android version, WebView package and version,
  Chrome version, app version, what failed, and "send a photo of this screen to your contact". With the Play Store,
  a large **Jetzt aktualisieren · Update now** opens the WebView in the Play Store; coming back re-checks by itself.
- **Offline:** Durby didn't load: **Try again**.
- **Settings → This device** (app 1.1) is a page of Durby itself, shown only inside the app to members who print
  bills: "This device prints", "Prints for" (a location, or the service page shown last), the receipt printer for
  bills at that location, and the app version. The Server select follows with the next app update.

## App behaviour

- HTTPS only, no mixed content, no local file access; web debugging off in release builds.
- Sign-in survives restarts: cookies are written to disk every 10 s, after each page load, on pause and on close.
  The WebView alone kept a new refresh cookie (`__Secure-durby_rt`) in memory for minutes, so a power cut or crash
  signed staff out (found on staging, 2026-11-08).
- File chooser for uploads (menu scan, import, bill logo).
- Links outside the allow-list, and `target="_blank"` links, open in Chrome.
- Offline: an error screen with **Retry** and **Device settings**.
- Blob downloads (the product import template) are not supported in version 1; use a browser.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`. No foreground service, no boot receiver.
- Screen kept on (app 1.1) only while Durby is in front **and** "This device prints" is on
  (`FLAG_KEEP_SCREEN_ON`): a sleeping till stops polling, while waiters' phones with printing off sleep as usual.

## Pilot printer setup

The first pilot restaurant's printer (self-test, 2026-11-08): DURAPOS DPT201-URE-BK, firmware SV3.02.46, **80 mm
paper (576 dots, 203 dpi**; 48 characters per line in font A, 64 in font B), Ethernet with the static address
`192.168.64.20` (mask 255.255.255.0, gateway 192.168.64.1, DHCP off), auto cutter, cash drawer port, near paper-end
sensor, code page PC437 (irrelevant: Durby sends pictures).

In Durby, Settings → Printers for that location: address `192.168.64.20`, port `9100`, paper **80 mm (576 dots)**,
print mode Standard, **Cut the paper after each bill** on. Then **Send test print** (in a browser it goes to the
till, which must have the app open): both ends of the `|<---->|` line must be on the paper. Staff do nothing for this;
the install guide tells them the printer is set up remotely. Find printer on the till lists `192.168.64.20:9100` as
Ready when the till is on the same network.

## In-app updates (app 1.1, ADR 0033 §14)

- **Never automatic.** The page asks the app (`update`) at each app start and every 6 hours; the app reads
  `/downloads/android/latest.json` from its own server (`{ versionCode, versionName, apk, sha256 }`, strict: the APK
  is a file name in the same folder, never an address). A newer version shows a small notice above the page,
  "A new version of the app is ready", with **Update now** and **Later**. It is never a dialog, so it never stops
  service on a till; **Later** hides it until the next check.
- **Update now** (`installUpdate`): the first time, Android's "Install unknown apps" screen for Durby opens ("Dieser
  Quelle vertrauen"); after that the app downloads the APK (at most 50 MB), checks its SHA-256, that it is this app
  (package name, the version code in `latest.json`) and that it is signed with this app's own certificate, then hands
  it to Android's installer (`PackageInstaller` session), which asks the user to confirm. Any failed check deletes
  the download and answers an `update.*` code (`update.checksum`, `update.signature`, `update.invalid`,
  `update.download`, `update.none`); the notice says to try later.
- Permission `REQUEST_INSTALL_PACKAGES`. Android itself refuses an update signed with another key.
- **Hosting:** Caddy serves `/downloads/android/*` read-only from `downloads/android/` next to
  `docker-compose.staging.yml` (`/opt/durby/downloads/android/`), `latest.json` with `Cache-Control: no-cache`. No
  listing.
- **Publishing:** raise `versionCode`/`versionName` in `app/build.gradle.kts`, run
  `apps/android/scripts/publish-update.sh` (signed release build, `release/downloads/durby-<version>.apk` and
  `latest.json`), then upload the APK first and `latest.json` second (the script prints the `scp` commands; it never
  uploads). Debug builds read the local web: put both files in `apps/web/public/downloads/android/` (git-ignored).
- Version 1.1 itself is installed by hand once; the Server select and the paper-near-end warning come as the first
  updates through it.

## Install guide

`docs/android/installationsanleitung.html`: one A4 page in German for staff (link, allowing the install source on
Android 9, install, sign in, updates from 1.1, the red check screen). Screenshots from the Android 9 emulator in
German, in `docs/android/img/`; `07-update-source.jpg` ("Dieser Quelle vertrauen" for Durby, step 5) from the
Android 14 emulator with the Settings app in German. Before sending, replace `LINK` with the APK's Drive link and print it to PDF:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer --print-to-pdf=docs/android/Durby-Installationsanleitung.pdf "file://$PWD/docs/android/installationsanleitung.html"
```

## Emulator runs

Debug builds (never release) also allow `http://localhost:3000` and start there, so an emulator can use the local
web: `adb reverse tcp:3000 tcp:3000`, the virtual printer on the Mac (`10.0.2.2:9100` from the emulator), and the
WebView's DevTools socket for driving pages. On plain HTTP the secure refresh cookie isn't kept, so a full reload
signs out locally; staging (HTTPS) keeps it.

## Tests

| Layer                      | What                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kotlin (JVM)               | ESC/POS bytes and TCP failures (from the spike); allow-list: a server off the list can't be selected or loaded, a stored one is ignored; address rules (below); duplicate ids |
| `packages/shared`          | `pos.printers` schema, same address table as Kotlin (shared JSON fixtures); protocol                                                                                          |
| Web (Vitest)               | App detected or not; `window.print` untouched outside the app; 384-dot layout; messages per code                                                                              |
| API                        | `GET /pos/bill-layout` carries `printers` at the location; cross-tenant isolation                                                                                             |
| Playwright                 | Settings → Printers; print with a fake print object                                                                                                                           |
| Emulator + virtual printer | Android 9, real WebView, full bill to PNG, each failure mode                                                                                                                  |

**Address rules, refused:** `8.8.8.8`, `127.0.0.1`, `0.0.0.0`, `169.254.1.1`, `172.15.0.1`, `172.32.0.1`,
`192.169.0.1`, `224.0.0.1`, `printer.local`, `example.com`, `::1`, `fe80::1`, `3232235521`, `0xC0.0xA8.0.1`,
`192.168.1`, `192.168.1.256`, `192.168.01.1`, `192.168.1.1.example.com`, an empty string. Ports 0, 80, 9099, 9103, 65536. **Accepted:** `10.0.0.1`, `172.16.0.1`, `172.31.255.254`, `192.168.64.20`, ports 9100–9102.

Kotlin tests run with `./gradlew testDebugUnitTest` in `apps/android/` (JDK 17, Android SDK); CI doesn't run them
yet (1.1, with the build workflow).

## Build order

Version 1 (ADR 0032 §14–15): staff only install and sign in. Estimate from 2026-11-07: **6–7 working days**, of which
the printer core, bill rendering, virtual printer and signing are done.

| Step | Work                                                                                                                                                                                                                  | Days  | State |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- |
| A1   | Virtual printer (`tools/virtual-printer/`)                                                                                                                                                                            | —     | done  |
| A3   | Printer core, address rules, protocol, duplicates                                                                                                                                                                     | —     | done  |
| A5   | Web: detection, 384-dot rendering, messages                                                                                                                                                                           | —     | done  |
| A6a  | Release key and signing                                                                                                                                                                                               | —     | done  |
| A2   | Shell behind an engine interface; device check screen (en, de); allow-list; sign-in kept; file chooser; offline screen; print object; `window.print()` → print screen                                                 | 1.5   |       |
| A3b  | Find printer: /24 scan on the device, `discover` message                                                                                                                                                              | 0.5   |       |
| A4   | `pos.printers`, Settings → Printers (find, manual, test print in the app), `GET /pos/bill-layout` gains `printers`                                                                                                    | 1.5   |       |
| A4b  | Remote find and test print: `pos_print_tasks`, api, polling in the app, Settings shows results (migration reviewed first)                                                                                             | 1.5–2 |       |
| A8   | Install guide (German, one page, screenshots: link, unknown apps on Android 9, install, open, sign in)                                                                                                                | 0.5   |       |
| A7   | Emulator run with the virtual printer (Android 9 and 14); web deploy to staging; APK link                                                                                                                             | 1     |       |
| 1.1  | Server select, tag-triggered build workflow, `/downloads`, GeckoView only if the device check fails                                                                                                                   | —     |       |
| 1.1  | Paper near end: the app already reads it (`DLE EOT 4`, bits 2+3) but only paper out and cover open stop a job. Show it as a warning after a sent bill and in Find printer (new status `paper_near_end`, labels en/de) | —     |       |

The web changes need a staging deploy, so GitHub Actions must be running (or a manual deploy).

Moving a customer to production needs a new APK in version 1 (the Server select comes in 1.1), once Hetzner production
serves `app.durby.tech`. That move changes DNS before the old Vercel project is deleted
([production.md](../ops/production.md)).
