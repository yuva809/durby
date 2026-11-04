// @vitest-environment jsdom
import type { PublicMenu } from '@durby/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandProvider } from '../theme-provider';
import { PublicMenuPage } from './public-menu-page';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const Brand = ({ children }: { children: ReactNode }) => (
  <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>{children}</BrandProvider>
);

const LINK = '0190a000-0000-7000-8000-0000000000a1.abcdefghijklmnopqrstuvwx';

const MENU: PublicMenu = {
  name: 'Bay Leaf',
  logo: null,
  tableName: 'T5',
  currency: 'EUR',
  locale: 'de',
  categories: [
    {
      name: 'Vorspeisen',
      products: [{ name: 'Tomatensuppe', description: 'Mit Basilikum', price: '6.90' }],
    },
    { name: 'Getränke', products: [{ name: 'Mango Lassi', description: null, price: '4.50' }] },
  ],
};

function serve(status: number, body: unknown) {
  const fetchMock = vi.fn(() => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('PublicMenuPage', () => {
  it("shows the restaurant's menu in its language and currency, without signing in", async () => {
    const fetchMock = serve(200, MENU);
    render(<PublicMenuPage link={LINK} />, { wrapper: Brand });
    expect(await screen.findByRole('heading', { name: 'Bay Leaf' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/public/menu/${LINK}`,
      expect.objectContaining({ credentials: 'omit' }),
    );
    expect(screen.getByTestId('menu-table').textContent).toBe('Tisch T5');
    expect(
      screen.getAllByTestId('menu-price').map((p) => p.textContent?.replace(/\s/g, ' ')),
    ).toEqual(['6,90 €', '4,50 €']);
    expect(screen.getByText('Powered by Product')).toBeTruthy();
  });

  it('filters by category chip and by search', async () => {
    serve(200, MENU);
    render(<PublicMenuPage link={LINK} />, { wrapper: Brand });
    await screen.findAllByTestId('menu-item');
    const chips = screen.getByRole('navigation', { name: 'Kategorien' });
    await userEvent.click(within(chips).getByRole('button', { name: 'Getränke' }));
    expect(screen.getAllByTestId('menu-category').map((c) => c.dataset.name)).toEqual(['Getränke']);
    await userEvent.click(within(chips).getByRole('button', { name: 'Alle' }));
    await userEvent.type(screen.getByLabelText('Karte durchsuchen'), 'basil');
    expect(screen.getAllByTestId('menu-item').map((i) => i.textContent)).toEqual([
      expect.stringContaining('Tomatensuppe'),
    ]);
    await userEvent.type(screen.getByLabelText('Karte durchsuchen'), 'xyz');
    expect(screen.getByText('Nichts passt zu Ihrer Suche.')).toBeTruthy();
  });

  it('explains a link that no longer works', async () => {
    serve(404, { code: 'pos.menu_not_found', message: 'x' });
    render(<PublicMenuPage link={LINK} />, { wrapper: Brand });
    expect((await screen.findByTestId('menu-error')).textContent).toMatch(/menu link/);
  });
});
