'use client';

import { staffRoleLabel } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { Building2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { useStaffSession } from '../../../components/staff/staff-session';
import { t } from '../../../lib/i18n';

/** /platform: who is signed in, and shortcuts to the customer pages the role may open. */
export default function PortalHomePage() {
  const { session } = useStaffSession();
  if (session.status !== 'signedIn') return null;
  const { me } = session;
  const held = new Set<string>(me.permissions);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('staff.home.title')}</h1>
      <Card className="flex max-w-2xl flex-col gap-4 p-6">
        <p data-testid="staff-signed-in-as">
          {t('staff.home.signedInAs', {
            email: me.email,
            role: t(staffRoleLabel(me.role) as LabelKey),
          })}
        </p>
        <p className="text-sm text-muted-foreground">{t('staff.home.next')}</p>
        <div className="flex flex-wrap gap-2">
          {held.has('staff.customers.create') && (
            <Button asChild>
              <Link href="/platform/customers/new">
                <UserPlus aria-hidden />
                {t('staff.nav.onboard')}
              </Link>
            </Button>
          )}
          {held.has('staff.customers.read') && (
            <Button asChild variant="outline">
              <Link href="/platform/customers">
                <Building2 aria-hidden />
                {t('staff.nav.customers')}
              </Link>
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
