'use client';

import {
  type CreatePriceRuleRequest,
  type LocationSummary,
  PRICE_RULE_NAME_MAX_LENGTH,
  type PriceRule,
  type PriceRuleKind,
  type PriceRuleProblem,
  priceRuleProblems,
  type Product,
  type ProductCategory,
  WEEKDAYS,
  type Weekday,
  zonedInstant,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadCategories, loadProducts } from '../../lib/catalog/api';
import {
  createPriceRule,
  deletePriceRule,
  loadPriceRules,
  loadPrices,
  updatePriceRule,
} from '../../lib/catalog/prices-api';
import { loadSettings } from '../../lib/settings/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { MoneyProvider, useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';

const PROBLEM: Record<PriceRuleProblem, LabelKey> = {
  target: 'catalog.prices.problems.target',
  percent_on_product: 'catalog.prices.problems.percentOnProduct',
  value: 'catalog.prices.problems.value',
  hours: 'catalog.prices.problems.hours',
  dates: 'catalog.prices.problems.dates',
};

/**
 * /catalog/prices (docs/modules/catalog.md → Price rules, ADR 0030): the organization's price rules
 * and a price check. Reading needs `catalog.products.read`, changing `catalog.products.edit`.
 */
export function PriceRulesPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('catalog.products.read')) return <NoAccess title="catalog.prices.title" />;
  return (
    <MoneyProvider>
      <PriceRules
        organizationId={session.activeOrganizationId}
        canManage={permissions.has('catalog.products.edit')}
      />
    </MoneyProvider>
  );
}

interface Menu {
  rules: PriceRule[];
  categories: ProductCategory[];
  products: Product[];
  locations: LocationSummary[];
}

