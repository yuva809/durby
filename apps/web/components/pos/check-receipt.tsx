'use client';

import type { BillLayout, GuestCheck } from '@durby/shared';
import { useT } from '../../app/labels-provider';
import { checkLines } from '../../lib/pos/format';
import { Receipt } from './receipt';

/**
 * A guest check printed as the bill (docs/modules/pos.md → Step 4, ADR 0036): the receipt with the check's number,
 * its tables and orders, its items (or its share), "Share 2 of 4" on a share and "CANCELLED" on a cancelled bill.
 */
export function CheckReceipt({
  check,
  layout,
  organizationName,
  productName,
  printedAt,
}: {
  check: GuestCheck;
  layout: Pick<BillLayout, 'header' | 'footer'> | null;
  organizationName: string;
  productName: string;
  printedAt: Date;
}) {
  const t = useT();
  const covers = check.orders.reduce<number | null>(
    (sum, o) => (o.covers === null ? sum : (sum ?? 0) + o.covers),
    null,
  );
  const share =
    check.shareIndex !== null && check.shareCount !== null
      ? t('pos.bill.share', { index: String(check.shareIndex), count: String(check.shareCount) })
      : null;
  // A share prints as one line, whatever VAT rates it spans.
  const lines = share
    ? [
        {
          key: 'share',
          name: share,
          note: null,
          quantity: 1,
          unitPrice: check.totals.gross,
          total: check.totals.gross,
        },
      ]
    : checkLines(check);
  return (
    <Receipt
      layout={layout}
      organizationName={organizationName}
      productName={productName}
      tableName={check.orders.map((o) => o.tableName).join(', ')}
      order={{
        number: check.number,
        covers,
        waiterName: check.orders[0]?.waiterName ?? null,
        total: check.totals.gross,
      }}
      bill={lines}
      printedAt={printedAt}
      banner={share}
      cancelled={check.cancelled}
    />
  );
}
