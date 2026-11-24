'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { businessDay, METRICS, type MetricKey, percentText, SETTINGS } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { Download } from 'lucide-react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { Session } from '../../lib/auth/session';
import { downloadCsv } from '../../lib/csv';
import { activeNavItem, visibleNav } from '../../lib/nav/registry';
import { REPORT_TABS } from '../../lib/nav/report-tabs';
import { type MoneyFormat, moneyFormat } from '../../lib/pos/format';
import type { ReportFilter } from '../../lib/reports/api';
import { filterFromParams, PERIODS, periodOf } from '../../lib/reports/filters';
import { loadSettings } from '../../lib/settings/api';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { NoAccess } from '../users/common';

export interface ReportContext {
  filter: ReportFilter;
  /** Changes with the organization and the filter: the key of everything the page loads. */
  key: string;
  locale: string;
  money: (currency: string) => MoneyFormat;
  /** With its sign; `percent` in tables and figures without. */
  change: (value: string) => string;
  percent: (value: string) => string;
  /** A location's name, for tables listing several. */
  locationName: (id: string) => string | null;
  manyLocations: boolean;
}

/** A report page: access, title, tabs, and the one row of filters its content follows. */
export function ReportFrame({
  tab,
  children,
}: {
  tab: string;
  children: (context: ReportContext) => ReactNode;
}) {
  const { session } = useAuth();
  const router = useRouter();
  const tabs =
    session && session.activeFeatures.includes('reports') ? visibleNav(REPORT_TABS, session) : [];
  // The menu opens the sales tab; someone with only another one goes there.
  const other = tabs.some((item) => item.id === tab) ? undefined : tabs[0]?.href;
  useEffect(() => {
    if (other) router.replace(other);
  }, [other, router]);
  if (!session || other) return null;
  if (tabs.length === 0) return <NoAccess title="reports.nav.title" />;
  return (
    <Frame session={session} tabs={tabs}>
      {children}
    </Frame>
  );
}

