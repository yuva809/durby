'use client';

import {
  createOrderCustomerRequestSchema,
  ORDER_CUSTOMER_CODE_MAX_LENGTH,
  ORDER_CUSTOMER_NAME_MAX_LENGTH,
  ORDER_TEXT_MAX_LENGTH,
  type OrderCustomer,
} from '@durby/shared';
import { useId, useRef, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createCustomer, updateCustomer } from '../../lib/orders/api';
import { useActionKey } from '../../lib/use-action-key';
import { Field, FormDialog } from '../form-dialog';
import { Input } from '../ui/input';

/** The api's own email rule. */
const email = createOrderCustomerRequestSchema.shape.email;
/** Empty text means "none": absent on create, null on edit. */
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/**
 * Add (no `customer`) or edit a customer (docs/modules/orders.md → Web). `onSaved` gets the saved customer, so the
 * order form can pick a customer it just added.
 */
export function CustomerDialog({
  customer,
  onSaved,
  trigger,
  triggerVariant,
}: {
  customer?: OrderCustomer;
  onSaved: (customer: OrderCustomer | null) => void;
  trigger?: string;
  triggerVariant?: 'default' | 'outline' | 'ghost';
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [fields, setFields] = useState({
    name: '',
    code: '',
    phone: '',
    email: '',
    address: '',
    note: '',
  });
  const [checked, setChecked] = useState(false);
  // A ref, not state: onDone runs right after submit resolves, before a re-render.
  const saved = useRef<OrderCustomer | null>(null);
  const nameMissing = checked && fields.name.trim() === '';
  const emailInvalid =
    checked && fields.email.trim() !== '' && !email.safeParse(fields.email.trim()).success;
  const set = (key: keyof typeof fields) => (e: { target: { value: string } }) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  const field = (
    key: keyof typeof fields,
    label: string,
    max: number,
    problem: string | null = null,
    type = 'text',
  ) => (
    <Field id={`${id}-${key}`} label={label} problem={problem}>
      <Input
        id={`${id}-${key}`}
        type={type}
        value={fields[key]}
        maxLength={max}
        aria-invalid={problem ? true : undefined}
        onChange={set(key)}
        data-testid={`customer-${key}`}
      />
    </Field>
  );

  return (
    <FormDialog
      trigger={trigger ?? t(customer ? 'orders.customers.edit' : 'orders.customers.create')}
      triggerVariant={triggerVariant ?? (customer ? 'outline' : 'default')}
      testId={customer ? 'customer-edit' : 'customer-create'}
      title={t(customer ? 'orders.customers.editTitle' : 'orders.customers.create')}
      onOpen={() => {
        setFields({
          name: customer?.name ?? '',
          code: customer?.code ?? '',
          phone: customer?.phone ?? '',
          email: customer?.email ?? '',
          address: customer?.address ?? '',
          note: customer?.note ?? '',
        });
        setChecked(false);
        saved.current = null;
      }}
      submit={() => {
        setChecked(true);
        if (fields.name.trim() === '') return null;
        if (fields.email.trim() !== '' && !email.safeParse(fields.email.trim()).success) {
          return null;
        }
        const pending = customer
          ? updateCustomer(store, action, customer.id, {
              name: fields.name.trim(),
              code: orNull(fields.code),
              phone: orNull(fields.phone),
              email: orNull(fields.email),
              address: orNull(fields.address),
              note: orNull(fields.note),
            })
          : createCustomer(store, action, {
              name: fields.name.trim(),
              ...(orNull(fields.code) ? { code: fields.code.trim() } : {}),
              ...(orNull(fields.phone) ? { phone: fields.phone.trim() } : {}),
              ...(orNull(fields.email) ? { email: fields.email.trim() } : {}),
              ...(orNull(fields.address) ? { address: fields.address.trim() } : {}),
              ...(orNull(fields.note) ? { note: fields.note.trim() } : {}),
            });
        return pending.then((result) => {
          if (result.ok) saved.current = result.data;
          return result;
        });
      }}
      onDone={() => onSaved(saved.current)}
    >
      {field(
        'name',
        t('orders.customers.name'),
        ORDER_CUSTOMER_NAME_MAX_LENGTH,
        nameMissing ? t('orders.customers.nameRequired') : null,
      )}
      {field('code', t('orders.customers.code'), ORDER_CUSTOMER_CODE_MAX_LENGTH)}
      {field('phone', t('orders.customers.phone'), 40, null, 'tel')}
      {field(
        'email',
        t('orders.customers.email'),
        254,
        emailInvalid ? t('orders.customers.emailInvalid') : null,
        'email',
      )}
      {field('address', t('orders.customers.address'), ORDER_TEXT_MAX_LENGTH)}
      {field('note', t('orders.customers.note'), ORDER_TEXT_MAX_LENGTH)}
    </FormDialog>
  );
}
