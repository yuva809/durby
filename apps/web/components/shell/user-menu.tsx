'use client';

import { LogOut, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { roleName } from '../../lib/rbac/roles';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

/** The signed-in user with their role in the active organization, and sign-out. */
export function UserMenu() {
  const { store, session } = useAuth();
  const t = useT();
  const router = useRouter();
  if (!session) return null;

  async function signOut() {
    await store.logout().catch(() => undefined);
    router.replace('/login');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('platform.shell.userMenu')}
          data-testid="user-menu"
        >
          <UserRound aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-foreground">
          <span className="block text-xs text-muted-foreground">
            {t('auth.session.signedInAs')}
          </span>
          <span className="block truncate" data-testid="user-email">
            {session.user.email}
          </span>
          {session.activeRole && (
            <span className="block text-xs text-muted-foreground" data-testid="role">
              {t('auth.session.role')}: {roleName(session.activeRole, t)}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()} data-testid="sign-out">
          <LogOut aria-hidden />
          {t('auth.logout.action')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
