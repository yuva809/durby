'use client';

import {
  BILL_CANCEL_REASON_MAX_LENGTH,
  type CheckSummary,
  type GuestCheck,
  type LocationSummary,
} from '@durby/shared';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadBillLayout, loadFloor } from '../../lib/pos/api';
import { cancelBill, loadCheck, loadChecks } from '../../lib/pos/bills';
import { printAs } from '../../lib/pos/print';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { Notice } from '../../app/auth-layout';
import { Field, FormDialog } from '../form-dialog';
import { NoLocations } from '../settings/locations-page';
import { useBrand } from '../theme-provider';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Loaded, NoAccess } from '../users/common';
import { CheckReceipt } from './check-receipt';
import { PrintRoot } from './kitchen-ticket';
import { MoneyProvider, useMoney } from './money';

/**
 * /checkout: the billing counter (docs/modules/pos.md → Step 4, ADR 0036 §7). Open tables with what is still to
 * bill, the guest checks of the last 24 hours and the history; a check opens as its receipt, to reprint with the
 * same number or, with `pos.bills.cancel`, to cancel.
 */
export function CheckoutPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('pos.bills.print')) {
    return <NoAccess title="pos.checkout.title" />;
  }
  return (
    <MoneyProvider>
      <Checkout organizationId={session.activeOrganizationId} />
    </MoneyProvider>
  );
}

function Checkout({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const [locations, reload] = useResource(organizationId, () => loadLocations(store));
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) =>
        list.length === 0 ? (
          <div className="flex flex-col gap-6">
            <h1 className="text-2xl font-semibold">{t('pos.checkout.title')}</h1>
            <NoLocations message={t('pos.floor.noLocations')} />
          </div>
        ) : (
          <Counter locations={list} />
        )
      }
    </Loaded>
  );
}

function Counter({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('pos.checkout.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('pos.checkout.description')}</p>
        </div>
        {locations.length > 1 && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-location`}>{t('pos.checkout.location')}</Label>
            <Select
              id={`${id}-location`}
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              data-testid="checkout-location"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <Tabs defaultValue="open" className="flex flex-col gap-4">
        <TabsList className="self-start">
          <TabsTrigger value="open" data-testid="checkout-tab-open">
            {t('pos.checkout.tabs.open')}
          </TabsTrigger>
          <TabsTrigger value="recent" data-testid="checkout-tab-recent">
            {t('pos.checkout.tabs.recent')}
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="checkout-tab-history">
            {t('pos.checkout.tabs.history')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="open">
          <OpenTables locationId={locationId} />
        </TabsContent>
        <TabsContent value="recent">
          <RecentChecks locationId={locationId} onOpen={setOpen} />
        </TabsContent>
        <TabsContent value="history">
          <History locationId={locationId} onOpen={setOpen} />
        </TabsContent>
      </Tabs>
      <CheckDialog checkId={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function OpenTables({ locationId }: { locationId: string }) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const [floor, reload] = useResource(locationId, () => loadFloor(store, locationId));
  return (
    <Loaded resource={floor} reload={reload}>
      {(tables) => {
        const open = tables.filter((table) => table.order);
        if (open.length === 0) return <Empty text={t('pos.checkout.emptyOpen')} />;
        return (
          <Card className="divide-y divide-border p-0" data-testid="checkout-open">
            {open.map((table) => (
              <div
                key={table.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                data-testid="checkout-open-row"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{table.name}</span>
                  <span className="text-sm text-muted-foreground">{table.order!.number}</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="tabular-nums">
                    {t('pos.checkout.columns.total')} {money(table.order!.gross)}
                  </span>
                  <span className="font-semibold tabular-nums" data-testid="checkout-unbilled">
                    {t('pos.checkout.columns.unbilled')} {money(table.order!.unbilled)}
                  </span>
                  <Button asChild variant="outline">
                    <Link href={`/service/${table.id}`}>{t('pos.checkout.openTill')}</Link>
                  </Button>
                </div>
              </div>
            ))}
          </Card>
        );
      }}
    </Loaded>
  );
}

function RecentChecks({
  locationId,
  onOpen,
}: {
  locationId: string;
  onOpen: (checkId: string) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const [checks, reload] = useResource(locationId, () =>
    loadChecks(store, { view: 'recent', locationId }),
  );
  return (
    <Loaded resource={checks} reload={reload}>
      {(page) =>
        page.data.length === 0 ? (
          <Empty text={t('pos.checkout.emptyRecent')} />
        ) : (
          <CheckRows checks={page.data} onOpen={onOpen} />
        )
      }
    </Loaded>
  );
}

function History({
  locationId,
  onOpen,
}: {
  locationId: string;
  onOpen: (checkId: string) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CheckSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(next?: string) {
    setBusy(true);
    setError(null);
    const result = await loadChecks(store, {
      view: 'history',
      locationId,
      from,
      to,
      q: q.trim() || undefined,
      cursor: next,
    });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorLabel(result.code)));
      return;
    }
    setRows((prev) => (next && prev ? [...prev, ...result.data.data] : result.data.data));
    setCursor(result.data.nextCursor);
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-from`}>{t('pos.checkout.from')}</Label>
          <Input
            id={`${id}-from`}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-to`}>{t('pos.checkout.to')}</Label>
          <Input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-q`}>{t('pos.checkout.search')}</Label>
          <Input
            id={`${id}-q`}
            value={q}
            maxLength={32}
            onChange={(e) => setQ(e.target.value)}
            data-testid="checkout-search"
          />
        </div>
        <Button type="submit" disabled={busy} data-testid="checkout-search-button">
          {t('pos.checkout.searchButton')}
        </Button>
      </form>
      <Notice text={error} tone="error" />
      {rows &&
        (rows.length === 0 ? (
          <Empty text={t('pos.checkout.emptyHistory')} />
        ) : (
          <CheckRows checks={rows} onOpen={onOpen} />
        ))}
      {cursor && (
        <Button
          variant="outline"
          className="self-start"
          disabled={busy}
          onClick={() => void search(cursor)}
          data-testid="checkout-more"
        >
          {t('pos.checkout.more')}
        </Button>
      )}
    </div>
  );
}

