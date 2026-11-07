# ADR 0032: Durby Android app for LAN receipt printing

- Status: proposed (2026-11-07). Accepted once step A0 has measured the device's WebView.
- Date: 2026-11-07
- Step: Android app (docs/modules/android-app.md). Amends [ADR 0016](0016-table-service-before-tse.md) §6 and
  [ADR 0025](0025-bill-layout-and-stations.md) §5.

## Context

The first pilot customer runs Durby on a SUNMI T2s Lite (Android 9, Chrome 125) with a LAN receipt printer that DISH
POS already uses. Printing is `window.print()`, which on Android reaches only the system print screen; nothing there
reaches a raw ESC/POS printer on port 9100.

We first designed a Print Bridge: a helper app listening on `127.0.0.1`, called by the page in Chrome. A spike
(branch `spike/print-bridge`) proved the printer side: raw TCP, ESC/POS raster and cut, status queries. The web side
was never built. Before building it we compared what the bridge would still need against a Durby app that holds the
website itself.

## Decisions

1. **A minimal Kotlin WebView app** (`apps/android/`, `tech.durby.pos`, name "Durby") loads the Durby website and
   prints bills itself over LAN: ESC/POS, raw TCP. No localhost server. The spike's printer code is reused.
2. **Why not the bridge.** It would need a background service that Android or SUNMI OS may stop (a risk we did not
   measure; the app prints while it is open, so the question goes away), a page calling a local address, which newer
   Chrome puts behind a permission (Local Network Access; not enforced on Chrome 125, but it is on any newer device),
   and pairing with tokens and allowed sites, because any website could otherwise call the port.
3. **Why not Capacitor.** Its docs say loading a remote site through `server.url` is "not intended for use in
   production". We need no plugins, and a second toolchain buys nothing over a small Kotlin app.
4. **Servers: a fixed allow-list, chosen in the app.** The first build allows exactly `https://staging.durby.tech`
   and `https://app.durby.tech`. A **Server** select on the device settings screen offers only these, default
   staging. Moving a customer to production is a settings change, never a new APK. A stored value not on the list is
   ignored and the default is used. Navigation to anything else opens in Chrome, never in the app. A new domain
   (a partner's, for example) does need a new APK. The list is one reviewed constant; there are no per-customer builds
   (hard rule 2). `app.durby.tech` is ours: today it serves the previous version of Durby from Vercel, and production
   on Hetzner replaces it under the same name, so the list doesn't change. That switch changes DNS first (or at the
   same moment) and deletes the Vercel project only afterwards (`docs/ops/production.md`): a record left pointing at a
   deleted project could be claimed by someone else, and their page would get the print object.
5. **Printer settings live in Durby, per location,** not on the device: one setting, `pos.printers` (§6). A replaced
   device needs no printer setup, and whoever manages the location can fix a printer without touching the till.
6. **`pos.printers`** (`dataBound: false`, scopes organization, brand, location; default `{ "bill": null }`):

   ```json
   {
     "bill": {
       "host": "192.168.64.20",
       "port": 9100,
       "widthDots": 384,
       "cutter": true,
       "imageMode": "gsV0"
     }
   }
   ```

   One key with a slot per printer role, rather than one key per field, so `kitchen` and `bar` are added later as new
   slots with no key renamed, and a printer is always saved whole. Version 1 has only `bill`. `imageMode` is `gsV0` or
   `escStar`. Read for printing through the existing `GET /pos/bill-layout` (`pos.bills.print`, gains `printers`);
   written through the settings api under `platform.settings.manage`, like the bill header. No new permission key and
   no migration. Delegating to managers later needs no ADR (ADR 0020).

