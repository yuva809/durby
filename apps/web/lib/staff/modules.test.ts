import type { CustomerEntitlements, FeatureCatalogResponse, FeatureKey } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  applyToggle,
  changesFor,
  currentState,
  differencesFromPlan,
  keptOverrides,
  planChangeEffect,
  planState,
  resetModule,
} from './modules';

// A fake catalog: the logic must not know real module names. Keys are cast, as the shared types
// only know the real registry.
const k = (key: string) => key as FeatureKey;
const feature = (key: string, dependsOn: string[] = [], order = 0) => ({
  key: k(key),
  label: `x.${key}`,
  description: `x.${key}.d`,
  dependsOn: dependsOn.map(k),
  order,
  limits: [],
});

const catalog: FeatureCatalogResponse = {
  modules: [
    { ...feature('base'), features: [] },
    { ...feature('till', ['base']), features: [feature('till.tax', ['till'])] },
    { ...feature('book', ['till']), features: [feature('book.web', ['book'])] },
    { ...feature('stock'), features: [feature('stock.count', ['stock'])] },
  ],
  plans: [
    { key: 'inventory', label: 'p.i', features: [k('base'), k('stock'), k('stock.count')] },
    {
      key: 'full',
      label: 'p.f',
      features: ['base', 'till', 'till.tax', 'book', 'book.web', 'stock', 'stock.count'].map(k),
    },
    { key: 'inventory_billing', label: 'p.ib', features: [k('base')] },
  ],
};

function entitlements(
  plan: 'inventory' | 'full',
  overrides: Record<string, { enabled: boolean; expired?: boolean }> = {},
): CustomerEntitlements {
  const inPlan = planState(catalog, plan);
  return {
    customerId: '00000000-0000-7000-8000-000000000000',
    plan,
    features: (Object.keys(inPlan) as FeatureKey[]).map((key) => {
      const o = overrides[key];
      return {
        key,
        enabled: false,
        inPlan: inPlan[key] ?? false,
        source: o ? 'override' : 'plan',
        blockedBy: [],
        override: o
          ? {
              enabled: o.enabled,
              limits: null,
              reason: 'r',
              expiresOn: null,
              expired: o.expired ?? false,
              setBy: null,
              updatedAt: '2026-11-11T00:00:00.000Z',
            }
          : null,
      };
    }),
  };
}

describe('applyToggle', () => {
  const none = planState(catalog, 'inventory');

  it('switches on what a key needs: a sub-feature ticks its module and that module’s needs', () => {
    const r = applyToggle(catalog, none, k('book.web'), true);
    expect(r.alsoOn).toEqual(['till', 'book']);
    expect(r.state).toMatchObject({ base: true, till: true, book: true, 'book.web': true });
  });

  it('switches off what needs a key: unticking a module unticks its sub-features and dependents', () => {
    const full = planState(catalog, 'full');
    const r = applyToggle(catalog, full, k('till'), false);
    expect(r.alsoOff).toEqual(['till.tax', 'book', 'book.web']);
    expect(r.state).toMatchObject({ base: true, till: false, book: false, stock: true });
  });

  it('reports nothing extra when nothing else changes', () => {
    expect(applyToggle(catalog, none, k('stock.count'), false)).toMatchObject({
      alsoOn: [],
      alsoOff: [],
    });
  });
});

describe('resetModule and differencesFromPlan', () => {
  it('sets a module card back to the plan without leaving a gap', () => {
    const plan = planState(catalog, 'inventory');
    const custom = applyToggle(catalog, plan, k('book.web'), true).state;
    const r = resetModule(catalog, custom, plan, k('till'));
    expect(r.state).toMatchObject({
      till: false,
      'till.tax': false,
      book: false,
      'book.web': false,
    });
    expect(r.alsoOff).toEqual(['book', 'book.web']);
  });

  it('lists only the switches that differ from the plan', () => {
    const plan = planState(catalog, 'full');
    const state = applyToggle(catalog, plan, k('stock'), false).state;
    expect(differencesFromPlan(state, plan)).toEqual({ stock: false, 'stock.count': false });
  });
});

describe('changesFor', () => {
  it('orders offs before ons, dependents first when off, needs first when on', () => {
    const e = entitlements('inventory');
    const desired = applyToggle(
      catalog,
      applyToggle(catalog, currentState(e), k('book'), true).state,
      k('stock'),
      false,
    ).state;
    expect(changesFor(catalog, e, desired)).toEqual([
      { key: 'stock.count', action: 'off' },
      { key: 'stock', action: 'off' },
      { key: 'till', action: 'on' },
      { key: 'book', action: 'on' },
    ]);
  });

  it('resets an override instead of repeating the plan', () => {
    const e = entitlements('full', {
      stock: { enabled: false },
      'stock.count': { enabled: false },
    });
    const desired = { ...currentState(e), stock: true, 'stock.count': true };
    expect(changesFor(catalog, e, desired)).toEqual([
      { key: 'stock', action: 'reset' },
      { key: 'stock.count', action: 'reset' },
    ]);
  });

  it('resets an override that already matches the plan when staff ask for it', () => {
    const e = entitlements('full', { stock: { enabled: true } });
    expect(changesFor(catalog, e, currentState(e))).toEqual([]);
    expect(changesFor(catalog, e, currentState(e), new Set([k('stock')]))).toEqual([
      { key: 'stock', action: 'reset' },
    ]);
  });

  it('treats an expired override as the plan', () => {
    const e = entitlements('full', { stock: { enabled: false, expired: true } });
    expect(currentState(e)[k('stock')]).toBe(true);
    expect(keptOverrides(catalog, e)).toEqual([]);
  });
});

describe('planChangeEffect', () => {
  it('lists what the new plan switches on and off, leaving kept overrides alone', () => {
    const e = entitlements('full', { stock: { enabled: false } });
    expect(planChangeEffect(catalog, e, 'inventory')).toEqual({
      on: [],
      off: ['till', 'till.tax', 'book', 'book.web'],
    });
  });

  it('counts a reset override as following the new plan', () => {
    const e = entitlements('full', { stock: { enabled: false } });
    expect(planChangeEffect(catalog, e, 'inventory', [k('stock')]).on).toEqual(['stock']);
  });

  it('reports nothing for the same plan', () => {
    const e = entitlements('full');
    expect(planChangeEffect(catalog, e, 'full')).toEqual({ on: [], off: [] });
  });
});

describe('keptOverrides', () => {
  it('lists the active overrides a plan change keeps, in catalog order', () => {
    const e = entitlements('full', { stock: { enabled: false }, book: { enabled: true } });
    // The response lists stock before book; the catalog puts book (module 3) first.
    e.features.sort((a, b) => (a.key === k('stock') ? -1 : b.key === k('stock') ? 1 : 0));
    expect(keptOverrides(catalog, e)).toEqual([
      { key: 'book', enabled: true, expiresOn: null },
      { key: 'stock', enabled: false, expiresOn: null },
    ]);
  });
});
