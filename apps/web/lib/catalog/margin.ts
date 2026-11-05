import { cents } from '@durby/shared';

/**
 * Margin on the net price, as whole percent (docs/modules/inventory.md → Dish cost & margin):
 * `(net − cost) ÷ net`, where `net = gross ÷ (1 + VAT)`. Money stays in integer cents (rule 6); only the
 * resulting percentage becomes a number. null without a price.
 */
export function marginPercent(gross: string, taxRate: string, cost: string): number | null {
  const price = cents(gross);
  if (price === 0n) return null;
  // cost ÷ net in basis points, half up: cost × (1 + VAT) ÷ gross.
  const costShare = (cents(cost) * (10_000n + cents(taxRate)) * 2n + price) / (price * 2n);
  return Math.round(Number(10_000n - costShare) / 100);
}
