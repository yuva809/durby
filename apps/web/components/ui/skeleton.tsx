import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** shadcn/ui skeleton: a placeholder while content loads. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
