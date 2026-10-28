'use client';

import { Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { cn } from '../../lib/utils';
import { Input } from './input';

/**
 * A password field with an eye button that shows or hides the text. Keep it out of a wrapping
 * `<label>` (use `<label htmlFor>`): the button would otherwise become part of the field's name.
 * `labels`: the button's names (`auth.password.show` / `.hide`), from the page's own `t()`, since
 * the public pages translate without the signed-in labels provider.
 */
export function PasswordInput({
  className,
  labels,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { labels: { show: string; hide: string } }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className={cn('pr-12', className)} />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground"
        aria-label={visible ? labels.hide : labels.show}
        aria-pressed={visible}
        aria-controls={props.id}
        data-testid="password-toggle"
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? (
          <EyeOff aria-hidden className="size-5" />
        ) : (
          <Eye aria-hidden className="size-5" />
        )}
      </button>
    </div>
  );
}
