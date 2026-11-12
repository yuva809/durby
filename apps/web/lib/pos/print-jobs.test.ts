import { describe, expect, it, vi } from 'vitest';
import { type JobDevice, oneAtATime, pollPrintJobs, runPrintJob } from './print-jobs';

const LOCATION = '0190a000-0000-7000-8000-000000000101';
const JOB_ID = '0190a000-0000-7000-8000-000000000501';
const PRINTER_ID = '0190a000-0000-7000-8000-000000000301';
const AT = '2026-11-09T12:00:00.000Z';
const image = { width: 576, height: 1, data: 'A'.repeat(96) };
const SETTINGS = {
  host: '192.168.64.20',
  port: 9100,
  widthDots: 576,
  cutter: true,
  imageMode: 'gsV0' as const,
};
const PRINTER = {
  id: PRINTER_ID,
  locationId: LOCATION,
  name: 'Kitchen',
  ...SETTINGS,
  enabled: true,
  printsBills: false,
  stations: ['kitchen' as const],
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
};
const JOB = {
  id: JOB_ID,
  locationId: LOCATION,
  printerId: PRINTER_ID,
  kind: 'ticket' as const,
  orderId: '0190a000-0000-7000-8000-000000000601',
  ticketId: '0190a000-0000-7000-8000-000000000701',
  checkId: null,
  status: 'claimed' as const,
  stale: false,
  expired: false,
  attempts: 0,
  lastCode: null,
  notBefore: AT,
  expiresAt: '2026-11-09T12:10:00.000Z',
  createdAt: AT,
  claimedAt: AT,
  completedAt: null,
};

function device(overrides: Partial<JobDevice> = {}): JobDevice {
  return {
    printer: {
      print: vi.fn(() => Promise.resolve({ state: 'sent' as const, code: 'print.sent' as const })),
    },
    printerFor: () => Promise.resolve(PRINTER),
    render: () => Promise.resolve(image),
    ...overrides,
  };
}

function api(due: unknown[], claimed: unknown) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const apiFetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : null });
    if (method === 'GET') return Promise.resolve(Response.json({ data: due }));
    if (url.endsWith('/claim')) return Promise.resolve(Response.json({ job: claimed }));
    return Promise.resolve(Response.json({ ...JOB, status: 'printed' }));
  });
  return { store: { apiFetch } as never, calls };
}

describe('runPrintJob (ADR 0033)', () => {
  it("draws the job at its printer's width and prints it there", async () => {
    const render = vi.fn(() => Promise.resolve(image));
    const d = device({ render });
    expect(await runPrintJob(JOB, d)).toEqual({ code: 'print.sent' });
    expect(render).toHaveBeenCalledWith(JOB, PRINTER);
    expect(d.printer.print).toHaveBeenCalledWith(expect.any(String), image, SETTINGS);
  });

  it('answers with a code when it cannot print', async () => {
    expect(await runPrintJob(JOB, device({ printerFor: () => Promise.resolve(null) }))).toEqual({
      code: 'print.no_printer',
    });
    expect(
      await runPrintJob(JOB, device({ render: () => Promise.reject(new Error('no canvas')) })),
    ).toEqual({ code: 'print.payload_invalid' });
  });

  it("reports an app that didn't answer as a timeout: it may have printed, so a person checks", async () => {
    const d = device();
    d.printer.print = vi.fn(() =>
      Promise.resolve({ state: 'failed' as const, code: 'print.no_answer' as const }),
    );
    expect(await runPrintJob(JOB, d)).toEqual({ code: 'print.printer_timeout' });
  });

  it("passes the app's nothingPrinted on, so the queue sends the job again by itself", async () => {
    const d = device();
    d.printer.print = vi.fn(() =>
      Promise.resolve({
        state: 'failed' as const,
        code: 'print.printer_timeout' as const,
        nothingPrinted: true,
      }),
    );
    expect(await runPrintJob(JOB, d)).toEqual({
      code: 'print.printer_timeout',
      nothingPrinted: true,
    });
    const { store, calls } = api([{ id: JOB_ID }], JOB);
    await pollPrintJobs(store, LOCATION, d);
    expect(calls.find((c) => c.url.endsWith('/result'))!.body).toEqual({
      code: 'print.printer_timeout',
      nothingPrinted: true,
    });
  });
});

