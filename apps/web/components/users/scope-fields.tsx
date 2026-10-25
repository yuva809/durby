'use client';

import type { Translator } from '@durby/i18n';
import type { LocationSummary, Role } from '@durby/shared';
import { useId } from 'react';
import { useT } from '../../app/labels-provider';
import { roleName } from '../../lib/rbac/roles';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Select } from '../ui/select';

/** A role with a location scope, as edited in the member and invitation dialogs. */
export interface ScopeValue {
  roleId: string;
  allLocations: boolean;
  locationIds: string[];
}

/** "All locations", the location names, or "N locations" when the names aren't readable. */
export function scopeText(
  t: Translator,
  scope: { allLocations: boolean; locationIds: readonly string[] },
  locations: readonly LocationSummary[] | null,
): string {
  if (scope.allLocations) return t('platform.members.scope.all');
  const names = scope.locationIds.map((id) => locations?.find((l) => l.id === id)?.name);
  if (names.length > 0 && names.every((n) => n !== undefined)) return names.join(', ');
  return t('platform.members.scope.count', { count: String(scope.locationIds.length) });
}

/** Owners always cover all locations (rbac.owner_all_locations). */
export function normalizeScope(value: ScopeValue, roles: readonly Role[]): ScopeValue {
  const owner = roles.find((r) => r.id === value.roleId)?.systemKey === 'owner';
  return owner ? { ...value, allLocations: true, locationIds: [] } : value;
}

/** The problem with a scope before sending it, if any. */
export function scopeProblem(value: ScopeValue): 'roleRequired' | 'locationsRequired' | null {
  if (!value.roleId) return 'roleRequired';
  if (!value.allLocations && value.locationIds.length === 0) return 'locationsRequired';
  return null;
}

/**
 * Role picker (only the roles the actor may grant) and location scope. Without readable locations
 * (`locations` null) the scope stays as it is and only the role can change; an organization
 * without locations shows no scope choice.
 */
export function ScopeFields({
  value,
  onChange,
  roles,
  locations,
  problem,
}: {
  value: ScopeValue;
  onChange: (value: ScopeValue) => void;
  roles: readonly Role[];
  locations: readonly LocationSummary[] | null;
  problem: 'roleRequired' | 'locationsRequired' | null;
}) {
  const t = useT();
  const id = useId();
  const isOwner = roles.find((r) => r.id === value.roleId)?.systemKey === 'owner';
  const set = (next: Partial<ScopeValue>) => onChange(normalizeScope({ ...value, ...next }, roles));

  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-role`}>{t('platform.members.form.role')}</Label>
        <Select
          id={`${id}-role`}
          data-testid="role-select"
          value={value.roleId}
          aria-invalid={problem === 'roleRequired' || undefined}
          aria-describedby={problem === 'roleRequired' ? `${id}-problem` : undefined}
          onChange={(e) => set({ roleId: e.target.value })}
        >
          <option value="" disabled>
            {t('platform.members.form.chooseRole')}
          </option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {roleName(role, t)}
            </option>
          ))}
        </Select>
      </div>

      {/* Without locations (none readable, or none yet) the only scope is all locations. */}
      {locations !== null && locations.length > 0 && (
        <fieldset className="grid gap-2" disabled={isOwner}>
          <legend className="mb-1 text-sm font-medium">{t('platform.members.form.scope')}</legend>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="radio"
              name={`${id}-scope`}
              className="size-5 accent-primary"
              checked={value.allLocations}
              onChange={() => set({ allLocations: true, locationIds: [] })}
            />
            {t('platform.members.scope.all')}
          </label>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="radio"
              name={`${id}-scope`}
              className="size-5 accent-primary"
              data-testid="scope-selected"
              checked={!value.allLocations}
              onChange={() => set({ allLocations: false })}
            />
            {t('platform.members.scope.selected')}
          </label>
          {isOwner && (
            <p className="text-sm text-muted-foreground">
              {t('platform.errors.ownerAllLocations')}
            </p>
          )}
          {!value.allLocations && (
            <ul
              className="grid gap-1 pl-8"
              aria-describedby={problem === 'locationsRequired' ? `${id}-problem` : undefined}
            >
              {locations.map((location) => {
                const checked = value.locationIds.includes(location.id);
                return (
                  <li key={location.id} className="flex min-h-11 items-center gap-3">
                    <Checkbox
                      id={`${id}-loc-${location.id}`}
                      checked={checked}
                      onCheckedChange={(next) =>
                        set({
                          locationIds:
                            next === true
                              ? [...value.locationIds, location.id]
                              : value.locationIds.filter((l) => l !== location.id),
                        })
                      }
                    />
                    <Label htmlFor={`${id}-loc-${location.id}`} className="font-normal">
                      {location.name}
                    </Label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      )}

      {problem && (
        <p id={`${id}-problem`} role="alert" className="text-sm text-destructive">
          {t(`platform.members.form.${problem}`)}
        </p>
      )}
    </>
  );
}
