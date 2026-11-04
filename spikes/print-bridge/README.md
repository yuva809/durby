# Print bridge spike (throwaway)

Step 1 of docs/modules/print-bridge.md §9. It answers one question: **can the Durby page in the T2s Lite's Chrome
reach an app on `http://127.0.0.1` and get a receipt printed on the LAN printer?** Delete this folder once the
real bridge (`apps/print-bridge-android/`) exists. It is not part of the pnpm workspace or CI, and it does not
change Durby's browser printing.

What it has: a Kotlin app (minSdk 28) with a foreground service serving HTTP on `127.0.0.1:17890` (CORS for any
origin, logged), raw TCP ESC/POS printing, a settings screen with _Test connection_, _Test print_ (text) and a
raster width ruler (GS v 0, or ESC \* as a fallback), cash drawer kick (ESC p, pin 2 or 5), and `spike.js`, a
diagnostics script that runs inside the Durby page. No pairing or tokens yet.

## Current APK

|         |                                                                                |
| ------- | ------------------------------------------------------------------------------ |
| File    | `spikes/print-bridge/print-bridge-spike-0.0.3.apk` (not committed)             |
| Version | 0.0.3 (build 3), package `app.durby.printbridge.spike`, Android 9+ (minSdk 28) |
| Size    | 2,089,713 bytes (about 2.0 MB)                                                 |
| SHA-256 | `93ef7181bbea0cb9b6c556e2e8ccb7e07bdcec32ef53da8d3e172bb61894e964`             |
| Signed  | Android debug key, APK Signature Scheme v2 (spike only; not for production)    |

Check a copy before sending it, and after uploading it anywhere:

```bash
shasum -a 256 spikes/print-bridge/print-bridge-spike-0.0.3.apk
```

## Build

Needs JDK 17 and the Android SDK (platform 35, build-tools 35).

```bash
cd spikes/print-bridge/android && gradle wrapper --gradle-version 8.11.1
```

```bash
cd spikes/print-bridge/android && ./gradlew clean test assembleRelease
```

The APK is `app/build/outputs/apk/release/app-release.apk`; copy it to
`spikes/print-bridge/print-bridge-spike-<version>.apk` and update the table above. The version lives in
`android/app/build.gradle.kts` (`versionName`, `versionCode`) and shows in the app, its notification, `/health`
and on the text test receipt.

---

## Developer checks (no SUNMI, no printer)

`spike.js` lays the bill out again at the printer's width instead of shrinking Durby's 80 mm layout: 2 dots per
css px, so 58 mm (384 dots) renders at 192 css px and 80 mm (576) at 288 css px, and 12 px text is 24 dots (3 mm)
on both. It styles only its own clone (`#bridge-spike-bill`); Durby's receipt component and browser printing are
untouched. Before printing it checks the clone: nothing wider than the paper, every price and the total flush
right, the logo loaded (the `reflow:` lines in the panel). The logo is dithered, text is thresholded.

```bash
node --test spikes/print-bridge/test/layout.test.mjs
```

```bash
node spikes/print-bridge/test/fake-bridge.mjs 384
```

The second one serves a stand-in bridge on `127.0.0.1:17890` and a fake Durby page with a long German bill (logo,
umlauts, €, a 48-letter word) on `http://localhost:5199`. Run the bookmarklet code on that page, then open
`http://127.0.0.1:17890/last` to see the 1-bit image the printer would get. Use `576` for 80 mm.

## For the restaurant owner: install and test the Print Bridge

This is a **test app**. It does not change how Durby or DISH POS work today, and it does not touch your orders,
bills or money. It only checks whether this terminal can talk to your receipt printer. Please do it **outside
service hours**; it takes about 30 minutes and prints a few short test slips.

Send everything back with the form in **`OWNER-REPORT-TEMPLATE.txt`** (you can copy it into an email or a
WhatsApp message). Photos taken with your phone are perfect.

### What you need

- The SUNMI T2s Lite terminal, switched on and connected to the internet.
- The receipt printer, switched on, with paper in it, and its network cable plugged in as usual.
- The download link for the app file **`print-bridge-spike-0.0.3.apk`**, which we send you.
- A phone to take photos.

### 1. Print the printer's self-test page

This page tells us the printer's model and its network address (IP address).

1. Switch the printer **off**.
2. Press and **hold the FEED button** (the paper feed button on the printer).
3. While holding it, switch the printer **on**. Keep holding for 2–3 seconds until it starts printing, then let go.
4. One or two long slips come out. **Take a clear photo of all of them.**

