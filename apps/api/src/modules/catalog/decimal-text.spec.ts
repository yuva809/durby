import { describe, expect, it } from 'vitest';
import { fixed2 } from './decimal-text';

describe('fixed2', () => {
  it.each([
    ['7', '7.00'],
    ['12.5', '12.50'],
    ['0', '0.00'],
    ['007.1', '7.10'],
    ['9999999999.99', '9999999999.99'],
  ])('%s → %s', (input, output) => {
    expect(fixed2(input)).toBe(output);
  });
});
