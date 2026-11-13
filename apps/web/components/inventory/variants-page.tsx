'use client';

import { MAX_VARIANTS_PER_ITEM, type StockItem, type VariantAttribute } from '@durby/shared';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { generateVariants, loadAttributes, loadStockItems } from '../../lib/inventory/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Loaded } from '../users/common';
import { InventorySubPage } from './sub-page';

/** The most attributes one Generate may combine (the api's limit). */
const MAX_ATTRIBUTES = 3;

/** Picked values per attribute id, in the attribute's order. */
type Picks = Record<string, string[]>;

/** How many variants the picks make: the product of each picked attribute's value count. */
export const combinationCount = (picks: Picks): number => {
  const lists = Object.values(picks).filter((values) => values.length > 0);
  return lists.length === 0 ? 0 : lists.reduce((n, values) => n * values.length, 1);
};

/** Inventory → Variant Products (ADR 0038): items with variants, and Generate variants. */
export function VariantsPage() {
  return (
    <InventorySubPage title="inventory.nav.variants" description="inventory.variants.description">
      {({ organizationId, can }) => (
        <Variants organizationId={organizationId} canGenerate={can('inventory.items.create')} />
      )}
    </InventorySubPage>
  );
}

function Variants({
  organizationId,
  canGenerate,
}: {
  organizationId: string | null;
  canGenerate: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [items, reloadItems] = useResource(organizationId, () => loadStockItems(store, true));
  const [attributes, reloadAttributes] = useResource(organizationId, () => loadAttributes(store));
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => {
    reloadItems();
    reloadAttributes();
  };

  return (
    <Loaded resource={items} reload={reload}>
      {(itemList) => (
        <Loaded resource={attributes} reload={reload}>
          {(attributeList) => {
            const variantsOf = new Map<string, StockItem[]>();
            for (const item of itemList) {
              if (!item.parentItemId) continue;
              variantsOf.set(item.parentItemId, [
                ...(variantsOf.get(item.parentItemId) ?? []),
                item,
              ]);
            }
            const parents = itemList.filter((i) => variantsOf.has(i.id));
            const candidates = itemList.filter((i) => !i.parentItemId && i.archivedAt === null);
            return (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Notice text={notice} tone="info" />
                  {canGenerate && (
                    <GenerateDialog
                      items={candidates}
                      attributes={attributeList}
                      onCreated={(created, skipped) => {
                        setNotice(
                          t('inventory.variants.generated', {
                            created: String(created),
                            skipped: String(skipped),
                          }),
                        );
                        reloadItems();
                      }}
                    />
                  )}
                </div>
                {parents.length === 0 ? (
                  <p className="text-muted-foreground">{t('inventory.variants.empty')}</p>
                ) : (
                  parents.map((parent) => (
                    <Card
                      key={parent.id}
                      className="flex flex-col p-0"
                      data-testid="variant-parent"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                        <span className="flex items-center gap-2 font-medium">
                          {parent.name}
                          {parent.archivedAt && <Badge>{t('inventory.page.archived')}</Badge>}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {t('inventory.variants.count', {
                            count: String(variantsOf.get(parent.id)!.length),
                          })}
                        </span>
                      </div>
                      <ul className="divide-y">
                        {variantsOf.get(parent.id)!.map((variant) => (
                          <li
                            key={variant.id}
                            className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                            data-testid="variant-row"
                          >
                            <span className="flex flex-wrap items-center gap-1.5">
                              {variant.variantValues.map((value, i) => (
                                <Badge
                                  key={`${i}-${value}`}
                                  className="border bg-card text-foreground"
                                >
                                  {value}
                                </Badge>
                              ))}
                              {variant.archivedAt && <Badge>{t('inventory.page.archived')}</Badge>}
                            </span>
                            <span className="text-muted-foreground">
                              {[t(`inventory.units.${variant.unit}`), variant.sku]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  ))
                )}
              </div>
            );
          }}
        </Loaded>
      )}
    </Loaded>
  );
}

function GenerateDialog({
  items,
  attributes,
  onCreated,
}: {
  items: StockItem[];
  attributes: VariantAttribute[];
  onCreated: (created: number, skipped: number) => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [itemId, setItemId] = useState('');
  const [picks, setPicks] = useState<Picks>({});
  const [prefix, setPrefix] = useState('');
  const [checked, setChecked] = useState(false);
  const count = combinationCount(picks);
  const chosen = Object.keys(picks);
  const itemMissing = checked && itemId === '';
  const picksProblem = checked
    ? count === 0
      ? t('inventory.variants.pickValues')
      : count > MAX_VARIANTS_PER_ITEM
        ? t('inventory.errors.tooManyVariants')
        : null
    : null;

  const toggleAttribute = (attribute: VariantAttribute, on: boolean) =>
    setPicks((current) => {
      const next = { ...current };
      if (on) next[attribute.id] = [...attribute.values];
      else delete next[attribute.id];
      return next;
    });
  const toggleValue = (attribute: VariantAttribute, value: string, on: boolean) =>
    setPicks((current) => {
      const picked = new Set(current[attribute.id] ?? []);
      if (on) picked.add(value);
      else picked.delete(value);
      return { ...current, [attribute.id]: attribute.values.filter((v) => picked.has(v)) };
    });

  return (
    <FormDialog
      trigger={t('inventory.variants.generate')}
      triggerVariant="default"
      testId="variants-generate"
      title={t('inventory.variants.generate')}
      onOpen={() => {
        setItemId('');
        setPicks({});
        setPrefix('');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (!itemId || count === 0 || count > MAX_VARIANTS_PER_ITEM) return null;
        return generateVariants(store, action, itemId, {
          attributes: Object.entries(picks)
            .filter(([, values]) => values.length > 0)
            .map(([attributeId, values]) => ({ attributeId, values })),
          ...(prefix.trim() ? { skuPrefix: prefix.trim() } : {}),
        }).then((result) => {
          if (result.ok && result.data) onCreated(result.data.created.length, result.data.skipped);
          return result;
        });
      }}
      onDone={() => undefined}
    >
      <Field
        id={`${id}-item`}
        label={t('inventory.variants.parent')}
        problem={itemMissing ? t('inventory.page.chooseItem') : null}
      >
        <Select
          id={`${id}-item`}
          value={itemId}
          aria-invalid={itemMissing || undefined}
          onChange={(e) => setItemId(e.target.value)}
          data-testid="variants-item"
        >
          <option value="">{t('inventory.page.chooseItem')}</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </Field>
      {attributes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inventory.variants.noAttributes')}</p>
      ) : (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">
            {t('inventory.variants.attributes', { max: String(MAX_ATTRIBUTES) })}
          </legend>
          {attributes.map((attribute) => {
            const on = chosen.includes(attribute.id);
            const full = !on && chosen.length >= MAX_ATTRIBUTES;
            return (
              <div key={attribute.id} className="flex flex-col gap-1.5 rounded-md border p-3">
                <label
                  className={cn(
                    'flex min-h-11 items-center gap-2 text-sm font-medium',
                    full && 'text-muted-foreground',
                  )}
                >
                  <Checkbox
                    checked={on}
                    disabled={full}
                    onCheckedChange={(v) => toggleAttribute(attribute, v === true)}
                    data-testid="variants-attribute"
                    data-name={attribute.name}
                  />
                  {attribute.name}
                </label>
                {on && (
                  <div className="flex flex-wrap gap-x-4 pl-7">
                    {attribute.values.map((value) => (
                      <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                        <Checkbox
                          checked={picks[attribute.id]?.includes(value) ?? false}
                          onCheckedChange={(v) => toggleValue(attribute, value, v === true)}
                          data-testid="variants-value"
                          data-value={value}
                        />
                        {value}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
      )}
      <p
        className={cn('text-sm', picksProblem ? 'text-destructive' : 'text-muted-foreground')}
        role={picksProblem ? 'alert' : undefined}
        data-testid="variants-count"
      >
        {picksProblem ?? t('inventory.variants.combinations', { count: String(count) })}
      </p>
      <Field id={`${id}-prefix`} label={t('inventory.variants.skuPrefix')} problem={null}>
        <Input
          id={`${id}-prefix`}
          value={prefix}
          maxLength={40}
          aria-describedby={`${id}-prefix-hint`}
          onChange={(e) => setPrefix(e.target.value)}
          data-testid="variants-prefix"
        />
        <p id={`${id}-prefix-hint`} className="text-xs text-muted-foreground">
          {t('inventory.variants.skuPrefixHint')}
        </p>
      </Field>
    </FormDialog>
  );
}
