import type { ReactNode } from 'react';
import { SettingsTabs } from '../../../components/settings/settings-tabs';

/** Settings: one sidebar item, its pages as tabs (docs/platform/web-shell.md → Settings). */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsTabs />
      {children}
    </>
  );
}
