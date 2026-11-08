import { describe, expect, it, vi } from 'vitest';
import { pollPrinterCommands, runPrinterCommand, type CommandDevice } from './printer-commands';

const PILOT = {
  host: '192.168.64.20',
  port: 9100,
  widthDots: 384,
  cutter: true,
  imageMode: 'gsV0' as const,
};
const LOCATION = '0190a000-0000-7000-8000-000000000101';
const COMMAND_ID = '0190a000-0000-7000-8000-000000000201';
const image = { width: 384, height: 1, data: 'A'.repeat(64) };
const PRINTER_ID = '0190a000-0000-7000-8000-000000000301';
const SAVED = {
  id: PRINTER_ID,
  locationId: LOCATION,
  name: 'Bar',
  ...PILOT,
  enabled: false,
  printsBills: true,
  stations: [],
  archivedAt: null,
  createdAt: '2026-11-08T12:00:00.000Z',
  updatedAt: '2026-11-08T12:00:00.000Z',
};
const FIND = { kind: 'find_printers', printerId: null } as const;
const TEST = { kind: 'test_print', printerId: PRINTER_ID } as const;

function device(overrides: Partial<CommandDevice> = {}): CommandDevice {
  return {
    printer: {
      discover: vi.fn(() =>
        Promise.resolve({
          type: 'discover' as const,
          subnet: '192.168.64.0/24',
          printers: [{ host: '192.168.64.20', port: 9100, status: 'online' as const }],
        }),
      ),
      print: vi.fn(() => Promise.resolve({ state: 'sent' as const, code: 'print.sent' as const })),
    },
    printerFor: () => Promise.resolve(SAVED),
    renderTestPage: () => Promise.resolve(image),
    ...overrides,
  };
}

describe('runPrinterCommand', () => {
  it('finds printers through the app', async () => {
    expect(await runPrinterCommand(FIND, device())).toEqual({
      subnet: '192.168.64.0/24',
      printers: [{ host: '192.168.64.20', port: 9100, status: 'online' }],
    });
  });

  it("prints the test page on the command's printer, even while it is switched off (ADR 0033)", async () => {
    const printerFor = vi.fn(() => Promise.resolve(SAVED));
    const renderTestPage = vi.fn(() => Promise.resolve(image));
    const d = device({ printerFor, renderTestPage });
    expect(await runPrinterCommand(TEST, d)).toEqual({ code: 'print.sent' });
    expect(printerFor).toHaveBeenCalledWith(PRINTER_ID);
    expect(renderTestPage).toHaveBeenCalledWith(SAVED);
    // The print object gets the printer only.
    expect(d.printer.print).toHaveBeenCalledWith(expect.any(String), image, PILOT);
  });

  it('answers with a code when it cannot run', async () => {
    expect(
      await runPrinterCommand(TEST, device({ printerFor: () => Promise.resolve(null) })),
    ).toEqual({
      code: 'print.no_printer',
    });
    const silent = device();
    silent.printer.discover = vi.fn(() => Promise.resolve(null));
    expect(await runPrinterCommand(FIND, silent)).toEqual({ code: 'print.no_answer' });
    const broken = device({ renderTestPage: () => Promise.reject(new Error('no canvas')) });
    expect(await runPrinterCommand(TEST, broken)).toEqual({
      code: 'print.payload_invalid',
    });
  });
});

describe('pollPrinterCommands', () => {
  const command = {
    id: COMMAND_ID,
    locationId: LOCATION,
    kind: 'find_printers',
    printerId: null,
    status: 'claimed',
    expired: false,
    createdAt: '2026-11-07T12:00:00.000Z',
    expiresAt: '2026-11-07T12:05:00.000Z',
    completedAt: null,
    result: null,
  };

  function api(pending: unknown[], claimed: unknown) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const apiFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (method === 'GET') return Promise.resolve(Response.json({ data: pending }));
      if (url.endsWith('/claim')) return Promise.resolve(Response.json({ command: claimed }));
      return Promise.resolve(
        Response.json({
          ...command,
          status: 'done',
          result: (calls.at(-1)!.body as { result: unknown }).result,
        }),
      );
    });
    return { store: { apiFetch } as never, calls };
  }

  it('only reads while nothing is open', async () => {
    const { store, calls } = api([], null);
    expect(await pollPrinterCommands(store, LOCATION, device())).toBe('idle');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('claims, runs and answers an open command', async () => {
    const { store, calls } = api([{ ...command, status: 'pending' }], command);
    const result = await pollPrinterCommands(store, LOCATION, device());
    expect(result).toMatchObject({ subnet: '192.168.64.0/24' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/v1/pos/printer-commands/pending?locationId=${LOCATION}`,
      'POST /api/v1/pos/printer-commands/claim',
      `POST /api/v1/pos/printer-commands/${COMMAND_ID}/result`,
    ]);
    expect(calls[1]!.body).toEqual({ locationId: LOCATION });
  });

  it('does nothing when another till took the command first', async () => {
    const d = device();
    const { store, calls } = api([{ ...command, status: 'pending' }], null);
    expect(await pollPrinterCommands(store, LOCATION, d)).toBe('taken');
    expect(calls).toHaveLength(2);
    expect(d.printer.discover).not.toHaveBeenCalled();
  });
});
