// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { TablesPage } from '../tables/tables-page';
import { FloorPage } from './floor-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

/** The published floor plan on Service and Tables (ADR 0073). */
const id = (n: number) => `0190a000-0000-7000-8000-00000000d${String(n).padStart(3, '0')}`;
const HERE = id(1);
const ROOM = id(2);
const TERRACE = id(3);
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const order = (tableId: string, readyCount = 0) => ({
  id: id(90),
  number: 'ORD-2026-000001',
  tableId,
  tableName: 'T1',
  locationId: HERE,
  status: 'open',
  openedAt: minutesAgo(42),
  closedAt: null,
  covers: null,
  itemCount: 3,
  gross: '13.80',
  readyCount,
  unbilled: '13.80',
});
const floorTable = (n: number, name: string, area: string | null, extra: object = {}) => ({
  id: id(10 + n),
  locationId: HERE,
  name,
  seats: 4,
  area,
  shape: 'square',
  color: 'neutral',
  order: null,
  seatedAt: null,
  lastOrderAt: null,
  ...extra,
});
const spot = (n: number, tableId: string) => ({
  key: `t-${n}`,
  x: n * 100,
  y: 100,
  width: 80,
  height: 80,
  tableId,
  create: null,
});
const LAYOUT = {
  room: { width: 1000, height: 600 },
  tables: [spot(1, id(11)), spot(2, id(12)), spot(3, id(15)), spot(4, id(99))],
  pieces: [{ key: 'bar-1', kind: 'bar', x: 0, y: 500, width: 300, height: 60 }],
};
const PLAN = { areaId: ROOM, areaName: 'Room', version: 2, layout: LAYOUT };

const FLOOR = [
  floorTable(1, 'T1', 'Room', { order: order(id(11), 2), seatedAt: minutesAgo(42) }),
  floorTable(2, 'T2', 'Room'),
  // In the area, not on the plan.
  floorTable(3, 'T3', 'Room'),
  floorTable(4, 'G1', 'Terrace'),
  // On the plan, but moved to the terrace since.
  floorTable(5, 'G2', 'Terrace'),
];

let answers: Record<string, () => Response>;
const asked: string[] = [];

