import { describe, expect, it } from 'vitest';
import { NATIVE_PRINT_CODES } from '../native-print';
import { printJobOutcome, printJobRetryDelayMs } from './pos-print-jobs';

describe('printJobOutcome (ADR 0033 §12)', () => {
  it('retries by itself only when nothing can have reached the paper', () => {
    expect(printJobOutcome('print.printer_unreachable')).toBe('retry');
    expect(printJobOutcome('print.paper_out')).toBe('retry');
    expect(printJobOutcome('print.cover_open')).toBe('retry');
  });
  it('leaves a job lost while sending to a person, unless the app says nothing was sent', () => {
    expect(printJobOutcome('print.printer_timeout')).toBe('needs_check');
    expect(printJobOutcome('print.printer_disconnected')).toBe('needs_check');
    expect(printJobOutcome('print.printer_timeout', true)).toBe('retry');
    expect(printJobOutcome('print.printer_disconnected', true)).toBe('retry');
  });
  it("fails what can't print as it is, and never retries a sent job", () => {
    expect(printJobOutcome('print.sent', true)).toBe('printed');
    for (const code of [
      'print.no_printer',
      'print.host_not_allowed',
      'print.port_not_allowed',
      'print.payload_invalid',
    ] as const) {
      expect(printJobOutcome(code)).toBe('failed');
      expect(printJobOutcome(code, true)).toBe('failed');
    }
  });
  it('has an answer for every code of the print object', () => {
    for (const code of NATIVE_PRINT_CODES) {
      expect(['printed', 'retry', 'needs_check', 'failed']).toContain(printJobOutcome(code));
    }
  });
});

describe('printJobRetryDelayMs', () => {
  it('waits 5 s, doubling, at most a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(printJobRetryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
    ]);
  });
});
