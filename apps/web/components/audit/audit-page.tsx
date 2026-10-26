'use client';

import { isLabelKey, type LabelKey } from '@durby/i18n';
import {
  AUDIT_ACTION_KEYS,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_SYSTEM_ACTORS,
  type AuditEntityType,
  type AuditLogEntry,
  auditEntityLabel,
  type Member,
  SETTINGS,
} from '@durby/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useId, useState } from 'react';
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
import { loadSettings } from '../../lib/settings/api';
import { useResource } from '../../lib/use-resource';
import { loadLocations, loadMembers, loadRoles } from '../../lib/users/api';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { NoAccess } from '../users/common';

const label = (key: string): LabelKey | null => (isLabelKey(key) ? key : null);

/** /settings/audit (docs/platform/web-shell.md → Audit log viewer). */
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
  const [members] = useResource(can('platform.users.read') ? org : null, () => loadMembers(store));
  // The organization's time zone; the registry default when settings can't be read.
  const configured =
    settings.status === 'ready'
      ? settings.data.find((s) => s.key === 'timezone')?.value
      : undefined;
  const timeZone = typeof configured === 'string' ? configured : SETTINGS.timezone.default;
  const zoneKnown = settings.status !== 'loading' || !can('platform.settings.read');

  const [version, setVersion] = useState(0);
  // The first page belongs to these filters, time zone, organization and retry; until it arrives
  // for the current key, the list shows as loading.
  const key = `${org}|${search}|${timeZone}|${version}`;
  const [loaded, setLoaded] = useState<{ key: string; page: Page } | null>(null);
  const page: Page | { status: 'loading' } =
    loaded?.key === key ? loaded.page : { status: 'loading' };
  const setPage = (next: Page) => setLoaded({ key, page: next });

  useEffect(() => {
    if (!zoneKnown) return;
    let current = true;
    const query = apiQuery(filtersFromParams(new URLSearchParams(search)), timeZone);
    void loadAuditPage(store, query, null).then((result) => {
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
  }, [store, search, timeZone, zoneKnown, key]);

  async function loadMore() {
    if (page.status !== 'ready' || !page.nextCursor) return;
    setPage({ ...page, more: true });
    const result = await loadAuditPage(store, apiQuery(filters, timeZone), page.nextCursor);
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
    const query = paramsFromFilters(next).toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  const ctx: FormatContext = {
    t,
    locale: session.user.locale,
    timeZone,
    roles: roles.status === 'ready' ? roles.data : null,
    locations: locations.status === 'ready' ? locations.data : null,
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('platform.nav.audit')}</h1>
      <p className="text-muted-foreground">{t('platform.auditPage.description', { timeZone })}</p>
      <FilterForm
        key={search}
        filters={filters}
        members={members.status === 'ready' ? members.data : null}
        onApply={apply}
      />
      {page.status === 'loading' ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : page.status === 'error' ? (
        <div className="flex flex-col items-start gap-2">
          <Notice text={t(errorLabel(page.code))} tone="error" />
          <Button variant="outline" onClick={() => setVersion((v) => v + 1)}>
            {t('platform.common.retry')}
          </Button>
        </div>
      ) : page.entries.length === 0 ? (
        <Card className="p-6 text-center text-muted-foreground" data-testid="audit-empty">
          {Object.keys(filters).length > 0
            ? t('platform.auditPage.emptyFiltered')
            : t('platform.auditPage.emptyAll')}
        </Card>
      ) : (
        <>
          <ol className="flex flex-col gap-3" aria-label={t('platform.nav.audit')}>
            {page.entries.map((entry) => (
              <li key={entry.id}>
                <Entry entry={entry} ctx={ctx} onActor={(actor) => apply({ ...filters, actor })} />
              </li>
            ))}
          </ol>
          {page.nextCursor && (
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
        </>
      )}
    </div>
  );
}

function FilterForm({
  filters,
  members,
  onApply,
}: {
  filters: AuditFilters;
  members: readonly Member[] | null;
  onApply: (filters: AuditFilters) => void;
}) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState<AuditFilters>(filters);
  const set = (patch: Partial<AuditFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const actorKnown = !draft.actor || members?.some((m) => m.userId === draft.actor);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    onApply(draft);
  }

  return (
    <form
      className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={onSubmit}
      aria-label={t('platform.auditPage.filters')}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-action`}>{t('platform.auditPage.action')}</Label>
        <Select
          id={`${id}-action`}
          data-testid="filter-action"
          value={draft.action ?? ''}
          onChange={(e) => set({ action: (e.target.value || undefined) as AuditFilters['action'] })}
        >
          <option value="">{t('platform.auditPage.any')}</option>
          {AUDIT_ENTITY_TYPES.map((type) => {
            const actions = AUDIT_ACTION_KEYS.filter((a) => AUDIT_ACTIONS[a].entityType === type);
            if (actions.length === 0) return null;
            const group = label(auditEntityLabel(type));
            return (
              <optgroup key={type} label={group ? t(group) : type}>
                {actions.map((action) => {
                  const name = label(AUDIT_ACTIONS[action].label);
                  return (
                    <option key={action} value={action}>
                      {name ? t(name) : action}
                    </option>
                  );
                })}
              </optgroup>
            );
          })}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-entity`}>{t('platform.auditPage.entityType')}</Label>
        <Select
          id={`${id}-entity`}
          data-testid="filter-entity"
          value={draft.entityType ?? ''}
          onChange={(e) =>
            set({ entityType: (e.target.value || undefined) as AuditEntityType | undefined })
          }
        >
          <option value="">{t('platform.auditPage.any')}</option>
          {AUDIT_ENTITY_TYPES.map((type) => {
            const name = label(auditEntityLabel(type));
            return (
              <option key={type} value={type}>
                {name ? t(name) : type}
              </option>
            );
          })}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-actor`}>{t('platform.auditPage.actor')}</Label>
        <Select
          id={`${id}-actor`}
          data-testid="filter-actor"
          value={draft.actor ?? ''}
          onChange={(e) => set({ actor: e.target.value || undefined })}
        >
          <option value="">{t('platform.auditPage.anyone')}</option>
          {!actorKnown && draft.actor && (
            <option value={draft.actor}>{t('platform.auditPage.selectedActor')}</option>
          )}
          {members?.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.email}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-from`}>{t('platform.auditPage.from')}</Label>
        <Input
          id={`${id}-from`}
          type="date"
          data-testid="filter-from"
          value={draft.from ?? ''}
          max={draft.to}
          onChange={(e) => set({ from: e.target.value || undefined })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-to`}>{t('platform.auditPage.to')}</Label>
        <Input
          id={`${id}-to`}
          type="date"
          data-testid="filter-to"
          value={draft.to ?? ''}
          min={draft.from}
          onChange={(e) => set({ to: e.target.value || undefined })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Button type="submit" data-testid="filter-apply">
          {t('platform.auditPage.apply')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDraft({});
            onApply({});
          }}
        >
          {t('platform.auditPage.clear')}
        </Button>
      </div>
    </form>
  );
}

function Entry({
  entry,
  ctx,
  onActor,
}: {
  entry: AuditLogEntry;
  ctx: FormatContext;
  onActor: (userId: string) => void;
}) {
  const { t } = ctx;
  const action = label(AUDIT_ACTIONS[entry.action].label);
  const entity = label(auditEntityLabel(entry.entityType));
  const who =
    entry.actor.type === 'user'
      ? (entry.actor.email ?? t('platform.auditPage.unknownUser'))
      : (() => {
          const name = label(AUDIT_SYSTEM_ACTORS[entry.actor.key].label);
          return name ? t(name) : entry.actor.key;
        })();
  const when = new Intl.DateTimeFormat(ctx.locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: ctx.timeZone,
  }).format(new Date(entry.createdAt));
  const rows = diffRows(entry);
  const entryCtx = { ...ctx, entityType: entry.entityType };

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="audit-entry" data-action={entry.action}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="font-medium" data-testid="audit-what">
            {action ? t(action) : entry.action}
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">{t('platform.auditPage.by')} </span>
            <span className="break-all" data-testid="audit-who">
              {who}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            <time dateTime={entry.createdAt}>{when}</time>
          </p>
        </div>
        <Badge>{entity ? t(entity) : entry.entityType}</Badge>
      </div>

      {rows.length > 0 && (
        <table className="w-full text-left text-sm" data-testid="audit-diff">
          <thead className="max-md:sr-only">
            <tr className="border-b text-muted-foreground">
              <th className="py-2 pr-4 font-medium">{t('platform.auditPage.field')}</th>
              <th className="py-2 pr-4 font-medium">{t('platform.auditPage.before')}</th>
              <th className="py-2 pr-4 font-medium">{t('platform.auditPage.after')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const name = fieldLabel(row.field);
              return (
                <tr
                  key={row.field}
                  className="border-b align-top max-md:flex max-md:flex-col max-md:gap-1 max-md:py-2"
                  data-testid="audit-diff-row"
                  data-field={row.field}
                  data-changed={row.changed}
                >
                  <th scope="row" className="py-2 pr-4 font-medium max-md:py-0">
                    {name ? t(name) : row.field}
                    {row.changed && row.hasBefore && row.hasAfter && (
                      <Badge className="ml-2">{t('platform.auditPage.changed')}</Badge>
                    )}
                  </th>
                  <Value
                    side="before"
                    present={row.hasBefore}
                    text={row.hasBefore ? formatValue(row.field, row.before, entryCtx) : null}
                  />
                  <Value
                    side="after"
                    present={row.hasAfter}
                    text={row.hasAfter ? formatValue(row.field, row.after, entryCtx) : null}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {entry.actor.type === 'user' && (
          <Button
            variant="outline"
            data-testid="audit-only-actor"
            onClick={() => entry.actor.type === 'user' && onActor(entry.actor.userId)}
          >
            {t('platform.auditPage.onlyThisActor')}
          </Button>
        )}
      </div>

      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer py-2 text-primary-text">
          {t('platform.auditPage.details')}
        </summary>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]" data-testid="audit-details">
          <dt className="text-muted-foreground">{t('platform.auditPage.entityId')}</dt>
          <dd className="font-mono break-all">{entry.entityId}</dd>
          <dt className="text-muted-foreground">{t('platform.auditPage.requestId')}</dt>
          <dd className="font-mono break-all">
            {entry.requestId ?? t('platform.auditPage.empty')}
          </dd>
          <dt className="text-muted-foreground">{t('platform.auditPage.ip')}</dt>
          <dd className="font-mono">{entry.ip ?? t('platform.auditPage.empty')}</dd>
        </dl>
      </details>
    </Card>
  );
}

function Value({
  side,
  present,
  text,
}: {
  side: 'before' | 'after';
  present: boolean;
  text: string | null;
}) {
  const t = useT();
  return (
    // Stacked (below 768 px), a side that doesn't exist (create, delete) is left out.
    <td
      className={`py-2 pr-4 max-md:py-0 ${present ? '' : 'max-md:hidden'}`}
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
