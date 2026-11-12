'use client';

import {
  BILL_FOOTER_LINE_MAX_LENGTH,
  BILL_FOOTER_MAX_LINES,
  type BillFooter,
  billFooterSchema,
  type BillHeader,
  billHeaderSchema,
  DEFAULT_BILL_FOOTER,
  DEFAULT_BILL_HEADER,
  type KitchenTicket,
  type LocationSummary,
  type PrepStation,
  type ResolvedSetting,
} from '@durby/shared';
import { ImageUp, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { logoDataUrl } from '../../lib/pos/bill-logo';
import { deleteSetting, loadSettings, putSetting } from '../../lib/settings/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { MoneyProvider } from '../pos/money';
import { KitchenTicketView } from '../pos/kitchen-ticket';
import { Receipt } from '../pos/receipt';
import { useBrand } from '../theme-provider';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';

/** Sample items of the preview: the real bill layout around made-up items. */
const SAMPLE_ORDER_NUMBER = 'ORD-2026-000123';
const SAMPLE_ID = '00000000-0000-7000-8000-000000000000';

/** The form's text fields; '' is "none" (null in the setting). */
type HeaderDraft = Record<'name' | 'phone' | 'email' | 'website', string> & {
  logo: string | null;
};

const headerDraft = (h: BillHeader): HeaderDraft => ({
  logo: h.logo,
  name: h.name ?? '',
  phone: h.phone ?? '',
  email: h.email ?? '',
  website: h.website ?? '',
});

const headerOf = (d: HeaderDraft): BillHeader => ({
  logo: d.logo,
  name: d.name.trim() || null,
  phone: d.phone.trim() || null,
  email: d.email.trim() || null,
  website: d.website.trim() || null,
});

const footerOf = (lines: string[]): BillFooter => ({
  lines: lines.map((l) => l.trim()).filter((l) => l !== ''),
});

/**
 * /settings/bill (docs/modules/pos.md → Bill layout, ADR 0025): the printed bill's header (logo,
 * name, phone, email, website) and footer lines, for all locations or one location's own, with a
 * preview of the real bill. The middle (waiter, table, guests, number, items, total) is fixed.
 * Reading needs platform.settings.read, saving platform.settings.manage (the api checks both).
 */
export function BillPage() {
  const { store, session } = useAuth();
  const canRead = session?.activePermissions.includes('platform.settings.read') ?? false;
  const [locations, reload] = useResource(
    canRead ? (session?.activeOrganizationId ?? null) : null,
    () => loadLocations(store),
  );
  if (!session) return null;
  if (!canRead || !session.activeFeatures.includes('pos')) {
    return <NoAccess title="pos.billSettings.title" />;
  }
  return (
    <MoneyProvider>
      <Loaded resource={locations} reload={reload}>
        {(list) => <BillSettings locations={list} />}
      </Loaded>
    </MoneyProvider>
  );
}

function BillSettings({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const id = useId();
  const { store, session } = useAuth();
  // '' = all locations (organization scope).
  const [scope, setScope] = useState('');
  const [settings, reload] = useResource(`${session?.activeOrganizationId ?? ''}:${scope}`, () =>
    loadSettings(store, scope || undefined),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('pos.billSettings.title')}</h1>
          <p className="max-w-2xl text-muted-foreground">{t('pos.billSettings.description')}</p>
        </div>
        {locations.length > 0 && (
          <div className="grid min-w-56 gap-1.5">
            <Label htmlFor={`${id}-scope`}>{t('pos.billSettings.scope')}</Label>
            <Select
              id={`${id}-scope`}
              data-testid="bill-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">{t('pos.billSettings.wholeOrganization')}</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <Loaded resource={settings} reload={reload}>
        {(list) => (
          <BillEditor
            // A new scope or a reset starts from the stored values again.
            key={`${scope}:${JSON.stringify(list.filter((s) => s.key.startsWith('pos.bill')))}`}
            locationId={scope || null}
            header={list.find((s) => s.key === 'pos.billHeader')}
            footer={list.find((s) => s.key === 'pos.billFooter')}
            onChanged={reload}
          />
        )}
      </Loaded>
    </div>
  );
}

function BillEditor({
  locationId,
  header,
  footer,
  onChanged,
}: {
  locationId: string | null;
  header: ResolvedSetting | undefined;
  footer: ResolvedSetting | undefined;
  onChanged: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store, session } = useAuth();
  const { productName } = useBrand();
  const headerAction = useActionKey();
  const footerAction = useActionKey();
  const resetHeaderAction = useActionKey();
  const resetFooterAction = useActionKey();
  const fileInput = useRef<HTMLInputElement>(null);
  const canManage = session?.activePermissions.includes('platform.settings.manage') ?? false;
  const organizationName =
    session?.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? '';

  const storedHeader = billHeaderSchema.safeParse(header?.value).data ?? DEFAULT_BILL_HEADER;
  const storedFooter = billFooterSchema.safeParse(footer?.value).data ?? DEFAULT_BILL_FOOTER;
  const [draft, setDraft] = useState<HeaderDraft>(() => headerDraft(storedHeader));
  const [lines, setLines] = useState<string[]>(() => storedFooter.lines);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [logoError, setLogoError] = useState(false);

  const nextHeader = headerOf(draft);
  const nextFooter = footerOf(lines);
  const headerValid = billHeaderSchema.safeParse(nextHeader).success;
  const footerValid = billFooterSchema.safeParse(nextFooter).success;
  const emailInvalid = !billHeaderSchema.shape.email.safeParse(nextHeader.email).success;
  const ownHere =
    locationId !== null && (header?.source === 'location' || footer?.source === 'location');

  const set = (field: keyof Omit<HeaderDraft, 'logo'>) => (value: string) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [field]: value }));
  };

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setLogoError(false);
    const url = await logoDataUrl(file);
    if (url) {
      setSaved(false);
      setDraft((d) => ({ ...d, logo: url }));
    } else {
      setLogoError(true);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!headerValid || !footerValid) {
      setError(t('pos.billSettings.invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    const scope = locationId ?? undefined;
    const results = [
      await putSetting(store, headerAction, 'pos.billHeader', nextHeader, scope),
      await putSetting(store, footerAction, 'pos.billFooter', nextFooter, scope),
    ];
    setBusy(false);
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) {
      setError(t(errorLabel(failed.code)));
      return;
    }
    setSaved(true);
  }

  async function inheritOrganization() {
    setBusy(true);
    setError(null);
    const scope = locationId ?? undefined;
    const results = [
      await deleteSetting(store, resetHeaderAction, 'pos.billHeader', scope),
      await deleteSetting(store, resetFooterAction, 'pos.billFooter', scope),
    ];
    setBusy(false);
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) setError(t(errorLabel(failed.code)));
    else onChanged();
  }

  const field = (name: keyof Omit<HeaderDraft, 'logo'>, label: string, extra: object = {}) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input
        id={`${id}-${name}`}
        data-testid={`bill-${name}`}
        value={draft[name]}
        disabled={!canManage}
        onChange={(e) => set(name)(e.target.value)}
        {...extra}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <form className="flex max-w-3xl flex-col gap-6" onSubmit={(e) => void save(e)} noValidate>
        {locationId !== null && (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-sm" data-testid="bill-scope-state">
              {t(
                ownHere ? 'pos.billSettings.locationOverride' : 'pos.billSettings.locationInherits',
              )}
            </p>
            {ownHere && canManage && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void inheritOrganization()}
                data-testid="bill-use-organization"
              >
                {t('pos.billSettings.useOrganization')}
              </Button>
            )}
          </Card>
        )}

        <Card className="flex flex-col gap-4 p-4">
          <h2 className="font-semibold">{t('pos.billSettings.header')}</h2>
          <div className="flex flex-col gap-2">
            <Label>{t('pos.billSettings.logo')}</Label>
            <div className="flex flex-wrap items-center gap-3">
              {draft.logo && (
                // A data URL from the setting; next/image can't optimize it.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={draft.logo}
                  alt=""
                  className="max-h-16 max-w-40 rounded border border-border bg-card object-contain"
                  data-testid="bill-logo-preview"
                />
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="hidden"
                data-testid="bill-logo-input"
                onChange={(e) => {
                  void pickLogo(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              {canManage && (
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={() => fileInput.current?.click()}
                >
                  <ImageUp aria-hidden />
                  {t(draft.logo ? 'pos.billSettings.logoReplace' : 'pos.billSettings.logoUpload')}
                </Button>
              )}
              {canManage && draft.logo && (
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="bill-logo-remove"
                  onClick={() => {
                    setSaved(false);
                    setDraft((d) => ({ ...d, logo: null }));
                  }}
                >
                  {t('pos.billSettings.logoRemove')}
                </Button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{t('pos.billSettings.logoHint')}</p>
            {logoError && <Notice text={t('pos.billSettings.logoInvalid')} tone="error" />}
          </div>
          {field('name', t('pos.billSettings.name'), {
            maxLength: 100,
            placeholder: t('pos.billSettings.namePlaceholder', { name: organizationName }),
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {field('phone', t('pos.billSettings.phone'), { type: 'tel', maxLength: 40 })}
            {field('email', t('pos.billSettings.email'), {
              type: 'email',
              maxLength: 120,
              'aria-invalid': emailInvalid || undefined,
            })}
          </div>
          {field('website', t('pos.billSettings.website'), { maxLength: 120 })}
        </Card>

        <Card className="flex flex-col gap-4 p-4">
          <h2 className="font-semibold">{t('pos.billSettings.footer')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('pos.billSettings.footerHint', { thanks: t('pos.bill.thanks') })}
          </p>
          {lines.map((line, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor={`${id}-line-${i}`}>
                  {t('pos.billSettings.footerLine', { number: String(i + 1) })}
                </Label>
                <Input
                  id={`${id}-line-${i}`}
                  data-testid="bill-footer-line"
                  value={line}
                  maxLength={BILL_FOOTER_LINE_MAX_LENGTH}
                  disabled={!canManage}
                  onChange={(e) => {
                    setSaved(false);
                    setLines((ls) => ls.map((l, j) => (j === i ? e.target.value : l)));
                  }}
                />
              </div>
              {canManage && (
                <Button
                  type="button"
                  variant="ghost"
                  className="size-11 px-0"
                  aria-label={t('pos.billSettings.removeLine', { number: String(i + 1) })}
                  onClick={() => {
                    setSaved(false);
                    setLines((ls) => ls.filter((_, j) => j !== i));
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
          ))}
          {canManage && lines.length < BILL_FOOTER_MAX_LINES && (
            <Button
              type="button"
              variant="outline"
              className="gap-2 self-start"
              data-testid="bill-add-line"
              onClick={() => setLines((ls) => [...ls, ''])}
            >
              <Plus aria-hidden />
              {t('pos.billSettings.addLine')}
            </Button>
          )}
        </Card>

        {canManage && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy} className="min-h-11" data-testid="bill-save">
              {t('pos.billSettings.save')}
            </Button>
            {saved && <Badge data-testid="bill-saved">{t('pos.billSettings.saved')}</Badge>}
            <Notice text={error} tone="error" />
          </div>
        )}
      </form>

      <section aria-label={t('pos.billSettings.preview')} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('pos.billSettings.preview')}</h2>
        {/* What prints: the guest bill with the header and footer above, the kitchen and bar tickets as they are. */}
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Preview title={t('pos.bill.customer')} testId="bill-preview">
            <Receipt
              layout={{ header: nextHeader, footer: nextFooter }}
              organizationName={organizationName}
              productName={productName}
              tableName="5"
              order={{
                number: SAMPLE_ORDER_NUMBER,
                covers: 2,
                waiterName: t('pos.billSettings.sampleWaiter'),
                total: '20.10',
              }}
              bill={[
                {
                  key: 'dish',
                  name: t('pos.billSettings.sampleDish'),
                  note: null,
                  quantity: 1,
                  unitPrice: '12.50',
                  total: '12.50',
                },
                {
                  key: 'drink',
                  name: t('pos.billSettings.sampleDrink'),
                  note: null,
                  quantity: 2,
                  unitPrice: '3.80',
                  total: '7.60',
                },
              ]}
              printedAt={new Date()}
            />
          </Preview>
          <Preview title={t('pos.bill.kitchen')} testId="bill-preview-kitchen">
            <KitchenTicketView
              ticket={sampleTicket('kitchen', t('pos.billSettings.sampleDish'), 1)}
              tableName="5"
              orderNumber={SAMPLE_ORDER_NUMBER}
              organizationName={nextHeader.name ?? organizationName}
            />
          </Preview>
          <Preview title={t('pos.bill.bar')} testId="bill-preview-bar">
            <KitchenTicketView
              ticket={sampleTicket('bar', t('pos.billSettings.sampleDrink'), 2)}
              tableName="5"
              orderNumber={SAMPLE_ORDER_NUMBER}
              organizationName={nextHeader.name ?? organizationName}
            />
          </Preview>
        </div>
      </section>
    </div>
  );
}

function Preview({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <Card className="mx-auto w-full max-w-80 p-4" data-testid={testId}>
        {children}
      </Card>
    </div>
  );
}

/** A made-up ticket for the kitchen and bar previews. */
function sampleTicket(station: PrepStation, productName: string, quantity: number): KitchenTicket {
  const at = new Date().toISOString();
  return {
    id: SAMPLE_ID,
    sequence: 1,
    kind: 'order',
    station,
    status: 'new',
    direct: false,
    createdAt: at,
    lines: [
      {
        id: SAMPLE_ID,
        ticketId: SAMPLE_ID,
        productId: SAMPLE_ID,
        productName,
        unitPrice: '0.00',
        taxRate: '0.00',
        quantity,
        note: null,
        voidsLineId: null,
        remaining: quantity,
        billedQuantity: 0,
        total: '0.00',
        createdAt: at,
      },
    ],
  };
}
