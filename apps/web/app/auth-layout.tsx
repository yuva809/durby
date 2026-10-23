import type { ReactNode } from 'react';
import { Card } from '../components/ui/card';
import { Wordmark } from '../components/wordmark';
import { cn } from '../lib/utils';

/** Narrow centered card with the partner's wordmark for the sign-in pages. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <Wordmark className="self-center" />
      <Card className="p-6">
        <h1 className="mb-4 text-xl font-semibold">{title}</h1>
        {children}
      </Card>
    </main>
  );
}

export const fieldClass = 'mb-4 grid gap-1.5';

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
