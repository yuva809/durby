import { describe, expect, it } from 'vitest';
import addresses from './native-print-addresses.json';
import {
  isAllowedPrinterHost,
  isAllowedPrinterPort,
  nativeDiscoverAnswerSchema,
  nativePrintAnswerSchema,
  nativePrintRequestSchema,
  posPrintersReadSchema,
  posPrintersSchema,
  printerSettingsSchema,
} from './native-print';

const JOB = '0195f2a4-7c1e-7d3a-9b2c-4e5f6a7b8c9d';
/** Base64 of [n] zero bytes (no Buffer or btoa in this package's types). */
const zeros = (n: number) => 'AAAA'.repeat(Math.floor(n / 3)) + ['', 'AA==', 'AAA='][n % 3];
const image = (width: number, height: number, bytes = Math.ceil(width / 8) * height) => ({
  width,
  height,
  data: zeros(bytes),
});
const printer = {
  host: '192.168.64.20',
  port: 9100,
  widthDots: 384,
  cutter: true,
  imageMode: 'gsV0' as const,
};

describe('printer address rules (shared with the Android app)', () => {
  it.each(addresses.hosts.accepted)('accepts %j', (host) => {
    expect(isAllowedPrinterHost(host)).toBe(true);
  });
  it.each(addresses.hosts.refused)('refuses %j', (host) => {
    expect(isAllowedPrinterHost(host)).toBe(false);
  });
  it('accepts only ports 9100–9102', () => {
    expect(addresses.ports.accepted.every(isAllowedPrinterPort)).toBe(true);
    expect(addresses.ports.refused.some(isAllowedPrinterPort)).toBe(false);
  });
});

describe('printer settings', () => {
  it('takes the pilot printer', () => {
    expect(printerSettingsSchema.parse(printer)).toEqual(printer);
  });
  it('names the rule an address breaks', () => {
    const result = printerSettingsSchema.safeParse({ ...printer, host: '8.8.8.8', port: 80 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([
      'print.host_not_allowed',
      'print.port_not_allowed',
    ]);
  });
  it('refuses widths that are not whole bytes and unknown fields', () => {
    expect(printerSettingsSchema.safeParse({ ...printer, widthDots: 380 }).success).toBe(false);
    expect(printerSettingsSchema.safeParse({ ...printer, extra: 1 }).success).toBe(false);
  });
});

describe('print request', () => {
  const request = (patch: object = {}) =>
    nativePrintRequestSchema.safeParse({
      version: 1,
      type: 'print',
      jobId: JOB,
      image: image(384, 10),
      printer,
      ...patch,
    });

  it('takes a 384-dot image whose data matches its size, with the printer', () => {
    expect(request().success).toBe(true);
    expect(request({ printer: undefined }).success).toBe(false);
    expect(request({ printer: { ...printer, host: '8.8.8.8' } }).success).toBe(false);
  });
  it('refuses data that does not match width x height', () => {
    expect(request({ image: image(384, 10, 48 * 10 - 1) }).success).toBe(false);
    expect(request({ image: image(384, 10, 48 * 11) }).success).toBe(false);
  });
  it('refuses a job without a uuid, another version or raw commands', () => {
    expect(request({ jobId: 'job-1' }).success).toBe(false);
    expect(request({ version: 2 }).success).toBe(false);
    expect(request({ escpos: 'G3YwAA==' }).success).toBe(false);
  });
});

describe('print answer', () => {
  it('takes only known codes', () => {
    expect(
      nativePrintAnswerSchema.safeParse({
        type: 'print',
        jobId: JOB,
        state: 'failed',
        code: 'print.paper_out',
      }).success,
    ).toBe(true);
    expect(
      nativePrintAnswerSchema.safeParse({
        type: 'print',
        jobId: JOB,
        state: 'failed',
        code: 'boom',
      }).success,
    ).toBe(false);
  });
});

describe('discover answer', () => {
  it('takes found printers on private addresses only', () => {
    const answer = (host: string) => ({
      type: 'discover',
      subnet: '192.168.64.0/24',
      printers: [{ host, port: 9100, status: 'online' }],
    });
    expect(nativeDiscoverAnswerSchema.safeParse(answer('192.168.64.20')).success).toBe(true);
    expect(nativeDiscoverAnswerSchema.safeParse(answer('8.8.8.8')).success).toBe(false);
    expect(
      nativeDiscoverAnswerSchema.safeParse({ type: 'discover', subnet: null, printers: [] })
        .success,
    ).toBe(true);
  });
});

describe('reading pos.printers forward-compatibly (ADR 0033)', () => {
  const later = { bill: { ...printer, textMode: true }, kitchen: printer };
  it("reads a later release's value: unknown keys and printer fields are dropped", () => {
    expect(posPrintersReadSchema.parse(later)).toEqual({ bill: printer });
  });
  it('still writes strictly', () => {
    expect(posPrintersSchema.safeParse(later).success).toBe(false);
  });
  it('still refuses a bad bill printer', () => {
    expect(posPrintersReadSchema.safeParse({ bill: { ...printer, host: '8.8.8.8' } }).success).toBe(
      false,
    );
    expect(posPrintersReadSchema.safeParse('printer').success).toBe(false);
  });
});
