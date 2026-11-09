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
    const printer = new NativePrinter(fakeApp().target, {
      info: 100,
      print: 100,
      discover: 100,
      settings: 100,
      update: 100,
      install: 100,
    });
    const info = printer.info();
    const print = printer.print(JOB, image, settings);
    await vi.advanceTimersByTimeAsync(150);
    expect(await info).toBeNull();
    expect(await print).toEqual({ state: 'failed', code: 'print.no_answer' });
  });

  it('ignores answers it cannot read', async () => {
    vi.useFakeTimers();
    const app = fakeApp();
    const printer = new NativePrinter(app.target, {
      info: 100,
      print: 100,
      discover: 100,
      settings: 100,
      update: 100,
      install: 100,
    });
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

describe('app 1.1: features, device settings, nothingPrinted', () => {
  const LOCATION = '0190a000-0000-7000-8000-000000000101';
  const stored = { prints: false, tillLocationId: LOCATION, receiptPrinters: {} };

  it('reads the features once; a v1 app names none', async () => {
    const app = fakeApp();
    const printer = new NativePrinter(app.target);
    const first = printer.has('parallel');
    app.answer({ type: 'info', appVersion: '1.1.0', protocol: 1, features: ['parallel'] });
    expect(await first).toBe(true);
    expect(await printer.has('deviceSettings')).toBe(false);
    expect(app.sent.filter((m) => m.type === 'info')).toHaveLength(1);

    const v1 = fakeApp();
    const old = new NativePrinter(v1.target);
    const none = old.features();
    v1.answer({ type: 'info', appVersion: '1.0.0', protocol: 1 });
    expect([...(await none)]).toEqual([]);
  });

  it('reads and writes the device settings', async () => {
    const app = fakeApp();
    const printer = new NativePrinter(app.target);
    const written = printer.setDeviceSettings(stored);
    expect(app.sent.at(-1)).toEqual({ version: 1, type: 'setDeviceSettings', settings: stored });
    app.answer({ type: 'deviceSettings', settings: stored });
    expect(await written).toEqual({ settings: stored, refused: false });
    const read = printer.deviceSettings();
    app.answer({ type: 'deviceSettings', settings: stored, refused: true });
    expect(await read).toEqual({ settings: stored, refused: true });
  });

  it('passes nothingPrinted on', async () => {
    const app = fakeApp();
    const printer = new NativePrinter(app.target);
    const print = printer.print(JOB, image, settings);
    app.answer({
      type: 'print',
      jobId: JOB,
      state: 'failed',
      code: 'print.printer_timeout',
      nothingPrinted: true,
    });
    expect(await print).toEqual({
      state: 'failed',
      code: 'print.printer_timeout',
      nothingPrinted: true,
    });
  });
});

describe('app 1.1: updates', () => {
  it('asks for a newer version and to install it, each only when called', async () => {
    const app = fakeApp();
    const printer = new NativePrinter(app.target);
    const check = printer.checkUpdate();
    expect(app.sent.at(-1)).toEqual({ version: 1, type: 'update' });
    app.answer({ type: 'update', available: { versionCode: 3, versionName: '1.1.1' } });
    expect(await check).toEqual({ versionCode: 3, versionName: '1.1.1' });
    const install = printer.installUpdate();
    expect(app.sent.at(-1)).toEqual({ version: 1, type: 'installUpdate' });
    app.answer({ type: 'installUpdate', result: 'update.checksum' });
    expect(await install).toBe('update.checksum');
  });
});
