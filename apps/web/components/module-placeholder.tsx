'use client';

import type { LabelKey } from '@durby/i18n';
import type { FeatureKey } from '@durby/shared';
import { Construction, Lock } from 'lucide-react';
import { useT } from '../app/labels-provider';
import { useAuth } from '../app/providers';
import { Card } from './ui/card';

/**
 * A module's page until its phase: "coming soon", or "not available" when the organization lacks
 * the feature (a UI hint for direct links; the api enforces the feature on every call).
 */
export function ModulePlaceholder({ feature, title }: { feature: FeatureKey; title: LabelKey }) {
  const { session } = useAuth();
  const t = useT();
  const enabled = session?.activeFeatures.includes(feature) ?? false;
  const Icon = enabled ? Construction : Lock;
  const state = enabled ? 'comingSoon' : 'notAvailable';

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t(title)}</h1>
      <Card
        className="flex flex-col items-center gap-2 px-6 py-12 text-center"
        data-testid={`module-${state}`}
      >
        <Icon aria-hidden className="size-8 text-muted-foreground" />
        <h2 className="text-lg font-medium">{t(`platform.shell.${state}.title`)}</h2>
        <p className="max-w-sm text-muted-foreground">{t(`platform.shell.${state}.description`)}</p>
      </Card>
    </div>
  );
}
