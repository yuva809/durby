# Print bridge spike (throwaway)

Step 1 of docs/modules/print-bridge.md §9. It answers one question: **can the Durby page in the T2s Lite's Chrome
reach an app on `http://127.0.0.1` and get a receipt printed on the LAN printer?** Delete this folder once the
real bridge (`apps/print-bridge-android/`) exists. It is not part of the pnpm workspace or CI.

What it has: a Kotlin app (minSdk 28) with a foreground service serving HTTP on `127.0.0.1:17890` (CORS for any
origin, logged), raw TCP ESC/POS printing, a settings screen with _Test connection_, _Test print_ (text) and a raster
width ruler, and `spike.js`, a diagnostics script that runs inside the Durby page. No pairing or tokens yet.

## Build

Needs JDK 17 and the Android SDK (platform 35, build-tools 35).

```bash
cd spikes/print-bridge/android && gradle wrapper --gradle-version 8.11.1
```

```bash
cd spikes/print-bridge/android && ./gradlew test assembleRelease
```

The APK is `app/build/outputs/apk/release/app-release.apk` (debug-key signed, spike only; a copy is kept as
`spikes/print-bridge/print-bridge-spike-0.0.1.apk`, not committed).

## On the T2s Lite

1. Install the APK (USB: `adb install -r app-release.apk`, or copy the file over and open it; allow "unknown
   sources" for the file manager when asked).
2. Open **Print Bridge (spike)**: enter the printer IP (the one DISH POS uses), port `9100`, width `576` for 80 mm
   (try `512` if the ruler is cut off on the right), cutter on. Tap **Save and start bridge**. A notification
   "Listening on 127.0.0.1:17890" must stay.
3. **Test connection** → note the log line (online / no answer to status query / unreachable).
4. **Test print (text)** and **Test print (raster ruler)**. The ruler's left and right edge lines must both print.
5. In Chrome on the T2s, open `chrome://version` and note the version.
6. Open `http://127.0.0.1:17890/` in Chrome → **Run diagnostics** (same-origin baseline).
7. Add the bookmarklet: bookmark any page, edit it, name it `bridgespike`, set the URL to:

   ```
   javascript:(()=>{const s=document.createElement('script');s.src='http://127.0.0.1:17890/spike.js?'+Date.now();document.body.append(s)})()
   ```

8. Open Durby **staging** (https) and sign in. Type `bridgespike` in the address bar and pick the bookmark
   (Chrome Android only runs bookmarklets this way). A white panel lists PASS/FAIL lines.
9. For the real bill: open a table with items, tap **Print bill**, cancel the print dialog, run the bookmarklet
   again. Step 5 rasterizes the bill as Durby renders it and prints it.
10. Robustness: unplug the printer's Ethernet → _Test connection_ and a print must fail within ~3 s; plug back in.
    Print from DISH POS and the bridge one after the other. Reboot the T2s → the notification comes back without
    opening the app. Leave it idle overnight with the screen off → the bookmarklet still works next morning.

## Report back

| Check                                                      | Result |
| ---------------------------------------------------------- | ------ |
| Chrome version (`chrome://version`)                        |        |
| Printer make/model                                         |        |
| Test connection result                                     |        |
| Text test print OK                                         |        |
| Ruler: both edges printed at 576 (or 512)                  |        |
| Same-origin diagnostics all PASS                           |        |
| From Durby staging: `/health`, `/status` PASS              |        |
| From Durby staging: canvas raster printed (ü ß € readable) |        |
| Duplicate jobId not printed twice                          |        |
| Durby bill raster printed, legible, logo OK; time (ms)     |        |
| Any Chrome permission prompt shown                         |        |
| Printer offline → fails in ~3 s                            |        |
| Survives reboot / overnight                                |        |

The bridge log (in the app) shows each request's `Origin` and whether Chrome sent a Private Network Access
preflight; a screenshot of it helps.
