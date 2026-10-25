import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/**
 * A styled native <select>: the platform picker on tablets and phones, keyboard and screen-reader
 * support for free. Same look as Input.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'min-h-11 w-full rounded-md border border-input bg-card px-3 text-base disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
