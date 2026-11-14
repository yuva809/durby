// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { AuditPage } from './audit-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(() => {
  resetMocks();
  mockState.pathname = '/audit';
});
afterEach(cleanup);

const USER = '0190a000-0000-7000-8000-000000000002';
const ROLE = '0190a000-0000-7000-8000-000000000101';

const signedInAs = (key: SystemRole) => {
  mockState.session = sessionFixture({
    activeRole: { id: ROLE, systemKey: key, name: null },
    activePermissions: [...systemRolePermissions(key)],
  });
};

const entry = (n: number, extra: object = {}) => ({
  id: `0190a000-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`,
  actor: { type: 'user', userId: USER, email: 'owner@example.test' },
  action: 'platform.setting_value.updated',
  entityType: 'setting_value',
  entityId: '0190a000-0000-7000-8000-000000000401',
  before: { id: 'x', key: 'timezone', scopeType: 'organization', value: '"Europe/Berlin"' },
  after: { id: 'x', key: 'timezone', scopeType: 'organization', value: '"Europe/Vienna"' },
  requestId: 'req-123',
  ip: '203.0.113.7',
  createdAt: '2026-10-25T23:30:00.000Z',
  ...extra,
});

const page = (data: object[], nextCursor: string | null = null) =>
  Response.json({ data, meta: { nextCursor, limit: 50 } });

/** Answers audit pages by query and the display helpers; records the audit queries. */
function api(audit: (query: URLSearchParams) => Response, timeZone = 'Europe/Berlin') {
  mockState.store.apiFetch.mockImplementation((input: string) => {
    const url = new URL(input, 'http://web.test');
    if (url.pathname === '/api/v1/audit-logs') return Promise.resolve(audit(url.searchParams));
    if (url.pathname === '/api/v1/settings') {
      return Promise.resolve(
        Response.json({
          data: [{ key: 'timezone', value: timeZone, source: 'organization', dataBound: false }],
        }),
      );
    }
    if (url.pathname === '/api/v1/members') {
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: ROLE,
              userId: USER,
              email: 'owner@example.test',
              role: null,
              allLocations: true,
              locationIds: [],
            },
          ],
        }),
      );
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
}

const auditQueries = () =>
  mockState.store.apiFetch.mock.calls
    .map(([input]) => new URL(input, 'http://web.test'))
    .filter((u) => u.pathname === '/api/v1/audit-logs')
    .map((u) => Object.fromEntries(u.searchParams));

