import { createTranslator } from '@durby/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../auth/session';
import { createLabelsCache, fetchLabels, LABELS_API, localeOf } from './labels';

function storeWith(apiFetch: SessionStore['apiFetch']): SessionStore {
  return {
    get: () => null,
    subscribe: () => () => undefined,
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    switchOrganization: vi.fn(),
    apiFetch,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('localeOf', () => {
  it("uses the user's locale if supported", () => {
    expect(localeOf({ user: { id: 'u', email: 'e', locale: 'de' } })).toBe('de');
    expect(localeOf({ user: { id: 'u', email: 'e', locale: 'fr' } })).toBe('en');
  });
});

describe('fetchLabels', () => {
  it('loads the dictionary of a locale and keeps only known keys', async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      json(200, {
        locale: 'de',
        data: { 'inventory.nav.title': 'Produkte', 'unknown.key': 'x' },
      }),
    );
    expect(await fetchLabels(storeWith(apiFetch), 'de')).toEqual({
      'inventory.nav.title': 'Produkte',
    });
    expect(apiFetch).toHaveBeenCalledWith(`${LABELS_API}?locale=de`);
  });

  it.each([
    ['a 403', () => Promise.resolve(json(403, { code: 'rbac.permission_denied' }))],
    ['a malformed body', () => Promise.resolve(json(200, { data: 'x' }))],
    ['another locale', () => Promise.resolve(json(200, { locale: 'en', data: {} }))],
    ['a network error', () => Promise.reject(new Error('offline'))],
  ])('returns null on %s (callers use the defaults)', async (_, response) => {
    expect(await fetchLabels(storeWith(vi.fn(response)), 'de')).toBeNull();
  });
});

describe('createLabelsCache', () => {
  it('loads once per user, organization and locale', async () => {
    const load = vi.fn().mockResolvedValue({ 'inventory.nav.title': 'Products' });
    const cache = createLabelsCache(load);
    await cache.get('u1', 'org-a', 'en');
    await cache.get('u1', 'org-a', 'en');
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('u1', 'org-b', 'en'); // switched organization
    await cache.get('u1', 'org-a', 'de');
    await cache.get('u2', 'org-a', 'en'); // another user in this tab
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('retries a failed load next time', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ 'inventory.nav.title': 'Products' });
    const cache = createLabelsCache(load);
    expect(await cache.get('u1', 'org-a', 'en')).toBeNull();
    expect(await cache.get('u1', 'org-a', 'en')).toEqual({ 'inventory.nav.title': 'Products' });
  });
});

describe('rendering overrides', () => {
  it('renders an override as text, never as markup', () => {
    const t = createTranslator('en', { 'inventory.nav.title': '<b>x</b>' });
    expect(renderToStaticMarkup(createElement('li', null, t('inventory.nav.title')))).toBe(
      '<li>&lt;b&gt;x&lt;/b&gt;</li>',
    );
  });
});
