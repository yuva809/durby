import { describe, expect, it, vi } from 'vitest';
import { NATIVE_PRINT_CODES } from '@durby/shared';
import { dictionaries } from '@durby/i18n';
import { nativePrintMessage, printBillNatively } from './native-bill';

const JOB = '0195f2a4-7c1e-7d3a-9b2c-4e5f6a7b8c9d';
const bill = {} as HTMLElement;
const image = { width: 384, height: 2, data: 'A'.repeat(128) };

function printer(width: number | null | 'silent') {
  const info =
    width === 'silent'
      ? null
      : {
          type: 'info' as const,
          appVersion: '1.0.0',
          protocol: 1,
          printer: width === null ? null : { widthDots: width },
        };
  return {
    info: vi.fn(() => Promise.resolve(info)),
    print: vi.fn(() => Promise.resolve({ state: 'sent' as const, code: 'print.sent' as const })),
  };
}

describe('printBillNatively', () => {
  it('renders at the width the app reports and sends with the given job id', async () => {
    const p = printer(384);
    const render = vi.fn(() => Promise.resolve(image));
    expect(await printBillNatively(p, bill, JOB, render)).toEqual({
      state: 'sent',
      code: 'print.sent',
    });
    expect(render).toHaveBeenCalledWith(bill, 384);
    expect(p.print).toHaveBeenCalledWith(JOB, image);
  });

  it('stops before rendering when there is no printer or no app answer', async () => {
    const render = vi.fn(() => Promise.resolve(image));
    expect(await printBillNatively(printer(null), bill, JOB, render)).toEqual({
      state: 'failed',
      code: 'print.no_printer',
    });
    expect(await printBillNatively(printer('silent'), bill, JOB, render)).toEqual({
      state: 'failed',
      code: 'print.no_answer',
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('turns a rendering failure into a message instead of throwing', async () => {
    const p = printer(384);
    const render = vi.fn(() => Promise.reject(new Error('canvas tainted')));
    expect(await printBillNatively(p, bill, JOB, render)).toEqual({
      state: 'failed',
      code: 'print.payload_invalid',
    });
    expect(p.print).not.toHaveBeenCalled();
  });
});

describe('nativePrintMessage', () => {
  it('has an English label for every code the app can send, and for a silent app', () => {
    for (const code of [...NATIVE_PRINT_CODES, 'print.no_answer' as const]) {
      expect(dictionaries.en[nativePrintMessage(code)]).toBeTruthy();
    }
  });
});
