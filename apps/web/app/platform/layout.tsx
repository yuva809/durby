import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { StaffSessionProvider } from '../../components/staff/staff-session';
import { t } from '../../lib/i18n';

/**
 * The staff portal (docs/platform/admin-portal.md, ADR 0017 §9): outside the customer shell, its
 * own session, default labels only, and never indexed.
 */
export const metadata: Metadata = {
  title: t('staff.portal.title'),
  robots: { index: false, follow: false },
};

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <StaffSessionProvider>{children}</StaffSessionProvider>;
}