function Frame({
  session,
  tabs,
  children,
}: {
  session: Session;
  tabs: ReturnType<typeof visibleNav>;
  children: (context: ReportContext) => ReactNode;
}) {
  const t = useT();
  const { store } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const params = new URLSearchParams(search);
  const org = session.activeOrganizationId;
  const can = (key: string) => session.activePermissions.includes(key);
  const [settings] = useResource(can('platform.settings.read') ? org : null, () =>
    loadSettings(store),
  );
  const [locations] = useResource(can('platform.settings.read') ? org : null, () =>
    loadLocations(store),
  );
  // When the page opened: a period doesn't move while it is read.
  const [now] = useState(() => new Date());
  const ready = settings.status !== 'loading' || !can('platform.settings.read');
  const setting = (key: 'timezone' | 'reports.dayStartsAt' | 'locale'): string => {
    const value =
      settings.status === 'ready' ? settings.data.find((s) => s.key === key)?.value : undefined;
    return typeof value === 'string' ? value : SETTINGS[key].default;
  };
  const today = businessDay(now, {
    timeZone: setting('timezone'),
    dayStartsAt: setting('reports.dayStartsAt'),
  });
  const period = periodOf(params);
  const filter = filterFromParams(params, today);
  const places =
    locations.status === 'ready' ? locations.data.filter((l) => !l.isWarehouseSite) : [];
  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.replace(`${pathname}?${next.toString()}`);
  };
  const current = activeNavItem(tabs, pathname);
  const locale = setting('locale');

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('reports.nav.title')}</h1>
      <nav aria-label={t('reports.tabs.label')} className="border-b">
        <ul className="flex gap-1 overflow-x-auto">
          {tabs.map((item) => {
            const active = item.id === current?.id;
            return (
              <li key={item.id} className="shrink-0">
                <Link
                  href={search ? `${item.href}?${search}` : item.href}
                  aria-current={active ? 'page' : undefined}
                  data-testid={item.id}
                  className={cn(
                    '-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap no-underline hover:no-underline',
                    active
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(item.label)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex flex-wrap items-end gap-3" data-testid="report-filters">
        <div className="flex w-full flex-col gap-1 sm:w-48">
          <Label htmlFor="report-period">{t('reports.filters.period')}</Label>
          <Select
            id="report-period"
            value={period}
            onChange={(e) => set({ period: e.target.value })}
            data-testid="report-period"
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {t(`reports.periods.${p}`)}
              </option>
            ))}
          </Select>
        </div>
        {period === 'custom' ? (
          <>
            {(['from', 'to'] as const).map((side) => (
              <div key={side} className="flex flex-col gap-1">
                <Label htmlFor={`report-${side}`}>{t(`reports.filters.${side}`)}</Label>
                <Input
                  id={`report-${side}`}
                  type="date"
                  value={params.get(side) ?? ''}
                  onChange={(e) => set({ [side]: e.target.value })}
                  data-testid={`report-${side}`}
                />
              </div>
            ))}
          </>
        ) : null}
        {places.length > 1 ? (
          <div className="flex w-full flex-col gap-1 sm:w-56">
            <Label htmlFor="report-location">{t('reports.filters.location')}</Label>
            <Select
              id="report-location"
              value={params.get('location') ?? ''}
              onChange={(e) => set({ location: e.target.value })}
              data-testid="report-location"
            >
              <option value="">{t('reports.filters.allLocations')}</option>
              {places.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
      {!ready ? null : filter ? (
        children({
          filter,
          key: `${org}|${filter.from}|${filter.to}|${filter.locationId ?? ''}`,
          locale,
          money: (currency) => moneyFormat(locale, currency),
          change: (value) => percentText(locale, value, true),
          percent: (value) => percentText(locale, value),
          locationName: (id) => places.find((l) => l.id === id)?.name ?? null,
          manyLocations: places.length > 1,
        })
      ) : (
        <p className="text-muted-foreground" data-testid="report-period-invalid">
          {t('reports.filters.invalid')}
        </p>
      )}
    </div>
  );
}

/** A figure: its name and value, and what it counts. The registry gives both texts (ADR 0081). */
export function Figure({
  metric,
  value,
  note,
}: {
  metric: MetricKey;
  value: string | null;
  note?: string | undefined;
}) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-1 p-4" data-testid={`figure-${metric}`}>
      <p className="text-sm text-muted-foreground">{t(METRICS[metric].label as LabelKey)}</p>
      <p className="text-2xl font-semibold">{value ?? t('reports.page.none')}</p>
      {note ? <p className="text-sm">{note}</p> : null}
      <p className="text-xs text-muted-foreground">{t(METRICS[metric].description as LabelKey)}</p>
    </Card>
  );
}

export interface Column<T> {
  label: LabelKey;
  /** What the table shows. */
  cell: (row: T) => string;
  /** What the file holds; default the cell. Numbers stay plain decimals there. */
  csv?: (row: T) => string;
  number?: true;
}

/** A report table with its CSV export (translated headers). */
export function ReportTable<T>({
  title,
  fileName,
  columns,
  rows,
  rowKey,
  filter,
  note,
  shown,
}: {
  title: LabelKey;
  fileName: LabelKey;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  filter: ReportFilter;
  note?: LabelKey;
  /** Rows on the page; the export has all. */
  shown?: number;
}) {
  const t = useT();
  return (
    <section className="flex flex-col gap-3" data-testid={`table-${title}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">{t(title)}</h2>
        <Button
          variant="outline"
          disabled={rows.length === 0}
          onClick={() =>
            downloadCsv(
              `${t(fileName)}-${filter.from}-${filter.to}`,
              columns.map((c) => t(c.label)),
              rows.map((row) => columns.map((c) => (c.csv ?? c.cell)(row))),
            )
          }
        >
          <Download aria-hidden />
          {t('reports.page.export')}
        </Button>
      </div>
      {note ? <p className="text-sm text-muted-foreground">{t(note)}</p> : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{t('reports.page.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.label}
                    scope="col"
                    className={cn('px-3 py-2 font-medium', c.number && 'text-right')}
                  >
                    {t(c.label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((row) => (
                <tr key={rowKey(row)} className="border-t">
                  {columns.map((c) => (
                    <td
                      key={c.label}
                      className={cn('px-3 py-2', c.number && 'text-right tabular-nums')}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
