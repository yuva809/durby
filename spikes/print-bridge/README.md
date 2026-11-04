# Print bridge spike (throwaway)

Step 1 of docs/modules/print-bridge.md §9. It answers one question: **can the Durby page in the T2s Lite's Chrome
reach an app on `http://127.0.0.1` and get a receipt printed on the LAN printer?** Delete this folder once the
real bridge (`apps/print-bridge-android/`) exists. It is not part of the pnpm workspace or CI.

What it has: a Kotlin app (minSdk 28) with a foreground service serving HTTP on `127.0.0.1:17890` (CORS for any
origin, logged), raw TCP ESC/POS printing, a settings screen with _Test connection_, _Test print_ (text) and a raster
width ruler (GS v 0, or ESC \* as a fallback), cash drawer kick (ESC p, pin 2 or 5), and `spike.js`, a diagnostics script that runs inside the Durby page. No pairing or tokens yet.

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

### Step 0: find the printer's IP (before installing anything)

1. Print the printer's **self-test page**: switch the printer off, hold **Feed**, switch it on, release Feed when
   it starts printing. Note the **model**, **IP address**, **MAC address** and whether DHCP is on.
2. Find the terminal's IP: on the T2s, _Settings → About → Status → IP address_ (or the Ethernet/Wi-Fi details).
3. Both must be on the **same subnet, 192.168.2.x**. If the printer is on **192.168.64.x** (or any other subnet),
   **stop here** and record it in the table: that is a network fix (router/DHCP or the printer's IP setting), not a
   code fix. DISH POS printing to it does not prove the T2s can reach it.

### Run

1. Install the APK (USB: `adb install -r app-release.apk`, or copy the file over and open it; allow "unknown
   sources" for the file manager when asked).
2. Open **Print Bridge (spike)**: enter the printer IP from step 0, port `9100`, width `576` for 80 mm
   (try `512` if the ruler is cut off on the right), cutter on. Tap **Save and start bridge**. A notification
   "Listening on 127.0.0.1:17890" must stay.
3. **Test connection** → note the log line (online / no answer to status query / unreachable).
4. **Test print (text)** and **Test print (raster ruler)**. The ruler's left and right edge lines must both print.
5. **Raster fallback**, only if the ruler (GS v 0) printed nothing, garbage or endless characters: tap **Test print
   (raster ruler, ESC \* fallback)**. If that one prints correctly, tick **Print images with ESC \* instead of GS
   v 0** and **Save and start bridge**, so the prints from Durby in steps 9 and 10 use ESC \* too. Record which
   mode works.
6. **Cash drawer**, only if a drawer is plugged into the printer: tap **Kick cash drawer (pin 2)**. If it doesn't
   open, tap **Kick cash drawer (pin 5)**. Record which pin opens it (or neither). Check with the staff first: it
   opens the real till drawer.
7. In Chrome on the T2s, open `chrome://version` and note the version.
8. Open `http://127.0.0.1:17890/` in Chrome → **Run diagnostics** (same-origin baseline).
9. Add the bookmarklet: bookmark any page, edit it, name it `bridgespike`, set the URL to:

   ```
   javascript:(()=>{const s=document.createElement('script');s.src='http://127.0.0.1:17890/spike.js?'+Date.now();document.body.append(s)})()
   ```

   Open Durby **staging** (https) and sign in. Type `bridgespike` in the address bar and pick the bookmark
   (Chrome Android only runs bookmarklets this way). A white panel lists PASS/FAIL lines.

10. For the real bill: open a table with items, tap **Print bill**, cancel the print dialog, run the bookmarklet
    again. Step 5 of the panel rasterizes the bill as Durby renders it and prints it.
11. Robustness: unplug the printer's Ethernet → _Test connection_ and a print must fail within ~3 s; plug back in.
    Print from DISH POS and the bridge one after the other. Reboot the T2s → the notification comes back without
    opening the app. Leave it idle overnight with the screen off → the bookmarklet still works next morning.
12. **Future Chrome check** (Local Network Access), after everything above: open
    `chrome://flags/#local-network-access-check`, set it to **Enabled (Blocking)**, tap **Relaunch**. On the Durby
    staging page run the bookmarklet again (steps 9 and 10). Record whether Chrome shows a permission prompt (and
    its wording or a photo), whether printing works after you allow it, and whether it still works after a reload
    without prompting again. If the flag doesn't exist in this Chrome version, record that. Afterwards set the flag
    back to **Default** and relaunch.

## Report back

| Check                                                                         | Result |
| ----------------------------------------------------------------------------- | ------ |
| Step 0: printer model / IP / MAC (self-test page)                             |        |
| Step 0: terminal IP; same subnet 192.168.2.x? (if 192.168.64.x: stopped here) |        |
| Chrome version (`chrome://version`)                                           |        |
| Test connection result                                                        |        |
| Text test print OK                                                            |        |
| Ruler: both edges printed at 576 (or 512)                                     |        |
| Raster mode that works: GS v 0 / ESC \* / neither                             |        |
| Cash drawer: none connected / opens on pin 2 / pin 5 / neither                |        |
| Same-origin diagnostics all PASS                                              |        |
| From Durby staging: `/health`, `/status` PASS                                 |        |
| From Durby staging: canvas raster printed (ü ß € readable)                    |        |
| Duplicate jobId not printed twice                                             |        |
| Durby bill raster printed, legible, logo OK; time (ms)                        |        |
| Any Chrome permission prompt shown (normal run)                               |        |
| Printer offline → fails in ~3 s                                               |        |
| Survives reboot / overnight                                                   |        |
| LNA blocking: flag present? prompt shown? printing works after allowing?      |        |

The bridge log (in the app) shows each request's `Origin` and whether Chrome sent a Private Network Access
preflight; a screenshot of it helps.
