# Virtual printer

A fake ESC/POS network printer for testing the Durby Android app without paper (ADR 0032,
`docs/modules/android-app.md`). It listens on TCP like a receipt printer on port 9100, reads the commands the app
sends and draws each job to a PNG, so a test can look at the bill the way the printer would print it.

```bash
pnpm --filter @durby/virtual-printer start
```

```bash
pnpm --filter @durby/virtual-printer start -- --mode paper-out --paper-dots 576
```

Each connection is one job. In `out/` (git-ignored) it writes `job-001.bin` (the bytes as received),
`job-001.json` (commands, pages, errors) and `job-001-page-1.png` per page (a page ends at a cut).

## What it understands

`ESC @`, `ESC a`, `ESC E`, `ESC 2`, `ESC 3`, `ESC d`, `ESC p` (drawer kick, recorded), `ESC *` 24-dot modes,
`GS v 0`, `GS V` (cut), `DLE EOT` (status, answered), text and `LF`. Text is drawn as one box per character (filled
when bold); the report has the text itself. Anything else is reported as `unknown_command` with its offset, and an
image wider than `--paper-dots` as `wider_than_paper`, so a wrong byte in the app fails a test instead of a bill.

## Modes

| Mode         | Behaves like                                             | The app should report        |
| ------------ | -------------------------------------------------------- | ---------------------------- |
| `ok`         | A ready printer                                          | `print.sent`                 |
| `paper-out`  | Status: offline, paper end                               | `print.paper_out`            |
| `cover-open` | Status: offline, cover open                              | `print.cover_open`           |
| `silent`     | Prints, never answers status queries (many LAN printers) | `print.sent`                 |
| `disconnect` | Resets the connection after `--disconnect-after` bytes   | `print.printer_disconnected` |
| `stall`      | Accepts, then stops reading: the write hangs             | `print.printer_timeout`      |

Not modes, because no printer is needed for them:

- **Unreachable** (`print.printer_unreachable`): stop the virtual printer, or use a port nothing listens on.
- **Connect timeout** (`print.printer_timeout`): a private address nobody answers, for example `10.255.255.1`.

`stall` only stalls a job larger than the socket buffers (a few hundred kB on the Mac); a full bill raster is
around 70 kB, so the test job for it is a long one.

## With the Android emulator

The emulator reaches the Mac's `127.0.0.1` as `10.0.2.2`, which is a private address, so the app's address rule
accepts it. Set the location's bill printer in Settings → Printers to host `10.0.2.2`, port `9100`, then print a bill
in the app and open the PNG.

A real device on the same Wi-Fi needs `--host 0.0.0.0` and the Mac's LAN address in the printer settings. Only do
that on a network you trust: anyone on it can send jobs.
