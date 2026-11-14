/**
 * Orders on the catalog page (docs/modules/catalog.md → Menu numbers, ADR 0043). Menu numbers are short labels
 * (at most 6 characters), so plain JS numbers are exact for them.
 */

const rank = (menuNumber: string | null) =>
  menuNumber === null ? 2 : /^\d+$/.test(menuNumber) ? 0 : 1;

/**
 * Products by menu number: plain numbers ascending (1, 2, 10), then other numbers in natural order (`12a`, `M-4`),
 * then products without a number in the order given.
 */
export function byMenuNumber<T extends { menuNumber: string | null }>(products: readonly T[]): T[] {
  return products
    .map((product, index) => ({ product, index }))
    .sort((a, b) => {
      const ra = rank(a.product.menuNumber);
      const rb = rank(b.product.menuNumber);
      if (ra !== rb) return ra - rb;
      const na = a.product.menuNumber;
      const nb = b.product.menuNumber;
      if (ra === 0 && na !== null && nb !== null && Number(na) !== Number(nb)) {
        return Number(na) - Number(nb);
      }
      if (ra === 1 && na !== null && nb !== null) {
        const byText = na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
        if (byText !== 0) return byText;
      }
      return a.index - b.index;
    })
    .map(({ product }) => product);
}

/**
 * The categories in the order just dragged (`order`, ids), until the next load shows it; categories the order doesn't
 * know (created meanwhile) keep their place after it.
 */
export function inOrder<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[] | null,
): T[] {
  if (order === null) return [...items];
  const position = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (position.get(a.item.id) ?? order.length + a.index) -
        (position.get(b.item.id) ?? order.length + b.index),
    )
    .map(({ item }) => item);
}
