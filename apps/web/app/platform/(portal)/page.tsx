'use client';

import { staffRoleLabel } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { Card } from '../../../components/ui/card';
import { useStaffSession } from '../../../components/staff/staff-session';
import { t } from '../../../lib/i18n';

/** /platform: who is signed in, and what comes next (docs/platform/admin-portal.md → Roadmap). */
export default function PortalHomePage() {
  const { session } = useStaffSession();
  if (session.status !== 'signedIn') return null;
  const { me } = session;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('staff.home.title')}</h1>
      <Card className="flex max-w-2xl flex-col gap-2 p-6">
        <p data-testid="staff-signed-in-as">
          {t('staff.home.signedInAs', {
            email: me.email,
            role: t(staffRoleLabel(me.role) as LabelKey),
          })}
        </p>
        <p className="text-sm text-muted-foreground">{t('staff.home.next')}</p>
      </Card>
    </div>
  );
}
