'use client';

import {
  CATALOG_NAME_MAX_LENGTH,
  CATEGORY_DESCRIPTION_MAX_LENGTH,
  type PrepStation,
  PREP_STATIONS,
  type ProductCategory,
} from '@durby/shared';
import { ImagePlus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createCategory, updateCategory } from '../../lib/catalog/api';
import {
  categoryColor,
  removeCategoryImage,
  resizeCategoryImage,
  uploadCategoryImage,
  useCategoryImage,
} from '../../lib/catalog/category-image';
import { useActionKey } from '../../lib/use-action-key';
import { Field, FormDialog } from '../form-dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';

/** What happens to the tile image on save: keep it, set a new (resized) one, or remove it. */
type ImageChange =
  { kind: 'keep' } | { kind: 'set'; blob: Blob; preview: string } | { kind: 'remove' };

/**
 * Create (no `category`) or edit a category (docs/modules/catalog.md, ADR 0048): name, description, a secondary
 * category of a top-level one, and a tile image. Where its items print (kitchen / bar) shows only to organizations
 * with the till (`pos`); others never see it. `categories`: the organization's categories, for the parent choice.
 */
export function CategoryDialog({
  category,
  categories = [],
  onDone,
}: {
  category?: ProductCategory;
  categories?: readonly ProductCategory[];
  onDone: () => void;
}) {
  const t = useT();
  const { store, session } = useAuth();
  const action = useActionKey();
  const imageAction = useActionKey();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  const [station, setStation] = useState<PrepStation>('kitchen');
  const [image, setImage] = useState<ImageChange>({ kind: 'keep' });
  const [imageProblem, setImageProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const current = useCategoryImage(store, category ?? null);
  const nameMissing = checked && name.trim() === '';
  const withTill = session?.activeFeatures.includes('pos') ?? false;
  // One level: a top-level, active category other than this one; a category with secondary categories stays on top.
  const hasChildren = category ? categories.some((c) => c.parentId === category.id) : false;
  const parents = categories.filter(
    (c) => c.archivedAt === null && c.parentId === null && c.id !== category?.id,
  );
  const preview = image.kind === 'set' ? image.preview : image.kind === 'remove' ? null : current;

  useEffect(
    () => () => {
      if (image.kind === 'set') URL.revokeObjectURL(image.preview);
    },
    [image],
  );

  async function pick(file: File | undefined) {
    setImageProblem(null);
    if (!file) return;
    const blob = await resizeCategoryImage(file);
    if (!blob) {
      setImageProblem(t('catalog.errors.categoryImageInvalid'));
      return;
    }
    setImage({ kind: 'set', blob, preview: URL.createObjectURL(blob) });
  }

  return (
    <FormDialog
      trigger={t(category ? 'catalog.page.edit' : 'catalog.page.createCategory')}
      triggerVariant={category ? 'outline' : 'default'}
      testId={category ? 'category-edit' : 'category-create'}
      title={t(category ? 'catalog.page.editCategory' : 'catalog.page.createCategory')}
      onOpen={() => {
        setName(category?.name ?? '');
        setDescription(category?.description ?? '');
        setParentId(category?.parentId ?? '');
        setStation(category?.station ?? 'kitchen');
        setImage({ kind: 'keep' });
        setImageProblem(null);
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '') return null;
        // Only what is set (create) or changed (edit): an empty description or no parent is the default.
        const nextDescription = description.trim();
        const nextParent = parentId || null;
        const body = {
          name: name.trim(),
          ...(nextDescription !== (category?.description ?? '')
            ? { description: nextDescription }
            : {}),
          ...(nextParent !== (category?.parentId ?? null) ? { parentId: nextParent } : {}),
          ...(withTill ? { station } : {}),
        };
        return (async () => {
          const saved = category
            ? await updateCategory(store, action, category.id, body)
            : await createCategory(store, action, body);
          if (!saved.ok || !saved.data) return saved;
          // The image goes once the category exists; its own failure is reported like any other.
          if (image.kind === 'set') {
            return uploadCategoryImage(store, imageAction, saved.data.id, image.blob);
          }
          if (image.kind === 'remove' && saved.data.imageVersion) {
            return removeCategoryImage(store, imageAction, saved.data.id);
          }
          return saved;
        })();
      }}
      onDone={onDone}
    >
      <Field
        id={`${id}-name`}
        label={t('catalog.fields.name')}
        problem={nameMissing ? t('catalog.page.nameRequired') : null}
      >
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={CATALOG_NAME_MAX_LENGTH}
          placeholder={t('catalog.categoryDialog.namePlaceholder')}
          aria-invalid={nameMissing || undefined}
          onChange={(e) => setName(e.target.value)}
          data-testid="category-name"
        />
      </Field>
      <Field
        id={`${id}-description`}
        label={t('catalog.categoryDialog.description')}
        problem={null}
      >
        <textarea
          id={`${id}-description`}
          value={description}
          maxLength={CATEGORY_DESCRIPTION_MAX_LENGTH}
          rows={3}
          placeholder={t('catalog.categoryDialog.descriptionPlaceholder')}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-testid="category-description"
        />
      </Field>
      <Field id={`${id}-parent`} label={t('catalog.categoryDialog.parent')} problem={null}>
        <Select
          id={`${id}-parent`}
          value={parentId}
          disabled={hasChildren}
          aria-describedby={hasChildren ? `${id}-parent-hint` : undefined}
          onChange={(e) => setParentId(e.target.value)}
          data-testid="category-parent"
        >
          <option value="">{t('catalog.categoryDialog.noParent')}</option>
          {parents.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {hasChildren && (
          <p id={`${id}-parent-hint`} className="text-sm text-muted-foreground">
            {t('catalog.categoryDialog.parentLocked')}
          </p>
        )}
      </Field>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium" id={`${id}-image-label`}>
          {t('catalog.categoryDialog.image')}
        </span>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            aria-labelledby={`${id}-image-label`}
            className="relative flex size-20 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-dashed border-input bg-muted text-xs font-medium text-muted-foreground hover:bg-accent"
            style={preview ? undefined : { borderColor: categoryColor(category?.id ?? name) }}
            data-testid="category-image-pick"
          >
            {preview ? (
              // An object URL from the api or the picked file: next/image can't optimize those.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" className="absolute inset-0 size-full object-cover" />
            ) : (
              <>
                <ImagePlus aria-hidden className="size-5" />
                {t('catalog.categoryDialog.imageAdd')}
              </>
            )}
          </button>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{t('catalog.categoryDialog.imageHint')}</p>
            {preview && (
              <Button
                type="button"
                variant="ghost"
                className="self-start"
                onClick={() => setImage({ kind: 'remove' })}
                data-testid="category-image-remove"
              >
                <X aria-hidden />
                {t('catalog.categoryDialog.imageRemove')}
              </Button>
            )}
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
          data-testid="category-image-file"
        />
        {imageProblem && (
          <p role="alert" className="text-sm text-destructive">
            {imageProblem}
          </p>
        )}
      </div>
      {withTill && (
        // Where its items print: drinks on the bar ticket (ADR 0025). Only with the till.
        <Field id={`${id}-station`} label={t('catalog.fields.station')} problem={null}>
          <Select
            id={`${id}-station`}
            value={station}
            aria-describedby={`${id}-station-hint`}
            onChange={(e) => setStation(e.target.value as PrepStation)}
            data-testid="category-station-select"
          >
            {PREP_STATIONS.map((value) => (
              <option key={value} value={value}>
                {t(`catalog.stations.${value}`)}
              </option>
            ))}
          </Select>
          <p id={`${id}-station-hint`} className="text-sm text-muted-foreground">
            {t('catalog.stations.hint')}
          </p>
        </Field>
      )}
    </FormDialog>
  );
}
