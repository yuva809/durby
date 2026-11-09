// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDeviceSettings } from '../../lib/print/device-settings';
import { mockState, resetMocks } from '../../test/mocks';
import { PrinterCommandRunner } from './printer-command-runner';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());

const app = vi.hoisted(() => ({ printer: null as null | object }));
vi.mock('../../lib/print/native', () => ({ nativePrinter: () => app.printer }));

const LOCATION = '0190a000-0000-7000-8000-000000000101';

beforeEach(() => {
  resetMocks();
  resetDeviceSettings();
  app.printer = null;
  mockState.store.apiFetch.mockImplementation(() => Promise.resolve(Response.json({ data: [] })));
});
afterEach(cleanup);

describe('PrinterCommandRunner', () => {
  it('never polls in a normal browser', async () => {
    render(<PrinterCommandRunner locationId={LOCATION} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockState.store.apiFetch).not.toHaveBeenCalled();
  });

  it("inside the app, asks for its own location's open commands", async () => {
    app.printer = { discover: vi.fn(), print: vi.fn() };
    render(<PrinterCommandRunner locationId={LOCATION} />);
    await vi.waitFor(() =>
      expect(mockState.store.apiFetch).toHaveBeenCalledWith(
        `/api/v1/pos/printer-commands/pending?locationId=${LOCATION}`,
        expect.anything(),
      ),
    );
    expect(mockState.store.apiFetch).toHaveBeenCalledTimes(1);
  });
});
