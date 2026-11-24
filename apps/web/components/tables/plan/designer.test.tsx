// @vitest-environment jsdom
import {
  type AreaFloorPlanResponse,
  type FloorPlanLayout,
  floorPlanLayoutSchema,
  type SystemRole,
  systemRolePermissions,
} from '@durby/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../../test/mocks';
import { sessionFixture } from '../../../test/session-fixture';
import { DesignerPage } from './designer-page';

vi.mock('../../../app/providers', async () =>
  (await import('../../../test/mocks')).providersMock(),
);
vi.mock('../../../app/labels-provider', async () =>
  (await import('../../../test/mocks')).labelsMock(),
);
vi.mock('next/navigation', async () => (await import('../../../test/mocks')).navigationMock());

const id = (n: number) => `0190a000-0000-7000-8000-00000000c${String(n).padStart(3, '0')}`;
const AREA = { id: id(1), locationId: id(2), name: 'Room' };
const table = (n: number, name: string, areaId: string | null = AREA.id) => ({
  id: id(10 + n),
  locationId: AREA.locationId,
  name,
  seats: 4,
  areaId,
  area: areaId ? 'Room' : null,
  shape: 'square',
  color: 'neutral',
  sortOrder: 0,
  floorX: 0,
  floorY: 0,
  archivedAt: null,
  menuCode: `code${String(n).padStart(20, '0')}`,
});
const LAYOUT: FloorPlanLayout = {
  room: { width: 1000, height: 600 },
  tables: [{ key: 't-1', x: 100, y: 100, width: 80, height: 80, tableId: id(11), create: null }],
  pieces: [{ key: 'wall-1', kind: 'wall', x: 0, y: 0, width: 300, height: 20 }],
};
const info = (version: number, extra: object = {}) => ({
  version,
  restoredFrom: null,
  tables: 1,
  pieces: 1,
  createdAt: '2026-11-24T10:00:00.000Z',
  createdBy: 'Anna',
  ...extra,
});

let plan: AreaFloorPlanResponse;
let tables: ReturnType<typeof table>[];
let answers: Record<string, () => Response>;
const writes: { path: string; body: Record<string, unknown> }[] = [];

const signedIn = (role: SystemRole = 'owner', without: string[] = []) => {
  mockState.session = sessionFixture({
    activeFeatures: ['pos'],
    activePermissions: [...systemRolePermissions(role)].filter((p) => !without.includes(p)),
  });
};

/** 1000 units are 500 px: a pixel is two units. */
beforeEach(() => {
  resetMocks();
  writes.length = 0;
  plan = {
    area: AREA,
    latest: { version: 2, layout: LAYOUT },
    live: { version: 1, layout: { ...LAYOUT, pieces: [] } },
    history: [info(2, { restoredFrom: 1 }), info(1, { pieces: 0 })],
  };
  tables = [table(1, 'T1'), table(2, 'T2'), table(9, 'T9', null)];
  answers = {};
  const base = `/api/v1/pos/areas/${AREA.id}/floor-plan`;
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const path = input.split('?')[0]!;
    const short = path.startsWith(base) ? path.slice(base.length) : path;
    if (init?.method === 'POST') {
      writes.push({
        path: short,
        body: JSON.parse(init.body as string) as Record<string, unknown>,
      });
    }
    const answer = answers[`${init?.method ?? 'GET'} ${short}`];
    if (answer) return Promise.resolve(answer());
    if (path === base) return Promise.resolve(Response.json(plan));
    if (path === '/api/v1/pos/tables') return Promise.resolve(Response.json({ data: tables }));
    return Promise.resolve(Response.json({ code: 'x', message: 'x' }, { status: 404 }));
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 500,
    height: 300,
  } as DOMRect);
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    Object.defineProperty(Element.prototype, name, { value: () => undefined, configurable: true });
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = async () => {
  render(<DesignerPage areaId={AREA.id} />);
  await screen.findByTestId('plan-canvas');
};
const item = (key: string) =>
  screen.getAllByTestId('plan-item').find((e) => e.dataset.key === key)!;
