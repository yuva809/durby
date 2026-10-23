'use client';

import { useState } from 'react';
import { ActionKey } from './idempotency';

/** One ActionKey per component instance: pass it to sendAction for that form's submits. */
export function useActionKey(): ActionKey {
  const [action] = useState(() => new ActionKey());
  return action;
}
