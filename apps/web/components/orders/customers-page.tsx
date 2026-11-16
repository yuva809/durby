'use client';

import type { OrderCustomer } from '@durby/shared';
import { ArrowLeft, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadCustomers, updateCustomer } from '../../lib/orders/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { ArchiveToggle } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Loaded, NoAccess } from '../users/common';
import { CustomerDialog } from './customer-dialog';

/**
 * /orders/customers (docs/modules/orders.md → Web, ADR 0044): the customers of sales orders. Reading needs
 * `orders.customers.read`, adding `orders.customers.create`, editing and archiving `orders.customers.edit`.
 */
export function CustomersPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('orders.customers.read')) return <NoAccess title="orders.page.customers" />;
  return (
    <Customers
      organizationId={session.activeOrganizationId}
      canCreate={permissions.has('orders.customers.create')}
      canEdit={permissions.has('orders.customers.edit')}
    />
  );
}

function Customers({
  organizationId,
  canCreate,
  canEdit,
}: {
  organizationId: string | null;
  canCreate: boolean;
  canEdit: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [showArchived, setShowArchived] = useState(false);
  const [customers, reload] = useResource(
    organizationId === null ? null : `${organizationId}:${showArchived}`,
    () => loadCustomers(store, showArchived),
  );

  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" asChild className="self-start">
        <Link href="/orders">
          <ArrowLeft aria-hidden />
          {t('orders.customers.back')}
        </Link>
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('orders.page.customers')}</h1>
          <p className="text-muted-foreground">{t('orders.customers.intro')}</p>
        </div>
        {canCreate && <CustomerDialog onSaved={reload} />}
      </div>
      <div className="flex min-h-11 items-center gap-3">
        <Checkbox
          id={`${id}-archived`}
          checked={showArchived}
          onCheckedChange={(next) => setShowArchived(next === true)}
        />
        <Label htmlFor={`${id}-archived`} className="font-normal">
          {t('orders.customers.showArchived')}
        </Label>
      </div>
      <Loaded resource={customers} reload={reload}>
        {(list) =>
          list.length === 0 ? (
            <Card
              className="flex flex-col items-center gap-2 px-6 py-12 text-center"
              data-testid="customers-empty"
            >
              <UsersRound aria-hidden className="size-8 text-muted-foreground" />
              <p className="text-muted-foreground">{t('orders.customers.empty')}</p>
            </Card>
          ) : (
            <Card className="p-0">
              <ul className="divide-y divide-border" data-testid="customer-list">
                {list.map((customer) => (
                  <CustomerRow
                    key={customer.id}
                    customer={customer}
                    canEdit={canEdit}
                    onDone={reload}
                  />
                ))}
              </ul>
            </Card>
          )
        }
      </Loaded>
    </div>
  );
}

function CustomerRow({
  customer,
  canEdit,
  onDone,
}: {
  customer: OrderCustomer;
  canEdit: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const contact = [customer.phone, customer.email].filter(Boolean).join(' · ');
  return (
    <li
      className="flex flex-wrap items-center gap-3 px-4 py-3"
      data-testid="customer-row"
      data-name={customer.name}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{customer.name}</span>
          {customer.code && <Badge>{customer.code}</Badge>}
          {customer.archivedAt && <Badge>{t('orders.customers.archived')}</Badge>}
        </span>
        {contact && <span className="text-sm text-muted-foreground">{contact}</span>}
        {customer.address && (
          <span className="text-sm text-muted-foreground">{customer.address}</span>
        )}
      </span>
      {canEdit && (
        <span className="flex shrink-0 gap-2">
          <CustomerDialog customer={customer} onSaved={onDone} />
          <ArchiveToggle
            archived={customer.archivedAt !== null}
            labels={{
              archive: t('orders.customers.archive'),
              unarchive: t('orders.customers.unarchive'),
              title: t('orders.customers.archiveTitle'),
              description: t('orders.customers.archiveDescription', { name: customer.name }),
            }}
            run={(archived) => updateCustomer(store, action, customer.id, { archived })}
            onDone={onDone}
          />
        </span>
      )}
    </li>
  );
}
