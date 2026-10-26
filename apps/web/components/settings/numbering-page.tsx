'use client';

import { NUMBER_RESET_POLICIES, type NumberResetPolicy, type NumberSeries } from '@durby/shared';
import { Lock } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadNumberSeries, patchNumberSeries, raiseCounter } from '../../lib/settings/api';
import {
  counterProblem,
  formatProblemLabels,
  livePreview,
  seriesLabels,
} from '../../lib/settings/numbering';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';

/** /settings/numbering (docs/platform/web-shell.md → Number series). */
export function NumberingPage() {
  const t = useT();
  const { store, session } = useAuth();
  const canRead = session?.activePermissions.includes('platform.settings.read') ?? false;
  const canManage = session?.activePermissions.includes('platform.settings.manage') ?? false;
  const [series, reload] = useResource(
    canRead ? (session?.activeOrganizationId ?? null) : null,
    () => loadNumberSeries(store),
  );
  if (!canRead) return <NoAccess title="platform.nav.numbering" />;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('platform.nav.numbering')}</h1>
      <p className="text-muted-foreground">{t('platform.numberingPage.description')}</p>
      <Loaded resource={series} reload={reload}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">{t('platform.numberingPage.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {list.map((s) => (
                <li key={s.key}>
                  <SeriesCard initial={s} canManage={canManage} />
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}

function SeriesCard({ initial, canManage }: { initial: NumberSeries; canManage: boolean }) {
  const t = useT();
  const [series, setSeries] = useState(initial);
  const labels = seriesLabels(series.key);
  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="number-series" data-key={series.key}>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">{labels.name ? t(labels.name) : series.key}</h2>
        {labels.description && (
          <p className="text-sm text-muted-foreground">{t(labels.description)}</p>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t('platform.numberingPage.nextNumber')}</dt>
        <dd className="font-mono font-medium" data-testid="series-preview">
          {series.preview}
        </dd>
        <dt className="text-muted-foreground">{t('platform.numberingPage.nextValue')}</dt>
        <dd className="font-mono" data-testid="series-next-value">
          {series.nextValue}
        </dd>
      </dl>
      {canManage ? (
        <>
          <FormatEditor series={series} onSaved={setSeries} />
          <CounterEditor series={series} onSaved={setSeries} />
        </>
      ) : (
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('platform.numberingPage.prefix')}</dt>
          <dd className="font-mono">{series.prefix}</dd>
          <dt className="text-muted-foreground">{t('platform.numberingPage.pattern')}</dt>
          <dd className="font-mono">{series.pattern}</dd>
          <dt className="text-muted-foreground">{t('platform.numberingPage.resetPolicy')}</dt>
          <dd>{t(`platform.numberingPage.reset.${series.resetPolicy}`)}</dd>
        </dl>
      )}
    </Card>
  );
}

