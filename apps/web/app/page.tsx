import { getHealth } from '../lib/api';
import { t } from '../lib/i18n';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const health = await getHealth();

  return (
    <main>
      <h1>{t('platform.home.title')}</h1>
      <p>
        {t('platform.health.label')}:{' '}
        <strong data-testid="health-status">
          {health ? t('platform.health.status.ok') : t('platform.health.status.unavailable')}
        </strong>
      </p>
    </main>
  );
}