7. **The page sends a picture and printer settings; the app decides what is allowed.** With each print the web passes
   the location's printer settings and a 1-bit image. The page never sends raw printer commands: the app builds them.
   The app accepts only an IPv4 literal in a private range (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and ports
   9100–9102, and refuses anything else with a clear error. It parses the four decimal octets itself and never resolves
   a name, so a hostname or an odd spelling of an address can't reach the internet or the device itself. The shared
   Zod schema applies the same rule when saving; the app's check is the one that counts.
8. **Only the allow-listed pages can call the app.** The print object is added with `addWebMessageListener` restricted
   to the allow-listed origins, so frames from anywhere else never see it. `addJavascriptInterface` is not used.
9. **The web detects the app by that object,** not by the user agent. In the app the bill prints natively; otherwise
   `window.print()` runs as today. The bill is drawn by the existing `Receipt` component: the web re-lays-out a clone
   at the printer's width (`widthDots / 2` css px, so 58 mm is 192 px) and rasterizes it with `html-to-image`, bundled
   and loaded only in the app. The component and browser printing do not change.
10. **Kitchen tickets, order slips and QR cards use the Android print screen in the app:** `window.print()` is mapped to
    `WebView.createPrintDocumentAdapter`, so they behave as they do in Chrome and never fail silently.
11. **"Sent", never "printed".** ESC/POS over TCP can't prove paper came out. The app reports `sent` or a stable error
    code; the web shows it through labels.
12. **The device settings screen keeps only** the server, a connection check and the app version.
13. **Signing.** One release key, held in a password manager, an encrypted offline copy and a protected GitHub
    environment. Signed APKs are built by a tag-triggered workflow, not on every merge. Downloads are served from
    `/downloads` on our own domain.

14. **Two releases, because the customer needs bills now.** Version 1 ships 2–3 working days after A0 confirms the
    WebView; version 1.1 completes the decisions above.
    - **Version 1:** the app frame, the allow-list, sign-in, direct bill printing (§7–9, §11), duplicate protection
      and clear messages, and kitchen tickets, order slips and QR cards through the Android print screen (§10).
      The bill printer (host, port, width, cutter, image mode) is set on the **device settings
      screen**, under the same address rules; the page sends only the picture, and asks the app for the width
      first. One server, staging, fixed in the build. A signed APK, built on our machine with the release key and
      shared through Drive.
    - **Version 1.1:** `pos.printers` and Settings → Printers (§5–6; the device's printer field goes away and the
      page sends the location's printer), the Server select (§4), the tag-triggered signed build and `/downloads`
      (§13).
    - **What the cut costs:** each till's printer is set by hand on the device, and a replaced device needs it again.
      Moving the customer to `app.durby.tech` needs a new APK. Updates are installed by
      hand from Drive. The release key exists before the build workflow does, so it must be the final key from the
      start (Android refuses an update signed with another key). It lives in a password manager and an encrypted
      offline copy; on the build machine the key file sits in the git-ignored `apps/android/release/` and its password
      only in the user's `~/.gradle/gradle.properties` (`durbyReleasePassword`).

## Consequences

- Printing natively works only inside the app; other browsers keep `window.print()`.
- Measured on emulators (2026-11-07): stock Android 9 ships WebView 66, where Durby stays blank and the print link is
  missing; on WebView 113 Durby renders and the print link answers both ways. `window.print()` does nothing in a WebView
  (§10), and `createPrintDocumentAdapter` opens the Android print screen. That screen reaches a printer only if a print
  service is installed, as in Chrome today.
- The app's browser engine is the device's system WebView, which we don't control. On Android 9 it gets no updates past
  version 138, and Next.js 16 and Tailwind v4 need 111 or newer. Step A0 measures it before any of this is built. This
  is a security limit of the hardware, as Chrome on it already is.
- Anyone with `platform.settings.manage` can point a location's printing at any private address on ports 9100–9102. A
  page can do no more than print a picture there, because it never sends raw commands.
- The api gains one field on `GET /pos/bill-layout`; there is no migration and no new permission.
- A rollback to an older release ignores `pos.printers`. Adding a slot later must keep the previous release able to
  read the stored value (expand/contract).
- The Print Bridge design (`docs/modules/print-bridge.md`, on the spike branch only) is dropped. The spike is deleted
  once the app has replaced it on the customer's device.

## Open

- The address the pilot customer uses.
