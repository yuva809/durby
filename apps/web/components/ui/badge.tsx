import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** shadcn/ui badge (outline): a small label, e.g. "per location". */
export function Badge({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
