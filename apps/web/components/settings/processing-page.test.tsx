// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleNav } from '../../lib/nav/registry';
import { SETTINGS_TABS } from '../../lib/nav/settings-tabs';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { ProcessingPage } from './processing-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const id = (n: number) => `0190a000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`;
const MAIN = { id: id(1), name: 'Main street', brandId: id(90) };

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog', 'pos'],
  });
}

type Stored = { kitchen: boolean; bar: boolean; source: 'default' | 'organization' | 'location' };

/** Settings by scope ('' = organization); records the writes with their url. */
function api(byScope: Record<string, Stored>) {
  const writes: { method: string; url: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({
        method,
        url: input,
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      const key = input.replace(/^\/api\/v1\/settings\/([^?]+).*$/, '$1');
      return Promise.resolve(
        method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Response.json({ key, value: false, source: 'organization', dataBound: false }),
      );
    }
    if (input.startsWith('/api/v1/locations')) {
      return Promise.resolve(Response.json({ data: [MAIN] }));
    }
    if (input.startsWith('/api/v1/settings')) {
      const scope = /locationId=([^&]+)/.exec(input)?.[1] ?? '';
      const stored = byScope[scope] ?? byScope['']!;
      return Promise.resolve(
        Response.json({
          data: [
            { key: 'locale', value: 'en', source: 'default', dataBound: false },
            {
              key: 'pos.kitchenProcessing',
              value: stored.kitchen,
              source: stored.source,
              dataBound: false,
            },
            {
              key: 'pos.barProcessing',
              value: stored.bar,
              source: stored.source,
              dataBound: false,
            },
          ],
        }),
      );
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
  return writes;
}

const switchFor = async (station: string) =>
  (await screen.findAllByTestId('processing-switch')).find((s) => s.dataset.station === station)!;

describe('Settings → Kitchen & bar (ADR 0031)', () => {
  it('is a settings tab for the pos feature', () => {
    signedInAs('manager');
    const ids = (features: string[]) =>
      visibleNav(SETTINGS_TABS, {
        activePermissions: mockState.session!.activePermissions,
        activeFeatures: features,
      }).map((i) => i.id);
    expect(ids(['pos'])).toContain('service');
    expect(ids([])).not.toContain('service');
  });

  it('turns the bar off for all locations: drinks go straight to the bill', async () => {
    signedInAs('owner');
    const writes = api({ '': { kitchen: true, bar: true, source: 'default' } });
    render(<ProcessingPage />);
    const bar = await switchFor('bar');
    expect(bar.getAttribute('data-state')).toBe('checked');
    await userEvent.click(bar);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PUT',
      url: '/api/v1/settings/pos.barProcessing',
      body: { value: false },
    });
  });

  it("shows a location's own setting and goes back to the organization's", async () => {
    signedInAs('owner');
    const writes = api({
      '': { kitchen: true, bar: true, source: 'organization' },
      [MAIN.id]: { kitchen: false, bar: true, source: 'location' },
    });
    render(<ProcessingPage />);
    await userEvent.selectOptions(await screen.findByTestId('processing-scope'), MAIN.id);
    await waitFor(async () =>
      expect((await switchFor('kitchen')).getAttribute('data-state')).toBe('unchecked'),
    );
    expect(screen.getByTestId('processing-scope-state').textContent).toBe(
      'This location uses its own setting.',
    );
    expect(screen.getAllByTestId('processing-effect')[0]!.textContent).toContain(
      'straight onto the bill',
    );
    await userEvent.click(screen.getByTestId('processing-use-organization'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      `DELETE /api/v1/settings/pos.kitchenProcessing?locationId=${MAIN.id}`,
      `DELETE /api/v1/settings/pos.barProcessing?locationId=${MAIN.id}`,
    ]);
  });

  it('lets Manager read but not change it', async () => {
    signedInAs('manager');
    api({ '': { kitchen: true, bar: true, source: 'default' } });
    render(<ProcessingPage />);
    expect((await switchFor('kitchen')).hasAttribute('disabled')).toBe(true);
  });
});
