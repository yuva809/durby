'use client';

import {
  type Product,
  type ProductCategory,
  priceSchema,
  taxRateSchema,
  CATALOG_NAME_MAX_LENGTH,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
} from '@durby/shared';
import { ScanText } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  createCategory,
  createProduct,
  loadCategories,
  loadProducts,
  updateCategory,
  updateProduct,
} from '../../lib/catalog/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { ArchiveToggle, Field, FormDialog } from '../form-dialog';
import { ImportDialog } from './import-dialog';

/** /catalog (docs/modules/catalog.md → Web). Editing needs `catalog.products.manage`. */
export function CatalogPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('catalog.products.read')) return <NoAccess title="catalog.nav.title" />;
  return (
    <Catalog
      organizationId={session.activeOrganizationId}
      canManage={permissions.has('catalog.products.manage')}
    />
  );
}

function Catalog({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const key = organizationId === null ? null : `${organizationId}:${showArchived}`;
  const [categories, reloadCategories] = useResource(key, () =>
    loadCategories(store, showArchived),
  );
  const [products, reloadProducts] = useResource(key, () => loadProducts(store, showArchived));
  const reload = () => {
    reloadCategories();
    reloadProducts();
  };
  const openCategories =
    categories.status === 'ready' ? categories.data.filter((c) => c.archivedAt === null) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('catalog.nav.title')}</h1>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/catalog/scan" data-testid="scan-open">
                <ScanText aria-hidden />
                {t('catalog.scan.open')}
              </Link>
            </Button>
            <ImportDialog onDone={reload} />
            <CategoryDialog onDone={reload} />
            {openCategories.length > 0 && (
              <ProductDialog categories={openCategories} onDone={reload} />
            )}
          </div>
        )}
      </div>
      <div className="flex min-h-11 items-center gap-3">
        <Checkbox
          id={`${id}-archived`}
          checked={showArchived}
          onCheckedChange={(next) => setShowArchived(next === true)}
        />
        <Label htmlFor={`${id}-archived`} className="font-normal">
          {t('catalog.page.showArchived')}
        </Label>
      </div>
      <Loaded resource={categories} reload={reloadCategories}>
        {(categoryList) => (
          <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
            <section className="flex flex-col gap-2" aria-labelledby={`${id}-categories`}>
              <h2 id={`${id}-categories`} className="text-lg font-medium">
                {t('catalog.page.categories')}
              </h2>
              {categoryList.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t(canManage ? 'catalog.page.noCategoryHint' : 'catalog.page.emptyCategories')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  <li>
                    <Button
                      variant={filter === null ? 'outline' : 'ghost'}
                      className="w-full justify-start"
                      aria-pressed={filter === null}
                      onClick={() => setFilter(null)}
                    >
                      {t('catalog.page.allCategories')}
                    </Button>
                  </li>
                  {categoryList.map((category) => (
                    <CategoryRow
                      key={category.id}
                      category={category}
                      selected={filter === category.id}
                      onSelect={() => setFilter(category.id)}
                      canManage={canManage}
                      onDone={reload}
                    />
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col gap-2" aria-label={t('catalog.nav.title')}>
              <Loaded resource={products} reload={reloadProducts}>
                {(productList) => (
                  <ProductTable
                    products={productList.filter((p) => filter === null || p.categoryId === filter)}
                    categories={categoryList}
                    canManage={canManage}
                    onDone={reload}
                  />
                )}
              </Loaded>
            </section>
          </div>
        )}
      </Loaded>
    </div>
  );
}

function CategoryRow({
  category,
  selected,
  onSelect,
  canManage,
  onDone,
}: {
  category: ProductCategory;
  selected: boolean;
  onSelect: () => void;
  canManage: boolean;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <li className="flex flex-col gap-1" data-testid="category-row" data-name={category.name}>
      <Button
        variant={selected ? 'outline' : 'ghost'}
        className="w-full justify-start gap-2"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="truncate">{category.name}</span>
        {category.archivedAt && <Badge>{t('catalog.page.archived')}</Badge>}
      </Button>
      {canManage && selected && (
        <div className="flex flex-wrap gap-2 px-2 pb-2">
          <CategoryDialog category={category} onDone={onDone} />
          <ArchiveCategory category={category} onDone={onDone} />
        </div>
      )}
    </li>
  );
}

function ProductTable({
  products,
  categories,
  canManage,
  onDone,
}: {
  products: Product[];
  categories: ProductCategory[];
  canManage: boolean;
  onDone: () => void;
}) {
  const t = useT();
  if (products.length === 0) {
    return <p className="text-muted-foreground">{t('catalog.page.emptyProducts')}</p>;
  }
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const open = categories.filter((c) => c.archivedAt === null);
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-muted-foreground">
          <tr>
            <th className="p-3 font-medium">{t('catalog.fields.name')}</th>
            <th className="p-3 font-medium">{t('catalog.fields.category')}</th>
            <th className="p-3 text-right font-medium">{t('catalog.fields.price')}</th>
            <th className="p-3 text-right font-medium">{t('catalog.fields.taxRate')}</th>
            {canManage && <th className="p-3" />}
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr
              key={product.id}
              className="border-b border-border last:border-0"
              data-testid="product-row"
              data-name={product.name}
            >
              <td className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{product.name}</span>
                  {product.archivedAt && <Badge>{t('catalog.page.archived')}</Badge>}
                </div>
                {product.description && (
                  <p className="text-muted-foreground">{product.description}</p>
                )}
              </td>
              <td className="p-3">{categoryName.get(product.categoryId)}</td>
              <td className="p-3 text-right tabular-nums">{product.price}</td>
              <td className="p-3 text-right tabular-nums">{product.taxRate}</td>
              {canManage && (
                <td className="p-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    {open.length > 0 && (
                      <ProductDialog product={product} categories={open} onDone={onDone} />
                    )}
                    <ArchiveProduct product={product} onDone={onDone} />
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ArchiveCategory({ category, onDone }: { category: ProductCategory; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <ArchiveToggle
      archived={category.archivedAt !== null}
      labels={{
        archive: t('catalog.page.archive'),
        unarchive: t('catalog.page.unarchive'),
        title: t('catalog.page.archiveCategoryTitle'),
        description: t('catalog.page.archiveCategoryDescription', { name: category.name }),
      }}
      run={(archived) => updateCategory(store, action, category.id, { archived })}
      onDone={onDone}
    />
  );
}

function ArchiveProduct({ product, onDone }: { product: Product; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <ArchiveToggle
      archived={product.archivedAt !== null}
      labels={{
        archive: t('catalog.page.archive'),
        unarchive: t('catalog.page.unarchive'),
        title: t('catalog.page.archiveProductTitle'),
        description: t('catalog.page.archiveProductDescription', { name: product.name }),
      }}
      run={(archived) => updateProduct(store, action, product.id, { archived })}
      onDone={onDone}
    />
  );
}

/** Create (no `category`) or edit a category. */
function CategoryDialog({ category, onDone }: { category?: ProductCategory; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [name, setName] = useState('');
  const [checked, setChecked] = useState(false);
  const nameMissing = checked && name.trim() === '';

  return (
    <FormDialog
      trigger={t(category ? 'catalog.page.edit' : 'catalog.page.createCategory')}
      triggerVariant={category ? 'outline' : 'default'}
      testId={category ? 'category-edit' : 'category-create'}
      title={t(category ? 'catalog.page.editCategory' : 'catalog.page.createCategory')}
      onOpen={() => {
        setName(category?.name ?? '');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '') return null;
        const body = { name: name.trim() };
        return category
          ? updateCategory(store, action, category.id, body)
          : createCategory(store, action, body);
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
          aria-invalid={nameMissing || undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

/** Create (no `product`) or edit a product; `categories` are the non-archived ones. */
function ProductDialog({
  product,
  categories,
  onDone,
}: {
  product?: Product;
  categories: ProductCategory[];
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [form, setForm] = useState({
    name: '',
    categoryId: '',
    description: '',
    price: '',
    taxRate: '',
  });
  const [checked, setChecked] = useState(false);
  const set = (field: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const problems = {
    name: form.name.trim() === '' ? t('catalog.page.nameRequired') : null,
    categoryId: form.categoryId === '' ? t('catalog.page.categoryRequired') : null,
    price: priceSchema.safeParse(form.price.trim()).success ? null : t('catalog.page.priceInvalid'),
    taxRate: taxRateSchema.safeParse(form.taxRate.trim()).success
      ? null
      : t('catalog.page.taxRateInvalid'),
  };
  const shown = (field: keyof typeof problems) => (checked ? problems[field] : null);

  return (
    <FormDialog
      trigger={t(product ? 'catalog.page.edit' : 'catalog.page.createProduct')}
      triggerVariant={product ? 'outline' : 'default'}
      testId={product ? 'product-edit' : 'product-create'}
      title={t(product ? 'catalog.page.editProduct' : 'catalog.page.createProduct')}
      onOpen={() => {
        setForm({
          name: product?.name ?? '',
          categoryId:
            product?.categoryId && categories.some((c) => c.id === product.categoryId)
              ? product.categoryId
              : (categories[0]?.id ?? ''),
          description: product?.description ?? '',
          price: product?.price ?? '',
          taxRate: product?.taxRate ?? '',
        });
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (Object.values(problems).some((p) => p !== null)) return null;
        const body = {
          name: form.name.trim(),
          categoryId: form.categoryId,
          description: form.description.trim(),
          price: form.price.trim(),
          taxRate: form.taxRate.trim(),
        };
        return product
          ? updateProduct(store, action, product.id, body)
          : createProduct(store, action, body);
      }}
      onDone={onDone}
    >
      <Field id={`${id}-name`} label={t('catalog.fields.name')} problem={shown('name')}>
        <Input
          id={`${id}-name`}
          value={form.name}
          maxLength={CATALOG_NAME_MAX_LENGTH}
          aria-invalid={shown('name') ? true : undefined}
          onChange={(e) => set('name')(e.target.value)}
        />
      </Field>
      <Field
        id={`${id}-category`}
        label={t('catalog.fields.category')}
        problem={shown('categoryId')}
      >
        <Select
          id={`${id}-category`}
          value={form.categoryId}
          onChange={(e) => set('categoryId')(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-price`} label={t('catalog.fields.price')} problem={shown('price')}>
          <Input
            id={`${id}-price`}
            inputMode="decimal"
            value={form.price}
            aria-invalid={shown('price') ? true : undefined}
            onChange={(e) => set('price')(e.target.value)}
          />
        </Field>
        <Field id={`${id}-tax`} label={t('catalog.fields.taxRate')} problem={shown('taxRate')}>
          <Input
            id={`${id}-tax`}
            inputMode="decimal"
            value={form.taxRate}
            aria-invalid={shown('taxRate') ? true : undefined}
            onChange={(e) => set('taxRate')(e.target.value)}
          />
        </Field>
      </div>
      <Field id={`${id}-description`} label={t('catalog.fields.description')} problem={null}>
        <Input
          id={`${id}-description`}
          value={form.description}
          maxLength={PRODUCT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => set('description')(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
