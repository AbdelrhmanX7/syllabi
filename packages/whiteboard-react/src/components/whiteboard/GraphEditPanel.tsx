import React, { useEffect, useState } from 'react';

import { useWbStrings } from '../../i18n/context';
import { normalizeGraphSpec } from './utils/graphAxes';

import type { GraphMode, GraphSpec } from './utils/graphAxes';
import type { WbStringKey } from '../../i18n/strings';

/**
 * The graph's settings, shown in the selection bar while a graph is selected: which axes it has and
 * where each one starts and ends. Flat rows (it lives inside the bar). A number takes effect as soon as
 * it is a real number and the start is below the end; a half-typed value just waits.
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

type Field = 'xMin' | 'xMax' | 'yMin' | 'yMax';

const text = (spec: GraphSpec): Record<Field, string> => ({
  xMin: String(spec.xMin),
  xMax: String(spec.xMax),
  yMin: String(spec.yMin),
  yMax: String(spec.yMax),
});

export const GraphEditPanel: React.FC<GraphEditPanelProps> = ({ value, onChange }) => {
  const { t } = useWbStrings();
  const [draft, setDraft] = useState(() => text(value));

  // Another graph was selected, or this one was changed elsewhere (undo).
  useEffect(() => {
    setDraft(text(value));
  }, [value.xMin, value.xMax, value.yMin, value.yMax]);

  const edit = (field: Field, raw: string) => {
    const next = { ...draft, [field]: raw };

    setDraft(next);

    const numbers = (['xMin', 'xMax', 'yMin', 'yMax'] as const).map((key) => (next[key].trim() === '' || next[key].trim() === '-' ? Number.NaN : Number(next[key])));

    if (numbers.some((n) => !Number.isFinite(n))) return;

    const [xMin, xMax, yMin, yMax] = numbers as [number, number, number, number];

    if (xMin >= xMax || yMin >= yMax) return;

    onChange(normalizeGraphSpec({ mode: value.mode, xMin, xMax, yMin, yMax }));
  };
  const range = (axis: 'x' | 'y') => {
    const from: Field = axis === 'x' ? 'xMin' : 'yMin';
    const to: Field = axis === 'x' ? 'xMax' : 'yMax';
    const bad = Number(draft[from]) >= Number(draft[to]);
    const input = (field: Field, label: string) => (
      <input
        aria-label={label}
        className={`bg-paper text-ink h-11 w-20 rounded-xl border-2 px-2 text-center text-base font-semibold outline-none focus:border-[#2563eb] ${bad ? 'border-rose-400' : 'border-ink/15'}`}
        data-graph-field={field}
        inputMode='text'
        type='text'
        value={draft[field]}
        onChange={(event) => edit(field, event.target.value.replace('−', '-'))}
      />
    );

    return (
      <div className='flex items-center gap-2' data-graph-range={axis}>
        <span className='w-5 text-center text-sm font-semibold italic'>{axis}</span>
        <span className='text-ink/70 text-xs'>{t('graph.from')}</span>
        {input(from, `${axis} ${t('graph.from')}`)}
        <span className='text-ink/70 text-xs'>{t('graph.to')}</span>
        {input(to, `${axis} ${t('graph.to')}`)}
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
