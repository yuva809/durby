'use client';

import { type InvitationPreview, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@durby/shared';
import { DEFAULT_LOCALE, type LabelKey } from '@durby/i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { errorLabel } from '../../lib/auth/errors';
import { useLinkToken } from '../../lib/auth/link-token';
import { t } from '../../lib/i18n';
import {
  invitationTokenFromHash,
  joinAsNewUser,
  joinAsSignedIn,
  previewInvitation,
  type Result,
} from '../../lib/rbac/invitations';
import { roleName } from '../../lib/rbac/roles';
import { AuthCard, fieldStyle, formText, Notice } from '../auth-layout';
import { useAuth } from '../providers';

const fill = (key: LabelKey, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key));

/**
 * /accept-invite#token=… (docs/platform/rbac.md → Web). New users choose a password; existing
 * users sign in here (the token stays in memory) and accept with their session.
 */
export default function AcceptInvitePage() {
  const token = useLinkToken(invitationTokenFromHash);
  const { store, session, status } = useAuth();
  const router = useRouter();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  // An account turned up for the email: show the sign-in path even if the preview said none.
  const [accountExists, setAccountExists] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void previewInvitation(token).then((result) => {
      if (!active) return;
      if (result.ok) {
        setPreview(result.data);
        setAccountExists(result.data.accountExists);
      } else setError(t(errorLabel(result.code)));
    });
    return () => {
      active = false;
    };
  }, [token]);

  async function run(join: () => Promise<Result<string>>) {
    setBusy(true);
    setError(null);
    const result = await join();
    setBusy(false);
    if (result.ok) {
      setJoined(true);
      router.replace('/');
    } else {
      if (result.code === 'invitations.sign_in_required') setAccountExists(true);
      setError(t(errorLabel(result.code)));
    }
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !preview) return;
    const form = new FormData(event.currentTarget);
    const password = formText(form, 'password');
    if (password !== formText(form, 'confirm')) {
      setError(t('platform.invite.mismatch'));
      return;
    }
    void run(() =>
      joinAsNewUser(store, { token, email: preview.email, password, locale: DEFAULT_LOCALE }),
    );
  }

  function onSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !preview) return;
    const password = formText(new FormData(event.currentTarget), 'password');
    void run(async () => {
      const login = await store.login(preview.email, password);
      return login.ok ? joinAsSignedIn(store, token) : login;
    });
  }

  let content;
  if (joined && preview) {
    content = (
      <Notice
        text={fill('platform.invite.done', { organization: preview.organizationName })}
        tone="info"
      />
    );
  } else if (token === null) {
    content = <Notice text={t('platform.invite.missingToken')} tone="error" />;
  } else if (!preview) {
    content = error ? (
      <Notice text={error} tone="error" />
    ) : (
      token !== undefined && <p>{t('platform.invite.loading')}</p>
    );
  } else {
    const intro = (
      <p>
        {fill('platform.invite.intro', {
          organization: preview.organizationName,
          role: roleName(preview.role),
        })}
      </p>
    );
    if (!accountExists) {
      content = (
        <>
          {intro}
          <p>{t('platform.invite.newAccount')}</p>
          <form onSubmit={onCreate}>
            <label style={fieldStyle}>
              {t('platform.invite.email')}
              <input
                name="email"
                type="email"
                autoComplete="username"
                value={preview.email}
                readOnly
              />
            </label>
            <label style={fieldStyle}>
              {t('platform.invite.password')}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                required
              />
              <small>{t('platform.invite.hint')}</small>
            </label>
            <label style={fieldStyle}>
              {t('platform.invite.confirm')}
              <input name="confirm" type="password" autoComplete="new-password" required />
            </label>
            <Notice text={error} tone="error" />
            <button type="submit" disabled={busy}>
              {busy ? t('platform.invite.joining') : t('platform.invite.create')}
            </button>
          </form>
        </>
      );
    } else if (status === 'loading') {
      content = <p>{t('auth.session.loading')}</p>;
    } else if (session && session.user.email === preview.email) {
      content = (
        <>
          {intro}
          <Notice text={error} tone="error" />
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => joinAsSignedIn(store, token ?? ''))}
          >
            {busy ? t('platform.invite.joining') : t('platform.invite.accept')}
          </button>
        </>
      );
    } else if (session) {
      content = (
        <>
          {intro}
          <p>
            {fill('platform.invite.otherAccount', {
              current: session.user.email,
              email: preview.email,
            })}
          </p>
          <button type="button" onClick={() => void store.logout()}>
            {t('platform.invite.signOut')}
          </button>
        </>
      );
    } else {
      content = (
        <>
          {intro}
          <p>{t('platform.invite.signIn')}</p>
          <form onSubmit={onSignIn}>
            <label style={fieldStyle}>
              {t('platform.invite.email')}
              <input
                name="email"
                type="email"
                autoComplete="username"
                value={preview.email}
                readOnly
              />
            </label>
            <label style={fieldStyle}>
              {t('platform.invite.password')}
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <Notice text={error} tone="error" />
            <button type="submit" disabled={busy}>
              {busy ? t('platform.invite.joining') : t('platform.invite.signInSubmit')}
            </button>
          </form>
          <p>
            <Link href="/forgot-password">{t('auth.login.forgotPassword')}</Link>
          </p>
        </>
      );
    }
  }

  return <AuthCard title={t('platform.invite.title')}>{content}</AuthCard>;
}