function FormatEditor({
  series,
  onSaved,
}: {
  series: NumberSeries;
  onSaved: (series: NumberSeries) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [prefix, setPrefix] = useState(series.prefix);
  const [pattern, setPattern] = useState(series.pattern);
  const [resetPolicy, setResetPolicy] = useState<NumberResetPolicy>(series.resetPolicy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const format = { prefix, pattern, resetPolicy };
  const problems = formatProblemLabels(format);
  const preview = livePreview(format, series);
  const changed =
    prefix !== series.prefix || pattern !== series.pattern || resetPolicy !== series.resetPolicy;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!changed || problems.length > 0) return;
    setBusy(true);
    setError(null);
    const body = {
      ...(prefix !== series.prefix && { prefix }),
      ...(pattern !== series.pattern && { pattern }),
      ...(resetPolicy !== series.resetPolicy && { resetPolicy }),
    };
    const result = await patchNumberSeries(store, action, series.key, body);
    setBusy(false);
    if (result.ok && result.data) onSaved(result.data);
    else if (!result.ok) setError(t(errorLabel(result.code)));
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)} noValidate>
      <h3 className="font-medium">{t('platform.numberingPage.format')}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-prefix`}>{t('platform.numberingPage.prefix')}</Label>
          <Input
            id={`${id}-prefix`}
            className="font-mono"
            value={prefix}
            aria-invalid={problems.length > 0 || undefined}
            aria-describedby={problems.length > 0 ? `${id}-problems` : undefined}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-pattern`}>{t('platform.numberingPage.pattern')}</Label>
          <Input
            id={`${id}-pattern`}
            className="font-mono"
            data-testid="series-pattern"
            value={pattern}
            aria-invalid={problems.length > 0 || undefined}
            aria-describedby={`${id}-help${problems.length > 0 ? ` ${id}-problems` : ''}`}
            onChange={(e) => setPattern(e.target.value)}
          />
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {t('platform.numberingPage.patternHelp')}
          </p>
        </div>
      </div>
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor={`${id}-reset`}>{t('platform.numberingPage.resetPolicy')}</Label>
        <Select
          id={`${id}-reset`}
          value={resetPolicy}
          disabled={series.resetPolicyLocked}
          aria-describedby={series.resetPolicyLocked ? `${id}-locked` : undefined}
          onChange={(e) => setResetPolicy(e.target.value as NumberResetPolicy)}
        >
          {NUMBER_RESET_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {t(`platform.numberingPage.reset.${policy}`)}
            </option>
          ))}
        </Select>
        {series.resetPolicyLocked && (
          <p
            id={`${id}-locked`}
            className="flex items-start gap-2 text-xs text-muted-foreground"
            data-testid="reset-locked"
          >
            <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
            {t('platform.numberingPage.resetLocked')}
          </p>
        )}
      </div>
      {problems.length > 0 ? (
        <ul id={`${id}-problems`} role="alert" className="list-disc pl-5 text-sm text-destructive">
          {problems.map((p) => (
            <li key={p}>{t(p)}</li>
          ))}
        </ul>
      ) : (
        changed && (
          <p className="text-sm" data-testid="series-live-preview">
            <span className="text-muted-foreground">{t('platform.numberingPage.preview')} </span>
            <span className="font-mono font-medium">{preview}</span>
          </p>
        )
      )}
      <Notice text={error} tone="error" />
      <div>
        <Button type="submit" disabled={!changed || problems.length > 0 || busy}>
          {t('platform.common.save')}
        </Button>
      </div>
    </form>
  );
}

function CounterEditor({
  series,
  onSaved,
}: {
  series: NumberSeries;
  onSaved: (series: NumberSeries) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = value === '' ? null : counterProblem(series.nextValue, value);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (value === '' || problem) return;
    setBusy(true);
    setError(null);
    const result = await raiseCounter(store, action, series.key, value);
    setBusy(false);
    if (result.ok && result.data) {
      onSaved(result.data);
      setValue('');
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => void onSubmit(e)} noValidate>
      <h3 className="font-medium">{t('platform.numberingPage.counter')}</h3>
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        {t('platform.numberingPage.counterHelp', { current: series.nextValue })}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-value`}>{t('platform.numberingPage.newNextValue')}</Label>
          <Input
            id={`${id}-value`}
            data-testid="counter-value"
            className="max-w-48 font-mono"
            inputMode="numeric"
            value={value}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-help${problem ? ` ${id}-problem` : ''}`}
            onChange={(e) => setValue(e.target.value.trim())}
          />
        </div>
        <Button
          type="submit"
          data-testid="counter-raise"
          disabled={value === '' || problem !== null || busy}
        >
          {t('platform.numberingPage.raise')}
        </Button>
      </div>
      {problem && (
        <p id={`${id}-problem`} role="alert" className="text-sm text-destructive">
          {t(`platform.numberingPage.counterProblems.${problem}`, { current: series.nextValue })}
        </p>
      )}
      <Notice text={error} tone="error" />
    </form>
  );
}
