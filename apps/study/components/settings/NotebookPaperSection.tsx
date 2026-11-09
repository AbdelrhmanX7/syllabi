import type { PaperSpacingPreset } from '@repo/whiteboard-core';
import type { BoardThemeSetting } from '@/lib/notebooks/board-theme';

import {
  GRID_SPACING_PRESETS,
  LINED_SPACING_PRESETS,
  PAPER_SPACING_MM_MAX,
  PAPER_SPACING_MM_MIN,
} from '@repo/whiteboard-core';

import { Slider } from '@repo/ui';
import { useEffect } from 'react';

import { FilterChip, SectionTitle, Surface } from '@/components/ui/primitives';
import { ToggleRow } from '@/components/ui/Toggle';
import { saveBoardThemeSetting, useBoardThemeSetting } from '@/lib/notebooks/board-theme';
import { pushPaperSpacingToAccount, savePaperSpacingDefault, usePaperSpacingDefaults } from '@/lib/notebooks/paper-settings';
import { saveNotebookFillScreen, useNotebookFillScreen } from '@/lib/notebooks/fill-screen';
import { saveHidePenShortcuts, useHidePenShortcuts } from '@/lib/notebooks/pen-shortcuts-button';

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
  return (
    <div className='flex flex-col gap-3 py-3' data-paper-row={type}>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-st-fg text-sm font-medium'>{label}</p>
        <span className='text-st-muted text-xs tabular-nums'>
          {value === undefined ? 'Board default' : `${value.toFixed(1)} mm`}
        </span>
      </div>
      <div className='flex flex-wrap gap-2' role='group'>
        <FilterChip active={value === undefined} onClick={() => savePaperSpacingDefault(type, null)}>
          Default
        </FilterChip>
        {presets.map((preset) => (
          <FilterChip
            key={preset.id}
            active={value !== undefined && Math.abs(value - preset.mm) < 0.05}
            onClick={() => savePaperSpacingDefault(type, preset.mm)}
          >
            <span className='capitalize'>{preset.id}</span>
            <span className='text-st-muted text-xs tabular-nums'>{preset.mm} mm</span>
          </FilterChip>
        ))}
      </div>
      <Slider
        hideValue
        aria-label={`${label} spacing in millimetres`}
        color='primary'
        maxValue={PAPER_SPACING_MM_MAX}
        minValue={PAPER_SPACING_MM_MIN}
        size='sm'
        step={0.1}
        value={value ?? 7.9}
        onChange={(next) => savePaperSpacingDefault(type, Array.isArray(next) ? next[0] : next)}
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
          <FilterChip key={option.id} active={value === option.id} onClick={() => saveBoardThemeSetting(option.id)}>
            {option.label}
          </FilterChip>
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

  // Settings open → make sure the account (and so the AI) has this device's paper ruling.
  useEffect(() => pushPaperSpacingToAccount(0), []);

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
        <ToggleRow
          checked={fillScreen}
          hint='Notebook pages open as wide as the screen, without grey side margins.'
          label='Fill the screen'
          onChange={saveNotebookFillScreen}
        />
        <ToggleRow
          checked={!hidePenShortcuts}
          hint='The floating button on the board. The S Pen side button still opens the menu.'
          label='Pen shortcuts button'
          onChange={(on) => saveHidePenShortcuts(!on)}
        />
      </div>
    </Surface>
  );
}
