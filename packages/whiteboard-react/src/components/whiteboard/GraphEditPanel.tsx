import React, { useEffect, useState } from 'react';

import { useWbStrings } from '../../i18n/context';
import { normalizeGraphSpec } from './utils/graphAxes';

import type { GraphMode, GraphSpec } from './utils/graphAxes';
import type { WbStringKey } from '../../i18n/strings';

/**
 * The graph's settings, shown in the selection bar while a graph is selected: which axes it has and
 * where each one starts and ends, and the gap between its numbers (empty = picked to fit). Flat rows (it
 * lives inside the bar). A number takes effect as soon as it is a real number and the start is below the
 * end; a half-typed value just waits.
 */
interface GraphEditPanelProps {
  value: GraphSpec;
  onChange: (spec: GraphSpec) => void;
}

const MODES: Array<{ mode: GraphMode; label: WbStringKey }> = [
  { mode: 'xy', label: 'graph.both' },
  { mode: 'x', label: 'graph.xOnly' },
  { mode: 'y', label: 'graph.yOnly' },
];

type Field = 'xMin' | 'xMax' | 'yMin' | 'yMax' | 'xStep' | 'yStep';

const text = (spec: GraphSpec): Record<Field, string> => ({
  xMin: String(spec.xMin),
  xMax: String(spec.xMax),
  yMin: String(spec.yMin),
  yMax: String(spec.yMax),
  xStep: spec.xStep === undefined ? '' : String(spec.xStep),
  yStep: spec.yStep === undefined ? '' : String(spec.yStep),
});

/** A typed number, or NaN while it is empty or half-typed («-», «.»). */
const parse = (raw: string) => {
  const value = raw.trim();

  return value === '' || value === '-' || value === '.' || value === '-.' ? Number.NaN : Number(value);
};

export const GraphEditPanel: React.FC<GraphEditPanelProps> = ({ value, onChange }) => {
  const { t } = useWbStrings();
  const [draft, setDraft] = useState(() => text(value));

  // Another graph was selected, or this one was changed elsewhere (undo).
  useEffect(() => {
    setDraft(text(value));
  }, [value.xMin, value.xMax, value.yMin, value.yMax, value.xStep, value.yStep]);

  const edit = (field: Field, raw: string) => {
    const next = { ...draft, [field]: raw };

    setDraft(next);

    const numbers = (['xMin', 'xMax', 'yMin', 'yMax'] as const).map((key) => parse(next[key]));

    if (numbers.some((n) => !Number.isFinite(n))) return;

    const [xMin, xMax, yMin, yMax] = numbers as [number, number, number, number];

    if (xMin >= xMax || yMin >= yMax) return;

    // An empty step = picked to fit. A half-typed or zero step waits, like the other numbers.
    const step = (key: 'xStep' | 'yStep') => (next[key].trim() === '' ? undefined : parse(next[key]));
    const xStep = step('xStep');
    const yStep = step('yStep');

    if ((xStep !== undefined && !(xStep > 0)) || (yStep !== undefined && !(yStep > 0))) return;

    onChange(normalizeGraphSpec({ mode: value.mode, xMin, xMax, yMin, yMax, xStep, yStep }));
  };
  const range = (axis: 'x' | 'y') => {
    const from: Field = axis === 'x' ? 'xMin' : 'yMin';
    const to: Field = axis === 'x' ? 'xMax' : 'yMax';
    const stepField: Field = axis === 'x' ? 'xStep' : 'yStep';
    const bad = Number(draft[from]) >= Number(draft[to]);
    const stepBad = draft[stepField].trim() !== '' && !(parse(draft[stepField]) > 0);
    const input = (field: Field, label: string, invalid: boolean, placeholder?: string) => (
      <input
        aria-label={label}
        className={`bg-paper text-ink placeholder:text-ink/40 h-11 w-16 rounded-xl border-2 px-1 text-center text-base font-semibold outline-none focus:border-[#2563eb] ${invalid ? 'border-rose-400' : 'border-ink/15'}`}
        data-graph-field={field}
        inputMode='text'
        placeholder={placeholder}
        type='text'
        value={draft[field]}
        onChange={(event) => edit(field, event.target.value.replace('−', '-'))}
      />
    );

    return (
      <div className='flex items-center gap-1.5' data-graph-range={axis}>
        <span className='w-4 text-center text-sm font-semibold italic'>{axis}</span>
        <span className='text-ink/70 text-xs'>{t('graph.from')}</span>
        {input(from, `${axis} ${t('graph.from')}`, bad)}
        <span className='text-ink/70 text-xs'>{t('graph.to')}</span>
        {input(to, `${axis} ${t('graph.to')}`, bad)}
        <span className='text-ink/70 text-xs'>{t('graph.step')}</span>
        {input(stepField, `${axis} ${t('graph.step')}`, stepBad, t('graph.auto'))}
      </div>
    );
  };

  return (
    <div className='flex flex-col gap-2 px-0.5' data-testid='wb-graph-panel'>
      <div aria-label={t('selection.graph')} className='flex gap-1' role='group'>
        {MODES.map((entry) => (
          <button
            key={entry.mode}
            aria-pressed={value.mode === entry.mode}
            className={`hover:bg-ink/5 min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold ${value.mode === entry.mode ? 'bg-ink/10' : ''}`}
            data-graph-mode={entry.mode}
            style={value.mode === entry.mode ? { boxShadow: 'inset 0 0 0 2px #2563eb' } : undefined}
            type='button'
            onClick={() => onChange(normalizeGraphSpec({ ...value, mode: entry.mode }))}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      {value.mode !== 'y' ? range('x') : null}
      {value.mode !== 'x' ? range('y') : null}
    </div>
  );
};
