'use client';

import type { StockRequest, StockRequestLine, StockRequestStatus } from '@durby/shared';
import { Printer } from 'lucide-react';
import type { ReactNode } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { sumDecimals } from '../../lib/inventory/overview';
import { formatPackSize } from '../../lib/inventory/pack-size';
import { boxesOf, piecesOf, piecesPerBox } from '../../lib/orders/request-cart';
import { loadRequest } from '../../lib/orders/requests-api';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { useBrand } from '../theme-provider';
import { Button } from '../ui/button';
import { Loaded } from '../users/common';
import { shortQuantity } from './common';

export type RequestDocumentKind = 'oc' | 'dc';

/** A delivery document exists once the goods are packed (ADR 0064). */
const DELIVERY_DOCUMENT_STATUSES: readonly StockRequestStatus[] = [
  'packed',
  'in_transit',
  'delivered',
  'received',
];

export const hasDeliveryDocument = (status: StockRequestStatus) =>
  DELIVERY_DOCUMENT_STATUSES.includes(status);

const zero = (quantity: string | null) => quantity === null || /^0(\.0+)?$/.test(quantity);

/** "18 / 11 / 2026", as the distributor's papers write dates. */
function paperDate(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getDate())} / ${two(d.getMonth() + 1)} / ${d.getFullYear()}`;
}

/**
 * A branch request's documents (ADR 0064) as printable A4 pages in the distributor's layout, quantities only and never
 * prices: the Order Confirmation from the moment it is sent (prepared by the main warehouse, requested for the shop:
 * product, pack size, unit, quantity) and the Delivery Confirmation once packed (dispatched from, delivered to, with
 * brand and best-before). The logo is the brand's; the browser prints them or saves them as PDF.
 */
export function RequestDocument({ id, kind }: { id: string; kind: RequestDocumentKind }) {
  const t = useT();
  const { store } = useAuth();
  const [request, reload] = useResource(id, () => loadRequest(store, id));
  return (
    <div className="mx-auto flex max-w-[210mm] flex-col gap-4 p-4 print:max-w-none print:p-0">
      <div className="flex justify-end print:hidden">
        <Button onClick={() => window.print()} data-testid="document-print">
          <Printer aria-hidden />
          {t('orders.documents.print')}
        </Button>
      </div>
      <Loaded resource={request} reload={reload}>
        {(r) =>
          kind === 'dc' && !hasDeliveryDocument(r.status) ? (
            <Notice text={t('orders.documents.notYet')} tone="info" />
          ) : (
            <Paper request={r} kind={kind} />
          )
        }
      </Loaded>
    </div>
  );
}

/** A line's quantity as ordered: whole boxes of an item that comes in boxes, else in the item's own unit. */
function asOrdered(line: StockRequestLine, quantity: string) {
  const perBox = piecesPerBox({ unit: line.unit, packCount: line.packCount });
  const plain = shortQuantity(quantity);
  if (perBox) {
    const boxes = boxesOf(plain, perBox);
    if (piecesOf(boxes, perBox) === plain) return { unit: 'box' as const, quantity: boxes };
  }
  return { unit: line.unit, quantity: plain };
}

function Paper({ request: r, kind }: { request: StockRequest; kind: RequestDocumentKind }) {
  const t = useT();
  const { session } = useAuth();
  const { logoUrl, productName } = useBrand();
  const organization =
    session?.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? productName;
  const oc = kind === 'oc';
  const packed = r.events.find((e) => e.status === 'packed')?.createdAt ?? r.updatedAt;
  const arrived = r.events.find(
    (e) => e.status === 'delivered' || e.status === 'received',
  )?.createdAt;
  // The confirmation lists what was ordered; lines added at packing (item 9) are only on the challan.
  const lines = (
    oc ? r.lines.filter((l) => !l.addedAtPacking) : r.lines.filter((l) => !zero(l.pickedQuantity))
  ).map((line) => ({
    line,
    ...asOrdered(line, oc ? (line.approvedQuantity ?? line.quantity) : line.pickedQuantity!),
  }));
  // "Totals: 230 Box and 10 pc."
  const units = [...new Set(lines.map((l) => l.unit))];
  const totals = units.map(
    (unit) =>
      `${shortQuantity(
        sumDecimals(
          lines.filter((l) => l.unit === unit).map((l) => l.quantity),
          3,
        ),
      )} ${t(`inventory.units.${unit}`)}`,
  );
  const totalsText =
    totals.length > 1
      ? t('orders.documents.totalsMany', {
          list: totals.slice(0, -1).join(', '),
          last: totals.at(-1)!,
        })
      : t('orders.documents.totalsOne', { list: totals[0] ?? '0' });
  const columns = oc
    ? (['sno', 'product', 'pack', 'unit', 'qty'] as const)
    : (['sno', 'product', 'brand', 'pack', 'unit', 'expiry', 'qty'] as const);
  const cell = 'border px-2 py-1.5';
  const signatures = oc
    ? [
        [t('orders.documents.preparedBy'), t('orders.documents.nameDate')],
        [t('orders.documents.approvedBy'), t('orders.documents.nameDate')],
        [t('orders.documents.confirmedBy'), t('orders.documents.nameDate')],
      ]
    : [
        [t('orders.documents.packedBy'), organization],
        [t('orders.documents.dispatchedBy'), organization],
        [t('orders.documents.receivedBy'), t('orders.documents.nameDate')],
      ];

  return (
    <article
      className="flex flex-col gap-6 rounded-lg border bg-card p-8 text-sm text-card-foreground shadow-sm print:rounded-none print:border-0 print:bg-transparent print:p-0 print:text-foreground print:shadow-none"
      data-testid={`document-${kind}`}
    >
      <header className="flex items-start justify-between gap-6 border-b-4 border-primary pb-4">
        {logoUrl ? (
          // A same-origin static file (the brand's logo).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt={productName}
            className="h-24 w-auto"
            data-testid="document-logo"
          />
        ) : (
          <span className="text-xl font-bold">{productName}</span>
        )}
        <div className="flex flex-col items-end gap-1 text-right">
          <p className="text-2xl font-bold text-primary uppercase">{organization}</p>
          {r.fromLocationAddress && (
            <p className="text-xs text-muted-foreground">{r.fromLocationAddress}</p>
          )}
        </div>
      </header>

      <h1 className="bg-primary py-2 text-center text-2xl font-bold text-primary-foreground uppercase">
        {t(oc ? 'orders.documents.oc' : 'orders.documents.dc')}
      </h1>

      <dl className="grid grid-cols-[auto_1fr_auto_1fr] border" data-testid="document-facts">
        <dt className="border-r bg-muted px-2 py-1.5 font-semibold text-primary">
          {t(oc ? 'orders.documents.orderDate' : 'orders.documents.deliveryDate')}
        </dt>
        <dd className="border-r px-2 py-1.5">
          {oc
            ? paperDate(r.createdAt)
            : arrived
              ? t('orders.documents.planned', {
                  date: paperDate(arrived),
                  planned: paperDate(packed),
                })
              : paperDate(packed)}
        </dd>
        <dt className="border-r bg-muted px-2 py-1.5 font-semibold text-primary">
          {t('orders.documents.incharge')}
        </dt>
        <dd className="px-2 py-1.5">
          {oc ? (r.requestedByName ?? r.locationName) : (r.driverName ?? '')}
        </dd>
      </dl>

      <section className="grid grid-cols-2 border">
        <Box title={t(oc ? 'orders.documents.preparedFrom' : 'orders.documents.dispatchedFrom')}>
          <span>{r.fromWarehouseName}</span>
          {r.fromLocationAddress && (
            <span className="whitespace-pre-line">{r.fromLocationAddress}</span>
          )}
        </Box>
        <Box
          title={t(oc ? 'orders.documents.requestedFor' : 'orders.documents.deliveredTo')}
          testId="document-to"
        >
          <span>{t('orders.documents.shopName', { name: r.locationName })}</span>
          {r.locationAddress && (
            <span>{t('orders.documents.address', { address: r.locationAddress })}</span>
          )}
          <span>{t('orders.documents.contact')}</span>
          <span>{t('orders.documents.phone')}</span>
        </Box>
      </section>

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-primary text-primary-foreground">
            {columns.map((c) => (
              <th key={c} className={cn(cell, 'text-center font-semibold')}>
                {t(`orders.documents.columns.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map(({ line, unit, quantity }, index) => {
            const pack = formatPackSize({
              count: line.packCount,
              size: line.packSize,
              unit: line.packUnit,
            });
            return (
              <tr
                key={line.id}
                className="break-inside-avoid odd:bg-muted/60"
                data-testid="document-line"
              >
                <td className={cn(cell, 'text-center tabular-nums')}>{index + 1}</td>
                <td className={cell}>
                  {line.itemName}
                  {line.addedAtPacking && ` (${t('orders.requestsPage.addedAtPacking')})`}
                </td>
                {!oc && <td className={cell}>{line.brand ?? ''}</td>}
                <td className={cn(cell, 'text-center')}>{pack}</td>
                <td className={cn(cell, 'text-center')}>{t(`inventory.units.${unit}`)}</td>
                {!oc && (
                  <td className={cell}>
                    {line.expiresOn
                      ? t('orders.documents.expiry', { date: line.expiresOn, quantity })
                      : ''}
                  </td>
                )}
                <td className={cn(cell, 'text-center tabular-nums')}>{quantity}</td>
              </tr>
            );
          })}
          <tr>
            <td colSpan={columns.length - 1} className={cn(cell, 'text-right font-semibold')}>
              {t(oc ? 'orders.documents.totalOrdered' : 'orders.documents.totalDispatched')}
            </td>
            <td className={cn(cell, 'text-center font-semibold')}>
              {t('orders.documents.seeNotes')}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="flex flex-col gap-0.5" data-testid="document-notes">
        <span>{t('orders.documents.notes')}</span>
        <span>{totalsText}</span>
        {r.note && <span>{r.note}</span>}
      </div>

      <section className="grid grid-cols-3 gap-6 pt-6 text-center break-inside-avoid">
        {signatures.map(([title, sub]) => (
          <div key={title} className="flex flex-col font-semibold">
            <span>{title}</span>
            <span>{sub}</span>
          </div>
        ))}
      </section>
    </article>
  );
}

function Box({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div
      className="flex flex-col gap-0.5 p-3 font-semibold text-primary first:border-r"
      data-testid={testId}
    >
      <span>{title}</span>
      {children}
    </div>
  );
}
