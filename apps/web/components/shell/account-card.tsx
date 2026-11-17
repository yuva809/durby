'use client';

import { MAX_SIGNED_IN_ACCOUNTS } from '@durby/shared';
import { ChevronsUpDown, LogOut, Settings2, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAccounts, useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { roleName } from '../../lib/rbac/roles';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

/** "anna.weber@…" → "AW"; one letter for a single word. */
export function initialsOf(email: string): string {
  const name = email.split('@')[0] ?? '';
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = (parts.length > 1 ? [parts[0]!, parts[1]!] : [name]).map((p) => p[0] ?? '');
  return letters.join('').toUpperCase().slice(0, 2) || '?';
}

/**
 * The person at the bottom of the sidebar (docs/platform/web-shell.md → Layout, ADR 0046): who is signed in, in which
 * organization and role. Its menu switches to another organization on this site or another account signed in on this
 * browser (up to MAX_SIGNED_IN_ACCOUNTS, ADR 0047), adds an account, opens the account page and signs out (this account
 * or all). After a switch the session reloads and the app goes home (the page may not exist there).
 */
export function AccountCard() {
  const t = useT();
  const router = useRouter();
  const { store, session } = useAuth();
  const accounts = useAccounts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session) return null;
  const active = session.organizations.find((o) => o.id === session.activeOrganizationId);

  async function switchTo(organizationId: string) {
    if (organizationId === session?.activeOrganizationId) return;
    setBusy(true);
    setError(null);
    const result = await store.switchOrganization(organizationId);
    setBusy(false);
    if (result.ok) router.push('/');
    else setError(t(errorLabel(result.code)));
  }

  async function switchAccount(slot: number) {
    setBusy(true);
    setError(null);
    const result = await accounts.switchTo(slot);
    setBusy(false);
    if (result.ok) router.push('/');
    else setError(t(errorLabel(result.code)));
  }

  async function signOut() {
    setBusy(true);
    const another = await accounts.signOut();
    setBusy(false);
    if (another) router.push('/');
    else router.replace('/login');
  }

  async function signOutAll() {
    setBusy(true);
    await accounts.signOutAll();
    setBusy(false);
    router.replace('/login');
  }

  const others = accounts.list.filter((a) => a.slot !== accounts.current);

  return (
    <div className="flex flex-col gap-1 border-t p-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            className="flex min-h-14 w-full items-center gap-3 rounded-lg border bg-background px-3 py-2 text-left hover:bg-muted"
            aria-label={t('platform.shell.accountCard', {
              email: session.user.email,
              organization: active?.name ?? '',
            })}
            data-testid="account-card"
          >
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-primary"
            >
              {initialsOf(session.user.email)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium" data-testid="user-email">
                {session.user.email}
              </span>
              <span className="truncate text-xs text-muted-foreground" data-testid="organization">
                {active?.name ?? t('auth.session.noOrganization')}
                {session.activeRole && ` · ${roleName(session.activeRole, t)}`}
              </span>
            </span>
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          {session.organizations.length > 1 && (
            <>
              <DropdownMenuLabel>{t('platform.shell.switchOrganization')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={session.activeOrganizationId ?? ''}
                onValueChange={(id) => void switchTo(id)}
              >
                {session.organizations.map((org) => (
                  <DropdownMenuRadioItem
                    key={org.id}
                    value={org.id}
                    data-testid="account-organization"
                  >
                    {org.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel>{t('platform.shell.accounts')}</DropdownMenuLabel>
          {others.map((account) => (
            <DropdownMenuItem
              key={account.slot}
              onSelect={() => void switchAccount(account.slot)}
              data-testid="account-other"
            >
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.65rem] font-semibold text-primary"
              >
                {initialsOf(account.email)}
              </span>
              <span className="truncate">{account.email}</span>
            </DropdownMenuItem>
          ))}
          {accounts.list.length < MAX_SIGNED_IN_ACCOUNTS && (
            <DropdownMenuItem
              onSelect={() => router.push('/login?add=1')}
              data-testid="account-add"
            >
              <UserPlus aria-hidden />
              {t('platform.shell.addAccount')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => router.push('/account')} data-testid="account-link">
            <Settings2 aria-hidden />
            {t('platform.account.menu')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void signOut()} data-testid="sign-out">
            <LogOut aria-hidden />
            {t('auth.logout.action')}
          </DropdownMenuItem>
          {others.length > 0 && (
            <DropdownMenuItem onSelect={() => void signOutAll()} data-testid="sign-out-all">
              <LogOut aria-hidden />
              {t('platform.shell.signOutAll')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <p role="alert" className="px-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
