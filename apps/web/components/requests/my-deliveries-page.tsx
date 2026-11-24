'use client';

import { STOCK_REQUEST_ON_THE_WAY, type StockRequestSummary } from '@durby/shared';
import { Truck } from 'lucide-react';
import { useMemo } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { deliverRequest, loadRequests, pickUpRequest } from '../../lib/orders/requests-api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Card } from '../ui/card';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { NoteDialog, RequestStatusBadge, requestTitle } from './common';

/**
 * /my-deliveries (docs/modules/orders.md → Branch requests, ADR 0045): what is assigned to the signed-in driver, oldest
 * first. "Picked up" when leaving the warehouse, "Delivered" at the branch; the branch then confirms what arrived.
 */
export function MyDeliveriesPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('orders.delivery.use'))
    return <NoAccess title="platform.nav.myDeliveries" />;
  return <MyDeliveries organizationId={session.activeOrganizationId} />;
}

function MyDeliveries({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const [list, reload] = useResource(organizationId, () =>
    loadRequests(store, { status: STOCK_REQUEST_ON_THE_WAY, mine: true }),
  );
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    [],
  );
  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('platform.nav.myDeliveries')}</h1>
        <p className="text-muted-foreground">{t('orders.myDeliveries.intro')}</p>
      </div>
      <Loaded resource={list} reload={reload}>
        {(rows) =>
          rows.length === 0 ? (
            <Card
              className="flex flex-col items-center gap-2 px-6 py-12 text-center"
              data-testid="deliveries-empty"
            >
              <Truck aria-hidden className="size-8 text-muted-foreground" />
              <p className="text-muted-foreground">{t('orders.myDeliveries.empty')}</p>
            </Card>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2" data-testid="my-deliveries">
              {[...rows].reverse().map((r) => (
                <DeliveryCard
                  key={r.id}
                  request={r}
                  when={time.format(new Date(r.updatedAt))}
                  onDone={reload}
                />
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}

function DeliveryCard({
  request: r,
  when,
  onDone,
}: {
  request: StockRequestSummary;
  when: string;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const pickUpAction = useActionKey();
  const deliverAction = useActionKey();
  const title = requestTitle(r);
  return (
    <li>
      <Card className="flex h-full flex-col gap-3 p-4" data-testid="delivery-card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{title}</span>
          <RequestStatusBadge status={r.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t('orders.requestsPage.route', {
            from: `${r.fromLocationName} · ${r.fromWarehouseName}`,
            // Without a branch store (ADR 0080) just the branch.
            to: [r.locationName, r.toWarehouseName].filter(Boolean).join(' · '),
          })}
          <br />
          {t('orders.requestsPage.items', { count: String(r.lineCount) })} · {when}
        </p>
        <div className="mt-auto flex flex-wrap gap-2">
          {r.status === 'packed' && (
            <ConfirmAction
              testId="delivery-pick-up"
              trigger={t('orders.myDeliveries.pickUp')}
              title={t('orders.myDeliveries.pickUpTitle', { number: title })}
              description={t('orders.myDeliveries.pickUpHint')}
              confirm={t('orders.myDeliveries.pickUp')}
              run={() => pickUpRequest(store, pickUpAction, r.id, {})}
              onDone={onDone}
            />
          )}
          {r.status === 'in_transit' && (
            <NoteDialog
              trigger={t('orders.myDeliveries.deliver')}
              triggerVariant="default"
              testId="delivery-deliver"
              title={t('orders.myDeliveries.deliverTitle', { number: title })}
              label={t('orders.myDeliveries.note')}
              submitLabel={t('orders.myDeliveries.deliver')}
              run={(note) => deliverRequest(store, deliverAction, r.id, note ? { note } : {})}
              onDone={onDone}
            />
          )}
        </div>
      </Card>
    </li>
  );
}
