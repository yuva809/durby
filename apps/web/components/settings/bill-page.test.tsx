// @vitest-environment jsdom
import { DEFAULT_BILL_HEADER, type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleNav } from '../../lib/nav/registry';
import { SETTINGS_TABS } from '../../lib/nav/settings-tabs';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BrandProvider } from '../theme-provider';
import { BillPage } from './bill-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const Brand = ({ children }: { children: ReactNode }) => (
  <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>{children}</BrandProvider>
);

const id = (n: number) => `0190a000-0000-7000-8000-0000000008${String(n).padStart(2, '0')}`;
const MAIN = { id: id(1), name: 'Main street', brandId: id(90) };
const HARBOUR = { id: id(2), name: 'Harbour', brandId: id(90) };

function signedInAs(role: SystemRole, features = ['catalog', 'pos']) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: features,
  });
}

type Stored = { header: object; footer: object; source: 'default' | 'organization' | 'location' };

/** Settings by scope ('' = organization); records the writes with their query. */
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
      const value = init?.body
        ? (JSON.parse(init.body as string) as { value: unknown }).value
        : null;
      const key = input.replace(/^\/api\/v1\/settings\/([^?]+).*$/, '$1');
      return Promise.resolve(
        method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Response.json({ key, value, source: 'organization', dataBound: false }),
      );
    }
    if (input.startsWith('/api/v1/locations')) {
      return Promise.resolve(Response.json({ data: [MAIN, HARBOUR] }));
    }
    if (input.startsWith('/api/v1/settings')) {
      const scope = /locationId=([^&]+)/.exec(input)?.[1] ?? '';
      const stored = byScope[scope] ?? byScope['']!;
      return Promise.resolve(
        Response.json({
          data: [
            { key: 'locale', value: 'en', source: 'default', dataBound: false },
            { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
            {
              key: 'pos.billHeader',
              value: stored.header,
              source: stored.source,
              dataBound: false,
            },
            {
              key: 'pos.billFooter',
              value: stored.footer,
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

const EMPTY: Stored = { header: DEFAULT_BILL_HEADER, footer: { lines: [] }, source: 'default' };

describe('BillPage', () => {
  it('is a settings tab for those who read settings, with the pos feature', () => {
    const tabs = (role: SystemRole, features: string[]) =>
      visibleNav(SETTINGS_TABS, {
        activePermissions: [...systemRolePermissions(role)],
        activeFeatures: features,
      }).map((tab) => tab.id);
    expect(tabs('owner', ['pos'])).toContain('bill');
    expect(tabs('owner', [])).not.toContain('bill');
  });

  it('edits the header and footer with a live preview of the real bill, and saves both', async () => {
    signedInAs('owner');
    const writes = api({ '': EMPTY });
    render(<BillPage />, { wrapper: Brand });
    const preview = await screen.findByTestId('bill-preview-customer');
    // Empty: the organization's name and the default thanks; the fixed middle always.
    expect(within(preview).getByTestId('bill-header').textContent).toBe('Demo Bistro');
    expect(within(preview).getByTestId('bill-thanks').textContent).toBe('Thank you for visiting!');
    expect(within(preview).getByTestId('bill-waiter').textContent).toBe('Waiter: Alex');
    expect(within(preview).getByTestId('bill-table').textContent).toBe('Table 5 · Guests 2');
    expect(within(preview).getByTestId('order-total').textContent).toBe('€20.10');
    expect(within(preview).getByTestId('bill-footer').textContent).toContain('Powered by Product');

    await userEvent.type(screen.getByTestId('bill-name'), 'Bay Leaf');
    await userEvent.type(screen.getByTestId('bill-phone'), '+49 30 1234567');
    await userEvent.type(screen.getByTestId('bill-website'), 'www.bayleaf.example');
    await userEvent.click(screen.getByTestId('bill-add-line'));
    await userEvent.type(screen.getAllByTestId('bill-footer-line')[0]!, 'Thank you!');
    await userEvent.click(screen.getByTestId('bill-add-line'));
    await userEvent.type(screen.getAllByTestId('bill-footer-line')[1]!, 'Danke!');
    expect(within(preview).getByTestId('bill-header').textContent).toBe(
      'Bay Leaf+49 30 1234567www.bayleaf.example',
    );
    expect(
      within(preview)
        .getAllByTestId('bill-thanks')
        .map((l) => l.textContent),
    ).toEqual(['Thank you!', 'Danke!']);

    await userEvent.click(screen.getByTestId('bill-save'));
    expect(await screen.findByTestId('bill-saved')).toBeTruthy();
    expect(writes).toEqual([
      {
        method: 'PUT',
        url: '/api/v1/settings/pos.billHeader',
        body: {
          value: {
            logo: null,
            name: 'Bay Leaf',
            phone: '+49 30 1234567',
            email: null,
            website: 'www.bayleaf.example',
          },
        },
      },
      {
        method: 'PUT',
        url: '/api/v1/settings/pos.billFooter',
        body: { value: { lines: ['Thank you!', 'Danke!'] } },
      },
    ]);
  });

  it('refuses an invalid email before saving', async () => {
    signedInAs('owner');
    const writes = api({ '': EMPTY });
    render(<BillPage />, { wrapper: Brand });
    await userEvent.type(await screen.findByTestId('bill-email'), 'not an email');
    await userEvent.click(screen.getByTestId('bill-save'));
    expect(await screen.findByText('Check the highlighted fields.')).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it("saves a location's own bill and goes back to the organization's", async () => {
    signedInAs('owner');
    const writes = api({
      '': {
        ...EMPTY,
        header: { ...DEFAULT_BILL_HEADER, name: 'Bay Leaf' },
        source: 'organization',
      },
      [HARBOUR.id]: {
        ...EMPTY,
        header: { ...DEFAULT_BILL_HEADER, name: 'Bay Leaf Harbour' },
        source: 'location',
      },
    });
    render(<BillPage />, { wrapper: Brand });
    await screen.findByTestId('bill-preview-customer');
    await userEvent.selectOptions(screen.getByTestId('bill-scope'), HARBOUR.id);
    await waitFor(() =>
      expect(screen.getByTestId<HTMLInputElement>('bill-name').value).toBe('Bay Leaf Harbour'),
    );
    expect(screen.getByTestId('bill-scope-state').textContent).toBe(
      'This location uses its own bill.',
    );
    await userEvent.type(screen.getByTestId('bill-phone'), '040 123');
    await userEvent.click(screen.getByTestId('bill-save'));
    await screen.findByTestId('bill-saved');
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      `PUT /api/v1/settings/pos.billHeader?locationId=${HARBOUR.id}`,
      `PUT /api/v1/settings/pos.billFooter?locationId=${HARBOUR.id}`,
    ]);
    await userEvent.click(screen.getByTestId('bill-use-organization'));
    await waitFor(() => expect(writes).toHaveLength(4));
    expect(writes.slice(2).map((w) => `${w.method} ${w.url}`)).toEqual([
      `DELETE /api/v1/settings/pos.billHeader?locationId=${HARBOUR.id}`,
      `DELETE /api/v1/settings/pos.billFooter?locationId=${HARBOUR.id}`,
    ]);
  });

  it('shows a manager the bill read-only', async () => {
    signedInAs('manager');
    api({ '': EMPTY });
    render(<BillPage />, { wrapper: Brand });
    expect((await screen.findByTestId<HTMLInputElement>('bill-name')).disabled).toBe(true);
    expect(screen.queryByTestId('bill-save')).toBeNull();
  });

  it('needs the pos feature', () => {
    signedInAs('owner', ['catalog']);
    api({ '': EMPTY });
    render(<BillPage />, { wrapper: Brand });
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });
});
