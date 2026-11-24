'use client';

import {
  type ExistingFloorTable,
  FLOOR_PLAN_MAX_TABLES,
  type FloorPlanLayout,
  generateFloorPlan,
  TABLE_MAX_SEATS,
  TABLE_SHAPES,
  type TableShape,
} from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../../app/labels-provider';
import { Field, FormDialog } from '../../form-dialog';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';

/** "8,5" and "8.5" are the same; anything else is no number. */
const decimal = (text: string) =>
  /^\d{1,3}([.,]\d{1,2})?$/.test(text.trim()) ? Number(text.trim().replace(',', '.')) : Number.NaN;
const whole = (text: string) => (/^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);

/** Asks for a room and a table count and hands back a draft (ADR 0073). Nothing is saved. */
export function GenerateDialog({
  existing,
  takenNames,
  onDraft,
}: {
  existing: readonly ExistingFloorTable[];
  takenNames: readonly string[];
  onDraft: (layout: FloorPlanLayout) => void;
}) {
  const t = useT();
  const id = useId();
  const [form, setForm] = useState({ width: '10', height: '8', tables: '', seats: '4' });
  const [shape, setShape] = useState<TableShape>('square');
  const [checked, setChecked] = useState(false);
  const set = (field: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  const tables = whole(form.tables);
  const seats = whole(form.seats);
  const problems = {
    tables:
      tables >= 1 && tables <= FLOOR_PLAN_MAX_TABLES ? null : t('pos.plan.generate.badTables'),
    seats: seats >= 1 && seats <= TABLE_MAX_SEATS ? null : t('pos.tablesPage.seatsInvalid'),
  };
  const result =
    problems.tables || problems.seats
      ? null
      : generateFloorPlan({
          width: decimal(form.width),
          height: decimal(form.height),
          tables,
          seats,
          shape,
          existing,
          takenNames,
        });
  const failed = result && !result.ok ? result : null;
  const room = failed?.reason === 'room' ? t('pos.plan.generate.badRoom') : null;
  const count =
    failed?.reason === 'existing'
      ? t('pos.plan.generate.tooFew', { count: String(failed.existing) })
      : failed?.reason === 'too_many'
        ? failed.fits > 0
          ? t('pos.plan.generate.tooMany', { count: String(failed.fits) })
          : t('pos.plan.generate.noFit')
        : problems.tables;
  const shown = (problem: string | null) => (checked ? problem : null);

  return (
    <FormDialog
      trigger={t('pos.plan.generate.open')}
      triggerVariant="outline"
      testId="plan-generate"
      title={t('pos.plan.generate.title')}
      submitLabel={t('pos.plan.generate.submit')}
      onOpen={() => {
        setChecked(false);
        setForm((current) => ({
          ...current,
          tables: current.tables || String(Math.max(existing.length, 1)),
        }));
      }}
      submit={() => {
        setChecked(true);
        if (!result?.ok) return null;
        onDraft(result.layout);
        return Promise.resolve({ ok: true, data: null });
      }}
      onDone={() => undefined}
    >
      <p className="text-sm text-muted-foreground">{t('pos.plan.generate.text')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-width`} label={t('pos.plan.generate.width')} problem={shown(room)}>
          <Input
            id={`${id}-width`}
            inputMode="decimal"
            value={form.width}
            onChange={(e) => set('width')(e.target.value)}
          />
        </Field>
        <Field id={`${id}-height`} label={t('pos.plan.generate.height')} problem={null}>
          <Input
            id={`${id}-height`}
            inputMode="decimal"
            value={form.height}
            onChange={(e) => set('height')(e.target.value)}
          />
        </Field>
      </div>
      <Field id={`${id}-tables`} label={t('pos.plan.generate.tables')} problem={shown(count)}>
        <Input
          id={`${id}-tables`}
          inputMode="numeric"
          value={form.tables}
          onChange={(e) => set('tables')(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          {t('pos.plan.generate.tablesHint', { count: String(existing.length) })}
        </p>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${id}-seats`}
          label={t('pos.plan.generate.seats')}
          problem={shown(problems.seats)}
        >
          <Input
            id={`${id}-seats`}
            inputMode="numeric"
            value={form.seats}
            onChange={(e) => set('seats')(e.target.value)}
          />
        </Field>
        <Field id={`${id}-shape`} label={t('pos.plan.generate.shape')} problem={null}>
          <Select
            id={`${id}-shape`}
            value={shape}
            onChange={(e) => setShape(TABLE_SHAPES.find((s) => s === e.target.value) ?? 'square')}
          >
            {TABLE_SHAPES.map((s) => (
              <option key={s} value={s}>
                {t(`pos.tableShapes.${s}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </FormDialog>
  );
}