On the printout, look for lines such as **IP Address**, **Model**, **MAC Address** and **Port**, and copy them into
the report. If nothing prints, take a photo of the label on the bottom or back of the printer instead and tell us
in the report. Printers differ; we have not assumed any model.

### 2. Find the terminal's network address

1. On the T2s Lite, open **Settings**.
2. Go to **About** (sometimes called _About device_ or _About phone_) → **Status**, and find **IP address**. If it's
   not there: **Settings → Network & internet → Ethernet** (or **Wi-Fi**) → tap the connected network.
3. Write down the IP address (four numbers with dots, for example `192.168.2.20`; yours will be different).

Compare the **first three numbers** of the terminal's and the printer's addresses. We expect both to start with
`192.168.2.`. If they don't match (for example the printer starts with `192.168.64.`), **stop here** and just send
the report: that needs a network change, not this app.

### 3. Download and install the app

1. On the T2s Lite, open the download link we sent you (in **Chrome**, or your email app).
2. Download **`print-bridge-spike-0.0.3.apk`**. If Chrome warns that _"this type of file can harm your device"_,
   tap **Download anyway** (we sent this file; it is our test app).
3. When the download finishes, tap **Open** (or open it from **Files → Downloads**).
4. Android may say _"For your security, your phone is not allowed to install unknown apps from this source"_. Tap
   **Settings**, switch on **Allow from this source**, then go back.
5. Tap **Install**, then **Open**.

If you see a message that installation is **blocked** by the device or by SUNMI, or anything else unexpected, stop,
take a photo of the message and send it to us. Don't change other security settings.

### 4. The app screen and what to enter

The app has **one screen** that you scroll up and down. From top to bottom:

| On screen                                                                                                                                                                                       | What to do                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Title bar: **Print Bridge (spike) 0.0.3**                                                                                                                                                       | Nothing.                                                                                                    |
| Large bold line: **Version 0.0.3 (build 3)**                                                                                                                                                    | Check it says exactly this. If not, you have an old file: tell us.                                          |
| **Printer IP** (text box, empty)                                                                                                                                                                | Type the printer's IP address from the self-test page, exactly as printed (only numbers and dots).          |
| **Port** (text box, shows `9100`)                                                                                                                                                               | Leave `9100`, unless the self-test page shows a different port number for network printing; then type that. |
| **Printable width in dots (58 mm = 384, 80 mm = 576 or 512)** (text box, shows `576`)                                                                                                           | Measure the paper roll's width. **80 mm** (about 8 cm) → `576`. **58 mm** (about 6 cm) → `384`.             |
| **Printer has a cutter** (tick box, ticked)                                                                                                                                                     | Ticked if DISH POS receipts come out **cut by the printer**. Unticked if staff **tear** them off by hand.   |
| **Print images with ESC \* instead of GS v 0** (tick box, empty)                                                                                                                                | Leave empty for now (see step 5).                                                                           |
| **Save and start bridge** (button)                                                                                                                                                              | Tap it after filling in the boxes.                                                                          |
| **Test connection**, **Test print (text)**, **Test print (raster ruler)**, **Test print (raster ruler, ESC \* fallback)**, **Kick cash drawer (pin 2)**, **Kick cash drawer (pin 5)** (buttons) | See steps 5 and 6.                                                                                          |
| **Log** (small text at the bottom)                                                                                                                                                              | Every button writes one line here, **newest at the top**. You'll copy these lines into the report.          |

After **Save and start bridge**, a notification _"Listening on 127.0.0.1:17890 · printer …"_ stays at the top of
the screen (pull down from the top edge to see it). That is normal; leave it.

### 5. Run the three printer tests

Tap each button **once** and wait a few seconds. After each one, look at the newest line in the **Log**.

1. **Test connection.** Nothing prints. The log shows a new line: the time, then `test connection:` and a result.
   Copy it into the report (for example _online_, _paper out_, _reachable, no answer to status query_ or _unreachable_).
2. **Test print (text).** A short slip should print, starting with **PRINT BRIDGE TEST** and **Version 0.0.3
   (spike)**. Take a photo of it.
3. **Test print (raster ruler).** A slip with a **thick black bar** and **thin vertical lines** under it should
   print. Take a photo. Check that there is a vertical line at the **far left and the far right** edge.
   - If the right side is **cut off**: change the width to `512`, tap **Save and start bridge**, and tap **Test
     print (raster ruler)** again.
   - If **nothing** prints, or random characters or a very long strip print: tap **Test print (raster ruler,
     ESC \* fallback)** and take a photo of what comes out.

Write in the report what happened for each test, even if nothing printed. That's useful too.

### 6. Cash drawer (only if one is connected to the printer)

