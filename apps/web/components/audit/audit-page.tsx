'use client';

import { isLabelKey, type LabelKey } from '@durby/i18n';
import {
  AUDIT_ACTION_KEYS,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_MODULES,
  AUDIT_PAGE_MAX_LIMIT,
  AUDIT_SYSTEM_ACTORS,
  type AuditEntityType,
  type AuditLogEntry,
  auditEntityLabel,
  auditModuleOf,
  type AuditSystemActor,
  type LocationSummary,
  SETTINGS,
} from '@durby/shared';
import { ChevronDown, Download, Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { type ApiErrorCode, errorLabel } from '../../lib/auth/errors';
import type { Session } from '../../lib/auth/session';
import { loadAuditPage } from '../../lib/audit/api';
import {
  diffRows,
  fieldLabel,
  type FormatContext,
  formatValue,
  looksLikeId,
} from '../../lib/audit/diff';
import {
  type AuditFilters,
  apiQuery,
  filtersFromParams,
  paramsFromFilters,
} from '../../lib/audit/filters';
import {
  detailOf,
  matchesSearch,
  recordOf,
  toCsv,
  type Who,
  whereOf,
  whoOf,
} from '../../lib/audit/present';
import { loadSettings } from '../../lib/settings/api';
import { loadTeam } from '../../lib/team/api';
import { useResource } from '../../lib/use-resource';
import { loadLocations, loadRoles } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { NoAccess } from '../users/common';

const label = (key: string): LabelKey | null => (isLabelKey(key) ? key : null);

/** CSV export stops here (a few hundred KB); the notice says so. */
const EXPORT_MAX_ROWS = 5000;

/** /audit (docs/platform/web-shell.md → Audit log viewer). */
export function AuditPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('platform.audit.read')) {
    return <NoAccess title="platform.nav.audit" />;
  }
  return <AuditLog session={session} />;
}

type Page =
  | { status: 'error'; code: ApiErrorCode | 'unknown' }
  | { status: 'ready'; entries: AuditLogEntry[]; nextCursor: string | null; more: boolean };

/** What a row shows, also what search and the CSV export use. */
interface Row {
  entry: AuditLogEntry;
  when: string;
  what: string;
  module: string;
  detail: string | null;
  record: string | null;
  who: Who;
  where: string | null;
}

