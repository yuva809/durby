'use client';

import {
  berlinDate,
  type CatalogFeature,
  type CustomerEntitlements,
  type CustomerFeature,
  type FeatureCatalogResponse,
  type FeatureKey,
  type PlanKey,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { RotateCcw } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { fieldClass, formText, Notice } from '../../app/auth-layout';
import { errorLabel } from '../../lib/auth/errors';
import { t } from '../../lib/i18n';
import { staffApi, type StaffResult } from '../../lib/staff/api';
import {
  applyToggle,
  catalogFeatures,
  changesFor,
  currentState,
  keptOverrides,
  type ModuleChange,
  moduleKeys,
  planChangeEffect,
  planState,
  resetModule,
  type SwitchState,
  type Toggled,
} from '../../lib/staff/modules';
import { useResource } from '../../lib/use-resource';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';

/**
 * Module switches of the staff portal (docs/platform/admin-portal.md → Modules, step 1d), rendered
 * entirely from GET /platform/feature-catalog: names are the registry's label keys, so a new module
 * shows up here without a code change.
 */

const nameOf = (catalog: FeatureCatalogResponse, key: FeatureKey) =>
  t((catalogFeatures(catalog).find((f) => f.key === key)?.label ?? key) as LabelKey);
const namesOf = (catalog: FeatureCatalogResponse, keys: readonly FeatureKey[]) =>
  keys.map((k) => nameOf(catalog, k)).join(', ');
const planName = (catalog: FeatureCatalogResponse, plan: PlanKey) =>
  t((catalog.plans.find((p) => p.key === plan)?.label ?? plan) as LabelKey);

/** "Also switched on/off: …" after a toggle that pulled others along. */
export function toggleNote(catalog: FeatureCatalogResponse, toggled: Toggled): string | null {
  const parts = [
    toggled.alsoOn.length > 0
      ? t('staff.modules.alsoOn', { modules: namesOf(catalog, toggled.alsoOn) })
      : null,
    toggled.alsoOff.length > 0
      ? t('staff.modules.alsoOff', { modules: namesOf(catalog, toggled.alsoOff) })
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** One card per module: its main switch, then its sub-features. */
export function ModuleSwitches({
  catalog,
  state,
  onToggle,
  disabled = false,
  badges,
  moduleAction,
}: {
  catalog: FeatureCatalogResponse;
  state: SwitchState;
  onToggle: (key: FeatureKey, on: boolean) => void;
  disabled?: boolean;
  badges?: (key: FeatureKey) => ReactNode;
  /** E.g. "Reset to plan", shown at the foot of the module's card. */
  moduleAction?: (module: FeatureKey) => ReactNode;
}) {
  const id = useId();
  const row = (feature: CatalogFeature, sub: boolean) => {
    const inputId = `${id}-${feature.key}`;
    return (
      <div
        key={feature.key}
        className={sub ? 'flex items-start gap-3 py-2 ps-8' : 'flex items-start gap-3 py-2'}
        data-testid={`module-${feature.key}`}
      >
        <Checkbox
          id={inputId}
          checked={state[feature.key] ?? false}
          disabled={disabled}
          onCheckedChange={(checked) => onToggle(feature.key, checked === true)}
          aria-describedby={`${inputId}-description`}
          className="mt-0.5"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label
            id={`${inputId}-label`}
            htmlFor={inputId}
            className={sub ? 'text-sm' : 'text-sm font-semibold'}
          >
            {t(feature.label as LabelKey)}
          </label>
          <span id={`${inputId}-description`} className="text-xs text-muted-foreground">
            {t(feature.description as LabelKey)}
          </span>
          {badges && <span className="flex flex-wrap gap-1">{badges(feature.key)}</span>}
        </div>
      </div>
    );
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="module-switches">
      {catalog.modules.map((module) => (
        // A named group, so "Reset to plan" is announced with its module.
        <div
          key={module.key}
          role="group"
          aria-labelledby={`${id}-${module.key}-label`}
          className="flex flex-col rounded-md border p-3"
        >
          {row(module, false)}
          {module.features.map((f) => row(f, true))}
          {/* Below the switches, so it never squeezes the module's description. */}
          {moduleAction?.(module.key)}
        </div>
      ))}
    </div>
  );
}

/** Onboarding: switches pre-ticked from the chosen plan; the page sends their differences. */
export function OnboardModules({
  catalog,
  state,
  onChange,
}: {
  catalog: FeatureCatalogResponse;
  state: SwitchState;
  onChange: (state: SwitchState) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <fieldset className="mb-5 flex flex-col gap-3" data-testid="onboard-modules">
      <legend className="mb-1 text-sm font-medium">{t('staff.modules.title')}</legend>
      <p className="text-xs text-muted-foreground">{t('staff.modules.onboardingNote')}</p>
      <ModuleSwitches
        catalog={catalog}
        state={state}
        onToggle={(key, on) => {
          const toggled = applyToggle(catalog, state, key, on);
          setNote(toggleNote(catalog, toggled));
          onChange(toggled.state);
        }}
      />
      <Notice text={note} tone="info" />
    </fieldset>
  );
}

/** A YYYY-MM-DD day as the browser shows dates (noon UTC: the same day in every time zone). */
const displayDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString();

function sourceBadges(catalog: FeatureCatalogResponse, f: CustomerFeature | undefined) {
  if (!f) return null;
  const badges: ReactNode[] = [];
  if (f.override && !f.override.expired) {
    badges.push(
      <Badge key="custom" data-testid={`badge-custom-${f.key}`}>
        {t('staff.modules.badgeCustom')}
      </Badge>,
    );
    if (f.override.expiresOn) {
      badges.push(
        <Badge key="expires">
          {t('staff.modules.badgeExpires', { date: displayDay(f.override.expiresOn) })}
        </Badge>,
      );
    }
  } else {
    badges.push(<Badge key="plan">{t('staff.modules.badgePlan')}</Badge>);
    if (f.override?.expired) {
      badges.push(<Badge key="expired">{t('staff.modules.badgeExpired')}</Badge>);
    }
  }
  if (f.blockedBy.length > 0) {
    badges.push(
      <Badge key="needs" className="border-destructive text-destructive">
        {t('staff.modules.badgeNeeds', { modules: namesOf(catalog, f.blockedBy) })}
      </Badge>,
    );
  }
  return badges;
}

interface Outcome {
  saved: FeatureKey[];
  failed: { key: FeatureKey; code: string }[];
}

/** The customer page's Modules card. Read-only without staff.entitlements.manage. */
export function CustomerModules({
  customerId,
  canManage,
  guard,
  onPlanChanged,
}: {
  customerId: string;
  canManage: boolean;
  guard: <T>(run: () => Promise<StaffResult<T>>) => Promise<StaffResult<T>>;
  onPlanChanged: () => void;
}) {
  const [catalog] = useResource('feature-catalog', () => staffApi.featureCatalog());
  const [current, reload] = useResource(`entitlements:${customerId}`, () =>
    staffApi.entitlements(customerId),
  );
  const [draft, setDraft] = useState<SwitchState | null>(null);
  const [resets, setResets] = useState<Set<FeatureKey>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [planDialog, setPlanDialog] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);

  if (catalog.status === 'loading' || current.status === 'loading') {
    return (
      <Card className="p-6" aria-busy="true">
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (catalog.status === 'error' || current.status === 'error') {
    const code = catalog.status === 'error' ? catalog.code : (current as { code: string }).code;
    return (
      <Card className="p-6">
        <Notice text={t(errorLabel(code as never))} tone="error" />
      </Card>
    );
  }
  const cat = catalog.data;
  const ent = current.data;
  const saved = currentState(ent);
  const state = draft ?? saved;
  const plan = planState(cat, ent.plan);
  const byKey = new Map(ent.features.map((f) => [f.key, f]));
  const changes = changesFor(cat, ent, state, resets);
  const discard = () => {
    setDraft(null);
    setResets(new Set());
    setNote(null);
  };

  return (
    <Card className="flex flex-col gap-4 p-6" data-testid="customer-modules">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('staff.modules.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('staff.modules.intro')}</p>
        </div>
        {canManage && (
          <Button
            variant="outline"
            onClick={() => setPlanDialog(true)}
            data-testid="modules-change-plan"
          >
            {t('staff.modules.changePlanAction')}
          </Button>
        )}
      </div>
      {!canManage && <Notice text={t('staff.modules.readOnly')} tone="info" />}
      <ModuleSwitches
        catalog={cat}
        state={state}
        disabled={!canManage}
        badges={(key) => sourceBadges(cat, byKey.get(key))}
        onToggle={(key, on) => {
          const toggled = applyToggle(cat, state, key, on);
          setNote(toggleNote(cat, toggled));
          setOutcome(null);
          setDraft(toggled.state);
        }}
        moduleAction={(module) => {
          const keys = moduleKeys(cat, module);
          const custom = keys.some((k) => {
            const o = byKey.get(k)?.override;
            return o && !o.expired;
          });
          if (!canManage || !custom) return null;
          return (
            <Button
              variant="ghost"
              className="mt-1 self-start"
              data-testid={`module-reset-${module}`}
              onClick={() => {
                const toggled = resetModule(cat, state, plan, module);
                setNote(toggleNote(cat, toggled));
                setOutcome(null);
                setDraft(toggled.state);
                setResets(new Set([...resets, ...keys]));
              }}
            >
              <RotateCcw aria-hidden />
              {t('staff.modules.resetToPlan')}
            </Button>
          );
        }}
      />
      <Notice text={note} tone="info" />
      {outcome && <Notice text={outcome.text} tone={outcome.tone} />}
      {canManage && changes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setReviewing(true)} data-testid="modules-review">
            {t('staff.modules.reviewChanges')}
          </Button>
          <Button variant="outline" onClick={discard}>
            {t('staff.modules.discard')}
          </Button>
        </div>
      )}
      {reviewing && (
        <SaveDialog
          catalog={cat}
          changes={changes}
          onCancel={() => setReviewing(false)}
          onSave={async (reason, expiresOn) => {
            const result = await apply(customerId, changes, reason, expiresOn, guard);
            setReviewing(false);
            discard();
            reload();
            setOutcome(
              result.failed.length === 0
                ? { text: t('staff.modules.saved'), tone: 'info' }
                : {
                    text: t('staff.modules.partlySaved', {
                      saved: result.saved.length > 0 ? namesOf(cat, result.saved) : '–',
                      failed: result.failed
                        .map((f) => `${nameOf(cat, f.key)} (${t(errorLabel(f.code as never))})`)
                        .join(', '),
                    }),
                    tone: 'error',
                  },
            );
          }}
        />
      )}
      {planDialog && (
        <PlanDialog
          catalog={cat}
          entitlements={ent}
          onCancel={() => setPlanDialog(false)}
          onSave={async (next, reason, resetKeys) => {
            const outcome: Outcome = { saved: [], failed: [] };
            const planResult = await guard(() => staffApi.setPlan(customerId, next, reason));
            let error: string | null = planResult.ok ? null : t(errorLabel(planResult.code));
            if (planResult.ok) {
              // Only after the plan changed; one call each, nothing retried automatically.
              for (const key of resetKeys) {
                const r = await guard(() => staffApi.resetFeature(customerId, key, reason));
                if (r.ok) outcome.saved.push(key);
                else outcome.failed.push({ key, code: r.code });
              }
              if (outcome.failed.length > 0) {
                error = t('staff.modules.partlySaved', {
                  saved: outcome.saved.length > 0 ? namesOf(cat, outcome.saved) : '–',
                  failed: namesOf(
                    cat,
                    outcome.failed.map((f) => f.key),
                  ),
                });
              }
            }
            setPlanDialog(false);
            discard();
            reload();
            onPlanChanged();
            setOutcome(
              error
                ? { text: error, tone: 'error' }
                : { text: t('staff.modules.saved'), tone: 'info' },
            );
          }}
        />
      )}
    </Card>
  );
}

/**
 * Runs the changes one call at a time, in order. Stops at nothing and retries nothing: the caller
 * shows which keys were saved and which were not.
 */
async function apply(
  customerId: string,
  changes: readonly ModuleChange[],
  reason: string,
  expiresOn: string | undefined,
  guard: <T>(run: () => Promise<StaffResult<T>>) => Promise<StaffResult<T>>,
): Promise<Outcome> {
  const outcome: Outcome = { saved: [], failed: [] };
  for (const change of changes) {
    const result = await guard(() =>
      change.action === 'reset'
        ? staffApi.resetFeature(customerId, change.key, reason)
        : staffApi.setFeature(customerId, change.key, {
            enabled: change.action === 'on',
            reason,
            ...(expiresOn ? { expiresOn } : {}),
          }),
    );
    if (result.ok) outcome.saved.push(change.key);
    else outcome.failed.push({ key: change.key, code: result.code });
  }
  return outcome;
}

function ReasonField({ id, problem }: { id: string; problem: string | null }) {
  return (
    <label className={fieldClass}>
      {t('staff.modules.reason')}
      <Input
        name="reason"
        maxLength={500}
        autoComplete="off"
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-reason-hint`}
        data-testid="modules-reason"
      />
      <span id={`${id}-reason-hint`} className="text-xs font-normal text-muted-foreground">
        {t('staff.modules.reasonHint')}
      </span>
      {problem && (
        <span role="alert" className="text-sm font-normal text-destructive">
          {problem}
        </span>
      )}
    </label>
  );
}

function SaveDialog({
  catalog,
  changes,
  onCancel,
  onSave,
}: {
  catalog: FeatureCatalogResponse;
  changes: readonly ModuleChange[];
  onCancel: () => void;
  onSave: (reason: string, expiresOn: string | undefined) => Promise<void>;
}) {
  const id = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (c: ModuleChange) => {
    const name = nameOf(catalog, c.key);
    if (c.action === 'reset') return t('staff.modules.changeReset', { module: name });
    return t(c.action === 'on' ? 'staff.modules.changeOn' : 'staff.modules.changeOff', {
      module: name,
    });
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = formText(form, 'reason').trim();
    if (!reason) {
      setProblem(t('staff.modules.reasonRequired'));
      return;
    }
    setBusy(true);
    await onSave(reason, formText(form, 'expiresOn') || undefined);
    setBusy(false);
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent closeLabel={t('platform.common.close')} data-testid="modules-dialog">
        <DialogTitle>{t('staff.modules.dialogTitle')}</DialogTitle>
        <DialogDescription asChild>
          <ul className="list-disc ps-5 text-sm" data-testid="modules-summary">
            {changes.map((c) => (
              <li key={c.key}>{label(c)}</li>
            ))}
          </ul>
        </DialogDescription>
        <form noValidate onSubmit={(e) => void submit(e)} className="mt-2">
          <ReasonField id={id} problem={problem} />
          {changes.some((c) => c.action !== 'reset') && (
            <label className={fieldClass}>
              {t('staff.modules.expiresOn')}
              <Input
                name="expiresOn"
                type="date"
                // Today in Berlin is the earliest end day the api accepts (staff.expiry_past).
                min={berlinDate(new Date())}
                aria-describedby={`${id}-expiry-hint`}
                data-testid="modules-expires"
              />
              <span id={`${id}-expiry-hint`} className="text-xs font-normal text-muted-foreground">
                {t('staff.modules.expiresOnHint')}
              </span>
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              {t('platform.common.cancel')}
            </Button>
            <Button type="submit" disabled={busy} data-testid="modules-save">
              {t('staff.modules.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Changing the plan keeps custom switches: the dialog says so and offers to reset each. */
function PlanDialog({
  catalog,
  entitlements,
  onCancel,
  onSave,
}: {
  catalog: FeatureCatalogResponse;
  entitlements: CustomerEntitlements;
  onCancel: () => void;
  onSave: (plan: PlanKey, reason: string, resets: FeatureKey[]) => Promise<void>;
}) {
  const id = useId();
  const [plan, setPlan] = useState<PlanKey>(entitlements.plan);
  const [resets, setResets] = useState<FeatureKey[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kept = keptOverrides(catalog, entitlements).filter((o) => !resets.includes(o.key));
  const effect = planChangeEffect(catalog, entitlements, plan, resets);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = formText(new FormData(event.currentTarget), 'reason').trim();
    if (!reason) {
      setProblem(t('staff.modules.reasonRequired'));
      return;
    }
    setBusy(true);
    await onSave(plan, reason, resets);
    setBusy(false);
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent closeLabel={t('platform.common.close')} data-testid="plan-dialog">
        <DialogTitle>{t('staff.modules.changePlanAction')}</DialogTitle>
        <form noValidate onSubmit={(e) => void submit(e)} className="mt-2">
          <label className={fieldClass}>
            {t('staff.customers.plan')}
            <Select
              value={plan}
              onChange={(e) => setPlan(e.currentTarget.value as PlanKey)}
              data-testid="plan-select"
            >
              {catalog.plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {planName(catalog, p.key)}
                </option>
              ))}
            </Select>
          </label>
          {(effect.off.length > 0 || effect.on.length > 0) && (
            <div className="mb-5 flex flex-col gap-1 text-sm" data-testid="plan-effect">
              {effect.off.length > 0 && (
                <p className="text-destructive">
                  {t('staff.modules.planSwitchesOff', { modules: namesOf(catalog, effect.off) })}
                </p>
              )}
              {effect.on.length > 0 && (
                <p>{t('staff.modules.planSwitchesOn', { modules: namesOf(catalog, effect.on) })}</p>
              )}
            </div>
          )}
          {kept.length > 0 && (
            <div className="mb-5 flex flex-col gap-2 text-sm" data-testid="plan-kept">
              <p>{t('staff.modules.staysIntro')}</p>
              {/* Stacked on phones (each reset link under its row), one line from sm up. */}
              <ul className="flex flex-col divide-y">
                {kept.map((o) => (
                  <li
                    key={o.key}
                    className="flex flex-col items-start gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      {t('staff.modules.stays', {
                        module: nameOf(catalog, o.key),
                        state: t(o.enabled ? 'staff.modules.on' : 'staff.modules.off'),
                      })}
                      {o.expiresOn && (
                        <Badge>
                          {t('staff.modules.badgeExpires', { date: displayDay(o.expiresOn) })}
                        </Badge>
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => setResets([...resets, o.key])}
                    >
                      {t('staff.modules.resetLink', { module: nameOf(catalog, o.key) })}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {resets.length > 0 && (
            <p className="mb-5 text-sm">
              {resets
                .map((k) => t('staff.modules.changeReset', { module: nameOf(catalog, k) }))
                .join(' · ')}
            </p>
          )}
          <ReasonField id={id} problem={problem} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              {t('platform.common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || (plan === entitlements.plan && resets.length === 0)}
              data-testid="plan-save"
            >
              {t('staff.modules.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
