import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

import { Interpreter, statusReply, type Mode, type Result } from './escpos.ts';
import { encodePng } from './png.ts';

export interface VirtualPrinterOptions {
  /** 127.0.0.1 by default: the Android emulator reaches it as 10.0.2.2. */
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  mode?: Mode;
  /** Printable width in dots (58 mm: 384). */
  paperDots?: number;
  /** Where each job's bytes, report and pages go. Nothing is written when unset. */
  outDir?: string;
  /** disconnect mode: drop the connection once this many bytes arrived. */
  disconnectAfterBytes?: number;
  onJob?: (job: Job) => void;
}

/** One connection = one job, as the app sends it. */
export interface Job {
  id: number;
  bytes: Buffer;
  result: Result;
  files: string[];
}

export interface VirtualPrinter {
  port: number;
  jobs: Job[];
  /** Resolves with the next job to finish. */
  nextJob(): Promise<Job>;
  close(): Promise<void>;
}

/** Refuse a job beyond this (the app caps one at 2 MB). */
const MAX_JOB_BYTES = 16 * 1024 * 1024;

export async function startVirtualPrinter(
  options: VirtualPrinterOptions = {},
): Promise<VirtualPrinter> {
  const mode = options.mode ?? 'ok';
  const paperDots = options.paperDots ?? 384;
  const disconnectAfter = options.disconnectAfterBytes ?? 512;
  const jobs: Job[] = [];
  const waiting: ((job: Job) => void)[] = [];
  const sockets = new Set<Socket>();
  let nextId = 1;

  if (options.outDir) mkdirSync(options.outDir, { recursive: true });

  const server = createServer((socket) => {
    sockets.add(socket);
    const id = nextId++;
    const received: Buffer[] = [];
    let size = 0;
    const extraErrors: string[] = [];
    const interpreter = new Interpreter({
      paperDots,
      onStatus: (n) => {
        const reply = statusReply(mode, n);
        if (reply !== null && !socket.destroyed) socket.write(Buffer.from([reply]));
      },
    });

    // stall: accept, then never read, so the sender's buffers fill up and its write stalls.
    if (mode === 'stall') socket.pause();

    socket.on('data', (data: Buffer) => {
      received.push(data);
      size += data.length;
      interpreter.push(data);
      if (mode === 'disconnect' && size >= disconnectAfter) {
        extraErrors.push(`disconnected after ${disconnectAfter} bytes (mode disconnect)`);
        socket.resetAndDestroy();
      } else if (size > MAX_JOB_BYTES) {
        extraErrors.push(`job_too_large: over ${MAX_JOB_BYTES} bytes`);
        socket.destroy();
      }
    });
    socket.on('error', () => {}); // a client reset is part of the tests; the job is still recorded
    socket.on('end', () => socket.end());
    socket.on('close', () => {
      sockets.delete(socket);
      const result = interpreter.end();
      result.errors.push(...extraErrors);
      const job: Job = { id, bytes: Buffer.concat(received), result, files: [] };
      if (options.outDir) job.files = writeJob(options.outDir, job, mode);
      jobs.push(job);
      options.onJob?.(job);
      waiting.shift()?.(job);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 9100, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    jobs,
    nextJob: () => new Promise((resolve) => waiting.push(resolve)),
    close: () =>
      new Promise((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
      }),
  };
}

function writeJob(dir: string, job: Job, mode: Mode): string[] {
  const name = `job-${String(job.id).padStart(3, '0')}`;
  const files = [`${name}.bin`, `${name}.json`];
  writeFileSync(join(dir, `${name}.bin`), job.bytes);
  const pages = job.result.pages.map((page, i) => {
    const file = page.heightDots > 0 ? `${name}-page-${i + 1}.png` : null;
    if (file) {
      writeFileSync(join(dir, file), encodePng(page.widthDots, page.heightDots, page.bits));
      files.push(file);
    }
    return { widthDots: page.widthDots, heightDots: page.heightDots, cut: page.cut, file };
  });
  const report = {
    id: job.id,
    mode,
    bytes: job.bytes.length,
    errors: job.result.errors,
    pages,
    events: job.result.events,
  };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(report, null, 2) + '\n');
  return files;
}
