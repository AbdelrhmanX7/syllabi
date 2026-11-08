import type { PaperSpacingPreset } from '@repo/whiteboard-core';
import type { BoardThemeSetting } from '@/lib/notebooks/board-theme';

import {
  GRID_SPACING_PRESETS,
  LINED_SPACING_PRESETS,
  PAPER_SPACING_MM_MAX,
  PAPER_SPACING_MM_MIN,
} from '@repo/whiteboard-core';

import { SectionTitle, Surface } from '@/components/ui/primitives';
import { saveBoardThemeSetting, useBoardThemeSetting } from '@/lib/notebooks/board-theme';
import { savePaperSpacingDefault, usePaperSpacingDefaults } from '@/lib/notebooks/paper-settings';
import { saveNotebookFillScreen, useNotebookFillScreen } from '@/lib/notebooks/fill-screen';
import { saveHidePenShortcuts, useHidePenShortcuts } from '@/lib/notebooks/pen-shortcuts-button';

const CHIP =
  'inline-flex min-h-11 items-center justify-center rounded-full border px-3 text-xs font-medium tabular-nums transition-colors';

function SpacingRow({
  type,
  label,
  presets,
  value,
}: {
  type: 'lined' | 'grid';
  label: string;
  presets: readonly PaperSpacingPreset[];
  value: number | undefined;
}) {
  const chip = (active: boolean) =>
    `${CHIP} ${active ? 'border-st-accent-lip bg-st-accent text-st-accent-fg' : 'border-st-line text-st-fg hover:bg-st-raised'}`;

  return (
    <div className='flex flex-col gap-3 py-3' data-paper-row={type}>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-st-fg text-sm font-medium'>{label}</p>
        <span className='text-st-muted text-xs tabular-nums'>
          {value === undefined ? 'Board default' : `${value.toFixed(1)} mm`}
        </span>
      </div>
      <div className='flex flex-wrap gap-2' role='group'>
        <button
          aria-pressed={value === undefined}
          className={chip(value === undefined)}
          type='button'
          onClick={() => savePaperSpacingDefault(type, null)}
        >
          Default
        </button>
        {presets.map((preset) => (
          <button
            key={preset.id}
            aria-pressed={value !== undefined && Math.abs(value - preset.mm) < 0.05}
            className={chip(value !== undefined && Math.abs(value - preset.mm) < 0.05)}
            type='button'
            onClick={() => savePaperSpacingDefault(type, preset.mm)}
          >
            <span className='capitalize'>{preset.id}</span>&nbsp;· {preset.mm} mm
          </button>
        ))}
      </div>
      <input
        aria-label={`${label} spacing in millimetres`}
        className='accent-st-fg h-8 w-full'
        max={PAPER_SPACING_MM_MAX}
        min={PAPER_SPACING_MM_MIN}
        step={0.1}
        type='range'
        value={value ?? 7.9}
        onChange={(event) => savePaperSpacingDefault(type, Number(event.target.value))}
      />
    </div>
  );
}

const BOARD_THEMES: { id: BoardThemeSetting; label: string }[] = [
  { id: 'paper', label: 'Paper' },
  { id: 'dark', label: 'Dark' },
  { id: 'app', label: 'Match app' },
];

/** Board colour: white paper, a dark board (ink drawn light), or follow the app theme. View only. */
function BoardThemeRow() {
  const value = useBoardThemeSetting();

  return (
    <div className='flex flex-col gap-3 py-3' data-paper-row='board-theme'>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-st-fg text-sm font-medium'>Board</p>
        <span className='text-st-muted text-xs'>Exports stay on white paper</span>
      </div>
      <div className='flex flex-wrap gap-2' role='group'>
        {BOARD_THEMES.map((option) => (
          <button
            key={option.id}
            aria-pressed={value === option.id}
            className={`${CHIP} ${value === option.id ? 'border-st-accent-lip bg-st-accent text-st-accent-fg' : 'border-st-line text-st-fg hover:bg-st-raised'}`}
            type='button'
            onClick={() => saveBoardThemeSetting(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Settings → Notebook paper: the line / grid spacing a NEW notebook page starts with. Each page keeps
 * its own spacing afterwards (changed from the board's background menu), so this never moves the
 * lines of a page already written on.
 */
export function NotebookPaperSection() {
  const defaults = usePaperSpacingDefaults();
  const hidePenShortcuts = useHidePenShortcuts();
  const fillScreen = useNotebookFillScreen();

  return (
    <Surface className='p-5'>
      <SectionTitle>Notebook paper</SectionTitle>
      <p className='text-st-muted text-xs'>
        Spacing for new pages, in real millimetres. Change a page you&apos;re already writing on from the board&apos;s
        background menu.
      </p>
      <div className='divide-st-line divide-y'>
        <BoardThemeRow />
        <SpacingRow label='Lined paper' presets={LINED_SPACING_PRESETS} type='lined' value={defaults.lined} />
        <SpacingRow label='Grid and dot paper' presets={GRID_SPACING_PRESETS} type='grid' value={defaults.grid} />
        <label className='flex min-h-11 cursor-pointer items-center justify-between gap-3 py-3'>
          <span>
            <span className='text-st-fg block text-sm font-medium'>Fill the screen</span>
            <span className='text-st-muted block text-xs'>
              Notebook pages open as wide as the screen, without grey side margins.
            </span>
          </span>
          <input
            checked={fillScreen}
            className='accent-st-fg h-5 w-5'
            type='checkbox'
            onChange={(event) => saveNotebookFillScreen(event.target.checked)}
          />
        </label>
        <label className='flex min-h-11 cursor-pointer items-center justify-between gap-3 py-3'>
          <span>
            <span className='text-st-fg block text-sm font-medium'>Pen shortcuts button</span>
            <span className='text-st-muted block text-xs'>
              The floating button on the board. The S Pen side button still opens the menu.
            </span>
          </span>
          <input
            checked={!hidePenShortcuts}
            className='accent-st-fg h-5 w-5'
            type='checkbox'
            onChange={(event) => saveHidePenShortcuts(!event.target.checked)}
          />
        </label>
      </div>
    </Surface>
  );
}
