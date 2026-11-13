'use client';

import {
  VARIANT_ATTRIBUTE_MAX_VALUES,
  VARIANT_VALUE_MAX_LENGTH,
  type VariantAttribute,
} from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createAttribute, loadAttributes, updateAttribute } from '../../lib/inventory/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { ArchiveToggle, Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Loaded } from '../users/common';
import { InventorySubPage } from './sub-page';

/** "S, M , L,," → ["S", "M", "L"]: the values as typed, comma-separated. */
export function parseValues(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Why a list of values can't be saved, or null: 1–50 values, each at most 40 characters, no duplicates. */
export function valuesProblem(
  values: readonly string[],
): 'empty' | 'tooMany' | 'tooLong' | 'duplicate' | null {
  if (values.length === 0) return 'empty';
  if (values.length > VARIANT_ATTRIBUTE_MAX_VALUES) return 'tooMany';
  if (values.some((v) => v.length > VARIANT_VALUE_MAX_LENGTH)) return 'tooLong';
  if (new Set(values.map((v) => v.toLowerCase())).size !== values.length) return 'duplicate';
  return null;
}

/** Inventory → Variant Attributes (ADR 0038): what variants differ in, and their values in display order. */
export function AttributesPage() {
  return (
    <InventorySubPage
      title="inventory.nav.attributes"
      description="inventory.attributes.description"
    >
      {({ organizationId, can }) => <Attributes organizationId={organizationId} can={can} />}
    </InventorySubPage>
  );
}

function Attributes({
  organizationId,
  can,
}: {
  organizationId: string | null;
  can: (key: 'inventory.items.create' | 'inventory.items.edit') => boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
  const [attributes, reload] = useResource(
    organizationId === null ? null : `${organizationId}:${showArchived}`,
    () => loadAttributes(store, showArchived),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(next) => setShowArchived(next === true)}
          />
          {t('inventory.page.showArchived')}
        </label>
        {can('inventory.items.create') && <AttributeDialog onDone={reload} />}
      </div>
      <Loaded resource={attributes} reload={reload}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">{t('inventory.attributes.empty')}</p>
          ) : (
            <Card className="divide-y p-0">
              {list.map((attribute) => (
                <div
                  key={attribute.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  data-testid="attribute-row"
                  data-name={attribute.name}
                >
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <span className="flex items-center gap-2 font-medium">
                      {attribute.name}
                      {attribute.archivedAt && <Badge>{t('inventory.page.archived')}</Badge>}
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      {attribute.values.map((value) => (
                        <Badge key={value} className="border bg-card text-foreground">
                          {value}
                        </Badge>
                      ))}
                    </span>
                  </span>
                  {can('inventory.items.edit') && (
                    <span className="flex flex-wrap gap-2">
                      <AttributeDialog attribute={attribute} onDone={reload} />
                      <ArchiveFor attribute={attribute} onDone={reload} />
                    </span>
                  )}
                </div>
              ))}
            </Card>
          )
        }
      </Loaded>
    </div>
  );
}

function ArchiveFor({ attribute, onDone }: { attribute: VariantAttribute; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <ArchiveToggle
      archived={attribute.archivedAt !== null}
      labels={{
        archive: t('inventory.page.archive'),
        unarchive: t('inventory.page.restore'),
        title: t('inventory.attributes.archiveTitle', { name: attribute.name }),
        description: t('inventory.attributes.archiveDescription'),
      }}
      run={(archived) => updateAttribute(store, action, attribute.id, { archived })}
      onDone={onDone}
    />
  );
}

function AttributeDialog({
  attribute,
  onDone,
}: {
  attribute?: VariantAttribute;
  onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [name, setName] = useState('');
  const [values, setValues] = useState('');
  const [checked, setChecked] = useState(false);
  const nameMissing = checked && name.trim() === '';
  const problem = checked ? valuesProblem(parseValues(values)) : null;

  return (
    <FormDialog
      trigger={t(attribute ? 'inventory.page.edit' : 'inventory.attributes.add')}
      triggerVariant={attribute ? 'outline' : 'default'}
      testId={attribute ? 'attribute-edit' : 'attribute-create'}
      title={t(attribute ? 'inventory.attributes.edit' : 'inventory.attributes.add')}
      onOpen={() => {
        setName(attribute?.name ?? '');
        setValues(attribute?.values.join(', ') ?? '');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        const list = parseValues(values);
        if (!name.trim() || valuesProblem(list)) return null;
        const body = { name: name.trim(), values: list };
        return attribute
          ? updateAttribute(store, action, attribute.id, body)
          : createAttribute(store, action, body);
      }}
      onDone={onDone}
    >
      <Field
        id={`${id}-name`}
        label={t('inventory.fields.name')}
        problem={nameMissing ? t('inventory.page.nameRequired') : null}
      >
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={100}
          placeholder={t('inventory.attributes.namePlaceholder')}
          aria-invalid={nameMissing || undefined}
          onChange={(e) => setName(e.target.value)}
          data-testid="attribute-name"
        />
      </Field>
      <Field
        id={`${id}-values`}
        label={t('inventory.attributes.values')}
        problem={problem ? t(`inventory.attributes.valuesProblem.${problem}`) : null}
      >
        <Input
          id={`${id}-values`}
          value={values}
          placeholder={t('inventory.attributes.valuesPlaceholder')}
          aria-invalid={problem !== null || undefined}
          aria-describedby={`${id}-values-hint`}
          onChange={(e) => setValues(e.target.value)}
          data-testid="attribute-values"
        />
        <p id={`${id}-values-hint`} className="text-xs text-muted-foreground">
          {attribute
            ? t('inventory.attributes.valuesHintEdit')
            : t('inventory.attributes.valuesHint')}
        </p>
      </Field>
    </FormDialog>
  );
}
