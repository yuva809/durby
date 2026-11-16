'use client';

import { STOCK_REQUEST_NOTE_MAX_LENGTH, stockQuantitySchema } from '@durby/shared';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import {
  createRequest,
  loadAvailability,
  loadRequestWarehouses,
} from '../../lib/orders/requests-api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { shortQuantity } from './common';

/**
 * /requests/new, Request Stock (docs/modules/orders.md → Branch requests, ADR 0045): a branch picks the warehouse to
 * ask, sees what it has, enters quantities and sends the request. Needs `orders.requests.create` at the branch.
 */
export function RequestStockPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('orders.requests.create'))
    return <NoAccess title="platform.nav.requestStock" />;
  return <RequestStock organizationId={session.activeOrganizationId} />;
}

function RequestStock({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const action = useActionKey();
  const [warehouses] = useResource(organizationId, () => loadRequestWarehouses(store));
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const all = warehouses.status === 'ready' ? warehouses.data : [];
  const destinations = all.filter((w) => w.canRequestInto);
  const to = toId || destinations[0]?.id || '';
  const toWarehouse = all.find((w) => w.id === to);
  // The main warehouse usually: the first one elsewhere.
  const sources = all.filter((w) => w.id !== to);
  const from =
    fromId && fromId !== to
      ? fromId
      : (sources.find((w) => w.locationId !== toWarehouse?.locationId) ?? sources[0])?.id || '';
  const [items] = useResource(from ? `${organizationId}:${from}` : null, () =>
    loadAvailability(store, from),
  );

  const chosen = Object.entries(quantities).filter(([, q]) => q.trim() !== '');
  const invalid = chosen.some(([, q]) => !stockQuantitySchema.safeParse(q.trim()).success);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSent(null);
    if (chosen.length === 0) {
      setError(t('orders.requestForm.none'));
      return;
    }
    if (invalid) {
      setError(t('orders.requestForm.quantityInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await createRequest(store, action, {
      fromWarehouseId: from,
      toWarehouseId: to,
      lines: chosen.map(([itemId, q]) => ({ itemId, quantity: q.trim() })),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(t(errorLabel(result.ok ? 'unknown' : result.code)));
      return;
    }
    action.done();
    setSent(result.data.number);
    setQuantities({});
    setNote('');
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex max-w-3xl flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.nav.requestStock')}</h1>
          <p className="text-muted-foreground">{t('orders.requestForm.intro')}</p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/requests">{t('platform.nav.stockRequests')}</Link>
        </Button>
      </div>
      <Loaded resource={warehouses} reload={() => undefined}>
        {() =>
          destinations.length === 0 ? (
            <Notice text={t('orders.requestForm.noWarehouse')} tone="info" />
          ) : (
            <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
              <Card className="grid gap-4 p-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-from`}>{t('orders.requestForm.from')}</Label>
                  <Select
                    id={`${id}-from`}
                    value={from}
                    onChange={(e) => {
                      setFromId(e.target.value);
                      setQuantities({});
                    }}
                    data-testid="request-from"
                  >
                    {sources.map((w) => (
                      <option key={w.id} value={w.id}>
                        {`${w.locationName} · ${w.name}`}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-to`}>{t('orders.requestForm.to')}</Label>
                  <Select
                    id={`${id}-to`}
                    value={to}
                    onChange={(e) => setToId(e.target.value)}
                    data-testid="request-to"
                  >
                    {destinations.map((w) => (
                      <option key={w.id} value={w.id}>
                        {`${w.locationName} · ${w.name}`}
                      </option>
                    ))}
                  </Select>
                </div>
              </Card>

              <Card className="flex flex-col gap-0 p-0">
                <div className="relative border-b p-4">
                  <Label htmlFor={`${id}-search`} className="sr-only">
                    {t('orders.requestForm.search')}
                  </Label>
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-7 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id={`${id}-search`}
                    type="search"
                    className="pl-9"
                    placeholder={t('orders.requestForm.search')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    data-testid="request-search"
                  />
                </div>
                <Loaded resource={items} reload={() => undefined}>
                  {(list) => {
                    const q = search.trim().toLowerCase();
                    const shown = list.filter(
                      (i) =>
                        q === '' ||
                        i.itemName.toLowerCase().includes(q) ||
                        (i.sku ?? '').toLowerCase().includes(q),
                    );
                    if (shown.length === 0) {
                      return (
                        <p className="p-4 text-sm text-muted-foreground">
                          {t('orders.requestForm.empty')}
                        </p>
                      );
                    }
                    return (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm" data-testid="request-items">
                          <thead>
                            <tr className="border-b text-left text-xs text-muted-foreground uppercase">
                              <th className="px-4 py-2 font-medium">
                                {t('orders.requestForm.item')}
                              </th>
                              <th className="px-4 py-2 text-right font-medium">
                                {t('orders.requestForm.available')}
                              </th>
                              <th className="px-4 py-2 text-right font-medium">
                                {t('orders.requestForm.request')}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {shown.map((item) => (
                              <tr
                                key={item.itemId}
                                className="border-b last:border-0"
                                data-testid="request-item"
                              >
                                <td className="px-4 py-2">
                                  {item.itemName}
                                  {item.sku && (
                                    <span className="ml-2 text-muted-foreground">{item.sku}</span>
                                  )}
                                </td>
                                <td className="px-4 py-2 text-right tabular-nums">
                                  {`${shortQuantity(item.available)} ${item.unit}`}
                                </td>
                                <td className="px-4 py-2 text-right">
                                  <Input
                                    inputMode="decimal"
                                    className="ml-auto w-24 text-right"
                                    value={quantities[item.itemId] ?? ''}
                                    aria-label={t('orders.requestForm.quantity', {
                                      name: item.itemName,
                                    })}
                                    onChange={(e) =>
                                      setQuantities((v) => ({
                                        ...v,
                                        [item.itemId]: e.target.value.replace(',', '.'),
                                      }))
                                    }
                                    data-testid="request-quantity"
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  }}
                </Loaded>
              </Card>

              <Card className="flex flex-col gap-3 p-4">
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-note`}>{t('orders.requestForm.note')}</Label>
                  <Input
                    id={`${id}-note`}
                    value={note}
                    maxLength={STOCK_REQUEST_NOTE_MAX_LENGTH}
                    onChange={(e) => setNote(e.target.value)}
                    data-testid="request-note"
                  />
                </div>
                <p className="text-sm text-muted-foreground" data-testid="request-count">
                  {t('orders.requestForm.selected', { count: String(chosen.length) })}
                </p>
                <Notice text={error} tone="error" />
                {sent && (
                  <Notice text={t('orders.requestForm.sent', { number: sent })} tone="info" />
                )}
                <Button
                  type="submit"
                  disabled={busy}
                  className="self-start"
                  data-testid="request-submit"
                >
                  {t('orders.requestForm.submit')}
                </Button>
              </Card>
            </form>
          )
        }
      </Loaded>
    </div>
  );
}
