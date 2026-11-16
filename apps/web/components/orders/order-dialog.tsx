'use client';

import {
  ORDER_TEXT_MAX_LENGTH,
  type OrderCustomer,
  type SalesOrder,
  type StockItem,
  type Warehouse,
} from '@durby/shared';
import { Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createOrder, updateOrder } from '../../lib/orders/api';
import {
  type DraftLine,
  draftTotal,
  itemLabel,
  lineTotal,
  linesValid,
  sellableItems,
} from '../../lib/orders/form';
import { useActionKey } from '../../lib/use-action-key';
import { Field, FormDialog } from '../form-dialog';
import { useMoney } from '../pos/money';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { CustomerDialog } from './customer-dialog';

export interface OrderFormData {
  customers: OrderCustomer[];
  warehouses: Warehouse[];
  locationName: (id: string) => string;
  items: StockItem[];
  canAddCustomer: boolean;
  reloadCustomers: () => void;
}

/**
 * A new order (no `order`) or a draft's changes (docs/modules/orders.md → Web). Lines: an item, a quantity and a unit
 * price (the item's sale price to start with); the total is a preview in exact cents. New orders can be confirmed at
 * once.
 */
export function OrderDialog({
  order,
  data,
  onDone,
}: {
  order?: SalesOrder;
  data: OrderFormData;
  onDone: () => void;
}) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [customerId, setCustomerId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [requestedDate, setRequestedDate] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [confirmNow, setConfirmNow] = useState(true);
  const [checked, setChecked] = useState(false);

  const sellable = sellableItems(data.items);
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const nameOf = (itemId: string) => {
    const item = itemById.get(itemId);
    return item ? itemLabel(item, data.items) : '';
  };
  const activeCustomers = data.customers.filter(
    (c) => c.archivedAt === null || c.id === order?.customerId,
  );
  const activeWarehouses = data.warehouses.filter(
    (w) => w.archivedAt === null || w.id === order?.warehouseId,
  );
  const problems = {
    customer: checked && customerId === '' ? t('orders.form.customerRequired') : null,
    warehouse: checked && warehouseId === '' ? t('orders.form.warehouseRequired') : null,
    lines: !checked
      ? null
      : lines.length === 0
        ? t('orders.form.linesRequired')
        : !linesValid(lines)
          ? t('orders.form.lineInvalid')
          : null,
  };

  const addItem = (itemId: string) => {
    if (!itemId || lines.some((l) => l.itemId === itemId)) return;
    const price = itemById.get(itemId)?.salePrice ?? '';
    setLines((current) => [...current, { itemId, quantity: '1', unitPrice: price }]);
  };
  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  return (
    <FormDialog
      trigger={t(order ? 'orders.detail.edit' : 'orders.page.newOrder')}
      triggerVariant={order ? 'outline' : 'default'}
      testId={order ? 'order-edit' : 'order-create'}
      title={
        order ? t('orders.form.editTitle', { number: order.number }) : t('orders.form.createTitle')
      }
      submitLabel={t(order ? 'orders.form.save' : 'orders.form.create')}
      wide
      onOpen={() => {
        setCustomerId(order?.customerId ?? '');
        setWarehouseId(
          order?.warehouseId ?? (activeWarehouses.length === 1 ? activeWarehouses[0]!.id : ''),
        );
        setRequestedDate(order?.requestedDate ?? '');
        setDeliveryAddress(order?.deliveryAddress ?? '');
        setNote(order?.note ?? '');
        setLines(
          order?.lines.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity.replace(/\.?0+$/, ''),
            unitPrice: l.unitPrice,
          })) ?? [],
        );
        setConfirmNow(true);
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (!customerId || !warehouseId || lines.length === 0 || !linesValid(lines)) return null;
        const body = {
          customerId,
          warehouseId,
          lines: lines.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity.trim(),
            unitPrice: l.unitPrice.trim(),
          })),
        };
        if (order) {
          return updateOrder(store, action, order.id, {
            ...body,
            requestedDate: requestedDate || null,
            deliveryAddress: deliveryAddress.trim() || null,
            note: note.trim() || null,
          });
        }
        return createOrder(store, action, {
          ...body,
          ...(requestedDate ? { requestedDate } : {}),
          ...(deliveryAddress.trim() ? { deliveryAddress: deliveryAddress.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          confirm: confirmNow,
        });
      }}
      onDone={onDone}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-customer`} label={t('orders.form.customer')} problem={problems.customer}>
          <div className="flex gap-2">
            <Select
              id={`${id}-customer`}
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                const picked = data.customers.find((c) => c.id === e.target.value);
                if (picked?.address && !deliveryAddress) setDeliveryAddress(picked.address);
              }}
              aria-invalid={problems.customer ? true : undefined}
              data-testid="order-customer"
              className="min-w-0 flex-1"
            >
              <option value="">{t('orders.form.chooseCustomer')}</option>
              {activeCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code ? `${c.name} (${c.code})` : c.name}
                </option>
              ))}
            </Select>
            {data.canAddCustomer && (
              <CustomerDialog
                trigger={t('orders.form.newCustomer')}
                triggerVariant="outline"
                onSaved={(customer) => {
                  data.reloadCustomers();
                  if (customer) {
                    setCustomerId(customer.id);
                    if (customer.address && !deliveryAddress) setDeliveryAddress(customer.address);
                  }
                }}
              />
            )}
          </div>
        </Field>
        <Field
          id={`${id}-warehouse`}
          label={t('orders.form.warehouse')}
          problem={
            activeWarehouses.length === 0 ? t('orders.form.noWarehouses') : problems.warehouse
          }
        >
          <Select
            id={`${id}-warehouse`}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            aria-invalid={problems.warehouse ? true : undefined}
            data-testid="order-warehouse"
          >
            <option value="">{t('orders.form.chooseWarehouse')}</option>
            {activeWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {`${data.locationName(w.locationId)} · ${w.name}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${id}-date`} label={t('orders.form.requestedDate')} problem={null}>
          <Input
            id={`${id}-date`}
            type="date"
            value={requestedDate}
            onChange={(e) => setRequestedDate(e.target.value)}
            data-testid="order-date"
          />
        </Field>
        <Field id={`${id}-address`} label={t('orders.form.deliveryAddress')} problem={null}>
          <Input
            id={`${id}-address`}
            value={deliveryAddress}
            maxLength={ORDER_TEXT_MAX_LENGTH}
            onChange={(e) => setDeliveryAddress(e.target.value)}
            data-testid="order-address"
          />
        </Field>
      </div>

      <fieldset className="grid gap-2" aria-describedby={`${id}-lines-problem`}>
        <legend className="mb-1 text-sm font-medium">{t('orders.form.lines')}</legend>
        {lines.length > 0 && (
          <ul className="grid gap-2" data-testid="order-lines">
            {lines.map((line, index) => {
              const name = nameOf(line.itemId);
              const total = lineTotal(line.quantity, line.unitPrice);
              return (
                <li
                  key={line.itemId}
                  className="grid grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_2.75rem] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_7rem_6rem_2.75rem]"
                  data-testid="order-line"
                >
                  <span className="truncate text-sm">{name}</span>
                  <Input
                    inputMode="decimal"
                    value={line.quantity}
                    aria-label={t('orders.form.quantity', { name })}
                    onChange={(e) => setLine(index, { quantity: e.target.value })}
                    data-testid="order-line-quantity"
                  />
                  <Input
                    inputMode="decimal"
                    value={line.unitPrice}
                    aria-label={t('orders.form.unitPrice', { name })}
                    onChange={(e) => setLine(index, { unitPrice: e.target.value })}
                    data-testid="order-line-price"
                  />
                  <span className="hidden text-right text-sm tabular-nums sm:block">
                    {total === null ? t('orders.detail.none') : money(total)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={t('orders.form.remove', { name })}
                    onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                    data-testid="order-line-remove"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <Label htmlFor={`${id}-add`} className="sr-only">
          {t('orders.form.addItem')}
        </Label>
        <Select
          id={`${id}-add`}
          value=""
          onChange={(e) => addItem(e.target.value)}
          data-testid="order-add-item"
        >
          <option value="">{t('orders.form.addItem')}</option>
          {sellable
            .filter((item) => !lines.some((l) => l.itemId === item.id))
            .map((item) => (
              <option key={item.id} value={item.id}>
                {itemLabel(item, data.items)}
              </option>
            ))}
        </Select>
        {problems.lines && (
          <p id={`${id}-lines-problem`} role="alert" className="text-sm text-destructive">
            {problems.lines}
          </p>
        )}
        <p className="flex justify-between border-t pt-2 font-medium" data-testid="order-total">
          <span>{t('orders.form.total')}</span>
          <span className="tabular-nums">{money(draftTotal(lines))}</span>
        </p>
      </fieldset>

      <Field id={`${id}-note`} label={t('orders.form.note')} problem={null}>
        <Input
          id={`${id}-note`}
          value={note}
          maxLength={ORDER_TEXT_MAX_LENGTH}
          onChange={(e) => setNote(e.target.value)}
          data-testid="order-note"
        />
      </Field>
      {!order && (
        <div className="flex min-h-11 items-center gap-3">
          <Checkbox
            id={`${id}-confirm`}
            checked={confirmNow}
            onCheckedChange={(next) => setConfirmNow(next === true)}
            data-testid="order-confirm-now"
          />
          <Label htmlFor={`${id}-confirm`} className="font-normal">
            {t('orders.form.confirmNow')}
          </Label>
        </div>
      )}
    </FormDialog>
  );
}