function AuditLog({ session }: { session: Session }) {
  const t = useT();
  const { store } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const filters = filtersFromParams(new URLSearchParams(search));
  const org = session.activeOrganizationId;
  const can = (key: string) => session.activePermissions.includes(key);

  // Display helpers; each falls back quietly when the role can't read it.
  const [settings] = useResource(can('platform.settings.read') ? org : null, () =>
    loadSettings(store),
  );
  const [roles] = useResource(can('platform.roles.read') ? org : null, () => loadRoles(store));
  const [locations] = useResource(can('platform.settings.read') ? org : null, () =>
    loadLocations(store),
  );
  const [team] = useResource(can('platform.users.read') ? org : null, () => loadTeam(store));
  // The organization's time zone; the registry default when settings can't be read.
  const configured =
    settings.status === 'ready'
      ? settings.data.find((s) => s.key === 'timezone')?.value
      : undefined;
  const timeZone = typeof configured === 'string' ? configured : SETTINGS.timezone.default;
  const zoneKnown = settings.status !== 'loading' || !can('platform.settings.read');
  const locationList = locations.status === 'ready' ? locations.data : null;
  const teamList = team.status === 'ready' ? team.data.members : null;

  const [version, setVersion] = useState(0);
  // The api query (search stays in the page); the first page belongs to it, the time zone, the organization and a
  // retry. Typing in search never reloads.
  const query = apiQuery(filters, timeZone).toString();
  const key = `${org}|${query}|${version}`;
  const [loaded, setLoaded] = useState<{ key: string; page: Page } | null>(null);
  const page: Page | { status: 'loading' } =
    loaded?.key === key ? loaded.page : { status: 'loading' };
  const setPage = (next: Page) => setLoaded({ key, page: next });

  useEffect(() => {
    if (!zoneKnown) return;
    let current = true;
    void loadAuditPage(store, new URLSearchParams(query), null).then((result) => {
      if (!current) return;
      setLoaded({
        key,
        page: result.ok
          ? {
              status: 'ready',
              entries: result.data.data,
              nextCursor: result.data.meta.nextCursor,
              more: false,
            }
          : { status: 'error', code: result.code },
      });
    });
    return () => {
      current = false;
    };
  }, [store, query, zoneKnown, key]);

  async function loadMore() {
    if (page.status !== 'ready' || !page.nextCursor) return;
    setPage({ ...page, more: true });
    const result = await loadAuditPage(store, new URLSearchParams(query), page.nextCursor);
    if (result.ok) {
      setPage({
        status: 'ready',
        entries: [...page.entries, ...result.data.data],
        nextCursor: result.data.meta.nextCursor,
        more: false,
      });
    } else if (result.code === 'audit.cursor_invalid') {
      setVersion((v) => v + 1); // a stale cursor: start over
    } else {
      setPage({ status: 'error', code: result.code });
    }
  }

  const apply = (next: AuditFilters) => {
    const params = paramsFromFilters(next).toString();
    router.replace(params ? `${pathname}?${params}` : pathname);
  };

  const ctx: FormatContext = {
    t,
    locale: session.user.locale,
    timeZone,
    roles: roles.status === 'ready' ? roles.data : null,
    locations: locationList,
  };
  const day = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  });
  const time = new Intl.DateTimeFormat(session.user.locale, { timeStyle: 'short', timeZone });
  const systemLabel = (actorKey: string) => {
    const name = label(AUDIT_SYSTEM_ACTORS[actorKey as AuditSystemActor]?.label ?? '');
    return name ? t(name) : actorKey;
  };
  const rowOf = (entry: AuditLogEntry): Row => {
    const date = new Date(entry.createdAt);
    const action = label(AUDIT_ACTIONS[entry.action].label);
    const moduleKey = label(`platform.auditPage.modules.${auditModuleOf(entry.action)}`);
    return {
      entry,
      when: `${day.format(date)} ${time.format(date)}`,
      what: action ? t(action) : entry.action,
      module: moduleKey ? t(moduleKey) : auditModuleOf(entry.action),
      detail: detailOf(entry, t),
      record: recordOf(entry),
      who: whoOf(entry, teamList, t, systemLabel),
      where: whereOf(entry, locationList),
    };
  };
  const searchable = (row: Row) => [
    row.record,
    row.who.name,
    row.who.email,
    row.who.role,
    row.detail,
    row.what,
    row.module,
    row.where,
  ];

  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ text: string; tone: 'info' | 'error' } | null>(
    null,
  );
  async function exportCsv() {
    setExporting(true);
    setExportNote(null);
    const entries: AuditLogEntry[] = [];
    let cursor: string | null = null;
    const params = new URLSearchParams(query);
    params.set('limit', String(AUDIT_PAGE_MAX_LIMIT));
    do {
      const result = await loadAuditPage(store, params, cursor);
      if (!result.ok) {
        setExporting(false);
        setExportNote({ text: t(errorLabel(result.code)), tone: 'error' });
        return;
      }
      entries.push(...result.data.data);
      cursor = result.data.meta.nextCursor;
    } while (cursor && entries.length < EXPORT_MAX_ROWS);
    const rows = entries
      .slice(0, EXPORT_MAX_ROWS)
      .map(rowOf)
      .filter((row) => matchesSearch(searchable(row), filters.q));
    const csv = toCsv([
      [
        t('platform.auditPage.col.when'),
        t('platform.auditPage.col.what'),
        t('platform.auditPage.module'),
        t('platform.auditPage.col.detail'),
        t('platform.auditPage.col.record'),
        t('platform.auditPage.col.by'),
        t('platform.auditPage.col.email'),
        t('platform.auditPage.col.role'),
        t('platform.auditPage.col.where'),
        t('platform.auditPage.ip'),
        t('platform.auditPage.requestId'),
      ],
      ...rows.map((row) => [
        row.when,
        row.what,
        row.module,
        row.detail,
        row.record,
        row.who.name,
        row.who.email,
        row.who.role,
        row.where ?? t('platform.auditPage.wholeOrganization'),
        row.entry.ip,
        row.entry.requestId,
      ]),
    ]);
    // A BOM so spreadsheet apps read UTF-8 (umlauts, ₹, €) correctly.
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-log-${day.format(new Date())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setExporting(false);
    if (cursor) {
      setExportNote({
        text: t('platform.auditPage.exportCapped', { count: String(EXPORT_MAX_ROWS) }),
        tone: 'info',
      });
    }
  }

  const rows =
    page.status === 'ready'
      ? page.entries.map(rowOf).filter((row) => matchesSearch(searchable(row), filters.q))
      : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.nav.audit')}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {t('platform.auditPage.description', { timeZone })}
          </p>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          disabled={exporting || page.status !== 'ready'}
          onClick={() => void exportCsv()}
          data-testid="audit-export"
        >
          <Download aria-hidden className="size-4" />
          {t(exporting ? 'platform.auditPage.exporting' : 'platform.auditPage.export')}
        </Button>
      </div>
      {exportNote && <Notice text={exportNote.text} tone={exportNote.tone} />}

      <Card className="flex flex-col p-0">
        <FilterBar
          filters={filters}
          locations={locationList}
          onApply={apply}
          searchNote={page.status === 'ready' && page.nextCursor !== null}
        />
        {page.status === 'loading' ? (
          <div className="flex flex-col gap-3 p-4" aria-busy="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : page.status === 'error' ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <Notice text={t(errorLabel(page.code))} tone="error" />
            <Button variant="outline" onClick={() => setVersion((v) => v + 1)}>
              {t('platform.common.retry')}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-muted-foreground" data-testid="audit-empty">
            {Object.keys(filters).length > 0
              ? t('platform.auditPage.emptyFiltered')
              : t('platform.auditPage.emptyAll')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="block w-full text-sm lg:table" aria-label={t('platform.nav.audit')}>
              <thead className="hidden border-b text-left text-xs tracking-wide text-muted-foreground uppercase lg:table-header-group">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('platform.auditPage.col.when')}</th>
                  <th className="px-4 py-3 font-medium">{t('platform.auditPage.col.what')}</th>
                  <th className="px-4 py-3 font-medium">{t('platform.auditPage.col.record')}</th>
                  <th className="px-4 py-3 font-medium">{t('platform.auditPage.col.by')}</th>
                  <th className="px-4 py-3 font-medium">{t('platform.auditPage.col.where')}</th>
                  <th className="px-4 py-3">
                    <span className="sr-only">{t('platform.auditPage.details')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="block lg:table-row-group">
                {rows.map((row) => (
                  <EntryRow
                    key={row.entry.id}
                    row={row}
                    ctx={ctx}
                    onActor={(actor) => apply({ ...filters, actor })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {page.status === 'ready' && page.nextCursor && (
        <div>
          <Button
            variant="outline"
            data-testid="audit-more"
            disabled={page.more}
            onClick={() => void loadMore()}
          >
            {t('platform.auditPage.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The filters in one row: they apply as soon as they change (search as you type, without reloading). */
function FilterBar({
  filters,
  locations,
  onApply,
  searchNote,
}: {
  filters: AuditFilters;
  locations: readonly LocationSummary[] | null;
  onApply: (filters: AuditFilters) => void;
  /** More entries exist than are loaded: search covers the loaded ones. */
  searchNote: boolean;
}) {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState(filters.q ?? '');
  const set = (patch: Partial<AuditFilters>) => {
    const next = { ...filters, ...patch };
    for (const k of Object.keys(next) as (keyof AuditFilters)[]) {
      if (next[k] === undefined || next[k] === '') delete next[k];
    }
    onApply(next);
  };
  // Search: applied a moment after typing stops, so the URL isn't rewritten on every key.
  useEffect(() => {
    if ((filters.q ?? '') === q.trim()) return;
    const timer = setTimeout(() => set({ q: q.trim() || undefined }), 250);
    return () => clearTimeout(timer);
  });
  const actions = AUDIT_ACTION_KEYS.filter(
    (a) =>
      (!filters.module || auditModuleOf(a) === filters.module) &&
      (!filters.entityType || AUDIT_ACTIONS[a].entityType === filters.entityType),
  );
  const any = Object.keys(filters).length > 0;

  return (
    <div className="flex flex-col gap-2 border-b p-4" role="search">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1.6fr)_repeat(4,minmax(0,1fr))_auto_auto]">
        <label className="relative flex items-center">
          <span className="sr-only">{t('platform.auditPage.search')}</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('platform.auditPage.searchPlaceholder')}
            className="pl-9"
            maxLength={100}
            data-testid="filter-search"
          />
        </label>
        <Select
          aria-label={t('platform.auditPage.module')}
          value={filters.module ?? ''}
          onChange={(e) => set({ module: e.target.value || undefined, action: undefined })}
          data-testid="filter-module"
        >
          <option value="">{t('platform.auditPage.allModules')}</option>
          {AUDIT_MODULES.map((m) => {
            const name = label(`platform.auditPage.modules.${m}`);
            return (
              <option key={m} value={m}>
                {name ? t(name) : m}
              </option>
            );
          })}
        </Select>
        <Select
          aria-label={t('platform.auditPage.entityType')}
          value={filters.entityType ?? ''}
          onChange={(e) =>
            set({
              entityType: (e.target.value || undefined) as AuditEntityType | undefined,
              action: undefined,
            })
          }
          data-testid="filter-entity"
        >
          <option value="">{t('platform.auditPage.allRecords')}</option>
          {AUDIT_ENTITY_TYPES.map((type) => {
            const name = label(auditEntityLabel(type));
            return (
              <option key={type} value={type}>
                {name ? t(name) : type}
              </option>
            );
          })}
        </Select>
        <Select
          aria-label={t('platform.auditPage.action')}
          value={filters.action ?? ''}
          onChange={(e) => set({ action: (e.target.value || undefined) as AuditFilters['action'] })}
          data-testid="filter-action"
        >
          <option value="">{t('platform.auditPage.allActions')}</option>
          {actions.map((action) => {
            const name = label(AUDIT_ACTIONS[action].label);
            return (
              <option key={action} value={action}>
                {name ? t(name) : action}
              </option>
            );
          })}
        </Select>
        <Select
          aria-label={t('platform.auditPage.branch')}
          value={filters.location ?? ''}
          disabled={!locations || locations.length === 0}
          onChange={(e) => set({ location: e.target.value || undefined })}
          data-testid="filter-location"
        >
          <option value="">{t('platform.auditPage.allBranches')}</option>
          {locations?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Input
          id={`${id}-from`}
          type="date"
          aria-label={t('platform.auditPage.from')}
          value={filters.from ?? ''}
          max={filters.to}
          onChange={(e) => set({ from: e.target.value || undefined })}
          data-testid="filter-from"
        />
        <Input
          id={`${id}-to`}
          type="date"
          aria-label={t('platform.auditPage.to')}
          value={filters.to ?? ''}
          min={filters.from}
          onChange={(e) => set({ to: e.target.value || undefined })}
          data-testid="filter-to"
        />
      </div>
      {(any || (searchNote && q)) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{searchNote && q ? t('platform.auditPage.searchLoaded') : ''}</span>
          {any && (
            <Button
              type="button"
              variant="ghost"
              className="gap-1"
              onClick={() => {
                setQ('');
                onApply({});
              }}
              data-testid="filter-clear"
            >
              <X aria-hidden className="size-4" />
              {t('platform.auditPage.clear')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** One entry: when, what (with its module and a detail line), record, who, where; details open below it. */
function EntryRow({
  row,
  ctx,
  onActor,
}: {
  row: Row;
  ctx: FormatContext;
  onActor: (userId: string) => void;
}) {
  const { t } = ctx;
  const [open, setOpen] = useState(false);
  const { entry } = row;
  const diff = diffRows(entry);
  const entryCtx = { ...ctx, entityType: entry.entityType };

  return (
    <Fragment>
      <tr
        className={cn(
          'grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-b p-4 align-top lg:table-row lg:p-0',
          open && 'bg-muted/40',
        )}
        data-testid="audit-entry"
        data-action={entry.action}
      >
        <td className="col-span-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:px-4 lg:py-3 lg:text-sm">
          <time dateTime={entry.createdAt}>{row.when}</time>
        </td>
        <td className="col-span-2 lg:px-4 lg:py-3">
          <span className="font-medium" data-testid="audit-what">
            {row.what}
          </span>
          <span className="text-xs text-muted-foreground"> · {row.module}</span>
          {row.detail && (
            <p className="text-xs text-muted-foreground" data-testid="audit-detail">
              {row.detail}
            </p>
          )}
        </td>
        <td className="lg:px-4 lg:py-3" data-testid="audit-record">
          {row.record ? (
            <span className="break-words text-primary-text">{row.record}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="lg:px-4 lg:py-3">
          <span className="block break-all" data-testid="audit-who">
            {row.who.name}
          </span>
          {(row.who.email || row.who.role) && (
            <span className="block text-xs break-all text-muted-foreground">
              {[row.who.email, row.who.role].filter(Boolean).join(' · ')}
            </span>
          )}
        </td>
        <td className="text-muted-foreground lg:px-4 lg:py-3" data-testid="audit-where">
          {row.where ?? t('platform.auditPage.wholeOrganization')}
        </td>
        <td className="col-span-2 lg:px-2 lg:py-2 lg:text-right">
          <Button
            variant="ghost"
            className="gap-1"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            data-testid="audit-toggle"
          >
            <span className="lg:sr-only">{t('platform.auditPage.details')}</span>
            <ChevronDown
              aria-hidden
              className={cn('size-4 transition-transform', open && 'rotate-180')}
            />
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="block border-b bg-muted/40 lg:table-row">
          <td colSpan={6} className="block px-4 pb-4 lg:table-cell">
            <div className="flex flex-col gap-3">
              {diff.length > 0 && (
                <table className="w-full text-left text-sm" data-testid="audit-diff">
                  <thead className="max-md:sr-only">
                    <tr className="border-b text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">{t('platform.auditPage.field')}</th>
                      <th className="py-2 pr-4 font-medium">{t('platform.auditPage.before')}</th>
                      <th className="py-2 pr-4 font-medium">{t('platform.auditPage.after')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.map((d) => {
                      const name = fieldLabel(d.field);
                      return (
                        <tr
                          key={d.field}
                          className="border-b align-top max-md:flex max-md:flex-col max-md:gap-1 max-md:py-2"
                          data-testid="audit-diff-row"
                          data-field={d.field}
                          data-changed={d.changed}
                        >
                          <th scope="row" className="py-2 pr-4 font-medium max-md:py-0">
                            {name ? t(name) : d.field}
                            {d.changed && d.hasBefore && d.hasAfter && (
                              <Badge className="ml-2">{t('platform.auditPage.changed')}</Badge>
                            )}
                          </th>
                          <Value
                            side="before"
                            present={d.hasBefore}
                            text={d.hasBefore ? formatValue(d.field, d.before, entryCtx) : null}
                            changed={d.changed}
                          />
                          <Value
                            side="after"
                            present={d.hasAfter}
                            text={d.hasAfter ? formatValue(d.field, d.after, entryCtx) : null}
                            changed={d.changed}
                          />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <dl
                  className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]"
                  data-testid="audit-details"
                >
                  <dt className="text-muted-foreground">{t('platform.auditPage.entityId')}</dt>
                  <dd className="font-mono break-all">{entry.entityId}</dd>
                  <dt className="text-muted-foreground">{t('platform.auditPage.requestId')}</dt>
                  <dd className="font-mono break-all">
                    {entry.requestId ?? t('platform.auditPage.empty')}
                  </dd>
                  <dt className="text-muted-foreground">{t('platform.auditPage.ip')}</dt>
                  <dd className="font-mono">{entry.ip ?? t('platform.auditPage.empty')}</dd>
                </dl>
                {row.who.userId && (
                  <Button
                    variant="outline"
                    data-testid="audit-only-actor"
                    onClick={() => row.who.userId && onActor(row.who.userId)}
                  >
                    {t('platform.auditPage.onlyThisActor')}
                  </Button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function Value({
  side,
  present,
  text,
  changed,
}: {
  side: 'before' | 'after';
  present: boolean;
  text: string | null;
  changed: boolean;
}) {
  const t = useT();
  return (
    // Stacked (below 768 px), a side that doesn't exist (create, delete) is left out.
    <td
      className={cn(
        'py-2 pr-4 max-md:py-0',
        !present && 'max-md:hidden',
        changed && present && side === 'after' && 'font-medium',
      )}
      data-testid={`audit-${side}`}
    >
      {/* Stacked below 768 px: the column header is gone, so each value says which side it is. */}
      <span className="text-muted-foreground md:sr-only">
        {t(side === 'before' ? 'platform.auditPage.before' : 'platform.auditPage.after')}:{' '}
      </span>
      {present && text !== null ? (
        <span className={looksLikeId(text) ? 'font-mono break-all' : 'break-words'}>{text}</span>
      ) : (
        <span className="text-muted-foreground">{t('platform.auditPage.notApplicable')}</span>
      )}
    </td>
  );
}
