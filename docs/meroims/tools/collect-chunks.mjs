// Read-only: walk routes client-side (writes to api-dev blocked) and list JS chunks loaded.
// Usage: node collect-chunks.mjs <routes.json> <out-urls.txt>
import { readFileSync, writeFileSync } from 'node:fs';
const [routesPath, outPath] = process.argv.slice(2);
const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find((x) => x.type === 'page' && x.url.includes('app-dev.meroims.com'));
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const blocked = [];
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method === 'Fetch.requestPaused') { const { requestId, request } = d.params;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || /\/api\/(pos\/)?auth\/refresh$/.test(request.url)) send('Fetch.continueRequest', { requestId });
    else { blocked.push(`${request.method} ${new URL(request.url).pathname}`); send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); } } };
await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api-dev.meroims.com/*', requestStage: 'Request' }] });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
await ev('performance.setResourceTimingBufferSize(10000)');
const visited = [];
for (const r of routes) {
  await ev(`window.next.router.push(${JSON.stringify(r)})`);
  for (let i = 0; i < 30 && (await ev('location.pathname')) !== r.replace(/\?.*$/, ''); i++) await sleep(200);
  await sleep(3500); visited.push(await ev('location.pathname'));
}
const urls = await ev(`JSON.stringify([...new Set(performance.getEntriesByType('resource').map((e) => e.name.split('?')[0]).filter((n) => /\\/_next\\/static\\/chunks\\/.*\\.js$/.test(n)))])`);
await send('Fetch.disable'); ws.close();
writeFileSync(outPath, JSON.parse(urls).join('\n') + '\n');
console.log(JSON.stringify({ visited, chunks: JSON.parse(urls).length, blockedWrites: blocked }));
