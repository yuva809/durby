import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** shadcn/ui input. The border uses --input (≥ 3:1 against the page and cards). */
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'min-h-11 w-full rounded-md border border-input bg-card px-3 text-base disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
