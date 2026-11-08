import type { BlueprintSection, BlueprintSectionType } from '../types';

import React, { useEffect, useMemo, useState } from 'react';
import { LayoutList, Pencil, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';

import { useBlueprint, useSaveBlueprint } from '../api';
import {
  blueprintQuestionCount,
  cleanBlueprint,
  DEFAULT_EXAM_MINUTES,
  SECTION_TYPES,
  sectionTypeLabel,
} from '../lib/blueprint';
import { confirmDiscard, useUnsavedGuard } from '../lib/useUnsavedGuard';

import {
  ActionButton,
  Badge,
  EmptyState,
  ErrorNote,
  INPUT_CLASS,
  LoadingRows,
  Surface,
} from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { ConfirmSheet } from '@/components/ui/ConfirmSheet';

interface RowDraft extends Omit<BlueprintSection, 'count' | 'points'> {
  key: number;
  count: string;
  points: string;
}

let rowKey = 1;

const toDraft = (s: BlueprintSection): RowDraft => ({
  ...s,
  key: rowKey++,
  count: String(s.count),
  points: s.points === undefined ? '' : String(s.points),
});

const fromDraft = ({ key: _key, count, points, ...rest }: RowDraft): BlueprintSection => ({
  ...rest,
  count: Number(count),
  ...(points.trim() === '' ? {} : { points: Number(points) }),
});

/**
 * The class exam blueprint («Real exam format» mock exams are built from it): sections in paper
 * order with type, count and flags. Edit → PUT; Reset → back to the course default (or none).
 */
export function BlueprintEditor({ classId }: { classId: string }) {
  const state = useBlueprint(classId);
  const save = useSaveBlueprint(classId);
  const blueprint = state.data?.blueprint ?? null;
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<RowDraft[]>([]);
  const [minutes, setMinutes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const original = useMemo(
    () => JSON.stringify({ m: blueprint?.minutes ?? null, s: blueprint?.sections ?? [] }),
    [blueprint],
  );
  const dirty =
    editing && JSON.stringify({ m: minutes.trim() ? Number(minutes) : null, s: rows.map(fromDraft) }) !== original;

  useUnsavedGuard(dirty);

  useEffect(() => {
    if (editing) return;
    setRows((blueprint?.sections ?? []).map(toDraft));
    setMinutes(blueprint?.minutes ? String(blueprint.minutes) : '');
  }, [blueprint, editing]);

  const patch = (key: number, change: Partial<RowDraft>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const move = (key: number, by: -1 | 1) =>
    setRows((current) => {
      const i = current.findIndex((r) => r.key === key);
      const j = i + by;

      if (i < 0 || j < 0 || j >= current.length) return current;
      const next = [...current];

      [next[i], next[j]] = [next[j]!, next[i]!];

      return next;
    });

  const submit = () => {
    const clean = cleanBlueprint(minutes.trim() ? Number(minutes) : null, rows.map(fromDraft));

    if (typeof clean === 'string') {
      setError(clean);

      return;
    }
    setError(null);
    save.mutate(clean, { onSuccess: () => setEditing(false) });
  };

  const [confirmReset, setConfirmReset] = useState(false);
  const reset = () => setConfirmReset(true);

  return (
    <Surface as='section' className='p-4 sm:p-5'>
      {confirmReset ? (
        <ConfirmSheet
          danger
          confirmLabel='Reset'
          title='Reset the exam format?'
          onClose={() => setConfirmReset(false)}
          onConfirm={() => save.mutate(null, { onSuccess: () => setEditing(false) })}
        >
          It goes back to the class default and your edits are removed.
        </ConfirmSheet>
      ) : null}
      <div className='mb-3 flex flex-wrap items-start gap-3'>
        <div className='min-w-0 flex-1'>
          <h2 className='text-st-fg flex items-center gap-2 text-base font-semibold'>
            <LayoutList className='h-4 w-4' /> Exam format
            {state.data?.source === 'default' ? <Badge>Class default</Badge> : null}
            {state.data?.source === 'stored' ? <Badge tone='accent'>Customised</Badge> : null}
          </h2>
          <p className='text-st-muted mt-0.5 text-sm'>
            «Real exam format» mock exams follow these sections, in this order.
          </p>
        </div>
        {editing ? (
          <div className='flex gap-2'>
            <ActionButton
              variant='ghost'
              onClick={() => {
                if (!confirmDiscard(dirty)) return;
                setError(null);
                setEditing(false);
              }}
            >
              <X className='h-4 w-4' /> Cancel
            </ActionButton>
            <ActionButton disabled={!dirty} loading={save.isPending} variant='primary' onClick={submit}>
              <Save className='h-4 w-4' /> Save
            </ActionButton>
          </div>
        ) : (
          <div className='flex gap-2'>
            {state.data?.source === 'stored' ? (
              <ActionButton loading={save.isPending} variant='ghost' onClick={reset}>
                <RotateCcw className='h-4 w-4' /> Reset
              </ActionButton>
            ) : null}
            <ActionButton
              disabled={state.isLoading || state.isError}
              onClick={() => {
                save.reset();
                setRows(
                  (blueprint?.sections ?? [{ section: 'Multiple choice', type: 'mcq' as const, count: 20 }]).map(
                    toDraft,
                  ),
                );
                setMinutes(blueprint?.minutes ? String(blueprint.minutes) : '');
                setEditing(true);
              }}
            >
              <Pencil className='h-4 w-4' /> {blueprint ? 'Edit' : 'Set up'}
            </ActionButton>
          </div>
        )}
      </div>

      {state.isLoading ? <LoadingRows rows={3} /> : null}
      {state.isError ? <ErrorNote message={describeError(state.error)} onRetry={() => void state.refetch()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {save.isError ? <ErrorNote message={describeError(save.error)} /> : null}

      {editing ? (
        <div className='flex flex-col gap-3'>
          <label className='text-st-fg flex items-center gap-2 text-sm'>
            Minutes
            <input
              className={`${INPUT_CLASS} w-28`}
              inputMode='numeric'
              max={300}
              min={1}
              placeholder={String(DEFAULT_EXAM_MINUTES)}
              type='number'
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          {rows.map((row, i) => (
            <div key={row.key} className='rounded-st border-st-line flex flex-col gap-2 border p-3'>
              <div className='grid gap-2 sm:grid-cols-[2fr_1.6fr_0.7fr_0.7fr]'>
                <input
                  aria-label='Section name'
                  className={INPUT_CLASS}
                  maxLength={80}
                  placeholder='Section name'
                  value={row.section}
                  onChange={(e) => patch(row.key, { section: e.target.value })}
                />
                <select
                  aria-label='Question type'
                  className={INPUT_CLASS}
                  value={row.type}
                  onChange={(e) => patch(row.key, { type: e.target.value as BlueprintSectionType })}
                >
                  {SECTION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label='Questions'
                  className={INPUT_CLASS}
                  inputMode='numeric'
                  max={50}
                  min={1}
                  placeholder='Count'
                  type='number'
                  value={row.count}
                  onChange={(e) => patch(row.key, { count: e.target.value })}
                />
                <input
                  aria-label='Points'
                  className={INPUT_CLASS}
                  inputMode='decimal'
                  min={0}
                  placeholder='Points'
                  type='number'
                  value={row.points}
                  onChange={(e) => patch(row.key, { points: e.target.value })}
                />
              </div>
              <div className='text-st-fg flex flex-wrap items-center gap-x-4 gap-y-1 text-sm'>
                <Flag checked={Boolean(row.bonus)} label='Bonus' onChange={(v) => patch(row.key, { bonus: v })} />
                <Flag
                  checked={Boolean(row.optional)}
                  label='Optional (bank only)'
                  onChange={(v) => patch(row.key, { optional: v })}
                />
                <Flag
                  checked={Boolean(row.preferImage)}
                  label='Prefer images'
                  onChange={(v) => patch(row.key, { preferImage: v })}
                />
                <Flag
                  checked={row.from === 'concept_map'}
                  label='From concept maps'
                  onChange={(v) => patch(row.key, { from: v ? 'concept_map' : null })}
                />
                <span className='flex-1' />
                <ActionButton aria-label='Move up' disabled={i === 0} variant='ghost' onClick={() => move(row.key, -1)}>
                  ↑
                </ActionButton>
                <ActionButton
                  aria-label='Move down'
                  disabled={i === rows.length - 1}
                  variant='ghost'
                  onClick={() => move(row.key, 1)}
                >
                  ↓
                </ActionButton>
                <ActionButton
                  aria-label={`Remove ${row.section || 'section'}`}
                  variant='ghost'
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  <Trash2 className='h-4 w-4' />
                </ActionButton>
              </div>
            </div>
          ))}
          <ActionButton
            className='self-start'
            disabled={rows.length >= 20}
            onClick={() => setRows((current) => [...current, toDraft({ section: '', type: 'mcq', count: 1 })])}
          >
            <Plus className='h-4 w-4' /> Add section
          </ActionButton>
        </div>
      ) : state.data ? (
        blueprint ? (
          <>
            <ol className='divide-st-line flex flex-col divide-y'>
              {blueprint.sections.map((s) => (
                <li key={s.section} className='flex flex-wrap items-center gap-2 py-2 text-sm'>
                  <span className='text-st-fg min-w-0 flex-1 font-medium'>{s.section}</span>
                  <span className='text-st-muted'>
                    {s.count} × {sectionTypeLabel(s.type)}
                    {s.points !== undefined ? ` · ${s.points} pts` : ''}
                  </span>
                  {s.bonus ? <Badge tone='ok'>Bonus</Badge> : null}
                  {s.optional ? <Badge>Optional</Badge> : null}
                  {s.from === 'concept_map' ? <Badge>Concept maps</Badge> : null}
                </li>
              ))}
            </ol>
            <p className='text-st-muted mt-2 text-xs'>
              {blueprintQuestionCount(blueprint)} questions · {blueprint.minutes ?? DEFAULT_EXAM_MINUTES} min
            </p>
          </>
        ) : (
          <EmptyState
            hint='Describe the professor’s exam (sections, types, counts) to get mock exams in the same format.'
            icon={LayoutList}
            title='No exam format yet'
          />
        )
      ) : null}
    </Surface>
  );
}

function Flag({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className='inline-flex min-h-10 items-center gap-2'>
      <input checked={checked} className='h-4 w-4' type='checkbox' onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
