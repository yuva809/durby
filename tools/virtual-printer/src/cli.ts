import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { MODES, type Mode } from './escpos.ts';
import { startVirtualPrinter } from './server.ts';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '9100' },
    mode: { type: 'string', default: 'ok' },
    'paper-dots': { type: 'string', default: '384' },
    out: { type: 'string', default: 'out' },
    'disconnect-after': { type: 'string', default: '512' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: pnpm --filter @durby/virtual-printer start -- [options]

  --host <ip>              listen address (default 127.0.0.1; the emulator reaches it as 10.0.2.2)
  --port <n>               default 9100
  --mode <mode>            ${MODES.join(' | ')} (default ok)
  --paper-dots <n>         printable width in dots, 384 for 58 mm, 576 for 80 mm (default 384)
  --out <dir>              where jobs are written (default out/)
  --disconnect-after <n>   bytes before the drop in disconnect mode (default 512)`);
  process.exit(0);
}

const mode = values.mode as Mode;
if (!MODES.includes(mode)) {
  console.error(`Unknown mode "${values.mode}". Modes: ${MODES.join(', ')}`);
  process.exit(2);
}
const int = (name: string, value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`--${name} must be a whole number, got "${value}"`);
    process.exit(2);
  }
  return n;
};

const outDir = resolve(values.out);
const printer = await startVirtualPrinter({
  host: values.host,
  port: int('port', values.port),
  mode,
  paperDots: int('paper-dots', values['paper-dots']),
  disconnectAfterBytes: int('disconnect-after', values['disconnect-after']),
  outDir,
  onJob: (job) => {
    const pages = job.result.pages
      .map((p) => `${p.widthDots}x${p.heightDots}${p.cut ? ' cut' : ''}`)
      .join(', ');
    const status = job.result.errors.length === 0 ? 'ok' : `${job.result.errors.length} error(s)`;
    console.log(`job ${job.id}: ${job.bytes.length} bytes, pages [${pages || 'none'}], ${status}`);
    job.result.errors.forEach((e) => console.log(`  ! ${e}`));
  },
});

console.log(
  `Virtual printer on ${values.host}:${printer.port}, mode ${mode}, ${values['paper-dots']} dots, jobs in ${outDir}`,
);
