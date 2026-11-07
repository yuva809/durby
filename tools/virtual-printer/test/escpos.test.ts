import { describe, expect, it } from 'vitest';

import { Interpreter, statusReply, type Mode } from '../src/escpos.ts';
import * as E from './encode.ts';

function run(bytes: number[], opts: { paperDots?: number; mode?: Mode; chunk?: number } = {}) {
  const replies: number[] = [];
  const it = new Interpreter({
    paperDots: opts.paperDots ?? 384,
    onStatus: (n) => replies.push(statusReply(opts.mode ?? 'ok', n) ?? -1),
  });
  const buf = Uint8Array.from(bytes);
  const step = opts.chunk ?? buf.length;
  for (let i = 0; i < buf.length; i += step) it.push(buf.subarray(i, i + step));
  return { result: it.end(), replies };
}

const rowsOf = (bits: Uint8Array, widthDots: number, from: number, to: number) =>
  bits.subarray(from * E.bytesPerRow(widthDots), to * E.bytesPerRow(widthDots));

describe('Interpreter', () => {
  it('stitches GS v 0 bands into one page and ends it at the cut', () => {
    const bits = E.pattern(384, 600);
    const { result } = run([...E.INIT, ...E.raster(384, 600, bits), ...E.cut(3)]);

    expect(result.errors).toEqual([]);
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page).toMatchObject({ widthDots: 384, cut: true });
    expect(rowsOf(page.bits, 384, 0, 600)).toEqual(bits);
    expect(result.events.filter((e) => e.type === 'raster')).toEqual([
      { type: 'raster', mode: 'gsV0', widthDots: 384, heightDots: 256 },
      { type: 'raster', mode: 'gsV0', widthDots: 384, heightDots: 256 },
      { type: 'raster', mode: 'gsV0', widthDots: 384, heightDots: 88 },
    ]);
  });

  it('draws ESC * 24-dot stripes exactly like GS v 0', () => {
    const bits = E.pattern(384, 50);
    const { result } = run([...E.INIT, ...E.escStar(384, 50, bits), ...E.cut()]);

    expect(result.errors).toEqual([]);
    const page = result.pages[0]!;
    expect(page.heightDots).toBe(72); // three stripes of 24 rows
    expect(rowsOf(page.bits, 384, 0, 50)).toEqual(bits);
    expect(rowsOf(page.bits, 384, 50, 72).every((b) => b === 0)).toBe(true);
  });

  it('gives the same result whatever the TCP chunks', () => {
    const bytes = [
      ...E.INIT,
      ...E.line('Hello'),
      ...E.raster(384, 40, E.pattern(384, 40), 16),
      ...E.statusQuery(4),
      ...E.cut(),
    ];
    const whole = run(bytes);
    const byteByByte = run(bytes, { chunk: 1 });
    expect(byteByByte.result).toEqual(whole.result);
    expect(byteByByte.replies).toEqual(whole.replies);
  });

  it('reports an image wider than the paper', () => {
    const { result } = run([...E.INIT, ...E.raster(576, 10, E.pattern(576, 10)), ...E.cut()], {
      paperDots: 384,
    });
    expect(result.errors).toContain('wider_than_paper: 576 dots on 384');
  });

  it('records text lines with alignment and bold, and draws them', () => {
    const { result } = run([
      ...E.INIT,
      ...E.align(1),
      ...E.bold(true),
      ...E.line('DURBY TEST'),
      ...E.bold(false),
      ...E.align(0),
      ...E.line('Printer: 192.168.64.20:9100'),
      ...E.feed(2),
      ...E.cut(),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: 'DURBY TEST', align: 'center', bold: true },
      { type: 'text', text: 'Printer: 192.168.64.20:9100', align: 'left', bold: false },
    ]);
    expect(result.pages[0]!.bits.some((b) => b !== 0)).toBe(true);
  });

  it('records a drawer kick with its pin and pulse', () => {
    const { result } = run([...E.INIT, ...E.kickDrawer(true)]);
    expect(result.events).toContainEqual({ type: 'drawer', pin: 5, onMs: 50, offMs: 500 });
  });

  it('keeps a page without a cut and says so', () => {
    const { result } = run([...E.INIT, ...E.raster(384, 8, E.pattern(384, 8)), ...E.feed(4)]);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.cut).toBe(false);
  });

  it('flags unknown commands and a job cut off in the middle', () => {
    const unknown = run([...E.INIT, 0x1b, 0x7e, 0x01]);
    expect(unknown.result.errors[0]).toMatch(/^unknown_command at 2: 1b 7e/);

    const truncated = run([...E.INIT, ...E.raster(384, 8, E.pattern(384, 8)).slice(0, 100)]);
    expect(truncated.result.errors).toContain('truncated: 100 bytes of an unfinished command');
  });
});

describe('statusReply', () => {
  const ask = (mode: Mode) => [1, 2, 4].map((n) => statusReply(mode, n));

  it('answers like a ready printer', () => {
    expect(ask('ok')).toEqual([0x12, 0x12, 0x12]);
  });

  it('answers paper out and cover open the way the app reads them', () => {
    // App: offline = n1 bit 3; cover open = n2 bit 2; paper out = n4 bits 5+6 (EscPos.kt PrinterStatus.parse).
    expect(ask('paper-out')).toEqual([0x1a, 0x32, 0x72]);
    expect(ask('cover-open')).toEqual([0x1a, 0x16, 0x12]);
  });

  it('never answers when silent', () => {
    expect(ask('silent')).toEqual([null, null, null]);
  });
});