function PriceRules({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [menu, reload] = useResource(organizationId, async () => {
    const [rules, categories, products, locations] = await Promise.all([
      loadPriceRules(store),
      loadCategories(store),
      loadProducts(store),
      loadLocations(store),
    ]);
    if (!rules.ok) return rules;
    if (!categories.ok) return categories;
    if (!products.ok) return products;
    if (!locations.ok) return locations;
    const data: Menu = {
      rules: rules.data,
      categories: categories.data,
      products: products.data,
      locations: locations.data,
    };
    return { ok: true as const, data };
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Button variant="ghost" className="-ml-3 w-fit gap-1" asChild>
            <Link href="/catalog">
              <ArrowLeft aria-hidden />
              {t('catalog.prices.back')}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">{t('catalog.prices.title')}</h1>
          <p className="max-w-2xl text-muted-foreground">{t('catalog.prices.description')}</p>
        </div>
      </div>
      <Loaded resource={menu} reload={reload}>
        {(data) => (
          <>
            {canManage && data.categories.length > 0 && (
              <div>
                <RuleDialog menu={data} onDone={reload} />
              </div>
            )}
            <RuleList menu={data} canManage={canManage} onChanged={reload} />
            {data.locations.length > 0 && <PriceCheck menu={data} />}
          </>
        )}
      </Loaded>
    </div>
  );
}

function RuleList({
  menu,
  canManage,
  onChanged,
}: {
  menu: Menu;
  canManage: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const money = useMoney();
  if (menu.rules.length === 0) {
    return <p className="text-muted-foreground">{t('catalog.prices.empty')}</p>;
  }
  const productName = new Map(menu.products.map((p) => [p.id, p.name]));
  const categoryName = new Map(menu.categories.map((c) => [c.id, c.name]));
  const locationName = new Map(menu.locations.map((l) => [l.id, l.name]));
  return (
    <Card className="divide-y p-0" data-testid="price-rules">
      {menu.rules.map((rule) => (
        <div
          key={rule.id}
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          data-testid="price-rule"
          data-name={rule.name}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {rule.name}
              {!rule.active && <Badge>{t('catalog.prices.inactive')}</Badge>}
            </p>
            <p className="text-sm text-muted-foreground" data-testid="price-rule-summary">
              {[
                rule.productId
                  ? (productName.get(rule.productId) ?? '')
                  : (categoryName.get(rule.categoryId ?? '') ?? ''),
                rule.kind === 'fixed'
                  ? money(rule.value)
                  : t('catalog.prices.percentOff', { percent: trimZeros(rule.value) }),
                rule.locationId
                  ? (locationName.get(rule.locationId) ?? '')
                  : t('catalog.prices.allLocations'),
                whenText(rule, t),
              ].join(' · ')}
            </p>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <RuleDialog menu={menu} rule={rule} onDone={onChanged} />
              <ConfirmAction
                trigger={t('catalog.prices.delete', { name: rule.name })}
                triggerIcon={<Trash2 aria-hidden />}
                title={t('catalog.prices.deleteTitle', { name: rule.name })}
                description={t('catalog.prices.deleteDescription')}
                confirm={t('catalog.prices.deleteConfirm')}
                run={() => deletePriceRule(store, action, rule.id)}
                onDone={onChanged}
                testId="price-rule-delete"
              />
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

/** "Mo Tu We Th Fr · 17:00–19:00 · from 2026-12-01", or "Always". */
function whenText(rule: PriceRule, t: ReturnType<typeof useT>): string {
  const parts: string[] = [];
  if (rule.days.length > 0)
    parts.push(rule.days.map((d) => t(`catalog.prices.day.${d}`)).join(' '));
  if (rule.startsAt && rule.endsAt) {
    parts.push(t('catalog.prices.hours', { from: rule.startsAt, until: rule.endsAt }));
  }
  if (rule.validFrom && rule.validUntil) {
    parts.push(t('catalog.prices.dateRange', { from: rule.validFrom, until: rule.validUntil }));
  } else if (rule.validFrom) {
    parts.push(t('catalog.prices.fromDate', { date: rule.validFrom }));
  } else if (rule.validUntil) {
    parts.push(t('catalog.prices.untilDate', { date: rule.validUntil }));
  }
  return parts.length > 0 ? parts.join(' · ') : t('catalog.prices.always');
}

const trimZeros = (value: string) => value.replace(/\.?0+$/, '');

type Draft = {
  name: string;
  locationId: string;
  target: 'product' | 'category';
  productId: string;
  categoryId: string;
  kind: PriceRuleKind;
  value: string;
  days: Weekday[];
  startsAt: string;
  endsAt: string;
  validFrom: string;
  validUntil: string;
  active: boolean;
};

function draftOf(rule: PriceRule | undefined, menu: Menu): Draft {
  return {
    name: rule?.name ?? '',
    locationId: rule?.locationId ?? '',
    target: rule?.productId ? 'product' : 'category',
    productId: rule?.productId ?? menu.products[0]?.id ?? '',
    categoryId: rule?.categoryId ?? menu.categories[0]?.id ?? '',
    kind: rule?.kind ?? 'percent_off',
    value: rule ? trimZeros(rule.value) : '',
    days: rule?.days ?? [],
    startsAt: rule?.startsAt ?? '',
    endsAt: rule?.endsAt ?? '',
    validFrom: rule?.validFrom ?? '',
    validUntil: rule?.validUntil ?? '',
    active: rule?.active ?? true,
  };
}

function bodyOf(d: Draft): CreatePriceRuleRequest {
  const product = d.target === 'product';
  return {
    name: d.name.trim(),
    locationId: d.locationId || null,
    productId: product ? d.productId || null : null,
    categoryId: product ? null : d.categoryId || null,
    // A product gets a fixed price (percentages are for categories).
    kind: product ? 'fixed' : d.kind,
    value: d.value.trim().replace(',', '.'),
    days: WEEKDAYS.filter((day) => d.days.includes(day)),
    startsAt: d.startsAt || null,
    endsAt: d.endsAt || null,
    validFrom: d.validFrom || null,
    validUntil: d.validUntil || null,
    active: d.active,
  };
}

/** Create (no `rule`) or edit a price rule. */
function RuleDialog({ menu, rule, onDone }: { menu: Menu; rule?: PriceRule; onDone: () => void }) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [draft, setDraft] = useState<Draft>(() => draftOf(rule, menu));
  const [checked, setChecked] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const body = bodyOf(draft);
  const problems = priceRuleProblems(body);
  const nameMissing = body.name === '';
  const shown = (p: PriceRuleProblem) => (checked && problems.includes(p) ? t(PROBLEM[p]) : null);
  const percent = draft.target === 'category' && draft.kind === 'percent_off';

  return (
    <FormDialog
      trigger={rule ? t('catalog.prices.edit', { name: rule.name }) : t('catalog.prices.add')}
      triggerVariant={rule ? 'ghost' : 'default'}
      triggerIcon={rule ? <Pencil aria-hidden /> : undefined}
      testId={rule ? 'price-rule-edit' : 'price-rule-create'}
      title={t(rule ? 'catalog.prices.editTitle' : 'catalog.prices.addTitle')}
      onOpen={() => {
        setDraft(draftOf(rule, menu));
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (nameMissing || problems.length > 0) return null;
        return rule
          ? updatePriceRule(store, action, rule.id, body)
          : createPriceRule(store, action, body);
      }}
      onDone={onDone}
    >
      <Field
        id={`${id}-name`}
        label={t('catalog.prices.name')}
        problem={checked && nameMissing ? t('catalog.prices.problems.name') : null}
      >
        <Input
          id={`${id}-name`}
          value={draft.name}
          maxLength={PRICE_RULE_NAME_MAX_LENGTH}
          placeholder={t('catalog.prices.namePlaceholder')}
          onChange={(e) => set('name', e.target.value)}
          data-testid="price-rule-name"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-target`} label={t('catalog.prices.target')} problem={shown('target')}>
          <Select
            id={`${id}-target`}
            value={draft.target}
            onChange={(e) => set('target', e.target.value as Draft['target'])}
            data-testid="price-rule-target"
          >
            <option value="category">{t('catalog.prices.targetCategory')}</option>
            <option value="product">{t('catalog.prices.targetProduct')}</option>
          </Select>
        </Field>
        {draft.target === 'product' ? (
          <Field id={`${id}-product`} label={t('catalog.prices.product')} problem={null}>
            <Select
              id={`${id}-product`}
              value={draft.productId}
              onChange={(e) => set('productId', e.target.value)}
              data-testid="price-rule-product"
            >
              {menu.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field id={`${id}-category`} label={t('catalog.prices.category')} problem={null}>
            <Select
              id={`${id}-category`}
              value={draft.categoryId}
              onChange={(e) => set('categoryId', e.target.value)}
              data-testid="price-rule-category"
            >
              {menu.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {draft.target === 'category' && (
          <Field id={`${id}-kind`} label={t('catalog.prices.kind')} problem={null}>
            <Select
              id={`${id}-kind`}
              value={draft.kind}
              onChange={(e) => set('kind', e.target.value as PriceRuleKind)}
              data-testid="price-rule-kind"
            >
              <option value="percent_off">{t('catalog.prices.kindPercent')}</option>
              <option value="fixed">{t('catalog.prices.kindFixed')}</option>
            </Select>
          </Field>
        )}
        <Field
          id={`${id}-value`}
          label={t(percent ? 'catalog.prices.percent' : 'catalog.prices.value')}
          problem={shown('value') ?? shown('percent_on_product')}
        >
          <Input
            id={`${id}-value`}
            inputMode="decimal"
            value={draft.value}
            onChange={(e) => set('value', e.target.value)}
            data-testid="price-rule-value"
          />
        </Field>
      </div>
      <Field id={`${id}-location`} label={t('catalog.prices.location')} problem={null}>
        <Select
          id={`${id}-location`}
          value={draft.locationId}
          onChange={(e) => set('locationId', e.target.value)}
          data-testid="price-rule-location"
        >
          <option value="">{t('catalog.prices.allLocations')}</option>
          {menu.locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('catalog.prices.days')}</legend>
        <div className="flex flex-wrap gap-1.5" data-testid="price-rule-days">
          {WEEKDAYS.map((day) => {
            const on = draft.days.includes(day);
            return (
              <Button
                key={day}
                type="button"
                variant={on ? 'default' : 'outline'}
                className="min-w-11 px-2"
                aria-pressed={on}
                onClick={() =>
                  set('days', on ? draft.days.filter((d) => d !== day) : [...draft.days, day])
                }
              >
                {t(`catalog.prices.day.${day}`)}
              </Button>
            );
          })}
        </div>
        {draft.days.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('catalog.prices.everyDay')}</p>
        )}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-from`} label={t('catalog.prices.from')} problem={shown('hours')}>
          <Input
            id={`${id}-from`}
            type="time"
            value={draft.startsAt}
            aria-describedby={`${id}-hours-hint`}
            onChange={(e) => set('startsAt', e.target.value)}
            data-testid="price-rule-starts"
          />
        </Field>
        <Field id={`${id}-until`} label={t('catalog.prices.until')} problem={null}>
          <Input
            id={`${id}-until`}
            type="time"
            value={draft.endsAt}
            onChange={(e) => set('endsAt', e.target.value)}
            data-testid="price-rule-ends"
          />
        </Field>
      </div>
      <p id={`${id}-hours-hint`} className="-mt-2 text-sm text-muted-foreground">
        {t('catalog.prices.hoursHint')}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${id}-valid-from`}
          label={t('catalog.prices.validFrom')}
          problem={shown('dates')}
        >
          <Input
            id={`${id}-valid-from`}
            type="date"
            value={draft.validFrom}
            onChange={(e) => set('validFrom', e.target.value)}
          />
        </Field>
        <Field id={`${id}-valid-until`} label={t('catalog.prices.validUntil')} problem={null}>
          <Input
            id={`${id}-valid-until`}
            type="date"
            value={draft.validUntil}
            onChange={(e) => set('validUntil', e.target.value)}
          />
        </Field>
      </div>
      <div className="flex min-h-11 items-center gap-3">
        <Checkbox
          id={`${id}-active`}
          checked={draft.active}
          onCheckedChange={(next) => set('active', next === true)}
        />
        <Label htmlFor={`${id}-active`} className="font-normal">
          {t('catalog.prices.active')}
        </Label>
      </div>
    </FormDialog>
  );
}

/** What each product costs at a location at a chosen local date and time. */
function PriceCheck({ menu }: { menu: Menu }) {
  const t = useT();
  const id = useId();
  const money = useMoney();
  const { store } = useAuth();
  const [locationId, setLocationId] = useState(menu.locations[0]!.id);
  const [when, setWhen] = useState('');
  const key = `${locationId}:${when}:${menu.rules.map((r) => r.id).join(',')}`;
  const [prices] = useResource(key, async () => {
    if (!when) return loadPrices(store, locationId);
    // The location's wall clock, not the browser's.
    const settings = await loadSettings(store, locationId);
    if (!settings.ok) return settings;
    const zone = settings.data.find((s) => s.key === 'timezone')?.value;
    const [date = '', time = ''] = when.split('T');
    const at = typeof zone === 'string' ? zonedInstant(date, time, zone) : null;
    return loadPrices(store, locationId, at ? { at: at.toISOString() } : {});
  });
  const productName = new Map(menu.products.map((p) => [p.id, p.name]));

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {t('catalog.prices.check')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('catalog.prices.checkHint')}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="grid min-w-56 gap-1.5">
          <Label htmlFor={`${id}-location`}>{t('catalog.prices.location')}</Label>
          <Select
            id={`${id}-location`}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            data-testid="price-check-location"
          >
            {menu.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-at`}>{t('catalog.prices.checkAt')}</Label>
          <Input
            id={`${id}-at`}
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            data-testid="price-check-at"
          />
        </div>
      </div>
      <Loaded resource={prices} reload={() => undefined}>
        {(data) => (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-left text-sm" data-testid="price-check">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('catalog.prices.product')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('catalog.prices.kind')}</th>
                  <th className="px-4 py-2 font-medium">{t('catalog.prices.checkRule')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.data.map((p) => (
                  <tr
                    key={p.productId}
                    data-testid="price-check-row"
                    data-name={productName.get(p.productId)}
                  >
                    <td className="px-4 py-2">{productName.get(p.productId)}</td>
                    <td
                      className="px-4 py-2 text-right tabular-nums"
                      data-testid="price-check-price"
                    >
                      {money(p.price)}
                    </td>
                    <td className={cn('px-4 py-2', !p.ruleName && 'text-muted-foreground')}>
                      {p.ruleName ?? t('catalog.prices.ownPrice')}
                      {p.timed && <Badge className="ml-2">{t('catalog.prices.timed')}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Loaded>
    </section>
  );
}