describe('AuditPage', () => {
  it('shows "no access" to a Manager (no platform.audit.read) and loads nothing', () => {
    signedInAs('manager');
    render(<AuditPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
    expect(mockState.store.apiFetch).not.toHaveBeenCalled();
  });

  it('shows who, what, when (org time zone) and a readable diff; details hold ids and IP', async () => {
    signedInAs('owner');
    api(() => page([entry(1)]));
    render(<AuditPage />);
    const card = await screen.findByTestId('audit-entry');
    expect(within(card).getByTestId('audit-what').textContent).toBe('Setting changed');
    expect(within(card).getByTestId('audit-who').textContent).toBe('owner@example.test');
    // 23:30 UTC is 00:30 the next day in Berlin (winter time from 25 Oct).
    expect(within(card).getByText('2026-10-26 12:30 AM')).toBeTruthy();
    // The one-line detail names the changed field; the full before/after opens below the row.
    expect(within(card).getByTestId('audit-detail').textContent).toContain('Changed:');
    expect(screen.queryByTestId('audit-diff')).toBeNull();
    await userEvent.click(within(card).getByTestId('audit-toggle'));
    const value = screen.getAllByTestId('audit-diff-row').find((r) => r.dataset.field === 'value')!;
    expect(value.dataset.changed).toBe('true');
    expect(within(value).getByTestId('audit-before').textContent).toBe('Before: Europe/Berlin');
    expect(within(value).getByTestId('audit-after').textContent).toBe('After: Europe/Vienna');
    expect(within(value).getByText('Changed')).toBeTruthy();
    const key = screen.getAllByTestId('audit-diff-row').find((r) => r.dataset.field === 'key')!;
    expect(key.dataset.changed).toBe('false');
    expect(screen.getByTestId('audit-details').textContent).toContain('203.0.113.7');
    expect(screen.getByTestId('audit-details').textContent).toContain('req-123');
  });

  it('labels system actors and users that no longer exist', async () => {
    signedInAs('owner');
    api(() =>
      page([
        entry(1, { actor: { type: 'system', key: 'cli.create_admin' } }),
        entry(2, { actor: { type: 'user', userId: USER, email: null } }),
      ]),
    );
    render(<AuditPage />);
    const who = (await screen.findAllByTestId('audit-who')).map((w) => w.textContent);
    expect(who).toEqual(['Setup command (create-admin)', 'A user who no longer exists']);
  });

  it('reads filters from the URL and sends them, dates as instants in the org time zone', async () => {
    signedInAs('owner');
    mockState.search = `action=platform.role.created&actor=${USER}&from=2026-10-25&to=2026-10-25&bogus=1`;
    api(() => page([]));
    render(<AuditPage />);
    expect(await screen.findByTestId('audit-empty')).toBeTruthy();
    expect(screen.getByTestId('audit-empty').textContent).toBe('No entries match these filters.');
    expect(auditQueries()).toEqual([
      {
        action: 'platform.role.created',
        actorUserId: USER,
        from: '2026-10-24T22:00:00.000Z',
        to: '2026-10-25T23:00:00.000Z',
      },
    ]);
  });

  it('applies filters as soon as they change, by updating the URL', async () => {
    signedInAs('owner');
    api(() => page([entry(1)]));
    render(<AuditPage />);
    await screen.findByTestId('audit-entry');
    await userEvent.selectOptions(screen.getByTestId('filter-entity'), 'setting_value');
    expect(mockState.router.replace).toHaveBeenCalledWith('/audit?entityType=setting_value');
    await userEvent.selectOptions(screen.getByTestId('filter-module'), 'platform');
    expect(mockState.router.replace).toHaveBeenLastCalledWith('/audit?module=platform');
    await userEvent.click(screen.getByTestId('audit-toggle'));
    await userEvent.click(screen.getByTestId('audit-only-actor'));
    expect(mockState.router.replace).toHaveBeenLastCalledWith(`/audit?actor=${USER}`);
  });

  it('searches the loaded entries without asking the api again', async () => {
    signedInAs('owner');
    api(() => page([entry(1)]));
    mockState.search = 'q=nobody-matches-this';
    render(<AuditPage />);
    expect(await screen.findByTestId('audit-empty')).toBeTruthy();
    expect(auditQueries()).toEqual([{}]);
  });

  it('loads more with the cursor and appends', async () => {
    signedInAs('owner');
    api((q) => (q.get('cursor') === 'c1' ? page([entry(2)]) : page([entry(1)], 'c1')));
    render(<AuditPage />);
    expect(await screen.findAllByTestId('audit-entry')).toHaveLength(1);
    await userEvent.click(screen.getByTestId('audit-more'));
    await waitFor(() => expect(screen.getAllByTestId('audit-entry')).toHaveLength(2));
    expect(screen.queryByTestId('audit-more')).toBeNull();
  });

  it('shows the error label with a retry, and the empty state without filters', async () => {
    signedInAs('owner');
    let fail = true;
    api(() => (fail ? new Response('down', { status: 503 }) : page([])));
    render(<AuditPage />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findByTestId('audit-empty')).textContent).toBe(
      'Nothing has been recorded yet.',
    );
  });

  it('starts over when the cursor is no longer valid', async () => {
    signedInAs('owner');
    api((q) =>
      q.get('cursor') === 'stale'
        ? Response.json({ code: 'audit.cursor_invalid' }, { status: 400 })
        : page([entry(1)], 'stale'),
    );
    render(<AuditPage />);
    await screen.findByTestId('audit-entry');
    await userEvent.click(screen.getByTestId('audit-more'));
    await waitFor(() => expect(auditQueries().filter((q) => !q.cursor)).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
