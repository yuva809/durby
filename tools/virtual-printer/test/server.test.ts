import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startVirtualPrinter, type VirtualPrinter } from '../src/server.ts';
import * as E from './encode.ts';

let printer: VirtualPrinter | undefined;
afterEach(async () => {
  await printer?.close();
  printer = undefined;
});

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Sends one job on its own connection and resolves once the printer has recorded it. */
async function send(p: VirtualPrinter, bytes: number[]) {
  const job = p.nextJob();
  const socket = await open(p.port);
  socket.end(Buffer.from(bytes));
  return job;
}

/** Writes, then collects whatever the printer answers within [ms]. */
async function ask(p: VirtualPrinter, bytes: number[], ms = 300): Promise<number[]> {
  const socket = await open(p.port);
  const got: number[] = [];
  socket.on('data', (d: Buffer) => got.push(...d));
  socket.write(Buffer.from(bytes));
  await new Promise((r) => setTimeout(r, ms));
  socket.destroy();
  return got;
}

describe('virtual printer', () => {
  it('records a job per connection and writes the bytes, a report and a PNG per page', async () => {
    const out = mkdtempSync(join(tmpdir(), 'virtual-printer-'));
    printer = await startVirtualPrinter({ port: 0, outDir: out });

    const job = await send(printer, [
      ...E.INIT,
      ...E.raster(384, 30, E.pattern(384, 30)),
      ...E.cut(),
    ]);

    expect(job.id).toBe(1);
    expect(job.result.errors).toEqual([]);
    expect(job.result.pages).toHaveLength(1);
    expect(readdirSync(out).sort()).toEqual(['job-001-page-1.png', 'job-001.bin', 'job-001.json']);
    const report = JSON.parse(readFileSync(join(out, 'job-001.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(report).toMatchObject({ id: 1, mode: 'ok', bytes: job.bytes.length, errors: [] });
    expect(report.pages).toEqual([
      { widthDots: 384, heightDots: 30, cut: true, file: 'job-001-page-1.png' },
    ]);
  });

  it('answers status queries for the mode it runs in', async () => {
    printer = await startVirtualPrinter({ port: 0, mode: 'paper-out' });
    expect(
      await ask(printer, [...E.statusQuery(1), ...E.statusQuery(2), ...E.statusQuery(4)]),
    ).toEqual([0x1a, 0x32, 0x72]);
  });

  it('stays silent in silent mode', async () => {
    printer = await startVirtualPrinter({ port: 0, mode: 'silent' });
    expect(await ask(printer, E.statusQuery(1))).toEqual([]);
  });

  it('drops the connection mid-job in disconnect mode', async () => {
    printer = await startVirtualPrinter({ port: 0, mode: 'disconnect', disconnectAfterBytes: 512 });
    const job = printer.nextJob();
    const socket = await open(printer.port);
    const failed = new Promise<boolean>((resolve) => {
      socket.once('error', () => resolve(true));
      socket.once('close', () => resolve(true));
    });
    // Keep writing: the first writes may land in buffers before the reset arrives.
    const chunk = Buffer.alloc(64 * 1024);
    const timer = setInterval(() => socket.writable && socket.write(chunk), 10);
    expect(await failed).toBe(true);
    clearInterval(timer);
    expect((await job).result.errors).toContain('disconnected after 512 bytes (mode disconnect)');
  });

  it('stops reading in stall mode, so a large job never drains', async () => {
    printer = await startVirtualPrinter({ port: 0, mode: 'stall' });
    const socket = await open(printer.port);
    const drained = new Promise<boolean>((resolve) => {
      socket.once('drain', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    const accepted = socket.write(Buffer.alloc(16 * 1024 * 1024));
    expect(accepted).toBe(false);
    expect(await drained).toBe(false);
    socket.destroy();
  });
});
