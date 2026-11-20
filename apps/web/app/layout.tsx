import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { headers } from 'next/headers';
import { cache, type ReactNode } from 'react';
import { DEFAULT_LOCALE } from '@durby/i18n';
import { ServiceWorkerRegistration } from '../components/pwa/service-worker';
import { BrandProvider } from '../components/theme-provider';
import { fetchTheme, tokensCss } from '../lib/theme';
import { LabelsProvider } from './labels-provider';
import { AuthProvider } from './providers';
import './globals.css';

/**
 * The app's typeface (ADR 0015 §15). next/font downloads it at build time and serves it from the app,
 * so browsers make no third-party font request.
 */
const inter = Inter({ subsets: ['latin', 'latin-ext'], display: 'swap', variable: '--font-inter' });

/** One theme lookup per request, shared by the metadata and the layout. */
const requestTheme = cache(async () => fetchTheme((await headers()).get('host')));

export async function generateMetadata(): Promise<Metadata> {
  const { productName } = await requestTheme();
  return {
    title: { default: productName, template: `%s · ${productName}` },
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, title: productName, statusBarStyle: 'default' },
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/** Themed per request (ADR 0015 §7): the partner's tokens are in the first paint. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await requestTheme();
  return (
    <html lang={DEFAULT_LOCALE} className={inter.variable}>
      <head>
        <style id="theme-tokens">{tokensCss(theme.tokens)}</style>
      </head>
      <body className="min-h-dvh">
        <BrandProvider
          brand={{
            productName: theme.productName,
            logoUrl: theme.logoUrl,
            navLayout: theme.navLayout,
          }}
        >
          <AuthProvider>
            <LabelsProvider>{children}</LabelsProvider>
          </AuthProvider>
          <ServiceWorkerRegistration />
        </BrandProvider>
      </body>
    </html>
  );
}
