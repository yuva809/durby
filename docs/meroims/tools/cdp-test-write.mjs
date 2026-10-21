// Controlled single-write test runner (Option B). One approved scenario per run.
// Usage: node cdp-test-write.mjs <spec.json> <out.json> [--dry-run] [startDelayMs]
// spec: {
//   scenario,
//   localStorage?: { key, value },          // client-side preference set before acting (previous value recorded)
//   before?: ["/route", ...],               // read-only pages visited before acting (their GETs are recorded)
//   navigate: "/route",                     // page where the action happens
//   input?:  { match: "label/placeholder substring", value: "text" },
//   button:  { text: "exact button text" },
//   readClicks?: ["X-report"],              // read-only buttons clicked after the write (writes still blocked)
//   after?:  ["/route", ...],               // read-only pages visited after acting
//   allow: [{ method, path (regex) }], maxWrites: 1,
//   getFilters: { "<path regex>": { pick?: [topKeys], list?: "key or ''", top?: n, fields?: [..] } }  // GET bodies kept ONLY via a filter
//   settleMs
// }
// Every other non-GET request to api-dev is blocked and logged. Tokens/passwords are redacted from captured bodies.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const [specPath, outPath, delayArg] = args.filter((a) => a !== '--dry-run');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const ORIGIN = 'https://app-dev.meroims.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idify = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{id}');
const redact = (s) => (s || '')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
  .replace(/("(accessToken|refreshToken|token|password)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"');
const filters = Object.entries(spec.getFilters || {}).map(([re, f]) => ({ re: new RegExp(re), f }));
const applyFilter = (f, raw) => {
  let b; try { b = JSON.parse(raw); } catch { return '[non-JSON body dropped]'; }
  if (f.pick && b && typeof b === 'object' && !Array.isArray(b)) b = Object.fromEntries(f.pick.filter((k) => k in b).map((k) => [k, b[k]]));
  if (f.list !== undefined) {
    let arr = f.list === '' ? b : b?.[f.list];
    if (Array.isArray(arr)) {
      if (f.top) arr = arr.slice(0, f.top);
      if (f.fields) arr = arr.map((x) => Object.fromEntries(f.fields.filter((k) => k in x).map((k) => [k, x[k]])));
      b = f.list === '' ? arr : { ...(typeof b === 'object' && !Array.isArray(b) ? Object.fromEntries(Object.entries(b).filter(([k]) => k === 'meta')) : {}), [f.list]: arr };
    }
  }
  return b;
};

const target = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find((t) => t.type === 'page' && t.url.startsWith(ORIGIN));
if (!target) throw new Error('No MeroIMS tab');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else if (msg.method) listeners.forEach((f) => f(msg)); };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

const allowRe = (spec.allow || []).map((a) => ({ method: a.method, re: new RegExp(a.path) }));
let phase = 'before'; let writesAllowed = 0;
const blocked = []; const writes = []; const gets = []; const calls = []; const reqInfo = new Map();

listeners.push(async (msg) => {
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params; const u = new URL(request.url);
    const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || /^\/api\/(auth|pos\/auth)\/refresh$/.test(u.pathname);
    const isAllowed = !dry && phase === 'act' && writesAllowed < (spec.maxWrites ?? 1) && allowRe.some((a) => a.method === request.method && a.re.test(u.pathname));
    if (isRead) return send('Fetch.continueRequest', { requestId });
    if (isAllowed) { writesAllowed++; return send('Fetch.continueRequest', { requestId }); }
    blocked.push({ phase, method: request.method, path: idify(u.pathname) });
    return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const r = msg.params.request; const u = new URL(r.url);
    if (!u.pathname.startsWith('/api/') || r.method === 'OPTIONS') return;
    reqInfo.set(msg.params.requestId, { phase, method: r.method, path: u.pathname, query: [...new URLSearchParams(u.search).keys()], postData: r.postData ? redact(r.postData) : null, t: new Date().toISOString() });
  }
  if (msg.method === 'Network.responseReceived') {
    const i = reqInfo.get(msg.params.requestId); if (i) i.status = msg.params.response.status;
  }
  if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
    const i = reqInfo.get(msg.params.requestId); if (!i || i.done) return; i.done = true;
    if (msg.method === 'Network.loadingFailed') i.failed = msg.params.errorText;
    calls.push({ phase: i.phase, method: i.method, path: idify(i.path), query: i.query, status: i.status ?? null, failed: i.failed ?? null });
    const isWrite = !['GET', 'HEAD'].includes(i.method) && !/refresh$/.test(i.path);
    const flt = i.method === 'GET' ? filters.find((x) => x.re.test(i.path)) : null;
    if ((isWrite || flt) && !i.failed) {
      const b = await send('Network.getResponseBody', { requestId: msg.params.requestId });
      const body = b.result ? redact(b.result.body) : null;
      if (isWrite) { let rb; try { rb = JSON.parse(body); } catch { rb = body; } let rq; try { rq = JSON.parse(i.postData); } catch { rq = i.postData; } writes.push({ phase: i.phase, method: i.method, path: idify(i.path), status: i.status, request: rq, response: rb }); }
      else gets.push({ phase: i.phase, path: idify(i.path), query: i.query, status: i.status, body: applyFilter(flt.f, body) });
    }
  }
});
await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api-dev.meroims.com/*', requestStage: 'Request' }] });
await send('Network.enable'); await send('Runtime.enable');
if (delayArg) await sleep(Number(delayArg));

const softGo = async (path) => {
  await evalJs(`window.next.router.push(${JSON.stringify(path)})`);
  for (let i = 0; i < 40 && (await evalJs('location.pathname')) !== path; i++) await sleep(200);
  await sleep(spec.settleMs ?? 4000);
};
const clickByText = (text) => evalJs(`(() => { const n=(s)=>(s||'').replace(/\\s+/g,' ').trim(); const b=[...document.querySelectorAll('button')].filter((x)=>n(x.innerText)===${JSON.stringify(text)}); if(b.length!==1) return 'matches:'+b.length; b[0].click(); return 'clicked'; })()`);
const uiSnapshot = () => evalJs(`(() => { const n=(s)=>(s||'').replace(/\\s+/g,' ').trim().slice(0,120); const root=document.querySelector('[role=dialog]')||document.querySelector('main')||document.body; return { path: location.pathname, dialogOpen: !!document.querySelector('[role=dialog]'), headings: [...root.querySelectorAll('h1,h2,h3')].map((e)=>n(e.innerText)).slice(0,10), buttons: [...new Set([...root.querySelectorAll('button')].map((e)=>n(e.innerText)).filter((x)=>x && !/Rs\\.|\\d/.test(x)))].slice(0,30), alerts: [...document.querySelectorAll('[role=alert],[role=status],[data-sonner-toast]')].map((e)=>n(e.innerText)).filter(Boolean).slice(0,5) }; })()`);

const result = { scenario: spec.scenario, dryRun: dry, runAt: new Date().toISOString() };
await softGo('/');
const menuText = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /user menu/i.test(x.getAttribute('aria-label') || '')); return b ? b.innerText : ''; })()`) || '';
const terms = [...new Set(menuText.split(/\n+/).map((x) => x.trim()).filter((x) => x.length >= 4))].sort((a, b) => b.length - a.length);
for (const p of spec.before || []) await softGo(p);
if (spec.localStorage) {
  result.localStorage = { key: spec.localStorage.key, previous: await evalJs(`localStorage.getItem(${JSON.stringify(spec.localStorage.key)})`), set: spec.localStorage.value };
  // Approved client-side preference: applied in dry runs too (no server write involved).
  await evalJs(`localStorage.setItem(${JSON.stringify(spec.localStorage.key)}, ${JSON.stringify(spec.localStorage.value)})`);
}
await softGo(spec.navigate);
result.uiBefore = await uiSnapshot();

const locate = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const btnText = ${JSON.stringify(spec.button.text)};
  const m = ${JSON.stringify(spec.input ? spec.input.match : null)};
  let input = null, scope = document.body;
  if (m) {
    const inputs = [...document.querySelectorAll('input,textarea')].filter((e) => norm(e.placeholder + ' ' + (e.labels && e.labels[0] ? e.labels[0].innerText : '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase().includes(m.toLowerCase()));
    if (inputs.length !== 1) return { ok: false, reason: 'input matches: ' + inputs.length };
    input = inputs[0]; scope = input.parentElement;
  }
  let btns = [];
  while (scope) {
    btns = [...scope.querySelectorAll('button')].filter((b) => norm(b.innerText) === btnText);
    if (btns.length || scope === document.body) break; scope = scope.parentElement;
  }
  if (btns.length !== 1) return { ok: false, reason: 'button matches: ' + btns.length };
  window.__durbyTest = { input, button: btns[0] };
  return { ok: true, inputLabel: input ? norm((input.labels && input.labels[0] && input.labels[0].innerText) || input.placeholder) : null, inputValueBefore: input ? input.value : null, buttonText: norm(btns[0].innerText), buttonDisabled: btns[0].disabled };
})()`;
result.located = await evalJs(locate);

if (result.located?.ok && !dry) {
  phase = 'act';
  if (spec.input) {
    await evalJs(`(() => { const i = window.__durbyTest.input; i.focus(); i.select && i.select(); })()`);
    await send('Input.insertText', { text: spec.input.value });
    await sleep(400);
  }
  result.buttonDisabledBeforeClick = await evalJs('window.__durbyTest.button.disabled');
  await evalJs('window.__durbyTest.button.click()');
  await sleep(spec.settleMs ?? 4000);
  result.uiAfterAct = await uiSnapshot();
  phase = 'after';
  result.readClicks = [];
  for (const t of spec.readClicks || []) {
    const r = await clickByText(t); await sleep(spec.settleMs ?? 4000);
    result.readClicks.push({ button: t, result: r, ui: await uiSnapshot() });
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(800);
  }
  for (const p of spec.after || []) await softGo(p);
}
await send('Fetch.disable');
Object.assign(result, { writesAllowed, writes, blocked, gets, calls });
if (!terms.length) { console.error('ABORT: could not learn tenant/user names for redaction; not writing output'); process.exit(3); }
let out = JSON.stringify(result, null, 2);
for (const t of terms) out = out.split(t).join('[tenant/user redacted]');
writeFileSync(outPath, out);
ws.close();
console.log(JSON.stringify({ dryRun: dry, located: result.located, writesAllowed, writes: writes.map((w) => `${w.method} ${w.path} ${w.status}`), blocked: blocked.length }));
