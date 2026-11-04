'use client';

import { createTranslator, DEFAULT_LOCALE, isLocale } from '@durby/i18n';
import type { PublicMenu } from '@durby/shared';
import { Search, UtensilsCrossed } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { type ApiErrorCode, errorLabel } from '../../lib/auth/errors';
import { loadPublicMenu } from '../../lib/pos/public-menu';
import { cn } from '../../lib/utils';
import { useBrand } from '../theme-provider';
import { Input } from '../ui/input';

type State =
  | { status: 'loading' }
  | { status: 'ready'; menu: PublicMenu }
  | { status: 'error'; code: ApiErrorCode | 'unknown' };

/**
 * /menu/<organization>.<code> (docs/modules/pos.md → QR menu, ADR 0026): the restaurant's menu for
 * a guest who scanned a table's QR code, phone first: name and logo, the table, category chips,
 * search, prices in the restaurant's currency. Labels in the restaurant's language, defaults only
 * (a public page never shows an organization's overrides).
 */
export function PublicMenuPage({ link }: { link: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const { productName } = useBrand();

  useEffect(() => {
    let current = true;
    void loadPublicMenu(link).then((result) => {
      if (!current) return;
      setState(
        result.ok ? { status: 'ready', menu: result.data } : { status: 'error', code: result.code },
      );
    });
    return () => {
      current = false;
    };
  }, [link]);

  if (state.status === 'loading') {
    return <main className="min-h-dvh bg-background" aria-busy="true" />;
  }
  if (state.status === 'error') {
    const t = createTranslator(DEFAULT_LOCALE);
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <UtensilsCrossed aria-hidden className="size-10 text-muted-foreground" />
        <p className="max-w-sm text-foreground" role="alert" data-testid="menu-error">
          {t(errorLabel(state.code))}
        </p>
      </main>
    );
  }
  return <Menu menu={state.menu} productName={productName} />;
}

function Menu({ menu, productName }: { menu: PublicMenu; productName: string }) {
  const locale = isLocale(menu.locale) ? menu.locale : DEFAULT_LOCALE;
  const t = createTranslator(locale);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const money = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'currency', currency: menu.currency }),
    [locale, menu.currency],
  );
  const needle = query.trim().toLowerCase();
  const shown = menu.categories
    .filter((c) => category === null || c.name === category)
    .map((c) => ({
      ...c,
      products: c.products.filter(
        (p) =>
          needle === '' ||
          p.name.toLowerCase().includes(needle) ||
          (p.description ?? '').toLowerCase().includes(needle),
      ),
    }))
    .filter((c) => c.products.length > 0);

  return (
    <main className="min-h-dvh bg-background text-foreground" lang={locale}>
      <header className="flex flex-col items-center gap-2 border-b border-border bg-card px-4 pt-6 pb-4 text-center">
        {menu.logo && (
          // A data URL from the restaurant's bill header.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={menu.logo} alt="" className="max-h-20 max-w-[60%] object-contain" />
        )}
        <h1 className="text-2xl font-bold">{menu.name}</h1>
        <p className="text-sm text-muted-foreground" data-testid="menu-table">
          {t('pos.menu.table', { table: menu.tableName })}
        </p>
      </header>
      <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-border bg-background px-4 py-3">
        <div className="relative">
          <Search
            aria-hidden
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pos.menu.search')}
            aria-label={t('pos.menu.search')}
            className="pl-9"
          />
        </div>
        <nav aria-label={t('pos.menu.categories')} className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-2">
            {[null, ...menu.categories.map((c) => c.name)].map((name) => (
              <li key={name ?? ''} className="shrink-0">
                <button
                  type="button"
                  aria-pressed={category === name}
                  onClick={() => setCategory(name)}
                  className={cn(
                    'min-h-9 rounded-full border px-3 text-sm whitespace-nowrap',
                    category === name
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card text-foreground',
                  )}
                >
                  {name ?? t('pos.menu.all')}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-5">
        {shown.length === 0 && (
          <p className="py-10 text-center text-muted-foreground">{t('pos.menu.nothing')}</p>
        )}
        {shown.map((c) => (
          <section key={c.name} data-testid="menu-category" data-name={c.name}>
            <h2 className="mb-2 text-lg font-semibold">{c.name}</h2>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
              {c.products.map((p, i) => (
                <li
                  key={`${p.name}-${i}`}
                  className="flex items-start justify-between gap-3 p-3"
                  data-testid="menu-item"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{p.name}</p>
                    {p.description && (
                      <p className="text-sm text-muted-foreground">{p.description}</p>
                    )}
                  </div>
                  <p className="shrink-0 font-semibold tabular-nums" data-testid="menu-price">
                    {money.format(Number(p.price))}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="pt-4 text-center text-xs text-muted-foreground">
          {t('pos.bill.poweredBy', { product: productName })}
        </p>
      </div>
    </main>
  );
}
