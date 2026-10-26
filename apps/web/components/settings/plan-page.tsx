'use client';

import { isLabelKey, type LabelKey } from '@durby/i18n';
import { FEATURES, planLabel } from '@durby/shared';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadEntitlements } from '../../lib/settings/api';
import { useResource } from '../../lib/use-resource';
import { Card } from '../ui/card';
import { Loaded } from '../users/common';

const label = (key: string, fallback: LabelKey): LabelKey => (isLabelKey(key) ? key : fallback);

/**
 * /settings/plan (docs/platform/web-shell.md → Plan and features): read-only. Plans change only
 * through the CLI (ADR 0009).
 */
export function PlanPage() {
  const t = useT();
  const { store, session } = useAuth();
  const [entitlements, reload] = useResource(session?.activeOrganizationId ?? null, () =>
    loadEntitlements(store),
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('platform.nav.plan')}</h1>
      <p className="text-muted-foreground">{t('platform.planPage.description')}</p>
      <Loaded resource={entitlements} reload={reload}>
        {({ plan, features }) => (
          <div className="flex flex-col gap-4">
            <Card className="p-6">
              <p className="text-sm text-muted-foreground">{t('platform.planPage.plan')}</p>
              <p className="text-xl font-semibold" data-testid="plan-name">
                {plan
                  ? t(label(planLabel(plan.key), 'platform.planPage.unknownPlan'))
                  : t('platform.planPage.noPlan')}
              </p>
            </Card>
            <section className="flex flex-col gap-3" aria-labelledby="features">
              <h2 id="features" className="text-lg font-medium">
                {t('platform.planPage.features')}
              </h2>
              {features.length === 0 ? (
                <p className="text-muted-foreground">{t('platform.planPage.noFeatures')}</p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {features.map((feature) => {
                    const def = FEATURES[feature.key];
                    const limits = Object.entries(feature.limits);
                    return (
                      <li key={feature.key} data-testid="plan-feature" data-feature={feature.key}>
                        <Card className="flex h-full flex-col gap-1 p-4">
                          <h3 className="font-medium">
                            {t(label(def.label, 'platform.planPage.unknownPlan'))}
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            {t(label(def.description, 'platform.planPage.unknownPlan'))}
                          </p>
                          {limits.length > 0 && (
                            <dl className="mt-2 grid gap-1 text-sm">
                              {limits.map(([name, value]) => (
                                <div key={name} className="flex gap-2">
                                  <dt className="text-muted-foreground">
                                    {t(
                                      label(
                                        `platform.features.limits.${name}`,
                                        'platform.planPage.limit',
                                      ),
                                    )}
                                  </dt>
                                  <dd>{value ?? t('platform.planPage.unlimited')}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </Loaded>
    </div>
  );
}
