'use client';

import {
  type CustomerDetail,
  OWNER_LOCALES,
  type OnboardingOptionsResponse,
  type PlanKey,
  planLabel,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { ArrowLeft, CheckCircle2, Mail, Search, TriangleAlert, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useId, useRef, useState } from 'react';
import { fieldClass, formText, Notice } from '../../app/auth-layout';
import { errorLabel } from '../../lib/auth/errors';
import { t } from '../../lib/i18n';
import { staffApi } from '../../lib/staff/api';
import { useResource } from '../../lib/use-resource';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { StaffNoAccess } from './portal-shell';
import { useReauth } from './reauth';
import { useStaffSession } from './staff-session';

const planName = (plan: PlanKey) => t(planLabel(plan) as LabelKey);
const date = (iso: string) => new Date(iso).toLocaleDateString();

function useHeld(key: string): boolean {
  const { session } = useStaffSession();
  return session.status === 'signedIn' && session.me.permissions.some((p) => p === key);
}

function Loading() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}

/** /platform/customers: every organization, newest first, searchable by name. */
export function CustomersPage() {
  const canRead = useHeld('staff.customers.read');
  const canCreate = useHeld('staff.customers.create');
  const [query, setQuery] = useState('');
  const [list] = useResource(canRead ? `customers:${query}` : null, () =>
    staffApi.customers(query),
  );
  if (!canRead) return <StaffNoAccess />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t('staff.nav.customers')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/platform/customers/new" data-testid="customers-onboard">
              <UserPlus aria-hidden />
              {t('staff.nav.onboard')}
            </Link>
          </Button>
        )}
      </div>
      <form
        role="search"
        className="relative max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(formText(new FormData(e.currentTarget), 'query').trim());
        }}
      >
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          name="query"
          type="search"
          aria-label={t('staff.customers.search')}
          placeholder={t('staff.customers.search')}
          className="pl-9"
          data-testid="customers-search"
        />
      </form>
      {list.status === 'error' ? (
        <Notice text={t(errorLabel(list.code))} tone="error" />
      ) : list.status === 'loading' ? (
        <Loading />
      ) : list.data.data.length === 0 ? (
        <p className="text-muted-foreground">
          {query ? t('staff.customers.noMatch') : t('staff.customers.empty')}
        </p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="customers-table">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">{t('staff.customers.name')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.customers.partner')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.customers.plan')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.customers.created')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.data.data.map((customer) => (
                <tr key={customer.id} data-testid="customer-row">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/platform/customers/${customer.id}`}>{customer.name}</Link>
                  </td>
                  <td className="px-4 py-3">{customer.partner.name}</td>
                  <td className="px-4 py-3">
                    <Badge>{planName(customer.plan)}</Badge>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                    {date(customer.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

type Duplicate = { nameTaken: boolean; ownerHasAccount: boolean };

function duplicateOf(details: unknown): Duplicate {
  const d = (details ?? {}) as Partial<Duplicate>;
  return { nameTaken: d.nameTaken === true, ownerHasAccount: d.ownerHasAccount === true };
}

/**
 * /platform/customers/new: organization name and the Owner's email (the primary contact) are all
 * it takes; plan, partner and language have defaults. A known name or owner email asks for a
 * confirmation first (business rules).
 */
export function OnboardPage() {
  const canCreate = useHeld('staff.customers.create');
  const id = useId();
  const [options] = useResource(canCreate ? 'onboarding-options' : null, () =>
    staffApi.onboardingOptions(),
  );
  const { guard, dialog } = useReauth();
  const [problems, setProblems] = useState<{ name?: string; email?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CustomerDetail | null>(null);
  const [formKey, setFormKey] = useState(0);
  const attempt = useRef<{ input: string; key: string } | null>(null);

  if (!canCreate) return <StaffNoAccess />;
  if (done) {
    return (
      <OnboardDone
        customer={done}
        onAnother={() => {
          setDone(null);
          setDuplicate(null);
          setFormKey((k) => k + 1);
        }}
      />
    );
  }

  async function submit(form: HTMLFormElement, confirmDuplicates: boolean) {
    const data = new FormData(form);
    const name = formText(data, 'name').trim();
    const ownerEmail = formText(data, 'ownerEmail').trim();
    const next = {
      ...(name ? {} : { name: t('staff.onboard.nameRequired') }),
      ...(ownerEmail ? {} : { email: t('staff.onboard.emailRequired') }),
    };
    setProblems(next);
    if (next.name || next.email) return;
    setBusy(true);
    setError(null);
    const body = {
      name,
      ownerEmail,
      ownerLocale: formText(data, 'ownerLocale') as (typeof OWNER_LOCALES)[number],
      plan: formText(data, 'plan') as PlanKey,
      partnerId: formText(data, 'partnerId') || undefined,
      confirmDuplicates,
    };
    // One key per submit; a retry after the password re-confirmation reuses it. So does a retry
    // after an answer we never saw (timeout, network error): the customer may exist already, and
    // the api replays the stored answer for the same key instead of creating a second one.
    const input = JSON.stringify(body);
    const key = attempt.current?.input === input ? attempt.current.key : crypto.randomUUID();
    attempt.current = { input, key };
    const result = await guard(() => staffApi.onboard(body, key));
    setBusy(false);
    // Any real answer ends the attempt; only an unknown outcome keeps its key for the retry.
    if (result.ok || result.code !== 'unknown') attempt.current = null;
    if (result.ok) {
      setDone(result.data);
    } else if (result.code === 'staff.customer_duplicate') {
      setDuplicate(duplicateOf('details' in result ? result.details : undefined));
    } else {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('staff.onboard.title')}</h1>
        <p className="text-muted-foreground">{t('staff.onboard.intro')}</p>
      </div>
      <Card className="p-6">
        {options.status === 'loading' ? (
          <Loading />
        ) : options.status === 'error' ? (
          <Notice text={t(errorLabel(options.code))} tone="error" />
        ) : (
          <OnboardForm
            key={formKey}
            id={id}
            options={options.data}
            problems={problems}
            busy={busy}
            onChange={() => setDuplicate(null)}
            onSubmit={(form) => void submit(form, false)}
          >
            <Notice text={error} tone="error" />
            {duplicate && (
              <div
                role="alert"
                className="flex flex-col gap-3 rounded-md border border-destructive p-4 text-sm"
                data-testid="onboard-duplicate"
              >
                <p className="flex items-center gap-2 font-medium">
                  <TriangleAlert aria-hidden className="size-4 text-destructive" />
                  {t('staff.onboard.duplicateTitle')}
                </p>
                {duplicate.nameTaken && <p>{t('staff.onboard.duplicateName')}</p>}
                {duplicate.ownerHasAccount && <p>{t('staff.onboard.duplicateOwner')}</p>}
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    data-testid="onboard-confirm"
                    onClick={(e) => {
                      const form = e.currentTarget.form;
                      if (form) void submit(form, true);
                    }}
                  >
                    {t('staff.onboard.createAnyway')}
                  </Button>
                </div>
              </div>
            )}
          </OnboardForm>
        )}
      </Card>
      {dialog}
    </div>
  );
}

function OnboardForm({
  id,
  options,
  problems,
  busy,
  onChange,
  onSubmit,
  children,
}: {
  id: string;
  options: OnboardingOptionsResponse;
  problems: { name?: string; email?: string };
  busy: boolean;
  onChange: () => void;
  onSubmit: (form: HTMLFormElement) => void;
  children: React.ReactNode;
}) {
  const problem = (text: string | undefined, field: string) =>
    text ? (
      <span
        id={`${id}-${field}-problem`}
        role="alert"
        className="text-sm font-normal text-destructive"
      >
        {text}
      </span>
    ) : null;
  return (
    <form
      noValidate
      onChange={onChange}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSubmit(e.currentTarget);
      }}
      data-testid="onboard-form"
    >
      <label className={fieldClass}>
        {t('staff.onboard.name')}
        <Input
          name="name"
          maxLength={100}
          autoComplete="off"
          aria-invalid={problems.name ? true : undefined}
          aria-describedby={problems.name ? `${id}-name-problem` : undefined}
          data-testid="onboard-name"
        />
        {problem(problems.name, 'name')}
      </label>
      <label className={fieldClass}>
        {t('staff.onboard.ownerEmail')}
        <Input
          name="ownerEmail"
          type="email"
          autoComplete="off"
          aria-invalid={problems.email ? true : undefined}
          aria-describedby={`${id}-email-hint`}
          data-testid="onboard-email"
        />
        <span id={`${id}-email-hint`} className="text-xs font-normal text-muted-foreground">
          {t('staff.onboard.ownerEmailHint')}
        </span>
        {problem(problems.email, 'email')}
      </label>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <label className={fieldClass}>
          {t('staff.onboard.ownerLocale')}
          <Select name="ownerLocale" defaultValue="en">
            {OWNER_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(locale === 'de' ? 'staff.onboard.localeDe' : 'staff.onboard.localeEn')}
              </option>
            ))}
          </Select>
        </label>
        <label className={fieldClass}>
          {t('staff.onboard.plan')}
          <Select name="plan" defaultValue="full" data-testid="onboard-plan">
            {options.plans.map((plan) => (
              <option key={plan} value={plan}>
                {planName(plan)}
              </option>
            ))}
          </Select>
        </label>
        <label className={fieldClass}>
          {t('staff.onboard.partner')}
          <Select name="partnerId" defaultValue={options.defaultPartnerId ?? ''}>
            {options.defaultPartnerId === null && <option value="" />}
            {options.partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {children}
      <Button type="submit" className="mt-1 min-h-11" disabled={busy} data-testid="onboard-submit">
        {t('staff.onboard.submit')}
      </Button>
    </form>
  );
}

function OnboardDone({ customer, onAnother }: { customer: CustomerDetail; onAnother: () => void }) {
  return (
    <Card className="flex max-w-2xl flex-col gap-4 p-6" data-testid="onboard-done">
      <p className="flex items-center gap-2 text-lg font-semibold">
        <CheckCircle2 aria-hidden className="size-5 text-primary" />
        {t('staff.onboard.doneTitle', { name: customer.name })}
      </p>
      {customer.owner && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Mail aria-hidden className="size-4" />
          {t('staff.onboard.doneInvited', { email: customer.owner.email })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href={`/platform/customers/${customer.id}`}>{t('staff.onboard.openCustomer')}</Link>
        </Button>
        <Button variant="outline" onClick={onAnother}>
          {t('staff.onboard.another')}
        </Button>
      </div>
    </Card>
  );
}

/** /platform/customers/:id: metadata, the Owner and their invitation. */
export function CustomerPage({ id }: { id: string }) {
  const canRead = useHeld('staff.customers.read');
  const canInvite = useHeld('staff.customers.invite');
  const [customer, reload] = useResource(canRead ? `customer:${id}` : null, () =>
    staffApi.customer(id),
  );
  const { guard, dialog } = useReauth();
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canRead) return <StaffNoAccess />;

  async function resend() {
    setBusy(true);
    setNotice(null);
    const result = await guard(() => staffApi.resendOwnerInvite(id));
    setBusy(false);
    if (result.ok) setNotice({ text: t('staff.customers.resent'), tone: 'info' });
    else setNotice({ text: t(errorLabel(result.code)), tone: 'error' });
    reload();
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link href="/platform/customers" className="flex items-center gap-1 text-sm">
        <ArrowLeft aria-hidden className="size-4" />
        {t('staff.customers.back')}
      </Link>
      {customer.status === 'error' ? (
        <Notice text={t(errorLabel(customer.code))} tone="error" />
      ) : customer.status === 'loading' ? (
        <Loading />
      ) : (
        <>
          <h1 className="text-2xl font-semibold" data-testid="customer-name">
            {customer.data.name}
          </h1>
          <Card className="p-6">
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">{t('staff.customers.partner')}</dt>
              <dd>{customer.data.partner.name}</dd>
              <dt className="text-muted-foreground">{t('staff.customers.plan')}</dt>
              <dd>
                <Badge>{planName(customer.data.plan)}</Badge>
              </dd>
              <dt className="text-muted-foreground">{t('staff.customers.created')}</dt>
              <dd>{date(customer.data.createdAt)}</dd>
              <dt className="text-muted-foreground">{t('staff.customers.owner')}</dt>
              <dd className="flex flex-col items-start gap-2" data-testid="customer-owner">
                {customer.data.owner ? (
                  <>
                    <span className="font-medium">{customer.data.owner.email}</span>
                    <Badge>
                      {customer.data.owner.status === 'active'
                        ? t('staff.customers.ownerActive')
                        : t('staff.customers.ownerInvited')}
                    </Badge>
                    {canInvite && customer.data.owner.status === 'invited' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void resend()}
                        data-testid="customer-resend"
                      >
                        <Mail aria-hidden />
                        {t('staff.customers.resend')}
                      </Button>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">{t('staff.customers.noOwner')}</span>
                )}
              </dd>
            </dl>
          </Card>
          {notice && <Notice text={notice.text} tone={notice.tone} />}
        </>
      )}
      {dialog}
    </div>
  );
}
