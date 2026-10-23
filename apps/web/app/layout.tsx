import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { cache, type ReactNode } from 'react';
import { DEFAULT_LOCALE } from '@durby/i18n';
import { BrandProvider } from '../components/theme-provider';
import { fetchTheme, tokensCss } from '../lib/theme';
import { LabelsProvider } from './labels-provider';
import { AuthProvider } from './providers';
import './globals.css';

/** One theme lookup per request, shared by the metadata and the layout. */
const requestTheme = cache(async () => fetchTheme((await headers()).get('host')));

export async function generateMetadata(): Promise<Metadata> {
  const { productName } = await requestTheme();
  return { title: { default: productName, template: `%s · ${productName}` } };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/** Themed per request (ADR 0015 §7): the partner's tokens are in the first paint. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await requestTheme();
  return (
    <html lang={DEFAULT_LOCALE}>
      <head>
        <style id="theme-tokens">{tokensCss(theme.tokens)}</style>
      </head>
      <body className="min-h-dvh">
        <BrandProvider brand={{ productName: theme.productName, logoUrl: theme.logoUrl }}>
          <AuthProvider>
            <LabelsProvider>{children}</LabelsProvider>
          </AuthProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
