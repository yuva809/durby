// Runs the built api for the Playwright suite and restarts it on request, so a spec can check what
// the web does when the api goes away and comes back (docs/platform/realtime.md → Tests).
//
//   POST http://127.0.0.1:${API_SUPERVISOR_PORT:-4999}/restart → stops the api (SIGTERM, as a deploy
//   does), starts it again and answers 200 once /api/v1/health/live answers.
//
// Test tooling only: started by playwright.config.ts (`node --experimental-strip-types`) in place of
// `pnpm --filter @durby/api start`.
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api');
const controlPort = Number(process.env.API_SUPERVISOR_PORT ?? 4999);
const health = 'http://localhost:4000/api/v1/health/live';

let child: ChildProcess | undefined;
let stopping = false;

function start(): void {
  const started = spawn(process.execPath, ['dist/main.js'], {
    cwd: apiDir,
    stdio: 'inherit',
    env: process.env,
  });
  started.on('exit', (code, signal) => {
    if (!stopping) console.error(`api-supervisor: api exited (${code ?? signal})`);
  });
  child = started;
}

function stop(): Promise<void> {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const kill = setTimeout(() => current.kill('SIGKILL'), 10_000);
    current.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    current.kill('SIGTERM');
  });
}

async function healthy(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(health)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/restart') {
    res.writeHead(404).end();
    return;
  }
  void (async () => {
    stopping = true;
    await stop();
    stopping = false;
    start();
    const ok = await healthy(60_000);
    res.writeHead(ok ? 200 : 503).end(ok ? 'restarted' : 'not healthy');
  })();
}).listen(controlPort, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    void stop().then(() => process.exit(0));
  });
}

start();
