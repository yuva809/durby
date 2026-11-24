import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  const body = (cells: string[]) => toCsv(['A'], [cells]).split('\r\n')[1];

  it('quotes what needs quoting and starts with a byte order mark', () => {
    expect(toCsv(['Item'], [['Rice, "basmati"']])).toBe('﻿Item\r\n"Rice, ""basmati"""\r\n');
  });

  it('never lets a spreadsheet run a cell', () => {
    expect(body(['=1+1'])).toBe("'=1+1");
    expect(body(['@SUM(A1)'])).toBe("'@SUM(A1)");
    expect(body(['-2+3'])).toBe("'-2+3");
    expect(body(['+49 30 1'])).toBe("'+49 30 1");
    expect(body(['=HYPERLINK("x")'])).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('keeps numbers numbers', () => {
    expect(body(['-5.50', '+3', '12'])).toBe('-5.50,+3,12');
  });
});