**Only** if a cash drawer is plugged into the **printer** with a cable, and with the staff's OK (it opens the real
drawer):

1. Tap **Kick cash drawer (pin 2)**. Did the drawer open?
2. If not, tap **Kick cash drawer (pin 5)**. Did it open now?

If there is no drawer on the printer, skip this and write _no drawer_ in the report.

### 7. Check the Chrome version

1. Open **Chrome** on the T2s Lite.
2. In the address bar type **`chrome://version`** and press Enter.
3. The first line shows the version (for example _Chrome 138.0…_). Write it down or take a photo.

### 8. Send the report

Fill in **`OWNER-REPORT-TEMPLATE.txt`** and send it with the photos: self-test page, text test slip, ruler slip(s),
the app's Log (a phone photo of the screen is fine) and the Chrome version. You can leave the app installed; it
does nothing unless someone taps its buttons. We'll schedule a short call for the next part (testing from inside
Durby).

---

## For the restaurant owner, part 2: test from the Durby website

Do this **on a call with us**, outside service hours, after part 1. It prints about five short slips and one test
bill. Note the results in part 2 of **`OWNER-REPORT-TEMPLATE.txt`**. We send you three things by message: the new
app file **`print-bridge-spike-0.0.3.apk`**, a **test login** for the Durby test website, and a line of text for
a bookmark.

### 1. Update the app to 0.0.3

1. On the T2s, open our link and download **`print-bridge-spike-0.0.3.apk`**, then tap **Open**.
2. Android asks _"Do you want to install an update to this existing application?"_. Tap **Install**, then
   **Open**. Your settings stay.
3. Check the big line at the top says **Version 0.0.3 (build 3)**.
4. Check the boxes: **Printer IP** and **Port** as before. **Printable width** must be **`384`** (your paper is
   58 mm). **Printer has a cutter** ticked.
5. Look at the ruler slips from part 1. If the normal ruler printed well, leave **Print images with ESC \*…**
   empty. If only the _ESC \* fallback_ ruler printed well, tick it.
6. Tap **Save and start bridge**.

### 2. Quick check in Chrome

1. Open **Chrome** and type **`127.0.0.1:17890`** in the address bar, then press Enter.
2. Tap **Run diagnostics**. A white panel appears and **one** short slip prints, starting with _Bridge spike:
   canvas_. Take a photo of the panel and of the slip.

### 3. Create the test bookmark (once)

1. In Chrome, tap **⋮** (top right), then the **☆ star**. Chrome says _Bookmarked_.
2. Tap **⋮ → Bookmarks**, then **⋮** next to the new bookmark, then **Edit**.
3. **Name:** type `bridgespike`. **URL:** delete what's there and paste the line of text we sent you (it starts
   with `javascript:`). Tap back to save.
4. Open the bookmark editor once more and check the URL still starts with `javascript:`.

### 4. Run the test on the Durby test website

1. Open **`https://staging.durby.tech`** and sign in with the **test login** we sent (not your real account).
2. Tap the address bar, type **`bridgespike`** and tap the suggestion with the **star** (the bookmark). Don't
   press Enter (that would search Google).
3. The white panel appears and **one** slip prints. Take a photo of the panel and the slip, then tap **Close**.

### 5. Print a real test bill

1. In Durby, open the **test table** we tell you. Tap **Print bill**.
2. Android's print screen opens. **Cancel** it (back arrow or ✕). Stay on the same page. **Don't reload**.
3. Run **`bridgespike`** again (address bar → `bridgespike` → star suggestion). The first time, the panel says
   _loading the bill converter_ and can take up to 30 seconds. Wait for **done**; don't run it again meanwhile.
4. The panel shows lines starting with **reflow:** and then **Durby bill raster**. Two slips print: the canvas
   slip again and the **bill**.
5. Check the bill: can you read every line? Are the prices on the right? Is the **total** big and clear? Are the
   logo (if any), **ä ö ü ß** and **€** right? Is it cut? Take a photo of the bill on a table, plus the panel.

### 6. Printer off test

1. Unplug the printer's **network cable**. Run **`bridgespike`** once. Within a few seconds the panel shows
   **FAIL** lines (no slip). Take a photo.
2. Plug the cable back in. Print a receipt from **DISH POS** to make sure it still works.

### 7. Settings test (only together with us on the call)

We'll guide you through `chrome://flags` and one more run. Afterwards we put the setting back.

### 8. When we say we're finished

Open **Settings → Apps → Print Bridge (spike) → Uninstall**. The test app accepts print requests from any website
while it runs, so it shouldn't stay installed after testing.

## Full spike checklist (developer, or the owner guided by the developer on a call)

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
