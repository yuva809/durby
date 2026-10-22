import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DEFAULT_LOCALE } from '@durby/i18n';
import { t } from '../lib/i18n';
import { AuthProvider } from './providers';

export const metadata: Metadata = {
  title: t('platform.app.name'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={DEFAULT_LOCALE}>
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem' }}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
