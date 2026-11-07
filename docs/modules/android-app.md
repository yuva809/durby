# Android app

A minimal Kotlin app that loads the Durby website and prints bills over LAN (ADR 0032). Version 1: one bill printer per
location, 58 mm / 384 dots first. Status: A0 waits for the customer's device check; fast version 1 in preparation (ADR 0032 §14).

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

**Version 1 (fast release, ADR 0032 §14)** reads the printer from the device settings screen, not from the page:

- `info` answers `{ "type": "info", "appVersion", "protocol": 1, "printer": { "widthDots" } | null }`. The web
  renders at that width; `null` means no printer is set on the device (message: set it in the app's settings).
- `print` carries `version`, `type`, `jobId` and `image`. A `printer` field from the page is ignored.
- `testPrint` is started from the device settings screen only.

Answer: `{ "jobId", "state": "sent" | "failed", "code" }`.

| Code                         | Meaning                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `print.sent`                 | All bytes written and flushed. Not proof of paper.        |
| `print.no_printer`           | Version 1: no printer set on the device. Nothing is sent. |
| `print.host_not_allowed`     | Not a private IPv4 literal. Nothing is sent.              |
| `print.port_not_allowed`     | Not 9100–9102. Nothing is sent.                           |
| `print.payload_invalid`      | Size or width doesn't match the data, or over 2 MB.       |
| `print.printer_unreachable`  | Refused, or no route.                                     |
| `print.printer_timeout`      | No connection in 3 s, or writing stalled for 10 s.        |
| `print.printer_disconnected` | The connection dropped during the job. Outcome unknown.   |
| `print.paper_out`            | The status query says so. Only when the printer answers.  |
| `print.cover_open`           | The status query says so. Only when the printer answers.  |

**Duplicates.** One job id per tap; **Retry** reuses it. An id that was sent answers `print.sent` again without
printing (the app remembers the last 500, until it restarts). A failed id may be retried: nothing printed for most
codes, but after `print.printer_disconnected` or a write timeout the bill may have printed, so the web says to check
the paper before **Retry**. The app never retries by itself.

## Device screen

Opened by long-pressing the app icon, and from the app's offline screen so a dead server can't lock anyone out.

- **Server:** a select of the allow-list, default staging. Changing it reloads the site; sign-in is per server.
- **Connection check:** the server answers `/api/v1/health`; the last printer used answers on its port.
- **App version.**
- **Version 1 only: Bill printer** (host, port, width in dots, cutter, image mode) and **Test print**. Saving checks
  the address rules; the field moves to Settings → Printers in 1.1.

## App behaviour

- HTTPS only, no mixed content, no local file access; web debugging off in release builds.
- Sign-in survives restarts (the refresh cookie `__Secure-durby_rt` is flushed to disk).
- File chooser for uploads (menu scan, import, bill logo).
- Links outside the allow-list, and `target="_blank"` links, open in Chrome.
- Offline: an error screen with **Retry** and **Device settings**.
- Blob downloads (the product import template) are not supported in version 1; use a browser.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`. No foreground service, no boot receiver.

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

ADR 0032 §14: a fast version 1, then version 1.1.

| Step | Work                                                                                                                                            | Release |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A0   | Probe APK measures the device's WebView (and the RawBT stopgap); ADR 0032 and this spec                                                         | —       |
| A1   | Virtual printer (`tools/virtual-printer/`, done); emulator setup                                                                                | 1       |
| A2   | App shell: WebView, allow-list (staging only in the build), sign-in kept, file chooser, offline screen, `window.print()` → Android print screen | 1       |
| A3   | Printer core from the spike; address rules; device printer settings; print object; duplicates                                                   | 1       |
| A5   | Web: detection, `info`, 384-dot rendering, messages per code (labels en/de)                                                                     | 1       |
| A6a  | Release key; signed APK built locally; shared through Drive                                                                                     | 1       |
| A7a  | Emulator run with the virtual printer; web deploy to staging outside service hours; install call                                                | 1       |
| A4   | `pos.printers`, Settings → Printers, `GET /pos/bill-layout`, labels; device printer field removed                                               | 1.1     |
| A2b  | Server select                                                                                                                                   | 1.1     |
| A6b  | Tag-triggered signed build workflow, `/downloads`                                                                                               | 1.1     |

Version 1 needs the web change deployed to staging, so GitHub Actions must be running (or a manual deploy).

Moving a customer to production is the Server select (1.1), once Hetzner production serves `app.durby.tech`. That move
changes DNS before the old Vercel project is deleted ([production.md](../ops/production.md)).
