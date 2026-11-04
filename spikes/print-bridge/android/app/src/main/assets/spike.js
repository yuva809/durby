/*
 * Print bridge spike diagnostics (docs/modules/print-bridge.md §9 step 1). Served by the bridge at
 * http://127.0.0.1:17890/spike.js and injected into the Durby page (staging, https) by a bookmarklet, so
 * every request below runs from the real Durby origin. Throwaway: English only, no labels.
 */
(async () => {
  const BRIDGE = 'http://127.0.0.1:17890';
  const old = document.getElementById('bridge-spike');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'bridge-spike';
  panel.style.cssText =
    'position:fixed;inset:8px;z-index:2147483647;background:#fff;color:#000;border:2px solid #000;' +
    'font:12px/1.4 monospace;padding:8px;overflow:auto;white-space:pre-wrap';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.cssText = 'float:right;font:14px sans-serif;padding:6px 12px';
  close.onclick = () => panel.remove();
  panel.append(close);
  document.body.append(panel);
  const out = (ok, msg) => {
    const line = document.createElement('div');
    line.textContent = `${ok === null ? '·' : ok ? 'PASS' : 'FAIL'} ${msg}`;
    if (ok === false) line.style.fontWeight = 'bold';
    panel.append(line);
  };
  const call = async (path, init = {}) => {
    const started = performance.now();
    // targetAddressSpace: Local Network Access hint on newer Chrome; ignored elsewhere.
    const res = await fetch(BRIDGE + path, { ...init, targetAddressSpace: 'loopback' });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, ms: Math.round(performance.now() - started) };
  };
  const jobId = () =>
    (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).toString();

  out(null, `origin ${location.origin}  secureContext=${window.isSecureContext}`);
  out(null, `userAgent ${navigator.userAgent}`);
  const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent);
  out(null, `chrome major ${chrome ? chrome[1] : 'unknown'}`);

  // 1. Simple GET (no preflight): mixed content + CORS.
  let health;
  try {
    health = await call('/health');
    out(
      health.status === 200,
      `GET /health ${health.status} in ${health.ms} ms ${JSON.stringify(health.body)}`,
    );
  } catch (e) {
    out(
      false,
      `GET /health threw ${e}. Bridge not running, or blocked (mixed content / LNA). Stop.`,
    );
    return;
  }
  const printer = health.body.printer;
  if (!printer.configured) {
    out(false, 'printer not configured in the bridge app. Stop.');
    return;
  }

  // 2. Printer status through the bridge.
  try {
    const st = await call('/status');
    out(st.status === 200, `GET /status ${st.status} ${JSON.stringify(st.body)}`);
  } catch (e) {
    out(false, `GET /status threw ${e}`);
  }

  // 3. Raster drawn in this page, sent as JSON (preflighted POST: CORS + Private Network Access).
  const dots = printer.dots;
  const pack = (canvas) => {
    const { width, height } = canvas;
    const px = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const rowBytes = Math.ceil(width / 8);
    const bits = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const a = px[i + 3] / 255;
        const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * a + 255 * (1 - a);
        if (lum < 160) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    let bin = '';
    for (let i = 0; i < bits.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bits.subarray(i, i + 0x8000));
    return { width, height, data: btoa(bin) };
  };
  const send = async (label, raster, id) => {
    try {
      const r = await call('/print/raster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id },
        body: JSON.stringify({ ...raster, jobId: id }),
      });
      out(r.status === 200, `${label}: ${r.status} in ${r.ms} ms ${JSON.stringify(r.body)}`);
      return r;
    } catch (e) {
      out(false, `${label} threw ${e} (preflight blocked? check the bridge log for OPTIONS)`);
      return null;
    }
  };

  const canvas = document.createElement('canvas');
  canvas.width = dots;
  canvas.height = 220;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  g.fillRect(0, 0, dots, 6);
  g.font = `bold ${Math.round(dots / 16)}px monospace`;
  g.fillText('Bridge spike: canvas', 8, 50);
  g.font = `${Math.round(dots / 22)}px monospace`;
  g.fillText('Grüße · Straße · 12,50 €', 8, 95);
  g.fillText(location.host, 8, 135);
  g.fillText(new Date().toLocaleString(), 8, 175);
  g.fillRect(0, 214, dots, 6);
  const id = jobId();
  const first = await send('canvas raster', pack(canvas), id);
  // 4. Same jobId again: must answer without a second print.
  if (first && first.status === 200) {
    const again = await send('same jobId again', pack(canvas), id);
    out(
      !!(again && again.body && again.body.duplicate),
      'duplicate jobId returned without printing',
    );
  }

  // 5. The real Durby bill, if this page has rendered one (open a table, print the bill once, cancel the dialog).
  const receipt = document.querySelector('#print-root [data-testid="receipt"]');
  if (!receipt) {
    out(
      null,
      'no bill on this page: open a table, tap Print bill, cancel the dialog, run again for step 5',
    );
    return;
  }
  try {
    const { toCanvas } = await import('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm');
    const cssWidth = 288; // 72 mm at 96 css px/inch ≈ 272; a little wider like the print CSS
    const holder = document.createElement('div');
    holder.style.cssText = `position:fixed;left:0;top:0;width:${cssWidth}px;background:#fff;color:#000;z-index:-1`;
    const clone = receipt.cloneNode(true);
    holder.append(clone);
    document.body.append(holder);
    const started = performance.now();
    const bill = await toCanvas(holder, {
      pixelRatio: dots / cssWidth,
      backgroundColor: '#fff',
      width: cssWidth,
    });
    holder.remove();
    out(
      bill.width === dots,
      `html-to-image ${bill.width}x${bill.height} in ${Math.round(performance.now() - started)} ms`,
    );
    const fit = document.createElement('canvas');
    fit.width = dots;
    fit.height = Math.round((bill.height * dots) / bill.width);
    fit.getContext('2d').drawImage(bill, 0, 0, fit.width, fit.height);
    await send('Durby bill raster', pack(fit), jobId());
  } catch (e) {
    out(false, `bill rasterize threw ${e}`);
  }
  out(null, 'done');
})();
