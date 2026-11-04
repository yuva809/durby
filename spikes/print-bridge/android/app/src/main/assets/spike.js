/*
 * Print bridge spike diagnostics (docs/modules/print-bridge.md §9 step 1). Served by the bridge at
 * http://127.0.0.1:17890/spike.js and injected into the Durby page (staging, https) by a bookmarklet, so
 * every request below runs from the real Durby origin. Throwaway: English only, no labels.
 *
 * The bill is re-laid-out at the printer's width (58 mm = 384 dots → 192 css px at 2 dots per css px),
 * not a shrunken 80 mm layout. Durby's own receipt component and browser printing are untouched: the
 * spike clones the bill Durby already rendered and styles only the clone.
 *
 * Written as one classic script with no top-level bindings, so the bookmarklet can inject it again on
 * the same page. In Node (spikes/print-bridge/test) it exports the pure layout helpers instead of running.
 */
(function (root) {
  /** Dots per css px. 12 px Durby text → 24 dots (3 mm), the size of a thermal printer's own font. */
  var DOTS_PER_CSS_PX = 2;

  /** The bill's css width and scale for a printer `dots` wide: 384 → 192 px, 576 → 288 px, 512 → 256 px. */
  function renderGeometry(dots) {
    if (!(dots >= 8 && dots <= 2040)) throw new Error('dots ' + dots);
    var cssWidth = Math.floor(dots / DOTS_PER_CSS_PX);
    return {
      cssWidth: cssWidth,
      pixelRatio: DOTS_PER_CSS_PX,
      canvasWidth: cssWidth * DOTS_PER_CSS_PX,
    };
  }

  /**
   * Styles for the clone only (scoped to #bridge-spike-bill): black on white like the print CSS, and
   * long words wrap instead of pushing prices off the paper.
   */
  var BILL_CSS =
    '#bridge-spike-bill,#bridge-spike-bill *{color:#000!important;border-color:#000!important;' +
    'background:transparent!important;box-shadow:none!important;min-width:0;overflow-wrap:anywhere}' +
    '#bridge-spike-bill{background:#fff!important;position:fixed;left:0;top:0;z-index:-1;' +
    'box-sizing:border-box;padding:0;margin:0}';

  /**
   * RGBA → 1-bit rows (MSB = leftmost dot, 1 = black) for ESC/POS. Text is thresholded (crisp edges);
   * pixels inside `ditherRects` (the logo, in canvas pixels) get Floyd–Steinberg so gray stays gray.
   */
  function packBits(rgba, width, height, ditherRects) {
    var rects = ditherRects || [];
    var rowBytes = Math.ceil(width / 8);
    var bits = new Uint8Array(rowBytes * height);
    var lum = new Float32Array(width * height);
    for (var p = 0; p < width * height; p++) {
      var i = p * 4;
      var a = rgba[i + 3] / 255;
      lum[p] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
    }
    function inDither(x, y) {
      for (var r = 0; r < rects.length; r++) {
        var d = rects[r];
        if (x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) return true;
      }
      return false;
    }
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var k = y * width + x;
        var v = lum[k];
        var black;
        if (inDither(x, y)) {
          black = v < 128;
          var err = v - (black ? 0 : 255);
          if (x + 1 < width && inDither(x + 1, y)) lum[k + 1] += (err * 7) / 16;
          if (y + 1 < height) {
            if (x > 0 && inDither(x - 1, y + 1)) lum[k + width - 1] += (err * 3) / 16;
            if (inDither(x, y + 1)) lum[k + width] += (err * 5) / 16;
            if (x + 1 < width && inDither(x + 1, y + 1)) lum[k + width + 1] += err / 16;
          }
        } else {
          black = v < 160;
        }
        if (black) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return bits;
  }

  /**
   * Checks the re-laid-out bill before printing: nothing wider than the paper, every price and the
   * total flush right, the total present, the logo loaded. Returns [ok, message] pairs.
   */
  function checkReflow(holder) {
    var results = [];
    var box = holder.getBoundingClientRect();
    var overflow = holder.scrollWidth - holder.clientWidth;
    results.push([
      overflow <= 1,
      'bill fits ' + Math.round(box.width) + ' css px (overflow ' + overflow + ' px)',
    ]);
    var wide = Array.prototype.filter.call(holder.querySelectorAll('*'), function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
    });
    results.push([wide.length === 0, wide.length + ' elements outside the paper width']);
    var rows = Array.prototype.slice.call(
      holder.querySelectorAll('[data-testid="bill-line"] > p:first-child'),
    );
    var total = holder.querySelector('[data-testid="order-total"]');
    if (total) rows.push(total.parentElement);
    var ragged = rows.filter(function (row) {
      var last = row.lastElementChild;
      return (
        !last ||
        Math.abs(last.getBoundingClientRect().right - row.getBoundingClientRect().right) > 1
      );
    });
    results.push([
      rows.length > 0 && ragged.length === 0,
      rows.length + ' price rows, ' + ragged.length + ' not right-aligned',
    ]);
    results.push([
      !!total && total.getBoundingClientRect().height > 0,
      'total ' + (total ? '"' + total.textContent + '"' : 'missing'),
    ]);
    var logo = holder.querySelector('[data-testid="bill-logo"]');
    if (logo)
      results.push([
        logo.complete && logo.naturalWidth > 0,
        'logo ' + logo.naturalWidth + 'x' + logo.naturalHeight,
      ]);
    else results.push([null, 'no logo on this bill']);
    return results;
  }

  /** The logo's box in canvas pixels, for dithering. */
  function logoRects(holder, scale) {
    var logo = holder.querySelector('[data-testid="bill-logo"]');
    if (!logo) return [];
    var h = holder.getBoundingClientRect();
    var r = logo.getBoundingClientRect();
    return [
      {
        x: Math.floor((r.left - h.left) * scale),
        y: Math.floor((r.top - h.top) * scale),
        w: Math.ceil(r.width * scale),
        h: Math.ceil(r.height * scale),
      },
    ];
  }

  var layout = {
    DOTS_PER_CSS_PX: DOTS_PER_CSS_PX,
    BILL_CSS: BILL_CSS,
    renderGeometry: renderGeometry,
    packBits: packBits,
    checkReflow: checkReflow,
    logoRects: logoRects,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = layout;
    return;
  }
  root.BridgeSpikeLayout = layout;
  // One run at a time: a second tap while the first still loads the converter would print twice and
  // leave two clones behind.
  if (root.__bridgeSpikeRunning) {
    var busy = document.getElementById('bridge-spike');
    if (busy) {
      var note = document.createElement('div');
      note.textContent = '· still running, please wait for "done"';
      busy.append(note);
    }
    return;
  }
  root.__bridgeSpikeRunning = true;
  run(layout).finally(function () {
    root.__bridgeSpikeRunning = false;
  });

  async function run(L) {
    var BRIDGE = 'http://127.0.0.1:17890';
    var old = document.getElementById('bridge-spike');
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = 'bridge-spike';
    panel.style.cssText =
      'position:fixed;inset:8px;z-index:2147483647;background:#fff;color:#000;border:2px solid #000;' +
      'font:12px/1.4 monospace;padding:8px;overflow:auto;white-space:pre-wrap';
    var close = document.createElement('button');
    close.textContent = 'Close';
    close.style.cssText = 'float:right;font:14px sans-serif;padding:6px 12px';
    close.onclick = function () {
      panel.remove();
    };
    panel.append(close);
    document.body.append(panel);
    function out(ok, msg) {
      var line = document.createElement('div');
      line.textContent = (ok === null ? '·' : ok ? 'PASS' : 'FAIL') + ' ' + msg;
      if (ok === false) line.style.fontWeight = 'bold';
      panel.append(line);
    }
    async function call(path, init) {
      var started = performance.now();
      // targetAddressSpace: Local Network Access hint on newer Chrome; ignored elsewhere.
      var res = await fetch(
        BRIDGE + path,
        Object.assign({}, init, { targetAddressSpace: 'loopback' }),
      );
      var body = await res.json().catch(function () {
        return null;
      });
      return { status: res.status, body: body, ms: Math.round(performance.now() - started) };
    }
    function jobId() {
      return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    }
    function raster(canvas, ditherRects) {
      var px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      var bits = L.packBits(px, canvas.width, canvas.height, ditherRects);
      var bin = '';
      for (var i = 0; i < bits.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, bits.subarray(i, i + 0x8000));
      return { width: canvas.width, height: canvas.height, data: btoa(bin) };
    }
    async function send(label, body, id) {
      try {
        var r = await call('/print/raster', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id },
          body: JSON.stringify(Object.assign({}, body, { jobId: id })),
        });
        out(
          r.status === 200,
          label + ': ' + r.status + ' in ' + r.ms + ' ms ' + JSON.stringify(r.body),
        );
        return r;
      } catch (e) {
        out(
          false,
          label + ' threw ' + e + ' (preflight blocked? check the bridge log for OPTIONS)',
        );
        return null;
      }
    }

    out(
      null,
      'spike.js 0.0.3 · origin ' + location.origin + '  secureContext=' + window.isSecureContext,
    );
    out(null, 'userAgent ' + navigator.userAgent);
    var chrome = /Chrome\/(\d+)/.exec(navigator.userAgent);
    out(null, 'chrome major ' + (chrome ? chrome[1] : 'unknown'));

    // 1. GET /health: mixed content + CORS (and a Private Network Access preflight where Chrome sends one).
    var health;
    try {
      health = await call('/health');
      out(
        health.status === 200,
        'GET /health ' + health.status + ' in ' + health.ms + ' ms ' + JSON.stringify(health.body),
      );
    } catch (e) {
      out(
        false,
        'GET /health threw ' + e + '. Bridge not running, or blocked (mixed content / LNA). Stop.',
      );
      return;
    }
    var printer = health.body.printer;
    if (!printer.configured) {
      out(false, 'printer not configured in the bridge app. Stop.');
      return;
    }
    var dots = printer.dots;
    var geo = L.renderGeometry(dots);
    out(
      null,
      'printer ' +
        dots +
        ' dots → bill laid out at ' +
        geo.cssWidth +
        ' css px × ' +
        geo.pixelRatio,
    );

    // 2. Printer status through the bridge.
    try {
      var st = await call('/status');
      out(st.status === 200, 'GET /status ' + st.status + ' ' + JSON.stringify(st.body));
    } catch (e) {
      out(false, 'GET /status threw ' + e);
    }

    // 3. Raster drawn in this page, sent as JSON (preflighted POST: CORS + Private Network Access).
    var canvas = document.createElement('canvas');
    canvas.width = dots;
    canvas.height = 220;
    var g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#000';
    g.fillRect(0, 0, dots, 6);
    g.font = 'bold ' + Math.round(dots / 16) + 'px monospace';
    g.fillText('Bridge spike: canvas', 8, 50);
    g.font = Math.round(dots / 22) + 'px monospace';
    g.fillText('Grüße · Straße · 12,50 €', 8, 95);
    g.fillText(location.host, 8, 135);
    g.fillText(new Date().toLocaleString(), 8, 175);
    g.fillRect(0, 214, dots, 6);
    var id = jobId();
    var first = await send('canvas raster', raster(canvas), id);
    // 4. Same jobId again: must answer without a second print.
    if (first && first.status === 200) {
      var again = await send('same jobId again', raster(canvas), id);
      out(
        !!(again && again.body && again.body.duplicate),
        'duplicate jobId returned without printing',
      );
    }

    // 5. The real Durby bill, if this page has rendered one (open a table, print the bill once, cancel the dialog).
    var receipt = document.querySelector('#print-root [data-testid="receipt"]');
    if (!receipt) {
      out(
        null,
        'no bill on this page: open a table, tap Print bill, cancel the dialog, run again for step 5',
      );
      return;
    }
    var holder = null;
    var style = null;
    try {
      out(null, 'loading the bill converter (the first time can take up to 30 s)…');
      var loadStarted = performance.now();
      var lib = await import('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm');
      out(null, 'converter loaded in ' + Math.round(performance.now() - loadStarted) + ' ms');
      style = document.createElement('style');
      style.textContent = L.BILL_CSS;
      document.head.append(style);
      holder = document.createElement('div');
      holder.id = 'bridge-spike-bill';
      holder.style.width = geo.cssWidth + 'px';
      holder.append(receipt.cloneNode(true));
      document.body.append(holder);
      await Promise.all(
        // Wait for the logo by its load event, at most 3 s. Not img.decode(): that waits for a rendered
        // frame, which never comes while the screen is off or the tab is in the background.
        Array.prototype.map.call(holder.querySelectorAll('img'), function (img) {
          if (img.complete) return null;
          return new Promise(function (resolve) {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 3000);
          });
        }),
      );
      L.checkReflow(holder).forEach(function (r) {
        out(r[0], 'reflow: ' + r[1]);
      });
      var started = performance.now();
      var bill = await lib.toCanvas(holder, {
        pixelRatio: geo.pixelRatio,
        backgroundColor: '#fff',
        width: geo.cssWidth,
        height: holder.scrollHeight,
      });
      var rects = L.logoRects(holder, geo.pixelRatio);
      out(
        bill.width === geo.canvasWidth,
        'html-to-image ' +
          bill.width +
          'x' +
          bill.height +
          ' in ' +
          Math.round(performance.now() - started) +
          ' ms',
      );
      // Exactly `dots` wide: pad an odd width with white on the right instead of stretching.
      var fit = document.createElement('canvas');
      fit.width = dots;
      fit.height = bill.height;
      var fg = fit.getContext('2d');
      fg.fillStyle = '#fff';
      fg.fillRect(0, 0, fit.width, fit.height);
      fg.drawImage(bill, 0, 0);
      await send('Durby bill raster', raster(fit, rects), jobId());
    } catch (e) {
      out(false, 'bill rasterize threw ' + e);
    } finally {
      if (holder) holder.remove();
      if (style) style.remove();
    }
    out(null, 'done');
  }
})(typeof window !== 'undefined' ? window : this);
