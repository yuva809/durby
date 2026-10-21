import { getHealth } from '../lib/api';
import { t } from '../lib/i18n';

const STATUS_LABEL = {
  ok: 'platform.health.status.ok',
  degraded: 'platform.health.status.degraded',
} as const;

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const health = await getHealth();

  return (
    <main>
      <h1>{t('platform.home.title')}</h1>
      <p>
        {t('platform.health.label')}:{' '}
        <strong data-testid="health-status">
          {t(health ? STATUS_LABEL[health.status] : 'platform.health.status.unavailable')}
        </strong>
      </p>
    </main>
  );
}
