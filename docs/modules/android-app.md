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

## Printer settings (web)

**Settings → Printers**, like the Bill tab: pick a location, inherit or set here. Fields: host, port (default 9100),
width in dots (default 384), cutter, image mode. Reading needs `platform.settings.read`, saving
`platform.settings.manage`, and the `pos` feature. **Send test print** works in the app; in a browser the button
explains that it needs the app. Labels `pos.printerSettings.*` and `platform.settings.posPrinters.*`, en and de.

`pos.printers` schema: `bill` is null or a strict object. `host` is a private IPv4 literal, `port` 9100–9102,
`widthDots` 8–2040, `cutter` boolean, `imageMode` `gsV0` or `escStar`.

## Print flow

1. **Print bill** on a table, as today. The bill renders into `#print-root`.
2. If the print object is there and the location has a bill printer, the web clones the bill, lays it out at
   `widthDots / 2` css px, rasterizes it (text thresholded, logo dithered) and calls `print`.
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

Other types: `info` (app version, protocol version), `testPrint` (a receipt the app builds; the settings as above).

`discover` (`{ "version": 1, "type": "discover" }`) scans the device's own /24, if it is private, on ports
9100–9102 (connect timeout 300 ms, 32 at a time, up to about 10 s) and answers
`{ "type": "discover", "subnet": "192.168.64.0/24" | null, "printers": [{ "host", "port", "status" }] }` with
`status` `online`, `paper_out`, `cover_open` or `no_status` (the printer accepts connections but doesn't answer
status queries). The device's own address and the network and broadcast addresses are skipped.

In version 1 `print` must carry `printer` (the location's, from `GET /pos/bill-layout`); `info` answers the app
version and protocol only. A test print is an ordinary `print` of a small test bill the web draws (labels, so it is
in the location's language). `printScreen` is sent only by the app's own script that replaces `window.print()`
on allow-listed pages; the app answers by opening Android's print screen for the page.

Answer: `{ "jobId", "state": "sent" | "failed", "code" }`.

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
| `POST /pos/printer-commands`                    | `platform.settings.manage` (Owner, Admin)   | `{ locationId, kind: find_printers \| test_print }`, 5 min                                             |
| `GET /pos/printer-commands?locationId=`         | `platform.settings.read`                    | The location's last 10 commands with status and result                                                 |
| `GET /pos/printer-commands/pending?locationId=` | `pos.bills.print` at the location           | Open commands; the till polls this every 15 s, in the app only                                         |
| `POST /pos/printer-commands/claim`              | `pos.bills.print` at the location           | One atomic `UPDATE … WHERE status = 'pending' AND expires_at > now() RETURNING`: exactly one till wins |
| `POST /pos/printer-commands/:id/result`         | the till that claimed it, before it expires | `{ result: { subnet, printers } \| { code } }` → done or failed                                        |

Every write takes an `Idempotency-Key` and is audited (`pos.printer_command.requested`, `.claimed`, `.completed`);
the audit log is the lasting record. A test print goes to the location's saved printer. Errors:
`pos.printer_command_not_found`, `pos.printer_command_expired`, `pos.printer_command_not_claimed`.

## Device screens

- **Device check** (every start, before Durby loads): WebView 111 or newer and the print link. OK → Durby's sign-in,
  nothing shown. Not OK → one screen, German and English: device model, Android version, WebView package and version,
  Chrome version, app version, what failed, and "send a photo of this screen to your contact". With the Play Store,
  a large **Jetzt aktualisieren · Update now** opens the WebView in the Play Store; coming back re-checks by itself.
- **Offline:** Durby didn't load: **Try again**.
- Version 1.1 adds the device settings screen with the Server select.

## App behaviour

- HTTPS only, no mixed content, no local file access; web debugging off in release builds.
- Sign-in survives restarts (the refresh cookie `__Secure-durby_rt` is flushed to disk).
- File chooser for uploads (menu scan, import, bill logo).
- Links outside the allow-list, and `target="_blank"` links, open in Chrome.
- Offline: an error screen with **Retry** and **Device settings**.
- Blob downloads (the product import template) are not supported in version 1; use a browser.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`. No foreground service, no boot receiver.

## Install guide

`docs/android/installationsanleitung.html`: one A4 page in German for staff (link, allowing the install source on
Android 9, install, sign in, the red check screen). Screenshots from the Android 9 emulator in German, in
`docs/android/img/`. Before sending, replace `LINK` with the APK's Drive link and print it to PDF:

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

| Step | Work                                                                                                                                                                  | Days  | State |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- |
| A1   | Virtual printer (`tools/virtual-printer/`)                                                                                                                            | —     | done  |
| A3   | Printer core, address rules, protocol, duplicates                                                                                                                     | —     | done  |
| A5   | Web: detection, 384-dot rendering, messages                                                                                                                           | —     | done  |
| A6a  | Release key and signing                                                                                                                                               | —     | done  |
| A2   | Shell behind an engine interface; device check screen (en, de); allow-list; sign-in kept; file chooser; offline screen; print object; `window.print()` → print screen | 1.5   |       |
| A3b  | Find printer: /24 scan on the device, `discover` message                                                                                                              | 0.5   |       |
| A4   | `pos.printers`, Settings → Printers (find, manual, test print in the app), `GET /pos/bill-layout` gains `printers`                                                    | 1.5   |       |
| A4b  | Remote find and test print: `pos_print_tasks`, api, polling in the app, Settings shows results (migration reviewed first)                                             | 1.5–2 |       |
| A8   | Install guide (German, one page, screenshots: link, unknown apps on Android 9, install, open, sign in)                                                                | 0.5   |       |
| A7   | Emulator run with the virtual printer (Android 9 and 14); web deploy to staging; APK link                                                                             | 1     |       |
| 1.1  | Server select, tag-triggered build workflow, `/downloads`, GeckoView only if the device check fails                                                                   | —     |       |

The web changes need a staging deploy, so GitHub Actions must be running (or a manual deploy).

Moving a customer to production needs a new APK in version 1 (the Server select comes in 1.1), once Hetzner production
serves `app.durby.tech`. That move changes DNS before the old Vercel project is deleted
([production.md](../ops/production.md)).
