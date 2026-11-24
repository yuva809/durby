'use client';

import type { SalesCard } from '@durby/shared';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { MoneyFormat } from '../../lib/pos/format';
import { loadCategories, loadHours, loadItems, loadSummary } from '../../lib/reports/api';
import { useResource } from '../../lib/use-resource';
import { Card } from '../ui/card';
import { Loaded } from '../users/common';
import { HourBars, hourLabel } from './hour-bars';
import { Figure, type ReportContext, ReportFrame, ReportTable } from './report-frame';

/** How many products the top and least sold tables show; the export has all. */
const LISTED = 10;

/** Sales (docs/modules/reports.md): cards, the period's figures, busy hours, items and categories. */
export function SalesReport() {
  return <ReportFrame tab="report-sales">{(context) => <Sales context={context} />}</ReportFrame>;
}

function Sales({ context }: { context: ReportContext }) {
  const t = useT();
  const { store } = useAuth();
  const { filter, key } = context;
  const [summary, reloadSummary] = useResource(key, () => loadSummary(store, filter));
  const [hours, reloadHours] = useResource(key, () => loadHours(store, filter));
  const [items, reloadItems] = useResource(key, () => loadItems(store, filter));
  const [categories, reloadCategories] = useResource(key, () => loadCategories(store, filter));

  return (
    <>
      <p className="text-sm text-muted-foreground">{t('reports.page.salesNote')}</p>
      <Loaded resource={summary} reload={reloadSummary}>
        {(data) => {
          const money = context.money(data.currency);
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3" data-testid="sales-cards">
                {data.cards.map((card) => (
                  <SalesCardTile key={card.key} card={card} money={money} change={context.change} />
                ))}
              </div>
              <h2 className="text-lg font-medium">{t('reports.page.period')}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Figure metric="sales.gross" value={money(data.period.gross)} />
                <Figure metric="sales.orders" value={String(data.period.orders)} />
                <Figure metric="sales.items" value={String(data.period.items)} />
                <Figure
                  metric="sales.averageOrder"
                  value={data.period.averageOrder === null ? null : money(data.period.averageOrder)}
                />
                <Figure
                  metric="sales.secondRoundRate"
                  value={
                    data.period.secondRoundRate === null
                      ? null
                      : context.percent(data.period.secondRoundRate)
                  }
                  note={t('reports.page.secondRounds', {
                    count: String(data.period.secondRoundOrders),
                    orders: String(data.period.orders),
                  })}
                />
              </div>
            </>
          );
        }}
      </Loaded>
      <Loaded resource={hours} reload={reloadHours}>
        {(data) => {
          const money = context.money(data.currency);
          return (
            <>
              <section className="flex flex-col gap-3">
                <h2 className="text-lg font-medium">{t('reports.hours.title')}</h2>
                <HourBars hours={data.data} money={money} />
              </section>
              <ReportTable
                title="reports.hours.table"
                fileName="reports.files.hours"
                filter={filter}
                rows={data.data.filter((h) => h.items > 0)}
                rowKey={(h) => String(h.hour)}
                columns={[
                  { label: 'reports.columns.hour', cell: (h) => hourLabel(h.hour) },
                  {
                    label: 'reports.columns.sales',
                    cell: (h) => money(h.gross),
                    csv: (h) => h.gross,
                    number: true,
                  },
                  { label: 'reports.columns.orders', cell: (h) => String(h.orders), number: true },
                  { label: 'reports.columns.items', cell: (h) => String(h.items), number: true },
                ]}
              />
            </>
          );
        }}
      </Loaded>
      <Loaded resource={items} reload={reloadItems}>
        {(data) => {
          const money = context.money(data.currency);
          const columns = [
            { label: 'reports.columns.product', cell: (i: Item) => i.name },
            { label: 'reports.columns.category', cell: (i: Item) => i.categoryName },
            {
              label: 'reports.columns.quantity',
              cell: (i: Item) => String(i.quantity),
              number: true,
            },
            {
              label: 'reports.columns.sales',
              cell: (i: Item) => money(i.gross),
              csv: (i: Item) => i.gross,
              number: true,
            },
          ] as const;
          const least = [...data.data].reverse();
          return (
            <div className="grid gap-6 xl:grid-cols-2">
              <ReportTable
                title="reports.items.top"
                fileName="reports.files.items"
                filter={filter}
                rows={data.data}
                shown={LISTED}
                rowKey={(i) => i.productId}
                columns={columns}
              />
              <ReportTable
                title="reports.items.least"
                fileName="reports.files.leastItems"
                note="reports.items.leastNote"
                filter={filter}
                rows={least}
                shown={LISTED}
                rowKey={(i) => i.productId}
                columns={columns}
              />
            </div>
          );
        }}
      </Loaded>
      <Loaded resource={categories} reload={reloadCategories}>
        {(data) => {
          const money = context.money(data.currency);
          return (
            <ReportTable
              title="reports.categories.title"
              fileName="reports.files.categories"
              note="reports.categories.note"
              filter={filter}
              rows={data.data}
              rowKey={(c) => c.categoryId}
              columns={[
                { label: 'reports.columns.category', cell: (c) => c.name },
                {
                  label: 'reports.columns.quantity',
                  cell: (c) => String(c.quantity),
                  number: true,
                },
                {
                  label: 'reports.columns.sales',
                  cell: (c) => money(c.gross),
                  csv: (c) => c.gross,
                  number: true,
                },
                {
                  label: 'reports.columns.share',
                  cell: (c) =>
                    c.share === null ? t('reports.page.none') : context.percent(c.share),
                  csv: (c) => c.share ?? '',
                  number: true,
                },
              ]}
            />
          );
        }}
      </Loaded>
    </>
  );
}

interface Item {
  productId: string;
  name: string;
  categoryName: string;
  quantity: number;
  gross: string;
}

/** A card: the day's sales, and how they compare with the same weekday a week before. */
function SalesCardTile({
  card,
  money,
  change,
}: {
  card: SalesCard;
  money: MoneyFormat;
  change: (value: string) => string;
}) {
  const t = useT();
  const compared =
    card.changePercent === null
      ? t('reports.cards.noComparison')
      : t('reports.cards.change', {
          percent: change(card.changePercent),
          amount: money(card.compare.gross),
        });
  return (
    <Card className="flex flex-col gap-1 p-4" data-testid={`card-${card.key}`}>
      <p className="text-sm text-muted-foreground">{t(`reports.cards.${card.key}`)}</p>
      <p className="text-3xl font-semibold">{money(card.figures.gross)}</p>
      <p className="text-sm" data-testid={`card-${card.key}-change`}>
        {compared}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(`reports.cards.${card.key}Compare`)}
        {' · '}
        {t('reports.cards.orders', { count: String(card.figures.orders) })}
      </p>
    </Card>
  );
}
