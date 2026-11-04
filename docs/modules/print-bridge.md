# Print Bridge (DRAFT, awaiting approval)

Status: proposal, 2026-11-04. Nothing here is built yet. When approved it becomes ADR 0027 (the "later decision"
ADR 0016 §6 and ADR 0025 left open) plus this spec.

Scope v1: **one** external LAN receipt printer per till device, reached from the Durby web app running in Chrome on
a SUNMI T2s Lite (Android 9). No kitchen routing, no multiple printers, no print management.

## 1. Existing printing (findings)

| What                 | Where                                                                                              | Notes                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bill (guest check)   | `apps/web/components/pos/receipt.tsx` (`Receipt`)                                                  | React, 80 mm roll layout: header from `pos.billHeader` (logo, name, contacts), waiter/table/covers/bill number, lines, total, footer from `pos.billFooter`, "not a receipt", powered-by, date |
| Order slip           | `apps/web/components/pos/kitchen-ticket.tsx` (`OrderSlip`)                                         | For roles without `pos.bills.print`                                                                                                                                                           |
| Kitchen / bar ticket | `kitchen-ticket.tsx` (`KitchenTicketView`)                                                         | One print job per station (ADR 0025 §5)                                                                                                                                                       |
| Print root           | `kitchen-ticket.tsx` (`PrintRoot`) → `#print-root`                                                 | Portal; the only thing visible in `@media print`                                                                                                                                              |
| Print action         | `apps/web/lib/pos/print.ts` (`printAs`) and `order-page.tsx` (`printParts`, `PrintJob` with `seq`) | `window.print()`, one dialog per `data-print-part`                                                                                                                                            |
| Paper CSS            | `apps/web/app/globals.css` (`#print-root`)                                                         | 80 x 297 mm page, 72 mm printed width, black only, monospace                                                                                                                                  |
| Bill data            | `lib/pos/format.ts` (`BillLine`), `GET /pos/bill-layout` (`pos.bills.print`)                       | Totals come from the api as decimal strings                                                                                                                                                   |
| Logo                 | `lib/pos/bill-logo.ts`                                                                             | Already shrunk to ≤ 384 x 192 px gray-on-white PNG data URL                                                                                                                                   |

Conclusions:

- **Receipt generation exists, and only as React DOM.** There is no server-side receipt model, no ESC/POS code, no
  printer configuration, no print-job record. Printing is fire-and-forget (`window.print()`), with no success signal.
- The api has nothing print-specific beyond `pos.bills.print` and the bill layout. v1 needs **no api or DB change**.
- To avoid duplicating layout logic, the bridge must print **what the existing components render**, not a second
  receipt template.

## 2. Bridge architecture

```
Chrome (Durby web, https://<tenant domain>)                 Print Bridge app (Kotlin, same device)
 ├─ Receipt / OrderSlip render into #print-root (unchanged)   ├─ Foreground service (starts on boot)
 ├─ lib/print/rasterize.ts: data-print-part → canvas          │   └─ HTTP server on 127.0.0.1:17890 only
 │    576 px (or 384) wide → 1-bit (dither) → PNG/packed bits  ├─ Auth: paired origin + bearer token
 ├─ lib/print/bridge-client.ts ── fetch http://127.0.0.1 ───▶ ├─ Job store (idempotent by jobId, 24 h TTL)
 │    jobId (UUID v7), timeout, Zod-parsed result            ├─ Single serial print queue
 └─ fallback: window.print() (today's path)                  ├─ ESC/POS encoder (raster, feed, cut, status)
                                                             └─ TCP socket → printer IP:9100 (LAN)
```

**Content format: raster first.** The web rasterizes the already-rendered `data-print-part` element at the printer's
dot width and sends a 1-bit bitmap; the bridge wraps it in ESC/POS `GS v 0` bands. Why:

- Zero duplicated receipt logic: labels, i18n, money formatting, logo, partner theming all stay in the React
  components.
- No code-page problems (ä ö ü ß €, any future locale) and the logo prints as-is.
- Cost: raster is slower to print than text (≈ 50–110 KB per bill at 576 dots; ~1–2 s on a typical 80 mm LAN
  printer) and slightly softer text. Acceptable for v1; a text/ops mode can be added to the same protocol later.

The protocol allows `ops: [{raster}, {feed}, {cut}]` so a later text mode is additive. The bridge's own **test
receipt** is built natively in Kotlin (ESC/POS text, ASCII only) so the printer can be tested without Durby.

