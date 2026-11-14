import { describe, expect, it } from 'vitest';
import { byMenuNumber, inOrder } from './menu-order';

const p = (name: string, menuNumber: string | null) => ({ name, menuNumber });
const names = (list: { name: string }[]) => list.map((x) => x.name);

describe('byMenuNumber (ADR 0043)', () => {
  it('puts plain numbers first, numerically, then other numbers, then unnumbered in their order', () => {
    expect(
      names(
        byMenuNumber([
          p('Tea', null),
          p('Curry', '10'),
          p('Soup', 'S1'),
          p('Samosa', '2'),
          p('Naan', '12a'),
          p('Water', null),
          p('Rice', '1'),
          p('Lamb', '012'),
        ]),
      ),
    ).toEqual(['Rice', 'Samosa', 'Curry', 'Lamb', 'Naan', 'Soup', 'Tea', 'Water']);
  });

  it('keeps the given order between equal numbers', () => {
    expect(names(byMenuNumber([p('B', '5'), p('A', '05')]))).toEqual(['B', 'A']);
  });
});

describe('inOrder', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'new' }];

  it('follows the dragged order and keeps unknown items after it', () => {
    expect(inOrder(items, ['c', 'a', 'b']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'new']);
  });

  it('keeps the loaded order without a dragged one', () => {
    expect(inOrder(items, null).map((i) => i.id)).toEqual(['a', 'b', 'c', 'new']);
  });
});
