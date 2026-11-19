'use client';

import type { StockRequest, StockRequestStatus, StockUnit } from '@durby/shared';
import { Printer } from 'lucide-react';
import { useMemo } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadRequest } from '../../lib/orders/requests-api';
import { useResource } from '../../lib/use-resource';
import { Button } from '../ui/button';
import { Loaded } from '../users/common';
import { shortQuantity, statusKey } from './common';

export type RequestDocumentKind = 'oc' | 'dc';

/** A Delivery Challan exists once the goods are packed (ADR 0064). */
const DELIVERY_DOCUMENT_STATUSES: readonly StockRequestStatus[] = [
  'packed',
  'in_transit',
  'delivered',
  'received',
];

export const hasDeliveryDocument = (status: StockRequestStatus) =>
  DELIVERY_DOCUMENT_STATUSES.includes(status);

const zero = (quantity: string | null) => quantity === null || /^0(\.0+)?$/.test(quantity);

/**
 * A branch request's documents (ADR 0064) as printable A4 pages, quantities only and never prices: the Order
 * Confirmation (OC, from the moment it is sent: what was asked and, once approved, what will come; its number is the
 * request's) and the Delivery Challan (DC, once packed: what was sent, with room to sign; its number is the
 * transfer's). The browser prints them or saves them as PDF.
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

function Paper({ request: r, kind }: { request: StockRequest; kind: RequestDocumentKind }) {
  const t = useT();
  const { session } = useAuth();
  const organization =
    session?.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? '';
  const date = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }), []);
  const oc = kind === 'oc';
  // The OC is dated when it was sent; the DC when it was packed.
  const packedAt = r.events.find((e) => e.status === 'packed')?.createdAt ?? r.updatedAt;
  const lines = oc ? r.lines : r.lines.filter((l) => !zero(l.pickedQuantity));
  const unit = (value: StockUnit) => t(`inventory.units.${value}`);
  const head = 'py-2 font-semibold';
  return (
    <article
      className="flex flex-col gap-6 rounded-lg border bg-card p-8 text-card-foreground shadow-sm print:rounded-none print:border-0 print:bg-transparent print:p-0 print:text-foreground print:shadow-none"
      data-testid={`document-${kind}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-foreground pb-4">
        <div className="flex flex-col gap-1">
          <p className="text-xl font-bold">{organization}</p>
          <h1 className="text-2xl font-semibold">
            {t(oc ? 'orders.documents.oc' : 'orders.documents.dc')}
          </h1>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('orders.documents.number')}</dt>
          <dd className="font-semibold" data-testid="document-number">
            {oc ? r.number : (r.transferNumber ?? r.number)}
          </dd>
          <dt className="text-muted-foreground">{t('orders.documents.date')}</dt>
          <dd>{date.format(new Date(oc ? r.createdAt : packedAt))}</dd>
          {oc ? (
            <>
              <dt className="text-muted-foreground">{t('orders.documents.status')}</dt>
              <dd>{t(`orders.requestStatus.${statusKey(r.status)}`)}</dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">{t('orders.documents.ocShort')}</dt>
              <dd>{r.number}</dd>
            </>
          )}
        </dl>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
        <Party
          title={t('orders.documents.from')}
          name={r.fromLocationName}
          place={r.fromWarehouseName}
          address={r.fromLocationAddress}
        />
        <Party
          title={t('orders.documents.deliverTo')}
          name={r.locationName}
          place={r.toWarehouseName}
          address={r.locationAddress}
          testId="document-to"
        />
      </section>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('orders.documents.requestedBy')}</dt>
        <dd>{r.requestedByName ?? '–'}</dd>
        {!oc && r.driverName && (
          <>
            <dt className="text-muted-foreground">{t('orders.documents.driver')}</dt>
            <dd>{r.driverName}</dd>
          </>
        )}
      </dl>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-2 border-foreground text-left">
            <th className={`${head} w-10 pr-2`}>#</th>
            <th className={`${head} pr-2`}>{t('orders.documents.item')}</th>
            <th className={`${head} w-20 px-2`}>{t('orders.documents.unit')}</th>
            <th className={`${head} w-28 px-2 text-right`}>
              {t(oc ? 'orders.documents.requested' : 'orders.documents.sent')}
            </th>
            <th className={`${head} w-32 pl-2 text-right`}>
              {t(oc ? 'orders.documents.approved' : 'orders.documents.received')}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, index) => (
            <tr key={l.id} className="border-b break-inside-avoid" data-testid="document-line">
              <td className="py-2 pr-2 tabular-nums">{index + 1}</td>
              <td className="py-2 pr-2">{l.itemName}</td>
              <td className="px-2 py-2">{unit(l.unit)}</td>
              <td className="px-2 py-2 text-right tabular-nums">
                {shortQuantity(oc ? l.quantity : l.pickedQuantity!)}
              </td>
              <td className="py-2 pl-2 text-right tabular-nums">
                {oc
                  ? l.approvedQuantity === null
                    ? '–'
                    : shortQuantity(l.approvedQuantity)
                  : // Written in on delivery, or what the branch confirmed.
                    l.receivedQuantity === null
                    ? ''
                    : shortQuantity(l.receivedQuantity)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {r.note && (
        <p className="text-sm">
          <span className="font-medium">{t('orders.documents.note')}: </span>
          {r.note}
        </p>
      )}

      {!oc && (
        <section className="grid grid-cols-3 gap-6 pt-10 text-sm break-inside-avoid">
          {[
            t('orders.documents.packedBy'),
            t('orders.documents.driver'),
            t('orders.documents.receivedBy'),
          ].map((label) => (
            <div key={label} className="flex flex-col gap-1">
              <span aria-hidden className="h-10 border-b border-foreground" />
              <span>{label}</span>
            </div>
          ))}
        </section>
      )}

      <footer className="border-t pt-3 text-xs text-muted-foreground">
        {t('orders.documents.footer', { organization, date: date.format(new Date()) })}
      </footer>
    </article>
  );
}

function Party({
  title,
  name,
  place,
  address,
  testId,
}: {
  title: string;
  name: string;
  place: string;
  address: string | null;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border p-3 text-sm" data-testid={testId}>
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </span>
      <span className="font-semibold">{name}</span>
      {place !== name && <span>{place}</span>}
      {address && <span className="whitespace-pre-line">{address}</span>}
    </div>
  );
}
