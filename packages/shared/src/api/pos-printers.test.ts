import { describe, expect, it } from 'vitest';
import {
  billPrinterFor,
  createPrinterRequestSchema,
  type Printer,
  printerSchema,
  printerSettingsOf,
} from './pos-printers';

const at = '2026-11-08T12:00:00.000Z';
const printer = (id: string, overrides: Partial<Printer> = {}): Printer => ({
  id,
  locationId: '0190a000-0000-7000-8000-000000000101',
  name: id,
  host: '192.168.64.20',
  port: 9100,
  widthDots: 576,
  cutter: true,
  imageMode: 'gsV0',
  enabled: true,
  printsBills: true,
  stations: [],
  archivedAt: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});
const A = '0190a000-0000-7000-8000-0000000000a1';
const B = '0190a000-0000-7000-8000-0000000000b1';
const C = '0190a000-0000-7000-8000-0000000000c1';

describe('billPrinterFor (ADR 0033)', () => {
  it("takes the device's default while it prints bills here", () => {
    expect(billPrinterFor([printer(A), printer(B)], B)).toEqual({
      kind: 'printer',
      printer: printer(B),
    });
  });
  it('falls back to the only receipt printer, ignoring ones that are off, archived or without bills', () => {
    const list = [
      printer(A),
      printer(B, { enabled: false }),
      printer(C, { printsBills: false, stations: ['bar'] }),
    ];
    expect(billPrinterFor(list, B)).toEqual({ kind: 'printer', printer: printer(A) });
    expect(billPrinterFor([printer(A, { archivedAt: at })], null)).toEqual({ kind: 'none' });
  });
  it('asks which one when there are several and no default', () => {
    expect(billPrinterFor([printer(A), printer(B)], null)).toEqual({
      kind: 'choose',
      options: [printer(A), printer(B)],
    });
    expect(billPrinterFor([], null)).toEqual({ kind: 'none' });
  });
});

describe('printer schemas', () => {
  it('never takes `enabled` when adding a printer', () => {
    const body = {
      locationId: '0190a000-0000-7000-8000-000000000101',
      name: 'Bar',
      host: '192.168.64.20',
      port: 9100,
      widthDots: 576,
      cutter: true,
      imageMode: 'gsV0',
      printsBills: false,
      stations: ['bar'],
    };
    expect(createPrinterRequestSchema.safeParse(body).success).toBe(true);
    expect(createPrinterRequestSchema.safeParse({ ...body, enabled: true }).success).toBe(false);
  });
  it('reads station keys forward-compatibly: one a later release adds is dropped', () => {
    expect(printerSchema.parse({ ...printer(A), stations: ['bar', 'pizza'] }).stations).toEqual([
      'bar',
    ]);
  });
  it('gives the print object the printer only', () => {
    expect(printerSettingsOf(printer(A))).toEqual({
      host: '192.168.64.20',
      port: 9100,
      widthDots: 576,
      cutter: true,
      imageMode: 'gsV0',
    });
  });
});
