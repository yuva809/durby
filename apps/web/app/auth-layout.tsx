import type { ReactNode } from 'react';
import { Card } from '../components/ui/card';
import { Wordmark } from '../components/wordmark';
import { cn } from '../lib/utils';

/**
 * The sign-in pages' frame: the partner's wordmark over a roomy card, on a soft glow in the theme's
 * primary colour (tokens only, ADR 0015). `description`: one line under the title.
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,color-mix(in_srgb,var(--primary)_16%,transparent),transparent_65%)]"
      />
      <div className="relative flex w-full max-w-md flex-col gap-8">
        <Wordmark className="self-center" />
        <Card className="rounded-2xl p-6 shadow-lg sm:p-10">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
          <div className="mt-7">{children}</div>
        </Card>
      </div>
    </main>
  );
}

/** A label above its field; labels are medium weight, fields keep their own text size. */
export const fieldClass = 'mb-5 grid gap-2 text-sm font-medium';

/** Error or status text, announced to screen readers. */
export function Notice({ text, tone }: { text: string | null; tone: 'error' | 'info' }) {
  if (!text) return null;
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('my-3 text-sm', tone === 'error' && 'text-destructive')}
    >
      {text}
    </p>
  );
}

/** A text field of a submitted form ('' if missing). */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
