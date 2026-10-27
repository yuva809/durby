/**
 * A validated decimal string (`priceSchema` / `taxRateSchema`) with exactly two decimals, by text
 * only: never through a JS number (rule 6). `"7"` → `"7.00"`, `"12.5"` → `"12.50"`.
 */
export function fixed2(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = whole.replace(/^0+(?=\d)/, '');
  return `${digits}.${fraction.padEnd(2, '0')}`;
}