beforeEach(() => {
  resetMocks();
  asked.length = 0;
  mockState.pathname = '/service';
  mockState.session = null;
  answers = {
    '/api/v1/locations': () =>
      Response.json({ data: [{ id: HERE, name: 'Main street', brandId: id(8) }] }),
    '/api/v1/settings': () =>
      Response.json({
        data: [
          { key: 'locale', value: 'en', source: 'default', dataBound: false },
          { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
        ],
      }),
    '/api/v1/pos/floor': () => Response.json({ data: FLOOR }),
    '/api/v1/pos/floor/plans': () => Response.json({ data: [PLAN] }),
  };
  mockState.store.apiFetch.mockImplementation((input: string) => {
    const path = input.split('?')[0]!;
    asked.push(input);
    return Promise.resolve(answers[path]?.() ?? Response.json({ data: [] }));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signedIn = (role: SystemRole = 'waiter') => {
  mockState.session = sessionFixture({
    activeFeatures: ['pos'],
    activePermissions: [...systemRolePermissions(role)],
  });
};
const screenWidth = (width: number) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
const names = (testId: string) => screen.queryAllByTestId(testId).map((e) => e.dataset.name);

describe('the floor plan on Service', () => {
  it('draws the tables of the area in place, and lists the others', async () => {
    signedIn();
    render(<FloorPage />);
    const plan = await screen.findByTestId('floor-plan');
    // G2 left the area and an unknown table is gone: neither is drawn.
    expect(names('floor-plan-table')).toEqual(['T1', 'T2']);
    expect(within(plan).getAllByTestId('plan-piece')).toHaveLength(1);
    const [t1, t2] = screen.getAllByTestId('floor-plan-table');
    expect(t1!.parentElement!.style.left).toBe('10%');
    expect(t1!.getAttribute('href')).toBe(`/service/${id(11)}`);
    expect(t1!.dataset.state).toBe('open');
    expect(t1!.textContent).toBe('T142 min2');
    await waitFor(() =>
      expect(t1!.getAttribute('aria-label')).toBe(
        'T1: Open, €13.80, Seated 42 min, Ready to serve: 2',
      ),
    );
    expect(t2!.textContent).toBe('T24 seats');
    expect(names('floor-table')).toEqual(['T3', 'G1', 'G2']);
    expect(screen.getByText('Not on the plan')).toBeTruthy();
    expect(
      screen.getAllByTestId('floor-area').map((a) => a.querySelector('h2')?.textContent),
    ).toEqual(['Room', 'Terrace']);
  });

  it('dims what the filter leaves out and keeps it in place', async () => {
    signedIn();
    render(<FloorPage />);
    await screen.findByTestId('floor-plan');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dimmed = () =>
      screen.getAllByTestId('floor-plan-table').map((e) => e.className.includes('opacity-35'));
    expect(dimmed()).toEqual([false, true]);
    expect(names('floor-table')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Free' }));
    expect(dimmed()).toEqual([true, false]);
    expect(names('floor-table')).toEqual(['T3', 'G1', 'G2']);
  });

  it('switches to the list and back through the address', async () => {
    signedIn();
    render(<FloorPage />);
    await screen.findByTestId('floor-plan');
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(mockState.router.replace).toHaveBeenCalledWith('/service?view=list');
    cleanup();
    mockState.search = 'view=list';
    render(<FloorPage />);
    await screen.findByTestId('floor-view');
    expect(screen.queryByTestId('floor-plan')).toBeNull();
    expect(names('floor-table')).toEqual(['T1', 'T2', 'T3', 'G1', 'G2']);
    await userEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(mockState.router.replace).toHaveBeenLastCalledWith('/service');
  });

  it('is a list on phones, without plans, and when plans fail to load', async () => {
    signedIn();
    screenWidth(390);
    render(<FloorPage />);
    await screen.findAllByTestId('floor-table');
    await waitFor(() => expect(asked.some((a) => a.includes('/pos/floor/plans'))).toBe(true));
    expect(names('floor-table')).toHaveLength(5);
    expect(screen.queryByTestId('floor-view')).toBeNull();
    cleanup();
    screenWidth(1280);
    for (const answer of [
      () => Response.json({ data: [] }),
      () => Response.json({ code: 'x', message: 'x' }, { status: 500 }),
    ]) {
      answers['/api/v1/pos/floor/plans'] = answer;
      render(<FloorPage />);
      await screen.findAllByTestId('floor-table');
      expect(names('floor-table')).toHaveLength(5);
      expect(screen.queryByTestId('floor-view')).toBeNull();
      cleanup();
    }
  });
});

describe('the floor plan on Tables', () => {
  const area = (areaId: string, name: string, livePlan?: boolean) => ({
    id: areaId,
    locationId: HERE,
    name,
    sortOrder: 0,
    tableCount: 1,
    ...(livePlan === undefined ? {} : { livePlan }),
  });
  const table = (n: number, name: string, areaId: string | null) => ({
    id: id(10 + n),
    locationId: HERE,
    name,
    seats: 4,
    areaId,
    area: null,
    shape: 'round',
    color: 'teal',
    sortOrder: 0,
    floorX: 100,
    floorY: 100,
    archivedAt: null,
    menuCode: `code${String(n).padStart(20, '0')}`,
  });
  const arranged = () => screen.getAllByTestId('table-card')[0]!.parentElement!.dataset.arranged;

  beforeEach(() => {
    answers['/api/v1/pos/tables'] = () =>
      Response.json({
        data: [table(1, 'T1', ROOM), table(4, 'G1', TERRACE), table(6, 'L1', null)],
      });
    answers['/api/v1/pos/areas'] = () =>
      // The terrace as an older api answers it: no plan.
      Response.json({ data: [area(ROOM, 'Room', true), area(TERRACE, 'Terrace')] });
    answers[`/api/v1/pos/areas/${ROOM}/floor-plan`] = () =>
      Response.json({
        area: { id: ROOM, locationId: HERE, name: 'Room' },
        latest: { version: 2, layout: LAYOUT },
        live: { version: 2, layout: LAYOUT },
        history: [],
      });
  });
  const tab = (name: RegExp) => userEvent.click(screen.getByRole('tab', { name }));

  it('shows the plan of the area with its state, and the tables to manage below', async () => {
    signedIn('owner');
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    // Several rooms don't share a canvas: "All" is a grid.
    expect(arranged()).toBe('false');
    await tab(/Room/);
    const plan = await screen.findByTestId('area-plan');
    expect(
      within(plan)
        .getAllByTestId('plan-table')
        .map((e) => e.dataset.key),
    ).toEqual(['t-1']);
    expect(plan.textContent).toContain('Occupied');
    expect(names('table-card')).toEqual(['T1']);
    expect(arranged()).toBe('false');
    const link = screen.getByTestId('area-plan-link');
    expect([link.textContent, link.getAttribute('href')]).toEqual([
      'Edit plan',
      `/tables/plan/${ROOM}`,
    ]);
    // Without a plan: dragging as before, and the way to make one.
    await tab(/Terrace/);
    expect(screen.queryByTestId('area-plan')).toBeNull();
    expect(arranged()).toBe('true');
    expect(screen.getByTestId('area-plan-link').textContent).toBe('Create plan');
    await tab(/No area/);
    expect(arranged()).toBe('true');
  });

  it('keeps "All" as it was while no area has a plan', async () => {
    signedIn('owner');
    answers['/api/v1/pos/areas'] = () =>
      Response.json({ data: [area(ROOM, 'Room', false), area(TERRACE, 'Terrace')] });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    expect(arranged()).toBe('true');
  });

  it('lets others look, without the way to edit', async () => {
    signedIn('waiter');
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await tab(/Room/);
    expect(await screen.findByTestId('area-plan')).toBeTruthy();
    expect(screen.queryByTestId('area-plan-link')).toBeNull();
  });
});
