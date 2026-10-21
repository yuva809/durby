// Sequence-based controlled write test runner (Option B). One approved scenario per run.
// Usage: node cdp-test-seq.mjs <spec.json> <out.json> [--dry-run] [startDelayMs]
// spec.sequence ops (run in order):
//   {op:"go", path}                         client-side navigation (Next router)
//   {op:"fill", match, value, enter?, scope?:"dialog"}   type into the unique input whose label/placeholder contains `match`
//   {op:"click", text|prefix, scope?:"dialog"}           click the unique button with exact text / text prefix (read-only UI step)
//   {op:"clickFirstRow"}                    open the first table row (detail view)
//   {op:"act", text|prefix, scope?}         THE approved write click. Dry run stops here (no click).
//   {op:"snapshot", label} {op:"escape"} {op:"wait", ms} {op:"setLocalStorage", key, value}
// spec.dryRunCleanup: ops executed after a dry run stops (e.g. clear cart).
// spec.allow: [{method, path (regex), expect: "JS predicate over parsed request body"}], maxWrites
// spec.getFilters: { "<path regex>": { pick?, list?, top?, fields?, where?: {field: value} } }
// Guarantees: every non-GET to api-dev is paused; only allowed+expected writes during the act step continue.
// Captured bodies: tokens/passwords redacted; keys like pan/vat/phone/address/email/accountNumber removed;
// tenant/user names learned from the user menu are replaced in the output file.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const [specPath, outPath, delayArg] = args.filter((a) => a !== '--dry-run');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const ORIGIN = 'https://app-dev.meroims.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idify = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{id}');
const SENSITIVE_KEY = /^(pan|panNo|storePan|vatNo|vatNumber|customerVatNumber|phone|storePhone|customerPhone|address|storeAddress|deliveryAddress|email|customerEmail|partyEmail|accountNumber|accountHolderName)$/i;
const scrub = (v) => Array.isArray(v) ? v.map(scrub) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).filter(([k]) => !SENSITIVE_KEY.test(k)).map(([k, x]) => [k, scrub(x)])) : v;
const redactStr = (s) => (s || '').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]').replace(/("(accessToken|refreshToken|token|password)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"');
const parse = (s) => { try { return scrub(JSON.parse(redactStr(s))); } catch { return s ? '[non-JSON]' : null; } };
const filters = Object.entries(spec.getFilters || {}).map(([re, f]) => ({ re: new RegExp(re), f }));
const applyFilter = (f, b) => {
  if (!b || typeof b !== 'object') return b;
  if (f.pick && !Array.isArray(b)) b = Object.fromEntries(f.pick.filter((k) => k in b).map((k) => [k, b[k]]));
  if (f.list !== undefined) {
    let arr = f.list === '' ? b : b[f.list];
    if (Array.isArray(arr)) {
      if (f.where) arr = arr.filter((x) => Object.entries(f.where).every(([k, v]) => x[k] === v));
      if (f.top) arr = arr.slice(0, f.top);
      if (f.fields) arr = arr.map((x) => Object.fromEntries(f.fields.filter((k) => k in x).map((k) => [k, x[k]])));
      b = f.list === '' ? arr : { [f.list]: arr, ...(b.meta ? { meta: b.meta } : {}) };
    }
  }
  if (f.fieldsObj && !Array.isArray(b)) b = Object.fromEntries(f.fieldsObj.filter((k) => k in b).map((k) => [k, b[k]]));
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

const getPath = (obj, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const allow = (spec.allow || []).map((a) => ({ method: a.method, pathSrc: a.path, once: !!a.once, expect: a.expect ? new Function('b', 'w', `return (${a.expect});`) : () => true, expectSrc: a.expect || null }));
const deepFind = (v, key) => { if (Array.isArray(v)) { for (const x of v) { const r = deepFind(x, key); if (r !== undefined) return r; } } else if (v && typeof v === 'object') { if (key in v && (typeof v[key] !== 'object' || v[key] === null)) return v[key]; for (const x of Object.values(v)) { const r = deepFind(x, key); if (r !== undefined) return r; } } return undefined; };
const resolveTpl = (str) => { let unresolved = false; const out = String(str).replace(/\$\{w(\d+)\.\.(\w+)\}/g, (_, i, k) => { const v = writes[Number(i)] ? deepFind(writes[Number(i)].response, k) : undefined; if (v == null) { unresolved = true; return ''; } return String(v); }); return unresolved ? null : out; };
const ruleRe = (a) => { let unresolved = false; const src = a.pathSrc.replace(/\$\{w(\d+)\.\.(\w+)\}/g, (m) => { const r = resolveTpl(m); if (r == null) { unresolved = true; return ''; } return escRe(r); }); return unresolved ? null : new RegExp(src); };
let phase = 'before'; let writesAllowed = 0;
const blocked = []; const writes = []; const gets = []; const calls = []; const reqInfo = new Map(); const log = [];

listeners.push(async (msg) => {
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params; const u = new URL(request.url);
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || /^\/api\/(auth|pos\/auth)\/refresh$/.test(u.pathname)) return send('Fetch.continueRequest', { requestId });
    const candidates = allow.filter((a) => { const re = ruleRe(a); return a.method === request.method && re && re.test(u.pathname) && !a.used; });
    let rule = null; for (const a of candidates) { try { if (a.expect(body, writes)) { rule = a; break; } } catch {} }
    if (!rule && candidates.length) rule = candidates[0];
    let body = null; try { body = JSON.parse(request.postData || 'null'); } catch { body = null; }
    let reason = null;
    if (dry) reason = 'dry run';
    else if (phase !== 'act') reason = `write outside act step (phase=${phase})`;
    else if (!rule) reason = 'not in allow-list';
    else if (writesAllowed >= (spec.maxWrites ?? 1)) reason = 'maxWrites reached';
    else { try { if (!rule.expect(body, writes)) reason = `request body failed expectation: ${rule.expectSrc}`; } catch (e) { reason = 'expectation threw: ' + e.message; } }
    if (!reason) { writesAllowed++; if (rule.once) rule.used = true; return send('Fetch.continueRequest', { requestId }); }
    blocked.push({ phase, method: request.method, path: idify(u.pathname), reason, body: scrub(body) });
    return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const r = msg.params.request; const u = new URL(r.url);
    if (!u.pathname.startsWith('/api/') || r.method === 'OPTIONS') return;
    reqInfo.set(msg.params.requestId, { phase, method: r.method, path: u.pathname, query: [...new URLSearchParams(u.search).keys()], postData: r.postData || null });
  }
  if (msg.method === 'Network.responseReceived') { const i = reqInfo.get(msg.params.requestId); if (i) i.status = msg.params.response.status; }
  if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
    const i = reqInfo.get(msg.params.requestId); if (!i || i.done) return; i.done = true;
    if (msg.method === 'Network.loadingFailed') i.failed = msg.params.errorText;
    calls.push({ phase: i.phase, method: i.method, path: idify(i.path), query: i.query, status: i.status ?? null, failed: i.failed ?? null });
    const isWrite = !['GET', 'HEAD'].includes(i.method) && !/refresh$/.test(i.path);
    const flt = i.method === 'GET' ? filters.find((x) => x.re.test(i.path)) : null;
    if ((isWrite || flt) && !i.failed) {
      const b = await send('Network.getResponseBody', { requestId: msg.params.requestId });
      const body = b.result ? parse(b.result.body) : null;
      if (isWrite) writes.push({ phase: i.phase, method: i.method, path: idify(i.path), status: i.status, request: parse(i.postData), response: body });
      else gets.push({ phase: i.phase, path: idify(i.path), query: i.query, status: i.status, body: applyFilter(flt.f, body) });
    }
  }
});
await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api-dev.meroims.com/*', requestStage: 'Request' }] });
await send('Network.enable'); await send('Runtime.enable');
if (delayArg) await sleep(Number(delayArg));
const settle = spec.settleMs ?? 3500;

const J = JSON.stringify;
const norm = `const n=(s)=>(s||'').replace(/\\s+/g,' ').trim();`;
const scopeExpr = (scope) => scope === 'dialog' ? `(document.querySelector('[role=dialog]') || document.body)` : `document.body`;
const ops = {
  async go(o) { await evalJs(`window.next.router.push(${J(o.path)})`); for (let i = 0; i < 40 && (await evalJs('location.pathname')) !== o.path; i++) await sleep(200); await sleep(settle); return 'ok'; },
  async fill(o) {
    for (let i = 0; i < 16; i++) { const c = await evalJs(`(() => { ${norm} const root=${scopeExpr(o.scope)}; const m=${J(o.match.toLowerCase())}; return [...root.querySelectorAll('input,textarea')].filter((e)=>n(e.placeholder+' '+(e.labels&&e.labels[0]?e.labels[0].innerText:'')+' '+(e.getAttribute('aria-label')||'')).toLowerCase().includes(m) && !e.disabled).length; })()`); if (c >= 1) break; await sleep(500); }
    const r = await evalJs(`(() => { ${norm} const root=${scopeExpr(o.scope)}; const m=${J(o.match.toLowerCase())}; const c=[...root.querySelectorAll('input,textarea')].filter((e)=>n(e.placeholder+' '+(e.labels&&e.labels[0]?e.labels[0].innerText:'')+' '+(e.getAttribute('aria-label')||'')).toLowerCase().includes(m) && !e.disabled); const nth=${o.nth===undefined?'null':Number(o.nth)}; let el; if(nth===null){ if(c.length!==1) return 'input matches: '+c.length; el=c[0]; } else { el=c[nth<0?c.length+nth:nth]; if(!el) return 'input nth not found: '+nth+' of '+c.length; } el.focus(); el.select&&el.select(); return 'ok'; })()`);
    if (r !== 'ok') return r;
    await send('Input.insertText', { text: o.value });
    if (o.enter) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); }
    await sleep(o.wait ?? 1500); return 'ok';
  },
  async click(o, really = true) {
    const r = await evalJs(`(() => { ${norm} const root=${scopeExpr(o.scope)}; const nm=(x)=>n(x.innerText)||n(x.getAttribute('aria-label'))||n(x.title); const b=[...root.querySelectorAll('button')].filter((x)=>${o.text ? `nm(x)===${J(o.text)}` : `nm(x).startsWith(${J(o.prefix)})`}); if(b.length!==1) return 'button matches: '+b.length+' ['+[...root.querySelectorAll('button')].map((x)=>n(x.innerText)).filter(Boolean).slice(0,25).join(' | ')+']'; if(b[0].disabled) return 'button disabled: '+n(b[0].innerText); ${really ? 'b[0].click();' : ''} return 'ok:'+n(b[0].innerText); })()`);
    if (really) await sleep(o.wait ?? settle); return r;
  },
  async clickNthRow(o) { const r = await evalJs(`(() => { const trs=[...document.querySelectorAll('main table tbody tr')]; const tr=trs[${Number(o.n)||0}]; if(!tr) return 'no-row'; const td=[...tr.querySelectorAll('td')].find((c)=>!c.querySelector('button,input,a[href]'))||tr.querySelector('td'); td.click(); return 'ok'; })()`); await sleep(settle); return r; },
  async clickFirstRow() { const r = await evalJs(`(() => { const tr=document.querySelector('main table tbody tr'); if(!tr) return 'no-rows'; const td=[...tr.querySelectorAll('td')].find((c)=>!c.querySelector('button,input,a[href]'))||tr.querySelector('td'); td.click(); return 'ok'; })()`); await sleep(settle); return r; },
  async escape() { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(800); return 'ok'; },
  async wait(o) { await sleep(o.ms); return 'ok'; },
  async clickOption(o) {
    for (let i = 0; i < 12; i++) { const c = await evalJs(`[...document.querySelectorAll('[role=option],[role=listbox] li,[cmdk-item],button')].filter((e)=>(e.innerText||'').replace(/\\s+/g,' ').trim().startsWith(${J(o.prefix)})).length`); if (c >= 1) break; await sleep(400); }
    const r = await evalJs(`(() => { ${norm} const opts=[...document.querySelectorAll('[role=option],[role=listbox] li,[cmdk-item]')].filter((e)=>n(e.innerText).startsWith(${J(o.prefix)})); const pool=opts.length?opts:[...document.querySelectorAll('button')].filter((e)=>n(e.innerText).startsWith(${J(o.prefix)})); if(pool.length!==1) return 'option matches: '+pool.length; const el=pool[0]; el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); el.click(); return 'ok:'+n(el.innerText).slice(0,80); })()`);
    await sleep(o.wait ?? 1200); return r;
  },
  async select(o) {
    const r = await evalJs(`(() => { ${norm} const root=${scopeExpr(o.scope)}; const m=${J(o.match.toLowerCase())}; const c=[...root.querySelectorAll('select')].filter((e)=>n((e.labels&&e.labels[0]?e.labels[0].innerText:'')+' '+(e.getAttribute('aria-label')||'')).toLowerCase().includes(m)); if(c.length!==1) return 'select matches: '+c.length; const el=c[0]; if(![...el.options].some((op)=>op.value===${J(o.value)})) return 'option not found: '+${J(o.value)}+' ['+[...el.options].map((op)=>op.value).join(',')+']'; const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(el, ${J(o.value)}); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value===${J(o.value)}?'ok':'value did not stick'; })()`);
    await sleep(o.wait ?? 600); return r;
  },
  async assert(o) { const found = await evalJs(`(document.querySelector('[role=dialog]')||document.body).innerText.includes(${J(o.text)})`); return found ? 'ok' : 'assert failed: text not visible: ' + o.text; },
  async clickInRow(o) { const r = await evalJs(`(() => { const n=(s)=>(s||'').replace(/\\s+/g,' ').trim(); const rows=[...document.querySelectorAll('main table tbody tr')].filter((tr)=>tr.innerText.includes(${J(o.row)})); if(rows.length!==1) return 'row matches: '+rows.length; const b=[...rows[0].querySelectorAll('button')].filter((x)=>n(x.innerText)===${J(o.text)}); if(b.length!==1) return 'button-in-row matches: '+b.length; b[0].click(); return 'ok'; })()`); await sleep(settle); return r; },
  async clickInDialogRow(o) {
    const row = resolveTpl(o.row); if (row == null) return 'template unresolved: ' + o.row;
    const r = await evalJs(`(() => { const n=(s)=>(s||'').replace(/\s+/g,' ').trim(); const d=document.querySelector('[role=dialog]'); if(!d) return 'no dialog'; const btns=[...d.querySelectorAll('button')].filter((b)=>n(b.innerText)===${J(o.text)}); const mine=btns.filter((b)=>{ let el=b.parentElement; for(let i=0;i<6&&el&&el!==d;i++,el=el.parentElement){ if((el.innerText||'').includes(${J(row)})) return btns.filter((x)=>x!==b&&el.contains(x)).length===0; } return false; }); if(mine.length!==1) return 'row-button matches: '+mine.length+' (buttons in dialog: '+btns.length+')'; mine[0].click(); return 'ok:row '+${J(row)}; })()`);
    await sleep(o.wait ?? settle); return r;
  },
  async clickRowWith(o) { const r = await evalJs(`(() => { const rows=[...document.querySelectorAll('main table tbody tr')].filter((tr)=>tr.innerText.includes(${J(o.text)})); if(rows.length!==1) return 'row matches: '+rows.length; const td=[...rows[0].querySelectorAll('td')].find((c)=>!c.querySelector('button,input,a[href]'))||rows[0].querySelector('td'); td.click(); return 'ok'; })()`); await sleep(settle); return r; },
  async setLocalStorage(o) { const prev = await evalJs(`localStorage.getItem(${J(o.key)})`); await evalJs(`localStorage.setItem(${J(o.key)}, ${J(o.value)})`); return 'ok (previous: ' + prev + ')'; },
  async snapshot(o) {
    return evalJs(`(() => { ${norm} const d=document.querySelector('[role=dialog]'); const root=d||(${J(o.scope||'')}==='body'?document.body:(document.querySelector('main')||document.body)); return { label: ${J(o.label || '')}, path: location.pathname, dialogOpen: !!d, headings: [...root.querySelectorAll('h1,h2,h3')].map((e)=>n(e.innerText)).slice(0,10), buttons: [...new Set([...root.querySelectorAll('button')].map((e)=>n(e.innerText||e.getAttribute('aria-label')||e.title)).filter(Boolean))].slice(0, ${J(o.scope||'')}==='body' ? 300 : 40), inputs: [...root.querySelectorAll('input,textarea,select')].map((e)=>({label:n((e.labels&&e.labels[0]&&e.labels[0].innerText)||e.placeholder||e.getAttribute('aria-label')||''), type:e.type||e.tagName.toLowerCase(), value: e.type==='password'?'[hidden]':(e.value||'').slice(0,40), checked: (e.type==='checkbox'||e.type==='radio')?e.checked:undefined})).slice(0,30), alerts: [...document.querySelectorAll('[role=alert],[role=status],[data-sonner-toast]')].map((e)=>n(e.innerText)).filter(Boolean).slice(0,6), options: [...document.querySelectorAll('[role=option],[role=listbox] li,[cmdk-item]')].map((e)=>n(e.innerText)).filter(Boolean).slice(0,15) }; })()`);
  },
};

const result = { scenario: spec.scenario, dryRun: dry, runAt: new Date().toISOString(), steps: [] };
await ops.go({ path: '/' });
const menuText = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>/user menu/i.test(x.getAttribute('aria-label')||'')); return b?b.innerText:''; })()`) || '';
const terms = [...new Set(menuText.split(/\n+/).map((x) => x.trim()).filter((x) => x.length >= 4))].sort((a, b) => b.length - a.length);

let aborted = false;
for (const o of spec.sequence) {
  if (aborted) break;
  if (o.op === 'act') {
    const check = await ops.click(o, false);
    result.steps.push({ op: 'act-check', target: o.text || o.prefix, result: check });
    if (!String(check).startsWith('ok')) { aborted = true; result.abortReason = 'act target not uniquely found/enabled'; break; }
    if (dry) { result.steps.push({ op: 'snapshot', result: await ops.snapshot({ label: 'dry-run stop before act' }) }); break; }
    phase = 'act';
    const before = writes.length;
    const r = await ops.click(o, true);
    for (let i = 0; i < 30 && writes.length === before; i++) await sleep(200);
    result.steps.push({ op: 'act', target: o.text || o.prefix, result: r, writeCaptured: writes.length > before });
    phase = 'after';
    continue;
  }
  const r = await ops[o.op](o);
  result.steps.push({ op: o.op, arg: o.path || o.match || o.text || o.prefix || o.label || o.key || null, result: r });
  if (typeof r === 'string' && !r.startsWith('ok') && o.op !== 'clickFirstRow' && !o.optional) { aborted = true; result.abortReason = `${o.op} failed: ${r}`; }
}
if (dry) for (const o of spec.dryRunCleanup || []) result.steps.push({ op: 'cleanup:' + o.op, result: await ops[o.op](o, true) });

await send('Fetch.disable');
Object.assign(result, { aborted, writesAllowed, writes, blocked, gets, calls });
if (!terms.length) { console.error('ABORT: could not learn tenant/user names for redaction; not writing output'); process.exit(3); }
let out = JSON.stringify(result, null, 2);
for (const t of terms) out = out.split(t).join('[tenant/user redacted]');
// Anonymise register names (often people's names) except those named by the scenario.
const keep = new Set(spec.keepRegisterNames || []);
const regNames = new Set();
const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (Array.isArray(v.registers)) v.registers.forEach((r) => r && r.name && regNames.add(r.name)); if (v.register && v.register.name) regNames.add(v.register.name); Object.values(v).forEach(walk); } };
walk(result.gets.map((g) => g.body)); walk(result.writes);
for (const g of result.gets) if (/admin\/registers$/.test(g.path) && Array.isArray(g.body)) g.body.forEach((r) => r.name && regNames.add(r.name));
const letter = new Map([...regNames].filter((n) => !keep.has(n)).sort((a, b) => a.localeCompare(b)).map((n, i) => [n, 'Register-' + String.fromCharCode(65 + i)]));
[...letter.keys()].sort((a, b) => b.length - a.length).forEach((n) => { out = out.split(JSON.stringify(n)).join(JSON.stringify(letter.get(n))); if (n.length >= 3) out = out.split(n).join(letter.get(n)); });
writeFileSync(outPath, out);
ws.close();
let summary = JSON.stringify({ dryRun: dry, aborted, abortReason: result.abortReason || null, writesAllowed, writes: writes.map((w) => `${w.method} ${w.path} ${w.status}`), blocked: blocked.map((b) => `${b.method} ${b.path}: ${b.reason}`) });
for (const t of terms) summary = summary.split(t).join('[tenant/user redacted]');
console.log(summary);