describe('pollPrintJobs', () => {
  it('only reads while nothing is due', async () => {
    const { store, calls } = api([], null);
    expect(await pollPrintJobs(store, LOCATION, device())).toBe('idle');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('claims, prints and answers a due job', async () => {
    const { store, calls } = api([{ id: JOB_ID }], JOB);
    expect(await pollPrintJobs(store, LOCATION, device())).toEqual(['print.sent']);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/v1/pos/print-jobs/due?locationId=${LOCATION}`,
      'POST /api/v1/pos/print-jobs/claim',
      `POST /api/v1/pos/print-jobs/${JOB_ID}/result`,
    ]);
    expect(calls[2]!.body).toEqual({ code: 'print.sent' });
  });

  it('prints every due job in one poll, so tickets sent together come out together', async () => {
    const { store, calls } = api([{ id: JOB_ID }, { id: JOB_ID }], JOB);
    expect(await pollPrintJobs(store, LOCATION, device())).toEqual(['print.sent', 'print.sent']);
    expect(calls.filter((c) => c.url.endsWith('/claim'))).toHaveLength(2);
  });

  it("prints different printers at the same time and one printer's jobs in order", async () => {
    const BAR = '0190a000-0000-7000-8000-000000000302';
    const jobs = [
      { ...JOB, id: '0190a000-0000-7000-8000-000000000511' },
      { ...JOB, id: '0190a000-0000-7000-8000-000000000512' },
      { ...JOB, id: '0190a000-0000-7000-8000-000000000513', printerId: BAR },
    ];
    let claims = 0;
    const apiFetch = vi.fn((url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET')
        return Promise.resolve(Response.json({ data: jobs.map((j) => ({ id: j.id })) }));
      if (url.endsWith('/claim')) return Promise.resolve(Response.json({ job: jobs[claims++] }));
      return Promise.resolve(Response.json({ ...JOB, status: 'printed' }));
    });
    // The kitchen printer answers only when the test says so.
    const events: string[] = [];
    let releaseKitchen: () => void = () => undefined;
    const kitchenDone = new Promise<void>((r) => (releaseKitchen = r));
    const print = vi.fn(async (_id: string, _image: unknown, settings: { port: number }) => {
      const name = settings.port === 9101 ? 'bar' : 'kitchen';
      events.push(`start ${name}`);
      if (name === 'kitchen') await kitchenDone;
      events.push(`end ${name}`);
      return { state: 'sent' as const, code: 'print.sent' as const };
    });
    const d = device({
      printer: { print },
      printerFor: (id) =>
        Promise.resolve(id === BAR ? { ...PRINTER, id: BAR, name: 'Bar', port: 9101 } : PRINTER),
    });
    const polled = pollPrintJobs({ apiFetch }, LOCATION, d);
    await vi.waitFor(() => expect(events).toContain('end bar'));
    // The bar ticket printed while the first kitchen ticket was still printing; the second kitchen ticket waits.
    expect(events).toEqual(['start kitchen', 'start bar', 'end bar']);
    releaseKitchen();
    expect(await polled).toEqual(['print.sent', 'print.sent', 'print.sent']);
    expect(events).toEqual([
      'start kitchen',
      'start bar',
      'end bar',
      'end kitchen',
      'start kitchen',
      'end kitchen',
    ]);
  });

  it('prints nothing when another till took the job first', async () => {
    const d = device();
    const { store, calls } = api([{ id: JOB_ID }], null);
    expect(await pollPrintJobs(store, LOCATION, d)).toBe('taken');
    expect(calls).toHaveLength(2);
    expect(d.printer.print).not.toHaveBeenCalled();
  });
});

describe('oneAtATime', () => {
  it('runs calls one after another, in call order, and goes on after a failure', async () => {
    const log: string[] = [];
    const step = oneAtATime(async (name: string) => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${name}`);
      if (name === 'a') throw new Error('a failed');
      return name;
    });
    const a = step('a');
    const b = step('b');
    await expect(a).rejects.toThrow('a failed');
    expect(await b).toBe('b');
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
});
