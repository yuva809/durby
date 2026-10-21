// Read-only CDP route walker for the MeroIMS investigation.
// Usage: node cdp-drive.mjs <plan.json> <out.json> [startDelayMs]
// plan: [{ id, goto?: "/path", openFirst?: "regex for href", tabs?: true, wait?: ms }]
// Safety: navigates (GET) and clicks role="tab" elements only. Never clicks buttons,
// never types, never submits. Logs API method/path/query-param NAMES only (no values, no bodies).
import { readFileSync, writeFileSync } from 'node:fs';

const [planPath, outPath, delayArg] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const ORIGIN = 'https://app-dev.meroims.com';
const UNSAFE = /\b(save|post|delete|remove|approve|reject|submit|confirm|void|pay now|produce|dispatch|archive|send|logout|sign out)\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idify = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{id}');

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = targets.find((t) => t.type === 'page' && t.url.startsWith(ORIGIN));
if (!target) throw new Error('No MeroIMS tab found on the CDP endpoint');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let seq = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) listeners.forEach((f) => f(msg));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

let currentStep = 'init';
const api = []; let loadResolve = null;
listeners.push((msg) => {
  if (msg.method === 'Network.requestWillBeSent') {
    const u = new URL(msg.params.request.url);
    if (u.pathname.startsWith('/api/') && msg.params.request.method !== 'OPTIONS') {
      api.push({ step: currentStep, method: msg.params.request.method, host: u.host, path: idify(u.pathname), params: [...new URLSearchParams(u.search).keys()].sort() });
    }
  }
  if (msg.method === 'Page.loadEventFired' && loadResolve) { loadResolve(); loadResolve = null; }
});
const blocked = [];
const ALLOW_WRITE = /^\/api\/(auth|pos\/auth)\/refresh$/;
listeners.push(async (msg) => {
  if (msg.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = msg.params; const u = new URL(request.url);
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || ALLOW_WRITE.test(u.pathname)) {
    send('Fetch.continueRequest', { requestId });
  } else {
    blocked.push({ step: currentStep, method: request.method, path: idify(u.pathname) });
    send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  }
});
await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api-dev.meroims.com/*', requestStage: 'Request' }] });
await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable');

const INVENTORY = `(() => { const inv = (main) => {
  const t = (s) => (s || '').replace(/\\s+/g, ' ').trim().replace(/Rs\\.?\\s?-?[\\d,]+(\\.\\d+)?/g, 'Rs.[n]').slice(0, 90);
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const lab = (e) => t((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.placeholder || '').replace(/\\b(for|of|by)\\s+[A-Z][a-z]+(\\s+[A-Z][a-z]+)?$/, '$1 [name redacted]');
  return {
    path: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}'),
    queryKeys: [...new URLSearchParams(location.search).keys()],
    title: document.title.replace(/^[^|·—-]+[|·—-]\s*/, '[title] '),
    headings: uniq([...main.querySelectorAll('h1,h2,h3')].map((e) => t(e.innerText))).slice(0, 30),
    buttons: uniq([...main.querySelectorAll('button,[role=button]')].map((e) => t(e.getAttribute('aria-label') || e.innerText)).map((x) => (/Rs\\.|RS\\.|रु|\\d/.test(x) ? '[record button]' : x))).slice(0, 60),
    tabs: uniq([...main.querySelectorAll('[role=tab]')].map((e) => t(e.innerText))),
    fields: [...main.querySelectorAll('input,select,textarea,[role=combobox]')].map((e) => ({ tag: e.tagName.toLowerCase(), type: e.type || e.getAttribute('role') || '', name: e.name || '', label: lab(e), required: !!e.required })).filter((f) => f.type !== 'hidden').slice(0, 100),
    tableHeaders: [...main.querySelectorAll('table')].map((tb) => uniq([...tb.querySelectorAll('thead th,[role=columnheader]')].map((e) => t(e.innerText)))).slice(0, 6),
    links: uniq([...main.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute('href').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}').replace(/\\?.*$/, ''))).slice(0, 80),
    dialogs: document.querySelectorAll('[role=dialog]').length,
    emptyStates: uniq([...main.querySelectorAll('p,div')].filter((e) => e.children.length === 0).map((e) => t(e.innerText)).filter((x) => /^(no |nothing|empty|not found|you don)/i.test(x))).slice(0, 10),
    errorText: uniq([...main.querySelectorAll('[role=alert]')].map((e) => t(e.innerText))).slice(0, 5)
  };
  };
  const t = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = inv(document.querySelector('main') || document.body);
  const isRecord = /[0-9a-f]{8}-[0-9a-f]{4}-/.test(location.pathname) || /[?&](party|id)=/.test(location.search);
  if (isRecord && out.headings.length) out.headings[0] = '[record title redacted]';
  const dlg = document.querySelector('[role=dialog], [aria-modal="true"], [data-state="open"][data-vaul-drawer], aside[data-state="open"], [role=complementary][data-state="open"]');
  if (dlg) { const d = inv(dlg); delete d.path; delete d.queryKeys; delete d.title; if (d.headings.length) d.headings[0] = '[panel title redacted]'; out.dialog = d; }
  return out;
})()`;

const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const hardNavigate = async (path, settle) => {
  const loaded = new Promise((r) => { loadResolve = r; setTimeout(r, 15000); });
  await send('Page.navigate', { url: ORIGIN + path });
  await loaded; await sleep(settle);
};
// Client-side (SPA) navigation via the Next.js app router, same as a link click.
// Keeps the document alive so passive REA capture is not interrupted.
let softCount = 0, hardCount = 0;
const navigate = async (path, settle) => {
  const target = path.replace(/\?.*$/, '');
  const ok = await evalJs(`(() => { if (window.next && window.next.router && window.next.router.push) { window.next.router.push(${JSON.stringify(path)}); return true; } return false; })()`);
  if (!ok) { hardCount++; return hardNavigate(path, settle); }
  for (let i = 0; i < 40; i++) { if ((await evalJs('location.pathname')) === target) break; await sleep(200); }
  softCount++; await sleep(settle);
};

if (delayArg) await sleep(Number(delayArg));
const readMenu = () => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /user menu/i.test(x.getAttribute('aria-label') || '')); return b ? b.innerText : ''; })()`);
let menuText = await readMenu();
if (!menuText) { await evalJs(`window.next && window.next.router && window.next.router.push('/')`); await sleep(3500); menuText = await readMenu(); }
const results = [];
for (const step of plan) {
  currentStep = step.id; const settle = step.wait ?? 3500; const rec = { id: step.id, startedAt: new Date().toISOString() };
  try {
    if (step.goto) await navigate(step.goto, settle);
    if (step.openFirst) {
      const href = await evalJs(`(() => { const re = new RegExp(${JSON.stringify(step.openFirst)}); const a = [...document.querySelectorAll('a[href^="/"]')].find((x) => re.test(x.getAttribute('href'))); return a ? a.getAttribute('href') : null; })()`);
      if (!href) { rec.note = 'openFirst: no matching link (rows may not be anchors, or the list is empty)'; }
      else { rec.opened = idify(href.replace(/\?.*$/, '')); await navigate(href, settle); }
    }
    if (step.openFirstRow) {
      const before = await evalJs('location.pathname');
      const ok = await evalJs(`(() => { const tr = document.querySelector('main table tbody tr'); if (!tr) return 'no-rows'; const td = [...tr.querySelectorAll('td')].find((c) => !c.querySelector('button,input,[role=button],a[href]')) || tr.querySelector('td'); if (!td) return 'no-cell'; td.click(); return 'clicked'; })()`);
      await sleep(settle);
      const after = await evalJs('location.pathname');
      rec.opened = { result: ok, from: idify(before || ''), to: idify(after || '') };
    }
    rec.ui = await evalJs(INVENTORY);
    if (step.tabs && rec.ui?.tabs?.length) {
      rec.tabViews = [];
      const names = rec.ui.tabs.filter((n) => !UNSAFE.test(n));
      rec.skippedTabs = rec.ui.tabs.filter((n) => UNSAFE.test(n));
      for (const name of names.slice(0, 8)) {
        currentStep = `${step.id}#${name}`;
        const ok = await evalJs(`(() => { const el = [...document.querySelectorAll('main [role=tab]')].find((e) => e.innerText.replace(/\\s+/g,' ').trim().startsWith(${JSON.stringify(name.slice(0, 40))})); if (!el) return false; el.click(); return true; })()`);
        await sleep(2000);
        rec.tabViews.push({ tab: name, clicked: ok, ui: ok ? await evalJs(INVENTORY) : null });
      }
    }
  } catch (e) { rec.error = String(e); }
  rec.endedAt = new Date().toISOString();
  results.push(rec);
}
await send('Fetch.disable');
// Redact tenant/user names learned from the user-menu button (never stored).
menuText = (menuText || '') + '\n' + ((await readMenu()) || '');
const terms = [...new Set(menuText.split(/\n+/).map((x) => x.trim()).filter((x) => x.length >= 4))].sort((a, b) => b.length - a.length);
if (!terms.length) { console.error('ABORT: could not learn tenant/user names for redaction; refusing to write unredacted output'); process.exit(3); }
let json = JSON.stringify({ target: target.id, runAt: new Date().toISOString(), steps: results, api, blocked, redactedTerms: terms.length }, null, 2);
for (const term of terms) json = json.split(term).join('[tenant/user redacted]');
writeFileSync(outPath, json);
ws.close();
console.log(`done: ${results.length} steps (soft nav ${softCount}, hard nav ${hardCount}), ${api.length} api calls, ${blocked.length} BLOCKED writes -> ${outPath}`);
