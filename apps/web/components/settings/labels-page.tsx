'use client';

import { dictionaries, type LabelKey, type Locale } from '@durby/i18n';
import type { LabelOverride } from '@durby/shared';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useReloadLabels, useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import {
  deleteLabelOverride,
  loadLabelOverrides,
  loadResolvedLabels,
  putLabelOverride,
} from '../../lib/settings/api';
import {
  EDITOR_LOCALES,
  inactiveReason,
  overridableKeys,
  overrideProblem,
  previewText,
} from '../../lib/settings/labels-editor';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';

/** /settings/labels (docs/platform/web-shell.md → Labels editor). */
export function LabelsPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('platform.labels.manage')) {
    return <NoAccess title="platform.nav.labels" />;
  }
  return <LabelsEditor organizationId={session.activeOrganizationId} />;
}

function LabelsEditor({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const reloadShell = useReloadLabels();
  const [overrides, reloadOverrides] = useResource(organizationId, () => loadLabelOverrides(store));
  const [filter, setFilter] = useState('');

  /** After a save or remove: this page's lists and the labels the shell (nav) uses. */
  const changed = () => {
    reloadOverrides();
    reloadShell();
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('platform.nav.labels')}</h1>
      <p className="text-muted-foreground">{t('platform.labelsEditor.description')}</p>
      <Loaded resource={overrides} reload={reloadOverrides}>
        {(rows) => (
          <>
            <InactiveRows rows={rows.filter((r) => !r.active)} onChanged={changed} />
            <div className="grid max-w-sm gap-1.5">
              <Label htmlFor="labels-filter">{t('platform.labelsEditor.filter')}</Label>
              <Input
                id="labels-filter"
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <Tabs defaultValue={EDITOR_LOCALES[0]} className="flex flex-col gap-4">
              <TabsList aria-label={t('platform.labelsEditor.language')} className="self-start">
                {EDITOR_LOCALES.map((locale) => (
                  <TabsTrigger key={locale} value={locale} data-testid={`labels-locale-${locale}`}>
                    {t(`platform.labelsEditor.locales.${locale}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
              {EDITOR_LOCALES.map((locale) => (
                <TabsContent key={locale} value={locale}>
                  <LocaleEditor
                    locale={locale}
                    organizationId={organizationId}
                    overrides={rows.filter((r) => r.active && r.locale === locale)}
                    filter={filter}
                    onChanged={changed}
                  />
                </TabsContent>
              ))}
            </Tabs>
          </>
        )}
      </Loaded>
    </div>
  );
}

function LocaleEditor({
  locale,
  organizationId,
  overrides,
  filter,
  onChanged,
}: {
  locale: Locale;
  organizationId: string | null;
  overrides: LabelOverride[];
  filter: string;
  onChanged: () => void;
}) {
  const { store } = useAuth();
  // The resolved texts (override, else partner, else default) for "Current".
  const [resolved, reloadResolved] = useResource(
    organizationId ? `${organizationId}:${locale}` : null,
    () => loadResolvedLabels(store, locale),
  );
  const current = resolved.status === 'ready' ? resolved.data : {};
  const needle = filter.trim().toLowerCase();
  const matches = (key: LabelKey) =>
    needle === '' ||
    key.toLowerCase().includes(needle) ||
    dictionaries[locale][key].toLowerCase().includes(needle) ||
    (current[key] ?? '').toLowerCase().includes(needle);

  return (
    <div className="flex flex-col gap-6">
      {overridableKeys().map(({ module, keys }) => {
        const shown = keys.filter(matches);
        if (shown.length === 0) return null;
        return (
          <section key={module} className="flex flex-col gap-3" aria-label={module}>
            <h2 className="text-lg font-medium">{module}</h2>
            {shown.map((key) => (
              <LabelRow
                key={key}
                labelKey={key}
                locale={locale}
                override={overrides.find((o) => o.key === key) ?? null}
                current={current[key] ?? null}
                onChanged={() => {
                  reloadResolved();
                  onChanged();
                }}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function LabelRow({
  labelKey,
  locale,
  override,
  current,
  onChanged,
}: {
  labelKey: LabelKey;
  locale: Locale;
  override: LabelOverride | null;
  current: string | null;
  onChanged: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const save = useActionKey();
  const remove = useActionKey();
  const [value, setValue] = useState(override?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = value !== (override?.value ?? '');
  const problem = touched ? overrideProblem(t, labelKey, locale, value) : null;
  const isNav = labelKey.includes('.nav.');

  async function onSave() {
    setBusy(true);
    setError(null);
    const result = await putLabelOverride(store, save, locale, labelKey, value);
    setBusy(false);
    if (result.ok) onChanged();
    else setError(t(errorLabel(result.code)));
  }

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="label-row" data-key={labelKey}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="text-sm break-all">{labelKey}</code>
        {override && <Badge>{t('platform.labelsEditor.overridden')}</Badge>}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t('platform.labelsEditor.default')}</dt>
        <dd>{dictionaries[locale][labelKey]}</dd>
        <dt className="text-muted-foreground">{t('platform.labelsEditor.current')}</dt>
        <dd>{current ?? dictionaries[locale][labelKey]}</dd>
      </dl>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-value`}>{t('platform.labelsEditor.override')}</Label>
        <Input
          id={`${id}-value`}
          data-testid="label-value"
          value={value}
          placeholder={dictionaries[locale][labelKey]}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {problem && (
          <p id={`${id}-problem`} role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>
      {touched && !problem && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="label-preview">
          <span className="text-muted-foreground">{t('platform.labelsEditor.preview')}</span>
          {isNav ? (
            <span className="inline-flex min-h-9 items-center rounded-md border-l-2 border-primary bg-muted px-3 font-medium">
              {previewText(value)}
            </span>
          ) : (
            <span className="font-medium">{previewText(value)}</span>
          )}
        </div>
      )}
      <Notice text={error} tone="error" />
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="label-save"
          disabled={!touched || problem !== null || busy}
          onClick={() => void onSave()}
        >
          {t('platform.common.save')}
        </Button>
        {override && (
          <ConfirmAction
            testId="label-remove"
            trigger={t('platform.labelsEditor.remove')}
            title={t('platform.labelsEditor.removeTitle')}
            description={t('platform.labelsEditor.removeDescription', {
              text: dictionaries[locale][labelKey],
            })}
            confirm={t('platform.labelsEditor.remove')}
            run={() => deleteLabelOverride(store, remove, locale, labelKey)}
            onDone={() => {
              setValue('');
              onChanged();
            }}
          />
        )}
      </div>
    </Card>
  );
}

/** Stored rows that are skipped on read (active: false), with the reason and a remove action. */
function InactiveRows({ rows, onChanged }: { rows: LabelOverride[]; onChanged: () => void }) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="inactive-labels">
      <h2 id="inactive-labels" className="text-lg font-medium">
        {t('platform.labelsEditor.inactive')}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t('platform.labelsEditor.inactiveDescription')}
      </p>
      {rows.map((row) => (
        <InactiveRow key={`${row.locale}:${row.key}`} row={row} onChanged={onChanged} />
      ))}
    </section>
  );
}

function InactiveRow({ row, onChanged }: { row: LabelOverride; onChanged: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const remove = useActionKey();
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="inactive-label" data-key={row.key}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm break-all">{row.key}</code>
        <Badge>{row.locale}</Badge>
      </div>
      <p className="text-sm">{row.value}</p>
      <p className="text-sm text-muted-foreground">
        {t(`platform.labelsEditor.reasons.${inactiveReason(row)}`)}
      </p>
      <div>
        <ConfirmAction
          testId="inactive-label-remove"
          trigger={t('platform.labelsEditor.remove')}
          title={t('platform.labelsEditor.removeTitle')}
          description={t('platform.labelsEditor.removeInactiveDescription')}
          confirm={t('platform.labelsEditor.remove')}
          run={() => deleteLabelOverride(store, remove, row.locale, row.key)}
          onDone={onChanged}
        />
      </div>
    </Card>
  );
}
