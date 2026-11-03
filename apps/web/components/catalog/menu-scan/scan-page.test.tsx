// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanError } from '../../../lib/catalog/menu-scan/ocr';
import type { OcrLine } from '../../../lib/catalog/menu-scan/parse';
import { mockState, resetMocks } from '../../../test/mocks';
import { sessionFixture } from '../../../test/session-fixture';
import { ScanPage } from './scan-page';

vi.mock('../../../app/providers', async () =>
  (await import('../../../test/mocks')).providersMock(),
);
vi.mock('../../../app/labels-provider', async () =>
  (await import('../../../test/mocks')).labelsMock(),
);
vi.mock('next/navigation', async () => (await import('../../../test/mocks')).navigationMock());

const ocr = vi.hoisted(() => ({ prepare: vi.fn(), recognize: vi.fn() }));
vi.mock('../../../lib/catalog/menu-scan/ocr', async (original) => ({
  ...(await original<typeof import('../../../lib/catalog/menu-scan/ocr')>()),
  preparePages: ocr.prepare,
  recognizePages: ocr.recognize,
}));

const CATEGORY_ID = '0190a000-0000-7000-8000-000000000201';
const PRODUCT_ID = '0190a000-0000-7000-8000-000000000301';

const line = (text: string, y: number, confidence = 95): OcrLine => ({
  text,
  confidence,
  page: 1,
  box: { x0: 10, y0: y, x1: 300, y1: y + 20 },
});

/** A small two-category menu; "Garlic Bread" is read with low confidence. */
const MENU: OcrLine[] = [
  line('STARTERS', 10),
  line('Chicken Soup 450.00', 40),
  line('Garlic Bread 1,200.00', 70, 55),
  line('DRINKS', 100),
  line('Lime Juice 350.00', 130),
];

function api() {
  const posts: unknown[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    if (input === '/api/v1/catalog/products/import' && init?.method === 'POST') {
      posts.push(typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null);
      return Promise.resolve(
        Response.json({
          created: 2,
          updated: 1,
          unchanged: 0,
          categoriesCreated: 1,
          rows: [],
        }),
      );
    }
    if (input.startsWith('/api/v1/catalog/categories')) {
      return Promise.resolve(
        Response.json({
          data: [{ id: CATEGORY_ID, name: 'Starters', sortOrder: 0, archivedAt: null }],
        }),
      );
    }
    if (input.startsWith('/api/v1/catalog/products')) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: PRODUCT_ID,
              categoryId: CATEGORY_ID,
              name: 'Chicken Soup',
              description: null,
              price: '400.00',
              taxRate: '7.00',
              sortOrder: 0,
              archivedAt: null,
            },
          ],
        }),
      );
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
  return posts;
}

beforeEach(() => {
  resetMocks();
  window.localStorage.clear();
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions('owner')],
    activeFeatures: ['catalog'],
  });
  ocr.prepare.mockResolvedValue([]);
  ocr.recognize.mockResolvedValue(MENU);
});
afterEach(cleanup);

const photo = () => new File(['x'], 'menu.jpg', { type: 'image/jpeg' });
const column = (name: string) =>
  screen.getAllByTestId('scan-category').find((c) => c.dataset.name === name)!;
const card = (name: string) =>
  screen.getAllByTestId('scan-product').find((c) => c.dataset.name === name)!;
const names = (category: string) =>
  within(column(category))
    .queryAllByTestId('scan-product')
    .map((c) => c.dataset.name);

async function scan() {
  render(<ScanPage />);
  await userEvent.upload(screen.getByTestId('scan-files'), photo());
  await userEvent.click(screen.getByTestId('scan-start'));
  await screen.findByTestId('scan-board');
}