Rasterizing the DOM: `html-to-image` (SVG `foreignObject` → canvas, pinned exact version) on a clone of the print part
styled with print sizing, at width = dots, then Floyd–Steinberg or threshold to 1 bit (text: threshold; logo already
gray). Open risk to verify in the spike: font rendering inside `foreignObject` on Chrome Android uses system
monospace, which is fine; web fonts would need embedding.

Printer settings (IP, port, paper width, cutter) live **in the bridge app**, per device, not in Durby settings. No
tenant data, no migration, no settings key in v1. The web reads the bridge's `paper.dots` from `/v1/status` to size
the raster.

## 3. Chrome ↔ Android communication

Chosen: **HTTP on loopback** (`http://127.0.0.1:17890`) from the page via `fetch`.

| Concern                                       | Finding                                                                                                                                                                                       | Handling                                                                                                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mixed content (https page → http)             | `http://127.0.0.1` and `http://localhost` are "potentially trustworthy"; Chrome does not block them as mixed content                                                                          | Use the literal `127.0.0.1` (avoids `localhost` resolving to `::1` or being overridden)                                                                                                                                  |
| CORS                                          | Cross-origin; `Content-Type: application/json` + `Authorization` force a preflight                                                                                                            | Bridge answers `OPTIONS` with `Access-Control-Allow-Origin: <exact paired origin>`, `Vary: Origin`, allowed methods/headers; never `*`                                                                                   |
| Private Network Access / Local Network Access | PNA preflight (`Access-Control-Request-Private-Network`) never left warning mode; LNA (permission prompt for public → loopback) shipped in Chrome 142+                                        | Answer `Access-Control-Allow-Private-Network: true` anyway; on a Chrome with LNA, the user approves "access apps on this device" once per origin at pairing. Web passes `targetAddressSpace: 'loopback'` where supported |
| **Chrome version on Android 9**               | Chrome's last version for Android 8/9 is **138** (to verify on the device via `chrome://version`; SUNMI may ship its own build). So no LNA prompt today, but also no further security updates | Works today; flag as a platform risk. Long-term option: a Durby kiosk shell (WebView/TWA) with a JS bridge, or newer hardware                                                                                            |
| Other sites / other apps calling the port     | Any page can send a "simple" request; any local app can connect to loopback                                                                                                                   | Server-side Origin check (not just CORS headers), required bearer token, JSON-only, body size limit, bind 127.0.0.1 only (never reachable from the LAN)                                                                  |
| TLS on loopback                               | Not needed (secure-context exemption); self-signed certs on Android Chrome are unworkable                                                                                                     | Plain HTTP on loopback only                                                                                                                                                                                              |
| Bridge not running                            | `fetch` fails fast (connection refused)                                                                                                                                                       | Web shows "printer bridge not reachable" and offers browser print                                                                                                                                                        |

