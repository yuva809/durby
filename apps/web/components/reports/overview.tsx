'use client';

import Link from 'next/link';
import { useRef } from 'react';
import type { LabelKey } from '@durby/i18n';
import {
  dayText,
  METRICS,
  NORMAL_DAY_WEEKS,
  type OverviewResponse,
  percentText,
} from '@durby/shared';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { Session } from '../../lib/auth/session';
import { type MoneyFormat, moneyFormat, toCents } from '../../lib/pos/format';
import { useLiveRefresh } from '../../lib/realtime/use-live-refresh';
import { loadOverview } from '../../lib/reports/api';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Card } from '../ui/card';
import { Loaded } from '../users/common';
import { DailyReportOffer } from './daily-report-offer';

const REFRESH_MS = 60_000;

/** Failures a later refresh may get past: the last figures stay meanwhile. Anything else is shown. */
const TEMPORARY: readonly string[] = ['unknown', 'platform.busy'];

type Today = OverviewResponse['total']['today'];
type Location = OverviewResponse['locations'][number];

interface Format {
  money: MoneyFormat;
  /** Money with its sign. */
  difference: MoneyFormat;
  change: (percent: string) => string;
  day: (day: string) => string;
}

/** Who sees the overview on the home page (ADR 0082); the api enforces the same. */
export function overviewVisible(session: Session): boolean {
  return (
    session.activeFeatures.includes('reports') &&
    session.activeFeatures.includes('pos') &&
    session.activePermissions.includes('reports.sales.read')
  );
}

/** The owner overview (docs/modules/reports.md → Overview): the group today, and yesterday against a normal day. */
export function Overview({
  session,
  locale,
  timeZone,
}: {
  session: Session;
  locale: string;
  timeZone: string;
}) {
  const t = useT();
  const { store } = useAuth();
  const key = `${session.user.id}|${session.activeOrganizationId}`;
  const last = useRef<{ key: string; data: OverviewResponse } | null>(null);
  const [overview, reload] = useResource(key, async () => {
    const result = await loadOverview(store);
    if (result.ok) {
      last.current = { key, data: result.data };
      return { ok: true as const, data: { figures: result.data, stale: false } };
    }
    if (last.current?.key === key && TEMPORARY.includes(result.code)) {
      return { ok: true as const, data: { figures: last.current.data, stale: true } };
    }
    return result;
  });
  // Polling only: the figures follow the till through the outbox, not a stream.
  useLiveRefresh({
    store,
    stream: 'pos',
    locationId: null,
    enabled: false,
    reload,
    pollMs: REFRESH_MS,
  });

  return (
    <div className="flex flex-col gap-6" data-testid="overview">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('reports.overview.title')}</h1>
        <Link href="/reports" className="text-sm">
          {t('reports.overview.reports')}
        </Link>
      </div>
      <DailyReportOffer session={session} />
      <Loaded resource={overview} reload={reload}>
        {({ figures, stale }) => {
          const time = new Intl.DateTimeFormat(locale, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone,
          }).format(new Date(figures.asOf));
          return (
            <>
              {stale ? (
                <Notice text={t('reports.overview.stale', { time })} tone="error" />
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="overview-as-of">
                  {t('reports.overview.asOf', { time })}
                </p>
              )}
              <Figures figures={figures} locale={locale} />
            </>
          );
        }}
      </Loaded>
    </div>
  );
}

function Figures({ figures, locale }: { figures: OverviewResponse; locale: string }) {
  const t = useT();
  const { total, locations } = figures;
  const money = moneyFormat(locale, figures.currency);
  const format: Format = {
    money,
    difference: (amount) => (toCents(amount) > 0n ? `+${money(amount)}` : money(amount)),
    change: (percent) => percentText(locale, percent, true),
    day: (day) => dayText(locale, day),
  };
  if (locations.length === 0) {
    return <p className="text-muted-foreground">{t('reports.overview.noLocations')}</p>;
  }
  if (!figures.hasData && total.today.openTables === 0) {
    return (
      <p className="text-muted-foreground" data-testid="overview-no-data">
        {t('reports.overview.noData')}
      </p>
    );
  }
  const [only, ...others] = locations;
  const single = others.length === 0 ? only : undefined;
  const { normal } = total.yesterday;
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('reports.page.salesNote')}</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="flex flex-col gap-2 p-4" data-testid="overview-today">
          <h2 className="text-sm text-muted-foreground">{t('reports.overview.today')}</h2>
          <p className="text-3xl font-semibold">{money(total.today.gross)}</p>
          <p className="text-sm" data-testid="overview-today-change">
            {lastWeekText(t, total.today, format)}
          </p>
          <TodayFacts today={total.today} format={format} />
        </Card>
        <Card className="flex flex-col gap-2 p-4" data-testid="overview-yesterday">
          <h2 className="text-sm text-muted-foreground">
            {t('reports.overview.yesterday')}
            {single ? ` · ${format.day(single.yesterday.day)}` : null}
          </h2>
          <p className="text-3xl font-semibold">{money(total.yesterday.gross)}</p>
          <p className="text-sm" data-testid="overview-yesterday-change">
            {normalText(t, normal, format)}
          </p>
          {single?.yesterday.normal ? (
            <p className="text-sm">{daysText(t, single.yesterday.normal.days)}</p>
          ) : null}
          {normal && total.yesterday.leftOut > 0 ? (
            <p className="text-sm" data-testid="overview-left-out">
              {t('reports.overview.leftOut', {
                count: String(total.yesterday.leftOut),
                compared: money(normal.compared),
              })}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t(METRICS['sales.normalDay'].description as LabelKey)}
          </p>
        </Card>
      </div>
      {single ? null : <Locations locations={locations} format={format} />}
    </>
  );
}