describe('ScanPage', () => {
  it('needs catalog.products.manage', () => {
    mockState.session = sessionFixture({
      activePermissions: ['catalog.products.read'],
      activeFeatures: ['catalog'],
    });
    render(<ScanPage />);
    expect(screen.queryByTestId('scan-drop')).toBeNull();
  });

  it('reads the photos into a board of categories with VAT by kind and catalog badges', async () => {
    api();
    await scan();
    expect(ocr.prepare).toHaveBeenCalledWith([expect.any(File)], expect.any(Function));
    expect(names('STARTERS')).toEqual(['Chicken Soup', 'Garlic Bread']);
    expect(names('DRINKS')).toEqual(['Lime Juice']);
    const vat = (name: string) =>
      within(column(name)).getByTestId<HTMLInputElement>('scan-category-vat').value;
    expect(vat('STARTERS')).toBe('7');
    expect(vat('DRINKS')).toBe('19');
    expect(screen.getByTestId('scan-summary').textContent).toContain('3 products in 2 categories');
    // "Chicken Soup" already exists in "Starters" (case-insensitive) at another price.
    await waitFor(() => expect(card('Chicken Soup').textContent).toContain('Updates'));
    expect(card('Garlic Bread').textContent).toContain('55');
  });

  it('applies a suggested correction from its chip, then all the rest as one undo step', async () => {
    api();
    ocr.recognize.mockResolvedValue([
      line('DESSERTS', 10),
      line('Gulab Jaman mil fisereme 8,20', 40, 50),
      line('Carvel Halwa 5,20', 70, 50),
    ]);
    await scan();
    const chip = within(card('Gulab Jaman mil fisereme')).getByTestId('scan-suggestion');
    expect(chip.textContent).toContain('Gulab Jamun mit Eiscreme');
    await userEvent.click(within(chip).getByTestId('scan-suggestion-apply'));
    expect(names('DESSERTS')).toEqual(['Gulab Jamun mit Eiscreme', 'Carvel Halwa']);

    await waitFor(() => expect(screen.getByTestId('scan-apply-all').textContent).toContain('(1)'));
    await userEvent.click(screen.getByTestId('scan-apply-all'));
    expect(names('DESSERTS')).toEqual(['Gulab Jamun mit Eiscreme', 'Carrot Halwa']);
    await userEvent.click(screen.getByTestId('scan-undo'));
    expect(names('DESSERTS')).toEqual(['Gulab Jamun mit Eiscreme', 'Carvel Halwa']);
  });

  it('reads a PDF page that carries its text exactly, without OCR', async () => {
    api();
    const text = (t: string, x: number, y: number, size: number, rotated = false) => ({
      text: t,
      x,
      y,
      width: t.length * size * 0.5,
      size,
      rotated,
    });
    ocr.prepare.mockResolvedValue([
      {
        number: 1,
        width: 900,
        height: 1260,
        small: false,
        sourceWidth: 900,
        sourceHeight: 1260,
        canvas: null,
        plain: null,
        previewUrl: '',
        text: [
          text('BROT', 80, 1100, 90, true),
          text('01.', 100, 200, 16),
          text('Garlic Naan', 130, 200, 21),
          text('Mit frischem Knoblauch', 130, 220, 15),
          text('4,50 €', 500, 220, 15),
          text('02.', 100, 280, 16),
          text('Poori (3 Stück)', 130, 280, 21),
          text('7,50 €', 500, 295, 15),
        ],
      },
    ]);
    ocr.recognize.mockResolvedValue([]);
    render(<ScanPage />);
    await userEvent.upload(screen.getByTestId('scan-files'), photo());
    await userEvent.click(screen.getByTestId('scan-start'));
    await screen.findByTestId('scan-board');
    expect(screen.getByTestId('scan-exact')).toBeDefined();
    expect(names('BROT')).toEqual(['Garlic Naan', 'Poori (3 Stück)']);
    expect(screen.queryByTestId('scan-suggestion')).toBeNull();
  });

  it('names both page limits when there are too many', async () => {
    api();
    ocr.prepare.mockRejectedValue(new ScanError('tooManyPages'));
    render(<ScanPage />);
    await userEvent.upload(screen.getByTestId('scan-files'), photo());
    await userEvent.click(screen.getByTestId('scan-start'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'At most 10 photos or scanned pages per scan, and PDFs up to 60 pages.',
    );
  });

  it('explains HEIC photos', async () => {
    api();
    ocr.prepare.mockRejectedValue(new ScanError('heic'));
    render(<ScanPage />);
    await userEvent.upload(screen.getByTestId('scan-files'), photo());
    await userEvent.click(screen.getByTestId('scan-start'));
    expect((await screen.findByRole('alert')).textContent).toContain('HEIC');
  });

  it('names a too-small picture instead of "nothing found", and warns on a small scan', async () => {
    api();
    const small = {
      number: 1,
      width: 1800,
      height: 1800,
      small: true,
      sourceWidth: 168,
      sourceHeight: 168,
      previewUrl: '',
    };
    ocr.prepare.mockResolvedValue([small]);
    ocr.recognize.mockResolvedValue([line('WELCOME', 10)]);
    render(<ScanPage />);
    await userEvent.upload(screen.getByTestId('scan-files'), photo());
    await userEvent.click(screen.getByTestId('scan-start'));
    expect((await screen.findByRole('alert')).textContent).toContain('168 × 168 px');

    ocr.recognize.mockResolvedValue(MENU);
    await userEvent.click(screen.getByTestId('scan-start'));
    expect((await screen.findByTestId('scan-small')).textContent).toContain('168 × 168 px');
  });

  it('says so when no priced lines were found', async () => {
    api();
    ocr.recognize.mockResolvedValue([line('WELCOME', 10)]);
    render(<ScanPage />);
    await userEvent.upload(screen.getByTestId('scan-files'), photo());
    await userEvent.click(screen.getByTestId('scan-start'));
    expect((await screen.findByRole('alert')).textContent).toContain('No products');
  });

  it('moves selected products to another category, and undoes it', async () => {
    api();
    await scan();
    await userEvent.click(within(card('Garlic Bread')).getByRole('checkbox'));
    await userEvent.selectOptions(
      screen.getByTestId('scan-move-to'),
      column('DRINKS').dataset.name!,
    );
    expect(names('DRINKS')).toEqual(['Lime Juice', 'Garlic Bread']);
    expect(names('STARTERS')).toEqual(['Chicken Soup']);
    await userEvent.click(screen.getByTestId('scan-undo'));
    expect(names('STARTERS')).toEqual(['Chicken Soup', 'Garlic Bread']);
  });

  it('renames a category inline and merges one into another', async () => {
    api();
    await scan();
    await userEvent.click(within(column('DRINKS')).getByTestId('scan-category-title'));
    const input = within(column('DRINKS')).getByTestId('scan-category-name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Beverages{Enter}');
    expect(column('Beverages')).toBeDefined();

    await userEvent.click(within(column('Beverages')).getByTestId('scan-category-menu'));
    await userEvent.click(await screen.findByText('Merge into…'));
    await userEvent.click(await screen.findByTestId('scan-apply'));
    expect(screen.getAllByTestId('scan-category').map((c) => c.dataset.name)).toEqual(['STARTERS']);
    expect(names('STARTERS')).toEqual(['Chicken Soup', 'Garlic Bread', 'Lime Juice']);
  });

  it('blocks the import while a product has a problem', async () => {
    api();
    await scan();
    const price = within(card('Lime Juice')).getByTestId('scan-product-price');
    await userEvent.clear(price);
    expect(screen.getByTestId('scan-problems').textContent).toContain('1 problems');
    expect(screen.getByTestId<HTMLButtonElement>('scan-import').disabled).toBe(true);
    await userEvent.type(price, '3,50');
    expect(screen.queryByTestId('scan-problems')).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>('scan-import').disabled).toBe(false);
  });

  it('imports the board as rows, shows the summary and forgets the draft', async () => {
    const posts = api();
    await scan();
    expect(Object.keys(window.localStorage).some((k) => k.startsWith('menu-scan-draft:'))).toBe(
      true,
    );
    await userEvent.click(screen.getByTestId('scan-import'));
    expect((await screen.findByTestId('scan-done')).textContent).toContain('2 new');
    expect(posts).toEqual([
      {
        rows: [
          { category: 'STARTERS', name: 'Chicken Soup', price: '450.00', taxRate: '7' },
          { category: 'STARTERS', name: 'Garlic Bread', price: '1200.00', taxRate: '7' },
          { category: 'DRINKS', name: 'Lime Juice', price: '350.00', taxRate: '19' },
        ],
      },
    ]);
    expect(Object.keys(window.localStorage).some((k) => k.startsWith('menu-scan-draft:'))).toBe(
      false,
    );
  });

  it('restores an unfinished scan after a reload', async () => {
    api();
    await scan();
    cleanup();
    render(<ScanPage />);
    expect(await screen.findByTestId('scan-board')).toBeDefined();
    expect(screen.getByText('Your unfinished scan was restored.')).toBeDefined();
    expect(names('DRINKS')).toEqual(['Lime Juice']);
  });
});
