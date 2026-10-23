'use client';

import { Building2, ChevronsUpDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

/**
 * The active organization; with several, a menu to switch. After a switch the session (features,
 * permissions, labels) reloads and the app goes home: the current page may not exist there.
 */
export function OrgSwitcher() {
  const { store, session } = useAuth();
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session) return null;

  const active = session.organizations.find((o) => o.id === session.activeOrganizationId);
  if (session.organizations.length < 2) {
    return (
      <span
        className="flex min-w-0 items-center gap-2 text-sm font-medium"
        data-testid="organization"
      >
        <Building2 aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{active?.name ?? t('auth.session.noOrganization')}</span>
      </span>
    );
  }

  async function switchTo(organizationId: string) {
    if (organizationId === session?.activeOrganizationId) return;
    setBusy(true);
    setError(null);
    const result = await store.switchOrganization(organizationId);
    setBusy(false);
    if (result.ok) router.push('/');
    else setError(t(errorLabel(result.code)));
  }

  return (
    <div className="flex min-w-0 flex-col">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="max-w-full min-w-0 justify-start px-2"
            disabled={busy}
            data-testid="organization-switcher"
            aria-label={`${t('platform.shell.switchOrganization')}: ${active?.name ?? ''}`}
          >
            <Building2 aria-hidden />
            <span className="truncate" data-testid="organization">
              {active?.name}
            </span>
            <ChevronsUpDown aria-hidden className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t('platform.shell.switchOrganization')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={session.activeOrganizationId ?? ''}
            onValueChange={(id) => void switchTo(id)}
          >
            {session.organizations.map((org) => (
              <DropdownMenuRadioItem key={org.id} value={org.id}>
                {org.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <p role="alert" className="px-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