function TodayFacts({ today, format }: { today: Today; format: Format }) {
  const t = useT();
  const facts = [
    ['sales.orders', String(today.orders)],
    [
      'sales.averageOrder',
      today.averageOrder === null ? t('reports.page.none') : format.money(today.averageOrder),
    ],
    ['tables.open', String(today.openTables)],
  ] as const;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      {facts.map(([metric, value]) => (
        <div key={metric} className="flex gap-2">
          <dt className="text-muted-foreground">{t(METRICS[metric].label as LabelKey)}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One row per location; on a phone one card per location. */
function Locations({ locations, format }: { locations: Location[]; format: Format }) {
  const t = useT();
  const label = (metric: keyof typeof METRICS) => t(METRICS[metric].label as LabelKey);
  const columns = [
    [t('reports.columns.location'), false],
    [t('reports.overview.today'), true],
    [t('reports.overview.columnLastWeek'), true],
    [label('sales.orders'), true],
    [label('sales.averageOrder'), true],
    [label('tables.open'), true],
    [t('reports.overview.yesterday'), true],
    [label('sales.normalDay'), true],
    [label('sales.vsNormalDay'), true],
  ] as const;
  const none = t('reports.page.none');
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">{t('reports.overview.locations')}</h2>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full text-sm" data-testid="overview-locations">
          <thead className="bg-muted text-left">
            <tr>
              {columns.map(([text, number]) => (
                <th
                  key={text}
                  scope="col"
                  className={cn('px-3 py-2 font-medium', number && 'text-right')}
                >
                  {text}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {locations.map(({ locationId, name, today, yesterday }) => (
              <tr key={locationId} className="border-t align-top">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {name}
                </th>
                {[
                  [format.money(today.gross)],
                  [
                    today.changePercent === null
                      ? t('reports.overview.noComparison')
                      : format.change(today.changePercent),
                  ],
                  [String(today.orders)],
                  [today.averageOrder === null ? none : format.money(today.averageOrder)],
                  [String(today.openTables)],
                  [format.money(yesterday.gross), format.day(yesterday.day)],
                  yesterday.normal
                    ? [format.money(yesterday.normal.gross), daysText(t, yesterday.normal.days)]
                    : [t('reports.overview.noComparison')],
                  yesterday.normal
                    ? [
                        format.difference(yesterday.normal.difference),
                        yesterday.normal.changePercent === null
                          ? undefined
                          : format.change(yesterday.normal.changePercent),
                      ]
                    : [t('reports.overview.noComparison')],
                ].map(([value, note], i) => (
                  <td key={columns[i + 1]?.[0]} className="px-3 py-2 text-right tabular-nums">
                    {value}
                    {note ? (
                      <span className="block text-xs whitespace-nowrap text-muted-foreground">
                        {note}
                      </span>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-3 md:hidden" data-testid="overview-cards">
        {locations.map(({ locationId, name, today, yesterday }) => (
          <li key={locationId}>
            <Card className="flex flex-col gap-2 p-4">
              <h3 className="font-medium">{name}</h3>
              <p className="text-2xl font-semibold">{format.money(today.gross)}</p>
              <p className="text-sm">{lastWeekText(t, today, format)}</p>
              <TodayFacts today={today} format={format} />
              <p className="border-t pt-2 text-sm">
                {`${t('reports.overview.yesterday')} · ${format.day(yesterday.day)}: `}
                <span className="font-medium">{format.money(yesterday.gross)}</span>
              </p>
              <p className="text-sm">{normalText(t, yesterday.normal, format)}</p>
              {yesterday.normal ? (
                <p className="text-xs text-muted-foreground">
                  {daysText(t, yesterday.normal.days)}
                </p>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

type T = ReturnType<typeof useT>;

function lastWeekText(t: T, today: Today, format: Format): string {
  return today.changePercent === null
    ? t('reports.overview.noComparison')
    : t('reports.overview.lastWeek', { percent: format.change(today.changePercent) });
}

function normalText(
  t: T,
  normal: { gross: string; difference: string; changePercent: string | null } | null,
  format: Format,
): string {
  if (!normal) return t('reports.overview.noComparison');
  const values = {
    difference: format.difference(normal.difference),
    normal: format.money(normal.gross),
  };
  return normal.changePercent === null
    ? t('reports.overview.vsNormalNoPercent', values)
    : t('reports.overview.vsNormal', { ...values, percent: format.change(normal.changePercent) });
}

const daysText = (t: T, days: number): string =>
  t('reports.overview.days', { days: String(days), of: String(NORMAL_DAY_WEEKS) });