const items = () => screen.queryAllByTestId('plan-item').map((e) => e.dataset.key);
const focus = (key: string) => act(() => item(key).focus());
const left = (key: string) => item(key).style.left;
const asButton = (element: HTMLElement): HTMLButtonElement => element as HTMLButtonElement;
const status = () => screen.getByTestId('plan-status').textContent;
const drag = (target: Element, dx: number, dy: number) => {
  const at = { pointerId: 1, button: 0 };
  fireEvent.pointerDown(target, { ...at, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(target, { ...at, clientX: 100 + dx / 2, clientY: 100 + dy / 2 });
  fireEvent.pointerMove(target, { ...at, clientX: 100 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(target, { ...at, clientX: 100 + dx, clientY: 100 + dy });
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const savedLayout = () => floorPlanLayoutSchema.parse(writes.at(-1)!.body.layout);

describe('floor plan designer', () => {
  it('drags with the grid, resizes at the corner, and undoes each as one step', async () => {
    signedIn();
    await open();
    expect(left('t-1')).toBe('10%');
    expect(status()).toContain('Published: version 1');
    expect(status()).toContain('Saved as version 2');
    // 53 px are 106 units: 100 + 106 snaps to 210.
    drag(item('t-1'), 53, 0);
    expect(left('t-1')).toBe('21%');
    expect(status()).toContain('Unsaved changes');
    fireEvent.pointerDown(screen.getByTestId('plan-resize'), {
      pointerId: 2,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(item('t-1'), { pointerId: 2, clientX: 20, clientY: 0 });
    fireEvent.pointerUp(item('t-1'), { pointerId: 2, clientX: 20, clientY: 0 });
    expect(item('t-1').style.width).toBe('12%');
    await userEvent.click(button('Undo'));
    expect([left('t-1'), item('t-1').style.width]).toEqual(['21%', '8%']);
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    expect(left('t-1')).toBe('10%');
    expect(status()).toContain('Saved as version 2');
    fireEvent.keyDown(document, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(left('t-1')).toBe('21%');
  });

  it('works by keyboard and by exact values', async () => {
    signedIn();
    await open();
    focus('t-1');
    fireEvent.keyDown(item('t-1'), { key: 'ArrowRight' });
    expect(left('t-1')).toBe('11%');
    fireEvent.keyDown(item('t-1'), { key: 'ArrowRight', altKey: true });
    expect(left('t-1')).toBe('11.1%');
    const x = screen.getByLabelText('From the left');
    await userEvent.clear(x);
    await userEvent.type(x, '500{Enter}');
    expect(left('t-1')).toBe('50%');
    await userEvent.clear(x);
    await userEvent.type(x, 'abc{Enter}');
    expect((x as HTMLInputElement).value).toBe('500');
    fireEvent.keyDown(item('wall-1'), { key: 'Delete' });
    expect(items()).toEqual(['t-1']);
  });

  it('takes a table off the plan and puts it back; it stays a table', async () => {
    signedIn();
    await open();
    const list = screen.getByTestId('plan-unplaced');
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['T2']);
    focus('t-1');
    await userEvent.click(button('Take off the plan'));
    expect(items()).toEqual(['wall-1']);
    await userEvent.click(button('Put T1 on the plan'));
    await userEvent.click(button('Put T2 on the plan'));
    expect(list.textContent).toContain('Every table of this area is on the plan.');
    expect(writes).toEqual([]);
  });

  it('adds pieces, marks overlaps and changes the room', async () => {
    signedIn();
    await open();
    await userEvent.click(button('Add Bar'));
    expect(items()).toContain('bar-1');
    expect(screen.queryByTestId('plan-overlaps')).toBeNull();
    await userEvent.click(button('Put T2 on the plan'));
    const x = screen.getByLabelText('From the left');
    await userEvent.clear(x);
    await userEvent.type(x, '120{Enter}');
    const y = screen.getByLabelText('From the top');
    await userEvent.clear(y);
    await userEvent.type(y, '120{Enter}');
    expect(screen.getByTestId('plan-overlaps').textContent).toBe('Overlapping tables: T1, T2');
    await userEvent.selectOptions(screen.getByLabelText('Room shape'), 'tall');
    expect(screen.getByTestId('plan-canvas').style.aspectRatio).toBe('600 / 1000');
  });

  it('saves on top of the version it started from', async () => {
    signedIn();
    await open();
    expect(asButton(button('Save')).disabled).toBe(true);
    drag(item('t-1'), 50, 0);
    await userEvent.click(button('Add Bar'));
    answers['POST /versions'] = () => {
      // As the api answers: in the schema's field order, not the editor's.
      const layout = floorPlanLayoutSchema.parse(writes.at(-1)!.body.layout);
      plan = { ...plan, latest: { version: 3, layout }, history: [info(3), ...plan.history] };
      return Response.json({ version: 3, layout }, { status: 201 });
    };
    await userEvent.click(button('Save'));
    await waitFor(() => expect(status()).toContain('Saved as version 3'));
    expect(writes[0]!.body.baseVersion).toBe(2);
    expect(savedLayout().tables[0]!.x).toBe(200);
    expect(screen.getAllByTestId('plan-version')).toHaveLength(3);
    // What was done stays undoable.
    await userEvent.click(button('Undo'));
    await userEvent.click(button('Undo'));
    expect(left('t-1')).toBe('10%');
  });

  it('says when someone else saved, and loads theirs', async () => {
    signedIn();
    await open();
    drag(item('t-1'), 50, 0);
    answers['POST /versions'] = () =>
      Response.json({ code: 'pos.floor_plan_changed', message: 'x' }, { status: 409 });
    await userEvent.click(button('Save'));
    expect((await screen.findByTestId('plan-conflict')).textContent).toContain(
      'Someone else saved this plan',
    );
    // Nothing is lost until asked.
    expect(left('t-1')).toBe('20%');
    plan = {
      ...plan,
      latest: {
        version: 3,
        layout: { ...LAYOUT, tables: [{ ...LAYOUT.tables[0]!, x: 700 }] },
      },
    };
    await userEvent.click(button('Load the newest version'));
    await waitFor(() => expect(left('t-1')).toBe('70%'));
    expect(screen.queryByTestId('plan-conflict')).toBeNull();
    expect(status()).toContain('Saved as version 3');
  });

  it('generates a draft with new tables, as one step back', async () => {
    signedIn();
    await open();
    await userEvent.click(screen.getByTestId('plan-generate'));
    const dialog = within(await screen.findByRole('dialog'));
    const field = async (name: string, value: string) => {
      await userEvent.clear(dialog.getByLabelText(name));
      await userEvent.type(dialog.getByLabelText(name), value);
    };
    const submit = () => userEvent.click(dialog.getByRole('button', { name: 'Generate' }));
    expect(dialog.getByLabelText<HTMLInputElement>('Tables in all').value).toBe('2');
    await field('Tables in all', '1');
    await submit();
    expect(dialog.getByRole('alert').textContent).toContain('has 2 tables already');
    await field('Tables in all', '99');
    expect(dialog.getByRole('alert').textContent).toMatch(/Room for \d+ tables of this kind/);
    await field('Room width (m)', '1');
    expect(dialog.getByRole('alert').textContent).toContain('2 to 60 metres');
    await field('Room width (m)', '9,5');
    await field('Tables in all', '4');
    await submit();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(items()).toEqual(['t-1', 't-2', 't-3', 't-4']);
    // T9 is at the location already, outside this area.
    expect(item('t-3').textContent).toBe('T34');
    expect(writes).toEqual([]);
    await userEvent.click(button('Undo'));
    expect(items()).toEqual(['wall-1', 't-1']);
  });

  it('renames a new table and refuses an empty or doubled name', async () => {
    signedIn();
    const create = (name: string) => ({ name, seats: 4, shape: 'round' as const });
    plan.latest!.layout = {
      ...LAYOUT,
      tables: [
        { ...LAYOUT.tables[0]!, tableId: null, create: create('T3') },
        { ...LAYOUT.tables[0]!, key: 't-2', x: 300, tableId: null, create: create('T4') },
      ],
    };
    await open();
    focus('t-1');
    const name = screen.getByLabelText('Name');
    const type = async (text: string) => {
      await userEvent.clear(name);
      await userEvent.type(name, `${text}{Enter}`);
    };
    await type('T4');
    expect((name as HTMLInputElement).value).toBe('T3');
    await type(' ');
    expect((name as HTMLInputElement).value).toBe('T3');
    await type('Window');
    const seats = screen.getByLabelText('Seats');
    await userEvent.clear(seats);
    await userEvent.type(seats, '6{Enter}');
    expect(item('t-1').textContent).toBe('Window6');
  });

  it('publishes the saved version after saying what it does', async () => {
    signedIn();
    const layout = {
      ...LAYOUT,
      tables: [
        ...LAYOUT.tables,
        {
          ...LAYOUT.tables[0]!,
          key: 't-2',
          x: 300,
          tableId: null,
          create: { name: 'T3', seats: 4, shape: 'square' as const },
        },
      ],
    };
    plan.latest = { version: 2, layout };
    await open();
    await userEvent.click(screen.getByTestId('plan-publish'));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(/New tables are created: T3\./).textContent).toContain(
      'Tables on it: 2',
    );
    answers['POST /publish'] = () => {
      const done = {
        ...layout,
        tables: layout.tables.map((x) => (x.create ? { ...x, tableId: id(13), create: null } : x)),
      };
      tables = [...tables, table(3, 'T3')];
      plan = {
        ...plan,
        latest: { version: 3, layout: done },
        live: { version: 3, layout: done },
      };
      return Response.json(
        { version: 3, layout: done, created: [{ id: id(13), name: 'T3' }] },
        { status: 201 },
      );
    };
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(status()).toContain('Published: version 3'));
    expect(writes.at(-1)).toEqual({ path: '/publish', body: { version: 2 } });
    expect(screen.getByText('Published.')).toBeTruthy();
    expect(item('t-2').textContent).toBe('T34');
    expect(asButton(screen.getByTestId('plan-publish')).disabled).toBe(true);
  });

  it('shows why publishing failed', async () => {
    signedIn();
    await open();
    answers['POST /publish'] = () =>
      Response.json({ code: 'pos.table_name_taken', message: 'x' }, { status: 409 });
    await userEvent.click(screen.getByTestId('plan-publish'));
    const dialog = within(await screen.findByRole('alertdialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    expect(
      await dialog.findByText('This location already has a table with this name.'),
    ).toBeTruthy();
  });

  it('does not publish unsaved changes, or new tables without the right to add some', async () => {
    signedIn();
    await open();
    drag(item('t-1'), 50, 0);
    const publish = asButton(screen.getByTestId('plan-publish'));
    expect([publish.disabled, publish.title]).toEqual([
      true,
      'Save the plan before publishing it.',
    ]);
    cleanup();
    signedIn('owner', ['pos.tables.create']);
    plan.latest!.layout = {
      ...LAYOUT,
      tables: [
        {
          ...LAYOUT.tables[0]!,
          tableId: null,
          create: { name: 'T3', seats: 4, shape: 'square' },
        },
      ],
    };
    await open();
    expect(asButton(screen.getByTestId('plan-publish')).disabled).toBe(true);
    expect(screen.getByText(/you may not add tables/)).toBeTruthy();
  });

  it('shows an old version, and restores it as the newest', async () => {
    signedIn();
    await open();
    const old = { ...LAYOUT, tables: [{ ...LAYOUT.tables[0]!, x: 400 }], pieces: [] };
    answers['GET /versions/1'] = () => Response.json({ version: 1, layout: old });
    const versions = screen.getAllByTestId('plan-version');
    expect(versions[0]!.textContent).toContain('Restored from version 1');
    expect(versions[1]!.textContent).toContain('Published');
    expect(within(versions[0]!).queryByTestId('plan-restore')).toBeNull();
    await userEvent.click(within(versions[1]!).getByRole('button', { name: 'View' }));
    expect((await screen.findByTestId('plan-preview')).textContent).toContain(
      'You are looking at version 1.',
    );
    expect(screen.getByTestId('plan-table').style.left).toBe('40%');
    expect(screen.queryByTestId('plan-tools')).toBeNull();
    await userEvent.click(button('Back to editing'));
    expect(left('t-1')).toBe('10%');

    answers['POST /versions/1/restore'] = () => {
      plan = { ...plan, latest: { version: 3, layout: old } };
      return Response.json({ version: 3, layout: old }, { status: 201 });
    };
    await userEvent.click(screen.getByTestId('plan-restore'));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore' }),
    );
    await waitFor(() => expect(left('t-1')).toBe('40%'));
    expect(writes.at(-1)!.body).toEqual({ baseVersion: 2 });
  });

  it('leaves out tables that are gone and says so', async () => {
    signedIn();
    tables = [table(2, 'T2')];
    await open();
    expect(items()).toEqual(['wall-1']);
    expect(screen.getByTestId('plan-gone').textContent).toContain(': 1.');
    expect(status()).toContain('Unsaved changes');
  });

  it('asks before leaving with unsaved changes', async () => {
    signedIn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await open();
    const link = screen.getByRole('link', { name: 'Tables' });
    const follow = () => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      // jsdom can't navigate: only whether the page would let it.
      document.addEventListener('click', (e) => e.preventDefault(), { once: true });
      link.dispatchEvent(event);
    };
    follow();
    expect(confirm).not.toHaveBeenCalled();
    drag(item('t-1'), 50, 0);
    follow();
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave this page?');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('starts empty for an area without a plan', async () => {
    signedIn();
    plan = { area: AREA, latest: null, live: null, history: [] };
    await open();
    expect(items()).toEqual([]);
    expect(status()).toBe('No plan published yet · Nothing saved yet.');
    expect(screen.getByText(/The plan is empty/)).toBeTruthy();
  });

  it('is only to look at on a small screen or without the edit key', async () => {
    signedIn();
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await open();
    expect(screen.getByTestId('plan-view-only')).toBeTruthy();
    expect(screen.getByTestId('plan-table').textContent).toBe('T14');
    expect(screen.queryByTestId('plan-save')).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    signedIn('waiter');
    await open();
    expect(screen.queryByTestId('plan-save')).toBeNull();
    expect(screen.queryByTestId('plan-view-only')).toBeNull();
    cleanup();
    signedIn('kitchen');
    render(<DesignerPage areaId={AREA.id} />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });
});
