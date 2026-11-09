// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { PrintWarnings } from './print-warnings';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());

const LOCATION = '0190a000-0000-7000-8000-000000000101';
const PRINTER = '0190a000-0000-7000-8000-000000000301';
const JOB = '0190a000-0000-7000-8000-000000000501';
const AT = '2026-11-09T12:00:00.000Z';

const job = {
  id: JOB,
  locationId: LOCATION,
  printerId: PRINTER,
  kind: 'ticket',
  orderId: '0190a000-0000-7000-8000-000000000601',
  ticketId: '0190a000-0000-7000-8000-000000000701',
  status: 'needs_check',
  stale: false,
  expired: false,
  attempts: 1,
  lastCode: 'print.printer_disconnected',
  notBefore: AT,
  expiresAt: '2026-11-09T12:10:00.000Z',
  createdAt: AT,
  claimedAt: AT,
  completedAt: AT,
  printerName: 'Kitchen',
  orderNumber: 'ORD-2026-000012',
};

function api(status: object) {
  const calls: string[] = [];
  mockState.store.apiFetch.mockImplementation((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'POST')
      return Promise.resolve(Response.json({ ...job, status: 'pending' }));
    return Promise.resolve(Response.json(status));
  });
  return calls;
}

beforeEach(resetMocks);
afterEach(cleanup);

const none = {
  tillSeenAt: null,
  waiting: { count: 0, oldestAt: null },
  retrying: [],
  attention: [],
};

describe('PrintWarnings (ADR 0033)', () => {
  it('shows nothing while all prints', async () => {
    const calls = api(none);
    render(<PrintWarnings locationId={LOCATION} canReprint />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('print-warnings')).toBeNull();
  });

  it('says when jobs wait because no till with the app is open', async () => {
    api({ ...none, waiting: { count: 2, oldestAt: AT } });
    render(<PrintWarnings locationId={LOCATION} canReprint />);
    expect((await screen.findByTestId('print-warnings')).textContent).toContain(
      '2 waiting to print: no till with the Durby app is open.',
    );
  });

  it('names a printer being retried and why', async () => {
    api({
      ...none,
      tillSeenAt: new Date().toISOString(),
      retrying: [{ printerId: PRINTER, printerName: 'Bar', lastCode: 'print.paper_out', count: 1 }],
    });
    render(<PrintWarnings locationId={LOCATION} canReprint />);
    expect((await screen.findByTestId('print-warnings')).textContent).toContain(
      'Bar: out of paper. Trying again.',
    );
  });

  it("lists what needs a check and reprints it from the station's screen", async () => {
    const calls = api({
      ...none,
      attention: [job, { ...job, id: `${JOB.slice(0, -1)}2`, expired: true }],
    });
    render(<PrintWarnings locationId={LOCATION} station="kitchen" canReprint />);
    const list = await screen.findByTestId('print-attention');
    expect(list.textContent).toContain('Kitchen · ORD-2026-000012: may have printed.');
    expect(list.textContent).toContain('too old to print by itself');
    await userEvent.click(within(list).getAllByTestId('print-reprint')[0]!);
    expect(calls).toContain(`POST /api/v1/pos/stations/kitchen/print-jobs/${JOB}/reprint`);
    expect(calls[0]).toBe(`GET /api/v1/pos/stations/kitchen/print-status?locationId=${LOCATION}`);
  });

  it('offers no Reprint to those who may not reprint', async () => {
    api({ ...none, attention: [job] });
    render(<PrintWarnings locationId={LOCATION} canReprint={false} />);
    await screen.findByTestId('print-attention');
    expect(screen.queryByTestId('print-reprint')).toBeNull();
  });
});
