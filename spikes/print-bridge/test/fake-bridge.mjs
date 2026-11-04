// Developer check for spike.js without a SUNMI or printer (../README.md → Developer checks):
//   node spikes/print-bridge/test/fake-bridge.mjs [dots]       (default 384 = 58 mm)
// Serves a stand-in for the Kotlin bridge on 127.0.0.1:17890 (same routes and CORS headers) and a
// fake Durby page on http://localhost:5199 whose #print-root holds an 80 mm bill marked up like
// apps/web/components/pos/receipt.tsx (same data-testids and structure, inline styles for Tailwind).
// http://127.0.0.1:17890/last shows the last raster exactly as the printer would get it.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dots = Number(process.argv[2] ?? 384);
const assets = fileURLToPath(new URL('../android/app/src/main/assets/', import.meta.url));
const jobs = new Map();
let last = null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

http
  .createServer((req, res) => {
    const origin = req.headers.origin;
    const head = { 'Cache-Control': 'no-store' };
    if (origin)
      Object.assign(head, {
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
    const json = (s, b) => {
      res.writeHead(s, { ...head, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    const path = req.url.split('?')[0];
    log(req.method, path, `origin=${origin}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, head);
      return res.end();
    }
    if (path === '/' || path === '/spike.js') {
      res.writeHead(200, {
        ...head,
        'Content-Type': path === '/' ? 'text/html' : 'text/javascript',
      });
      return res.end(fs.readFileSync(assets + (path === '/' ? 'index.html' : 'spike.js')));
    }
    if (path === '/health')
      return json(200, {
        ok: true,
        spike: true,
        printer: { configured: true, host: 'fake', port: 9100, dots, cutter: true, escStar: false },
      });
    if (path === '/status') return json(200, { state: 'online', reachable: true, answered: true });
    if (path === '/last') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<body style="margin:0;background:#888"><canvas id=c style="display:block"></canvas><script>
const r=${JSON.stringify(last)};const c=document.getElementById('c');c.width=r.width;c.height=r.height;
const g=c.getContext('2d');const d=atob(r.data);const rb=Math.ceil(r.width/8);const im=g.createImageData(r.width,r.height);
for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){const on=d.charCodeAt(y*rb+(x>>3))&(0x80>>(x&7));
const i=(y*r.width+x)*4;im.data[i]=im.data[i+1]=im.data[i+2]=on?0:255;im.data[i+3]=255}g.putImageData(im,0,0)</script>`);
    }
    if (path === '/print/raster' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const b = JSON.parse(body);
        const bytes = Buffer.from(b.data, 'base64').length;
        const expected = Math.ceil(b.width / 8) * b.height;
        if (bytes !== expected || b.width !== dots)
          return json(400, {
            code: 'bridge.payload_invalid',
            bytes,
            expected,
            width: b.width,
            dots,
          });
        if (jobs.has(b.jobId)) return json(200, { ...jobs.get(b.jobId), duplicate: true });
        const r = {
          jobId: b.jobId,
          state: 'sent',
          code: 'sent',
          bytes,
          width: b.width,
          height: b.height,
        };
        jobs.set(b.jobId, r);
        last = b;
        log('printed', `${b.width}x${b.height}`);
        json(200, r);
      });
      return;
    }
    json(404, { code: 'bridge.not_found' });
  })
  .listen(17890, '127.0.0.1');

const rule = '<div aria-hidden style="margin:8px 0;border-top:1px dashed #111"></div>';
const line = (qty, name, total, unit, note) => `
  <li data-testid="bill-line" data-name="${name}">
    <p style="display:flex;justify-content:space-between;gap:8px"><span>${qty} × ${name}</span><span style="flex-shrink:0;font-variant-numeric:tabular-nums">${total}</span></p>
    ${qty > 1 ? `<p style="padding-left:12px">${qty} × ${unit}</p>` : ''}${note ? `<p style="padding-left:12px;font-style:italic">${note}</p>` : ''}
  </li>`;
const page = `<!doctype html><meta charset=utf-8><title>fake durby</title>
<style>#print-root{display:none} p,ul{margin:0;padding:0;list-style:none}</style>
<p>Fake Durby page. The bill below is in #print-root (hidden), like after tapping Print bill.</p>
<div id="print-root"><div data-print-part>
<div data-testid="receipt" style="font-family:ui-monospace,monospace;font-size:12px;line-height:1.375;color:#1a1a1a">
  <header data-testid="bill-header" style="display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center">
    <img id="logo" alt="" data-testid="bill-logo" style="margin-bottom:4px;max-height:96px;max-width:60%;object-fit:contain;filter:grayscale(1)">
    <p style="font-size:16px;font-weight:700;letter-spacing:.025em">Gasthaus Zur Mühle Singen</p>
    <p style="word-break:break-all">+49 7731 123456</p>
    <p style="word-break:break-all">info@gasthaus-zur-muehle-singen.example</p>
    <p style="word-break:break-all">www.gasthaus-zur-muehle-singen.example</p>
  </header>
  ${rule}
  <div data-testid="bill-middle" style="display:flex;flex-direction:column;gap:2px">
    <p data-testid="bill-waiter">Bedienung: Jürgen</p>
    <p data-testid="bill-table">Tisch 12 · 4 Gäste</p>
    <p data-testid="bill-number" style="font-weight:700">Rechnung Nr. 2026-000123</p>
  </div>
  ${rule}
  <ul style="display:flex;flex-direction:column;gap:4px">
    ${line(2, 'Weißbier 0,5 l', '11,00 €', '5,50 €')}
    ${line(1, 'Schweinerückensteak mit Spätzle und Rahmsoße', '24,90 €')}
    ${line(1, 'Käsespätzle', '14,50 €', '', 'ohne Röstzwiebeln, extra Käse')}
    ${line(3, 'Apfelschorle', '10,50 €', '3,50 €')}
    ${line(1, 'Donaudampfschifffahrtsgesellschaftskapitänsteller', '1.234,50 €')}
  </ul>
  ${rule}
  <p style="display:flex;justify-content:space-between;gap:8px;font-size:16px;font-weight:700"><span>SUMME</span><span data-testid="order-total" style="font-variant-numeric:tabular-nums">1.295,40 €</span></p>
  ${rule}
  <footer data-testid="bill-footer" style="display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center">
    <p data-testid="bill-thanks" style="font-size:14px">Vielen Dank für Ihren Besuch!</p>
    <p style="margin-top:4px">Dies ist keine Quittung.</p>
    <p style="margin-top:8px">Powered by Durby</p>
    <p>04.11.26, 21:30</p>
  </footer>
</div></div></div>
<script>
// A gray-gradient logo with a ring, like a logo the bill-logo upload turned gray (lib/pos/bill-logo.ts).
const c = document.createElement('canvas'); c.width = 240; c.height = 120;
const g = c.getContext('2d'); const grad = g.createLinearGradient(0, 0, 240, 0);
grad.addColorStop(0, '#222'); grad.addColorStop(1, '#ddd'); g.fillStyle = grad; g.fillRect(0, 0, 240, 120);
g.fillStyle = '#fff'; g.beginPath(); g.arc(60, 60, 40, 0, 7); g.fill();
g.fillStyle = '#000'; g.font = 'bold 34px serif'; g.fillText('ZM', 34, 72);
document.getElementById('logo').src = c.toDataURL('image/png');
</script>`;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  })
  .listen(5199, '127.0.0.1');
log(`fake bridge :17890 (${dots} dots), fake durby http://localhost:5199`);
