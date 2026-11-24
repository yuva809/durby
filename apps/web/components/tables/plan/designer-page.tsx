'use client';

import type { AreaFloorPlanResponse } from '@durby/shared';
import Link from 'next/link';
import { useT } from '../../../app/labels-provider';
import { useAuth } from '../../../app/providers';
import { loadTables } from '../../../lib/pos/api';
import { loadAreaPlan } from '../../../lib/pos/floor-plan-api';
import { useMediaQuery } from '../../../lib/use-media-query';
import { useResource } from '../../../lib/use-resource';
import { Loaded, NoAccess } from '../../users/common';
import { Designer, type PlanAccess, PlanPicture } from './designer';

/** /tables/plan/<area>: the designer; without the edit key, or on a small screen, the live plan to look at. */
export function DesignerPage({ areaId }: { areaId: string }) {
  const { session, store } = useAuth();
  const can = (key: string) => session?.activePermissions.includes(key) ?? false;
  const allowed = can('pos.tables.read');
  const [plan, reload] = useResource(
    session && allowed ? `${session.activeOrganizationId}|${areaId}` : null,
    () => loadAreaPlan(store, areaId),
  );
  if (!session) return null;
  if (!allowed) return <NoAccess title="pos.nav.tables" />;
  return (
    <Loaded resource={plan} reload={reload}>
      {(data) => (
        <WithTables
          plan={data}
          access={{ canManage: can('pos.tables.edit'), canCreate: can('pos.tables.create') }}
        />
      )}
    </Loaded>
  );
}

function WithTables({ plan, access }: { plan: AreaFloorPlanResponse; access: PlanAccess }) {
  const t = useT();
  const { store } = useAuth();
  const [tables, reload] = useResource(plan.area.locationId, () =>
    loadTables(store, plan.area.locationId),
  );
  // Drag and drop needs room; below, the plan is only shown.
  const wide = useMediaQuery('(min-width: 1024px)');
  return (
    <Loaded resource={tables} reload={reload}>
      {(list) =>
        access.canManage && wide ? (
          <Designer initialPlan={plan} initialTables={list} access={access} />
        ) : (
          <div className="flex flex-col gap-4">
            <Link href="/tables" className="text-sm text-muted-foreground hover:underline">
              {t('pos.plan.back')}
            </Link>
            <h1 className="text-2xl font-semibold">
              {t('pos.plan.title', { area: plan.area.name })}
            </h1>
            {access.canManage ? (
              <p className="text-sm text-muted-foreground" data-testid="plan-view-only">
                {t('pos.plan.viewOnly')}
              </p>
            ) : null}
            {plan.live ? (
              <PlanPicture
                layout={plan.live.layout}
                tables={
                  new Map(
                    list.filter((x) => x.areaId === plan.area.id).map((x) => [x.id, x] as const),
                  )
                }
              />
            ) : (
              <p className="text-muted-foreground">{t('pos.plan.notLive')}</p>
            )}
          </div>
        )
      }
    </Loaded>
  );
}
