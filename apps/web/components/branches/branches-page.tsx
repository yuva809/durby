'use client';

import {
  LOCATION_ADDRESS_MAX_LENGTH,
  LOCATION_NAME_MAX_LENGTH,
  type LocationSummary,
  type TeamMember,
  type Warehouse,
} from '@durby/shared';
import { Archive, ArchiveRestore, Building2, Pencil, Search } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadWarehouses } from '../../lib/inventory/api';
import { roleName } from '../../lib/rbac/roles';
import { createLocation, loadSettings, putSetting, updateLocation } from '../../lib/settings/api';
import { loadTeam } from '../../lib/team/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';

const APPROVAL = 'orders.requestsNeedApproval';

/**
 * /branches (operations menu, ADR 0056): the organization's branches as cards (address, the staff limited to the
 * branch with their roles), searchable, archived ones on request; whether branch stock requests wait
 * for approval. Everyone with platform.settings.read sees it; owners (platform.org.manage) add, edit and archive;
 * platform.settings.manage changes the approval setting.
 */
export function BranchesPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('platform.settings.read')) return <NoAccess title="platform.nav.branches" />;
  const features = new Set(session.activeFeatures);
  return (
    <Branches
      organizationId={session.activeOrganizationId}
      canManage={permissions.has('platform.org.manage')}
      canSetApproval={permissions.has('platform.settings.manage')}
      withRequests={features.has('orders')}
      readsStaff={permissions.has('platform.users.read')}
      readsWarehouses={permissions.has('inventory.stock.read')}
    />
  );
}

function Branches({
  organizationId,
  canManage,
  canSetApproval,
  withRequests,
  readsStaff,
  readsWarehouses,
}: {
  organizationId: string | null;
  canManage: boolean;
  canSetApproval: boolean;
  withRequests: boolean;
  readsStaff: boolean;
  readsWarehouses: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [locations, reload] = useResource(organizationId, () => loadLocations(store, true));
  const [team] = useResource(readsStaff ? organizationId : null, () => loadTeam(store));
  const [warehouses] = useResource(readsWarehouses ? organizationId : null, () =>
    loadWarehouses(store),
  );
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const members = team.status === 'ready' ? team.data.members : null;
  const warehouseList = warehouses.status === 'ready' ? warehouses.data : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.nav.branches')}</h1>
          <p className="text-muted-foreground">{t('platform.branchesPage.intro')}</p>
        </div>
        {canManage && <BranchDialog onDone={reload} />}
      </div>

      {withRequests && <ApprovalCard organizationId={organizationId} canSet={canSetApproval} />}

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-60 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('platform.branchesPage.search')}
            aria-label={t('platform.branchesPage.search')}
            className="h-11 pl-9"
            data-testid="branches-search"
          />
        </div>
        <Button
          variant="outline"
          className="h-11 rounded-full"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((v) => !v)}
          data-testid="branches-show-archived"
        >
          <Archive aria-hidden />
          {t(
            showArchived
              ? 'platform.branchesPage.hideArchived'
              : 'platform.branchesPage.showArchived',
          )}
        </Button>
      </div>

      <Loaded resource={locations} reload={reload}>
        {(list) => {
          const needle = search.trim().toLowerCase();
          const shown = list
            .filter((l) => !l.isWarehouseSite)
            .filter((l) => showArchived || l.archivedAt === null)
            .filter(
              (l) =>
                needle === '' ||
                l.name.toLowerCase().includes(needle) ||
                (l.address ?? '').toLowerCase().includes(needle),
            );
          if (list.length === 0) {
            return (
              <Card
                className="flex flex-col items-center gap-2 px-6 py-12 text-center"
                data-testid="branches-empty"
              >
                <Building2 aria-hidden className="size-8 text-muted-foreground" />
                <p className="max-w-sm text-muted-foreground">{t('platform.branchesPage.empty')}</p>
              </Card>
            );
          }
          if (shown.length === 0) {
            return (
              <p className="py-8 text-center text-muted-foreground">
                {t('platform.branchesPage.noMatch')}
              </p>
            );
          }
          // The checklist: branches that still need a supplying warehouse (ADR 0067).
          const missing = warehouseList
            ? list.filter(
                (l) =>
                  l.archivedAt === null &&
                  !l.isWarehouseSite &&
                  supplierOf(warehouseList, l.id) === null,
              ).length
            : 0;
          return (
            <>
              {missing > 0 && (
                <p
                  className="text-sm font-medium text-destructive"
                  data-testid="branches-suppliers-missing"
                >
                  {t('platform.branchesPage.suppliersMissing', { count: String(missing) })}
                </p>
              )}
              <ul className="grid gap-4 md:grid-cols-2" data-testid="branch-list">
                {shown.map((location) => (
                  <li key={location.id}>
                    <BranchCard
                      location={location}
                      supplier={warehouseList ? supplierOf(warehouseList, location.id) : undefined}
                      staff={members && staffOf(members, location.id)}
                      canManage={canManage}
                      onChanged={reload}
                    />
                  </li>
                ))}
              </ul>
            </>
          );
        }}
      </Loaded>
    </div>
  );
}