function CheckRows({
  checks,
  onOpen,
}: {
  checks: CheckSummary[];
  onOpen: (checkId: string) => void;
}) {
  const t = useT();
  const money = useMoney();
  const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
  return (
    <Card className="divide-y divide-border p-0" data-testid="checkout-checks">
      {checks.map((check) => (
        <div
          key={check.id}
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          data-testid="checkout-check-row"
        >
          <div className="flex flex-col">
            <span className={check.cancelled ? 'font-medium line-through' : 'font-medium'}>
              {check.number}
              {check.shareIndex !== null &&
                ` · ${t('pos.bill.share', {
                  index: String(check.shareIndex),
                  count: String(check.shareCount ?? ''),
                })}`}
            </span>
            <span className="text-sm text-muted-foreground">
              {time.format(new Date(check.createdAt))} · {check.tableNames.join(', ')}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {check.cancelled && <Badge>{t('pos.checkout.cancelled')}</Badge>}
            <span className="font-semibold tabular-nums">{money(check.gross)}</span>
            <Button
              variant="outline"
              onClick={() => onOpen(check.id)}
              data-testid="checkout-view-check"
            >
              {t('pos.checkout.view')}
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

/** A check as its receipt: Reprint (same number) and, with `pos.bills.cancel`, Cancel bill. */
function CheckDialog({ checkId, onClose }: { checkId: string | null; onClose: () => void }) {
  const t = useT();
  const { store, session } = useAuth();
  const { productName } = useBrand();
  const [check, reload] = useResource(checkId, () => loadCheck(store, checkId!));
  const locationId = check.status === 'ready' ? check.data.locationId : null;
  const [layout] = useResource(locationId, () => loadBillLayout(store, locationId!));
  const [printing, setPrinting] = useState<{ check: GuestCheck; seq: number } | null>(null);
  const organizationName =
    session?.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? '';
  const canCancel = session?.activePermissions.includes('pos.bills.cancel') ?? false;
  useEffect(() => {
    if (printing) printAs(organizationName);
  }, [printing, organizationName]);
  const layoutData = layout.status === 'ready' ? layout.data : null;

  return (
    <Dialog open={checkId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        closeLabel={t('pos.checkout.close')}
      >
        <DialogTitle>{t('pos.checkout.columns.check')}</DialogTitle>
        <DialogDescription className="sr-only">{t('pos.checkout.description')}</DialogDescription>
        <Loaded resource={check} reload={reload}>
          {(data) => (
            <div className="flex flex-col gap-4" data-testid="checkout-check">
              <div className="rounded-md border border-border bg-background p-3">
                <CheckReceipt
                  check={data}
                  layout={layoutData}
                  organizationName={organizationName}
                  productName={productName}
                  printedAt={new Date(data.createdAt)}
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {canCancel && !data.cancelled && <CancelBill check={data} onCancelled={reload} />}
                <Button
                  onClick={() =>
                    setPrinting((prev) => ({ check: data, seq: (prev?.seq ?? 0) + 1 }))
                  }
                  data-testid="checkout-reprint"
                >
                  {t('pos.checkout.reprint')}
                </Button>
              </div>
            </div>
          )}
        </Loaded>
        {printing && (
          <PrintRoot>
            <div key={printing.seq} data-testid="printed-bill">
              <CheckReceipt
                check={printing.check}
                layout={layoutData}
                organizationName={organizationName}
                productName={productName}
                printedAt={new Date()}
              />
            </div>
          </PrintRoot>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CancelBill({ check, onCancelled }: { check: GuestCheck; onCancelled: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      trigger={t('pos.checkout.cancelBill')}
      triggerVariant="outline"
      testId="checkout-cancel-bill"
      title={t('pos.checkout.cancelTitle', { number: check.number })}
      onOpen={() => {
        setReason('');
        setProblem(null);
      }}
      submit={() => {
        if (!reason.trim()) {
          setProblem(t('pos.checkout.reasonRequired'));
          return null;
        }
        return cancelBill(store, action, check.billId, { reason: reason.trim() });
      }}
      onDone={onCancelled}
    >
      <p className="text-sm text-muted-foreground">{t('pos.checkout.cancelDescription')}</p>
      <Field id={`${id}-reason`} label={t('pos.checkout.cancelReason')} problem={problem}>
        <Input
          id={`${id}-reason`}
          value={reason}
          maxLength={BILL_CANCEL_REASON_MAX_LENGTH}
          onChange={(e) => setReason(e.target.value)}
          data-testid="checkout-cancel-reason"
        />
      </Field>
    </FormDialog>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <Card className="px-6 py-10 text-center text-muted-foreground" data-testid="checkout-empty">
      {text}
    </Card>
  );
}