**Pairing** (no tenant ids, no hardcoded domains, works for partner domains): the user taps _Pair_ in the bridge app,
which shows a 6-digit code for 2 minutes. In Durby (_This device's printer_), they enter it; `POST /v1/pair` with the
code returns a random 256-bit token bound to the calling `Origin`. The web stores `{token}` in `localStorage` for that
origin. Pairing attempts are rate-limited (5 per window). The bridge lists paired origins and can revoke them.

Rejected alternatives: `intent://` URLs (one-way, navigates the page, no result); WebSocket (same security model as
HTTP, more state); Web Bluetooth/USB (wrong transport); cloud relay where the bridge pulls jobs from the api (robust
and lets waiters' phones print, but needs api tables, events and auth for devices: a good phase-2 candidate, not v1).

## 4. Android app

- Kotlin, `minSdk 28` (Android 9), `targetSdk 35`, Jetpack (no Compose needed; one settings Activity with Material
  views is lighter), Ktor server CIO for HTTP, kotlinx.serialization, DataStore for config, a small JSON-file or
  Room job store.
- **Foreground service** (Android 8+ kills background services): persistent notification "Printer bridge running ·
  <printer> online/offline". `foregroundServiceType="connectedDevice"` (required from API 34, ignored on 28).
- **Start on boot** via `BOOT_COMPLETED` receiver; also started when the app is opened.
- Doze: the T2s is mains-powered with the screen on, so Doze rarely applies; still ask to exempt from battery
  optimisation. SUNMI OS may have its own task killer: verify on device (and whitelist in SUNMI settings if needed).
- Printer I/O: one connection per job, serial queue (many printers accept one socket at a time, and DISH POS shares
  this printer). Connect timeout 3 s, write timeout 10 s, up to 2 retries with backoff on connect refused/busy only
  (never after bytes were written).
- ESC/POS: `ESC @` init, `GS v 0` raster in bands of ≤ 256 rows, `ESC d n` feed, `GS V 66 n` partial cut when cutter
  is on (otherwise feed only). Status: `DLE EOT 1/2/4` (online, cover, paper) with 500 ms read timeout, treated as
  optional (some network printers don't answer).
- Config: IP, port (default 9100), paper 58 mm (384 dots) / 80 mm (576 dots) with a dots override (some 80 mm units
  are 512), cutter on/off, feed lines before cut.
- _Test connection_: TCP connect + optional status query → "online / paper out / cover open / no answer to status /
  unreachable". _Test print_: native test receipt with device, IP, width, time and a ruler line to check the width.
- App name and UI strings in `res/values` (en) and `res/values-de` (de), generic "Print Bridge" (no product name, in
  keeping with white-label). `applicationId` `app.durby.printbridge` is invisible to guests.

### Permissions

| Permission                                                     | Why                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `INTERNET`                                                     | Server socket on loopback and the TCP connection to the printer |
| `ACCESS_NETWORK_STATE`                                         | Show "no network" vs "printer unreachable"                      |
| `FOREGROUND_SERVICE`                                           | Keep the server alive (required since API 28)                   |
| `FOREGROUND_SERVICE_CONNECTED_DEVICE` + `CHANGE_NETWORK_STATE` | Required for the service type on API 34+ (no effect on 28)      |
| `RECEIVE_BOOT_COMPLETED`                                       | Start after the till restarts                                   |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`                         | Prompt to exempt from battery optimisation (optional)           |
| `POST_NOTIFICATIONS`                                           | Only on API 33+ for the service notification (no effect on 28)  |

No location, storage, Bluetooth or dangerous runtime permissions on Android 9. Raw TCP is not affected by
`cleartextTrafficPermitted`.

## 5. Local API (v1)

All JSON, decimals not involved. Errors `{ code, message, details? }` with stable codes (`bridge.*`). Schemas in
`packages/shared/src/print-bridge.ts`; JSON fixtures shared with the Kotlin tests.

| Route                                                                                                                                 | Auth                                                                        | Purpose                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                                                                                                                      | none (CORS for any origin, returns only `{ ok, version, paired: boolean }`) | Detect the bridge                                                                                                    |
| `POST /v1/pair` `{ code }`                                                                                                            | Origin + valid code                                                         | → `{ token }`                                                                                                        |
| `GET /v1/status`                                                                                                                      | token                                                                       | `{ printer: { configured, host, port, paperDots, cutter }, state: online\|offline\|paper_out\|cover_open\|unknown }` |
| `POST /v1/test`                                                                                                                       | token                                                                       | Print the native test receipt                                                                                        |
| `POST /v1/jobs` `Idempotency-Key: <jobId>` `{ jobId, ops: [{ type: 'raster', width, height, data(base64 1-bit) }, { type: 'cut' }] }` | token                                                                       | Queue and wait up to 12 s → `{ jobId, state, error? }`                                                               |
| `GET /v1/jobs/:jobId`                                                                                                                 | token                                                                       | Poll a job still `queued`/`printing`                                                                                 |

Job states: `queued → printing → sent` (all bytes written and flushed; if the status query answers, `sent` also
means no paper-out/cover-open afterwards) or `failed` with `bridge.printer_unreachable`, `bridge.printer_timeout`,
`bridge.paper_out`, `bridge.cover_open`, `bridge.printer_closed_connection`, `bridge.not_configured`,
`bridge.payload_invalid`. The bridge never claims "printed"; ESC/POS over TCP can't prove paper came out.

**Duplicates.** The web makes one `jobId` per print intent (the existing `PrintJob.seq` click); a retry of that
intent reuses it, a _Reprint_ gets a new one. The bridge stores `jobId → { hash, state }` for 24 h: the same id with
the same body returns the stored state without printing; with a different body → `409 bridge.job_conflict`. A job
found `printing` after a crash/restart becomes `failed` with `bridge.outcome_unknown` and is **never** auto-reprinted
(the staff decide whether to reprint; a duplicate bill is worse than asking). Max body 2 MB; queue length 20.

## 6. Web changes (v1)

- `apps/web/lib/print/`: `bridge-client.ts` (fetch with `AbortController` timeouts, Zod parse), `rasterize.ts`,
  `dither.ts` (pure, unit-tested), `use-print.ts` (bridge if paired and reachable, else `printAs`).
- `order-page.tsx`: the **bill and order slip** go through `use-print`; kitchen/bar tickets stay on browser printing
  in v1 (no routing). The existing components render unchanged.
- A small _This device's printer_ panel (pair, unpair, status, test print through the bridge), gated in the UI by
  `pos.bills.print`. Labels `pos.printer.*` in `packages/i18n/src/{en,de}/pos.json`.
- Result shown as a toast: sent / failed with the label for the error code, with _Retry_ (same jobId) and _Print via
  browser_.
- No api, DB, settings, audit or outbox changes in v1. (Auditing reprints server-side is a later fraud control.)

## 7. Repository structure

```
apps/print-bridge-android/          # Gradle project, not a pnpm package (no package.json)
  settings.gradle.kts, build.gradle.kts, gradle/libs.versions.toml, gradlew
  app/src/main/AndroidManifest.xml
  app/src/main/kotlin/app/durby/printbridge/
    BridgeApp.kt
    service/BridgeService.kt, service/BootReceiver.kt
    http/BridgeServer.kt, http/Routes.kt, http/Auth.kt (origin, token, pairing), http/Cors.kt
    jobs/JobStore.kt, jobs/PrintQueue.kt
    printer/TcpPrinter.kt, printer/PrinterStatus.kt
    escpos/EscPos.kt, escpos/RasterEncoder.kt, escpos/TestReceipt.kt
    config/BridgeConfig.kt
    ui/SettingsActivity.kt
  app/src/main/res/values{,-de}/strings.xml
  app/src/test/kotlin/...          # JVM unit + fake-printer integration tests
packages/shared/src/print-bridge.ts          # Zod protocol schemas + error codes
packages/shared/fixtures/print-bridge/*.json  # contract fixtures read by Vitest and JUnit
apps/web/lib/print/*                          # client, rasterize, dither, hook
apps/web/e2e/support/fake-bridge.ts           # Playwright fake bridge + fake printer
docs/adr/0027-print-bridge.md, docs/modules/print-bridge.md
.github/workflows/ci.yml                      # + android job (JDK 17, gradle test assembleRelease), path-filtered
```

## 8. Testing

- **Kotlin unit (JVM):** golden byte tests for the ESC/POS encoder (init, raster bands, 384/576 widths, cut on/off);
  job store (same id → no second print, conflict on different body, `printing` on restart → `outcome_unknown`, TTL);
  auth (unknown origin, missing/wrong token, pairing window, rate limit); routes via Ktor `testApplication`
  including the CORS/PNA preflight.
- **Kotlin integration with a fake printer** (in-process `ServerSocket`): success, connection refused (offline),
  connect timeout, write timeout (fake stops reading), connection closed mid-job, status replies for paper out /
  cover open / no reply, busy (second connection refused) → retry, no retry after bytes were written.
- **Contract:** the same JSON fixtures validated by the Zod schemas (Vitest) and decoded by Kotlin (JUnit).
- **Web Vitest:** dither/pack bit order, bridge client (timeout, unreachable → fallback, error code → label, retry
  keeps jobId, reprint gets a new one), the label files have the new keys in en and de.
- **Playwright:** bill print with a fake bridge on 127.0.0.1 → bytes reach the fake printer; bridge down → browser
  print fallback offered.
- **On-device checklist (SUNMI T2s Lite + the real printer):** `chrome://version`; install, pair from the staging
  domain; test connection and test print; a real bill with logo, umlauts, € and long names; printer Ethernet
  unplugged → offline error within ~3 s; paper out; double-tap print → one bill; reload page mid-job → no duplicate;
  reboot the T2s → bridge back without opening it; overnight idle; DISH POS printing at the same time.

## 9. Implementation plan (one PR each, after approval)

1. **Spike on the device (½ day):** throwaway APK with `/v1/health` + CORS; from the staging https page confirm
   `fetch('http://127.0.0.1:17890')` works in the T2s Chrome, check its version, and send one hard-coded raster to
   the printer over 9100. Decides go/no-go for the localhost approach.
2. **ADR 0027 + this spec final + shared protocol schemas and fixtures.**
3. **Bridge app core:** service, boot, config UI, TCP printer, ESC/POS, test connection, test print. Usable alone.
4. **Bridge local API:** pairing, auth, CORS, idempotent job store and queue. Tests above.
5. **Web:** rasterize + client + pairing panel + bill/slip through the bridge with browser fallback, labels,
   Vitest, Playwright.
6. **CI job for the Android build, signed release APK, on-device pilot** with the checklist.

## Open questions

1. v1 documents: bill + order slip only (kitchen tickets keep browser printing), or should everything from the till
   go to this one printer?
2. Chrome on the T2s Lite: which version does it run (Android 9 caps Play Store Chrome at 138)? Acceptable for now?
3. Printer make/model (to confirm `GS v 0`, `GS V`, `DLE EOT` support and 512 vs 576 dots).
4. Distribution and signing of the APK: sideload, SUNMI App Store or MDM; who holds the signing key.