/** The active members limited to this branch (members of every location are not listed on each card). */
export const staffOf = (members: readonly TeamMember[], locationId: string) =>
  members.filter(
    (m) => m.status === 'active' && !m.allLocations && m.locationIds.includes(locationId),
  );

/**
 * The warehouse that supplies a branch (ADR 0067): one that has the branch ticked, else the main warehouse, else
 * none. Archived and transit warehouses supply nobody. Mirrors the rule the request flow uses on the API.
 */
export function supplierOf(
  warehouses: readonly Warehouse[],
  locationId: string,
): { name: string; main: boolean } | null {
  const live = warehouses.filter((w) => w.archivedAt === null && !w.isTransit);
  const ticked = live.find((w) => !w.isMain && w.suppliesLocationIds.includes(locationId));
  if (ticked) return { name: ticked.name, main: false };
  const main = live.find((w) => w.isMain);
  return main ? { name: main.name, main: true } : null;
}

function BranchCard({
  location,
  supplier,
  staff,
  canManage,
  onChanged,
}: {
  location: LocationSummary;
  /** Undefined while the warehouses are not loaded (or not readable): the line is not shown. */
  supplier: { name: string; main: boolean } | null | undefined;
  staff: TeamMember[] | null;
  canManage: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const archived = location.archivedAt !== null;
  return (
    <Card
      className={cn('flex h-full flex-col gap-4 p-5', archived && 'opacity-75')}
      data-testid="branch-card"
      data-name={location.name}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Building2 aria-hidden className="size-5" />
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{location.name}</h2>
            {archived && (
              <Badge data-testid="branch-archived">{t('platform.branchesPage.archived')}</Badge>
            )}
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-2">
            {!archived && <BranchDialog location={location} onDone={onChanged} />}
            <ArchiveBranch location={location} onDone={onChanged} />
          </div>
        )}
      </div>
      <p
        className={cn('text-sm', location.address ? 'text-foreground/80' : 'text-muted-foreground')}
        data-testid="branch-address"
      >
        {location.address ?? t('platform.branchesPage.noAddress')}
      </p>
      {supplier !== undefined && !archived && (
        <p className="text-sm" data-testid="branch-supplier">
          {supplier === null
            ? t('platform.branchesPage.noSupplier')
            : t(
                supplier.main
                  ? 'platform.branchesPage.supplierMain'
                  : 'platform.branchesPage.supplier',
                { name: supplier.name },
              )}
        </p>
      )}
      {supplier === null && !archived && canManage && (
        <Link
          href="/inventory/warehouses"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          data-testid="branch-choose-supplier"
        >
          {t('platform.branchesPage.chooseSupplier')}
        </Link>
      )}
      {staff && <hr className="border-border" />}
      {staff && (
        <div className="flex flex-col gap-2" data-testid="branch-staff">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t('platform.branchesPage.staff', { count: String(staff.length) })}
          </p>
          {staff.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('platform.branchesPage.noStaff')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {staff.map((m) => (
                <li
                  key={m.membershipId}
                  className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-sm"
                  data-testid="branch-staff-member"
                >
                  <span className="font-medium">{m.name ?? m.email}</span>
                  {m.role && <span className="text-muted-foreground">{roleName(m.role, t)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/** Whether branch stock requests wait for approval (ADR 0056): the organization's setting, toggled here. */
function ApprovalCard({
  organizationId,
  canSet,
}: {
  organizationId: string | null;
  canSet: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [settings] = useResource(organizationId, () => loadSettings(store));
  const [changed, setChanged] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded =
    settings.status === 'ready'
      ? settings.data.find((s) => s.key === APPROVAL)?.value !== false
      : null;
  const required = changed ?? loaded;
  if (required === null) return null;

  async function toggle() {
    setBusy(true);
    setError(null);
    const result = await putSetting(store, action, APPROVAL, !required);
    setBusy(false);
    if (result.ok) {
      action.done();
      setChanged(!required);
    } else setError(t(errorLabel(result.code)));
  }

  return (
    <Card className="flex flex-col gap-3 p-5" data-testid="branches-approval">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex max-w-3xl flex-col gap-1">
          <h2 className="font-semibold">{t('platform.branchesPage.approvalTitle')}</h2>
          <p className="text-sm text-muted-foreground">
            {t(required ? 'platform.branchesPage.approvalOn' : 'platform.branchesPage.approvalOff')}
          </p>
        </div>
        <Button
          variant="outline"
          className="rounded-full px-5"
          aria-pressed={required}
          aria-label={t('platform.branchesPage.approvalToggle')}
          disabled={!canSet || busy}
          onClick={() => void toggle()}
          data-testid="branches-approval-toggle"
        >
          {t(
            required
              ? 'platform.branchesPage.approvalRequired'
              : 'platform.branchesPage.approvalNotRequired',
          )}
        </Button>
      </div>
      <Notice text={error} tone="error" />
    </Card>
  );
}

/** Add a branch (no `location`), or change its name and address. */
function BranchDialog({ location, onDone }: { location?: LocationSummary; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [checked, setChecked] = useState(false);
  const problem = checked && name.trim() === '' ? t('platform.locationsPage.nameRequired') : null;
  return (
    <FormDialog
      trigger={
        location
          ? t('platform.branchesPage.edit', { name: location.name })
          : t('platform.branchesPage.add')
      }
      triggerVariant="outline"
      triggerIcon={location ? <Pencil aria-hidden /> : undefined}
      triggerClassName={location ? 'size-9 rounded-full' : undefined}
      testId={location ? 'branch-edit' : 'branch-create'}
      title={
        location
          ? t('platform.branchesPage.editTitle', { name: location.name })
          : t('platform.branchesPage.addTitle')
      }
      onOpen={() => {
        setName(location?.name ?? '');
        setAddress(location?.address ?? '');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        const trimmed = name.trim();
        if (trimmed === '') return null;
        const where = address.trim();
        return location
          ? updateLocation(store, action, location.id, {
              ...(trimmed !== location.name ? { name: trimmed } : {}),
              address: where === '' ? null : where,
            })
          : createLocation(store, action, trimmed, where || undefined);
      }}
      onDone={onDone}
    >
      <Field id={`${id}-name`} label={t('platform.branchesPage.name')} problem={problem}>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={LOCATION_NAME_MAX_LENGTH}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setName(e.target.value)}
          data-testid="branch-name"
        />
      </Field>
      <Field id={`${id}-address`} label={t('platform.branchesPage.address')} problem={null}>
        <Input
          id={`${id}-address`}
          value={address}
          maxLength={LOCATION_ADDRESS_MAX_LENGTH}
          placeholder={t('platform.branchesPage.addressPlaceholder')}
          onChange={(e) => setAddress(e.target.value)}
          data-testid="branch-address-input"
        />
      </Field>
    </FormDialog>
  );
}

/** Archive (confirmed) or restore a branch; its stock, staff and history stay either way. */
function ArchiveBranch({ location, onDone }: { location: LocationSummary; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const restoreAction = useActionKey();
  const [busy, setBusy] = useState(false);
  if (location.archivedAt !== null) {
    return (
      <Button
        variant="outline"
        size="icon"
        className="size-9 rounded-full"
        aria-label={t('platform.branchesPage.restore', { name: location.name })}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void updateLocation(store, restoreAction, location.id, { archived: false }).then(() => {
            setBusy(false);
            onDone();
          });
        }}
        data-testid="branch-restore"
      >
        <ArchiveRestore aria-hidden />
      </Button>
    );
  }
  return (
    <ConfirmAction
      testId="branch-archive"
      trigger={t('platform.branchesPage.archive', { name: location.name })}
      triggerIcon={<Archive aria-hidden />}
      title={t('platform.branchesPage.archiveTitle', { name: location.name })}
      description={t('platform.branchesPage.archiveDescription')}
      confirm={t('platform.branchesPage.archiveConfirm')}
      run={() => updateLocation(store, action, location.id, { archived: true })}
      onDone={onDone}
    />
  );
}
