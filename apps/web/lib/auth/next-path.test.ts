import { describe, expect, it } from 'vitest';
import { loginPath, safeNextPath } from './next-path';

describe('safeNextPath', () => {
  it.each([
    ['/inventory', '/inventory'],
    ['/inventory?tab=1#x', '/inventory?tab=1#x'],
  ])('keeps the same-origin path %s', (raw, path) => {
    expect(safeNextPath(raw)).toBe(path);
  });

  it.each([
    [null],
    [''],
    ['inventory'],
    ['//evil.example'],
    ['/\\evil.example'],
    ['https://evil.example'],
    ['javascript:alert(1)'],
    ['/\tevil'],
  ])('refuses %s', (raw) => {
    expect(safeNextPath(raw)).toBe('/');
  });
});

describe('loginPath', () => {
  it('carries the current path, except for the home page', () => {
    expect(loginPath('/')).toBe('/login');
    expect(loginPath('/inventory/a b')).toBe('/login?next=%2Finventory%2Fa%20b');
  });
});
