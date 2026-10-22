import type { ReactNode } from 'react';

/** Narrow centered column for the sign-in pages. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={{ maxWidth: '22rem', margin: '4rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>{title}</h1>
      {children}
    </main>
  );
}

export const fieldStyle = { display: 'grid', gap: '0.25rem', marginBottom: '1rem' } as const;

/** Error or status text, announced to screen readers. */
export function Notice({ text, tone }: { text: string | null; tone: 'error' | 'info' }) {
  if (!text) return null;
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      style={{ color: tone === 'error' ? '#b00020' : 'inherit' }}
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
