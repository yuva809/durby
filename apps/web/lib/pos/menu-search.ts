import type { Product } from '@durby/shared';

/**
 * The order screen's search (docs/modules/catalog.md → Menu numbers, ADR 0029): a menu number matches
 * exactly or by its start (`1` finds 1, 12, 13a), a name anywhere, both ignoring case. `exact` is the
 * product whose number is the query, from the whole menu (the category filter doesn't hide it): Enter
 * adds it. The rest keep the category filter.
 */
export function searchMenu(
  products: readonly Product[],
  query: string,
  category: string | null,
): { exact: Product | null; matching: Product[] } {
  const needle = query.trim().toLocaleLowerCase();
  const number = (p: Product) => p.menuNumber?.toLocaleLowerCase() ?? null;
  const exact = needle === '' ? null : (products.find((p) => number(p) === needle) ?? null);
  const matching = products.filter(
    (p) =>
      p !== exact &&
      (category === null || p.categoryId === category) &&
      (needle === '' ||
        p.name.toLocaleLowerCase().includes(needle) ||
        (number(p)?.startsWith(needle) ?? false)),
  );
  return { exact, matching };
}

/** What Enter adds: the exact number, else the only match; null when it's not clear. */
export function enterTarget(result: {
  exact: Product | null;
  matching: Product[];
}): Product | null {
  return result.exact ?? (result.matching.length === 1 ? result.matching[0]! : null);
}
