import { afterEach, describe, expect, it, vi } from 'vitest';
import { findNativePrintObject, NativePrinter, type NativePrintObject } from './native';

const JOB = '0195f2a4-7c1e-7d3a-9b2c-4e5f6a7b8c9d';
const image = { width: 8, height: 1, data: 'AA==' };
const settings = {
  host: '192.168.64.20',
  port: 9100,
  widthDots: 384,
  cutter: true,
  imageMode: 'gsV0' as const,
};

/** The app's side of the print object: records what the page sent, answers when told to. */
function fakeApp() {
  const sent: Record<string, unknown>[] = [];
  let listener: ((event: { data: unknown }) => void) | null = null;
  const target: NativePrintObject = {
    postMessage: (m) => sent.push(JSON.parse(m) as Record<string, unknown>),
    addEventListener: (_type, l) => (listener = l),
  };
  return { target, sent, answer: (data: unknown) => listener?.({ data: JSON.stringify(data) }) };
}

afterEach(() => vi.useRealTimers());

describe('findNativePrintObject', () => {
  it('finds the app only when it added a usable object', () => {
    const app = fakeApp();
    expect(findNativePrintObject({ durbyPrint: app.target })).toBe(app.target);
    expect(findNativePrintObject({})).toBeNull();
    expect(findNativePrintObject({ durbyPrint: { postMessage: 'x' } })).toBeNull();
  });
});

describe('NativePrinter', () => {
  it('asks for info and reads the width to render at', async () => {
    const app = fakeApp();
    const printer = new NativePrinter(app.target);
    const info = printer.info();
    expect(app.sent).toEqual([{ version: 1, type: 'info' }]);
    app.answer({ type: 'info', appVersion: '1.0.0', protocol: 1 });
    expect(await info).toMatchObject({ appVersion: '1.0.0' });
  });

  it('matches print answers by job id, whatever the order', async () => {
    const app = fakeApp();
    const printer = new NativePrinter(app.target);
    const other = '0195f2a4-7c1e-7d3a-9b2c-000000000000';
    const first = printer.print(JOB, image, settings);
    const second = printer.print(other, image, settings);
    expect(app.sent[0]).toEqual({
      version: 1,
      type: 'print',
      jobId: JOB,
      image,
      printer: settings,
    });
    app.answer({ type: 'print', jobId: other, state: 'failed', code: 'print.paper_out' });
    app.answer({ type: 'print', jobId: JOB, state: 'sent', code: 'print.sent' });
    expect(await first).toEqual({ state: 'sent', code: 'print.sent' });
    expect(await second).toEqual({ state: 'failed', code: 'print.paper_out' });
  });

  it('asks the app to find printers and reads what it found', async () => {
    const app = fakeApp();
    const printer = new NativePrinter(app.target);
    const found = printer.discover();
    expect(app.sent).toEqual([{ version: 1, type: 'discover' }]);
    app.answer({
      type: 'discover',
      subnet: '192.168.64.0/24',
      printers: [{ host: '192.168.64.20', port: 9100, status: 'online' }],
    });
    expect((await found)?.printers).toHaveLength(1);
  });

  it('gives up when the app stays silent', async () => {
    vi.useFakeTimers();
    const printer = new NativePrinter(fakeApp().target, { info: 100, print: 100, discover: 100 });
    const info = printer.info();
    const print = printer.print(JOB, image, settings);
    await vi.advanceTimersByTimeAsync(150);
    expect(await info).toBeNull();
    expect(await print).toEqual({ state: 'failed', code: 'print.no_answer' });
  });

  it('ignores answers it cannot read', async () => {
    vi.useFakeTimers();
    const app = fakeApp();
    const printer = new NativePrinter(app.target, { info: 100, print: 100, discover: 100 });
    const print = printer.print(JOB, image, settings);
    app.answer({ type: 'print', jobId: JOB, state: 'sent', code: 'print.made_up' });
    await vi.advanceTimersByTimeAsync(150);
    expect(await print).toEqual({ state: 'failed', code: 'print.no_answer' });
  });

  it('reports an unreadable request to the oldest waiting print', async () => {
    const app = fakeApp();
    const printer = new NativePrinter(app.target);
    const print = printer.print(JOB, image, settings);
    app.answer({ type: 'print', jobId: null, state: 'failed', code: 'print.payload_invalid' });
    expect(await print).toEqual({ state: 'failed', code: 'print.payload_invalid' });
  });
});
