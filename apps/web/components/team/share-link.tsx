'use client';

import { Check, Copy, Link2, MessageCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { renewInvitationLink } from '../../lib/team/api';
import { whatsappUrl } from '../../lib/team/matrix';
import { useActionKey } from '../../lib/use-action-key';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

/**
 * An invitation's link, fetched on demand (each fetch issues a new link and voids the previous one,
 * ADR 0023 §5), with Copy and WhatsApp.
 */
export function ShareLink({
  invitationId,
  organizationName,
}: {
  invitationId: string;
  organizationName: string;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function fetchLink() {
    setBusy(true);
    setError(null);
    const result = await renewInvitationLink(store, action, invitationId);
    setBusy(false);
    if (result.ok && result.data) setLink(result.data.link);
    else setError(t(errorLabel(result.ok ? 'unknown' : result.code)));
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access: the link is selected in the field for copying by hand.
      document.getElementById(`${id}-link`)?.focus();
    }
  }

  if (!link) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button onClick={() => void fetchLink()} disabled={busy} data-testid="team-get-link">
          <Link2 aria-hidden />
          {t('platform.team.result.getLink')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('platform.team.result.newLinkNote')}</p>
        <Notice text={error} tone="error" />
      </div>
    );
  }
  const text = t('platform.team.shareText', { organization: organizationName, link });
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-link`}>{t('platform.team.result.link')}</Label>
      <Input
        id={`${id}-link`}
        readOnly
        value={link}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
        data-testid="team-link"
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button variant="outline" onClick={() => void copy()} data-testid="team-copy-link">
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {t(copied ? 'platform.team.result.copied' : 'platform.team.result.copy')}
        </Button>
        <Button variant="outline" asChild>
          <a
            href={whatsappUrl(text)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="team-whatsapp"
          >
            <MessageCircle aria-hidden />
            {t('platform.team.result.whatsapp')}
          </a>
        </Button>
      </div>
    </div>
  );
}
