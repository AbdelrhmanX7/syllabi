import type { InkClass } from '@repo/whiteboard-react/auto-color';

import { useState, useSyncExternalStore } from 'react';
import { SwatchPicker } from '@repo/ui';
import { DEFAULT_INK_PALETTE, INK_CLASSES } from '@repo/whiteboard-react/auto-color';

import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { ActionButton, FilterChip, SectionTitle, Surface } from '@/components/ui/primitives';
import { ToggleRow } from '@/components/ui/Toggle';
import { downloadInkModels, useInkModels } from '@/lib/ink/models';
import { nativeInkRecognizer } from '@/lib/ink/nativeRecognizer';
import { devicePhraseMemory } from '@/lib/ink/phrase-memory';
import { saveInkClassColor, saveInkSettings, useInkSettings } from '@/lib/ink/settings';

const CLASS_NAME: Record<InkClass, string> = {
  heading: 'Heading',
  term: 'Term',
  definition: 'Definition',
  formula: 'Formula / number',
  example: 'Example',
  keypoint: 'Key point',
  plain: 'Plain',
};

/** Swatches offered per class: each ≥ 4.5:1 on white paper, like the board's defaults. */
const SWATCHES = ['#3730a3', '#1d4ed8', '#0f766e', '#15803d', '#7e22ce', '#be185d', '#c2410c', '#b91c1c'];

const memory = devicePhraseMemory();
const memoryListeners = new Set<() => void>();
const subscribeMemory = (listener: () => void) => {
  memoryListeners.add(listener);

  return () => memoryListeners.delete(listener);
};

function ClassColorRow({ cls, value }: { cls: InkClass; value: string | null | undefined }) {
  const fallback = DEFAULT_INK_PALETTE[cls];
  const current = value === undefined ? fallback : value;
  return (
    <div className='flex flex-col gap-1 py-2' data-ink-class-row={cls}>
      <p className='text-sm font-medium' style={{ color: current ?? undefined }}>
        {CLASS_NAME[cls]}
      </p>
      <SwatchPicker
        colors={[{ value: null, label: `${CLASS_NAME[cls]}: keep the ink`, content: 'Aa' }, ...SWATCHES]}
        getLabel={(colour) => `${CLASS_NAME[cls]}: ${colour}`}
        label={`${CLASS_NAME[cls]} colour`}
        value={current}
        onChange={(colour) => saveInkClassColor(cls, colour === fallback ? undefined : colour)}
      />
    </div>
  );
}

/**
 * Settings → Auto-colour: colour handwriting by what it is (heading, term, formula…) as you write.
 * Off by default; only black ink is changed — a colour you pick yourself always wins.
 */
export function InkAutoColorSection() {
  const settings = useInkSettings();
  const models = useInkModels();
  const remembered = useSyncExternalStore(
    subscribeMemory,
    () => memory.size(),
    () => 0,
  );
  const supported = nativeInkRecognizer !== null;
  const [confirmForget, setConfirmForget] = useState(false);

  return (
    <Surface className='p-5'>
      <SectionTitle>
        Auto-colour
      </SectionTitle>
      <div className='divide-st-line divide-y'>
        <ToggleRow
          checked={settings.enabled}
          hint={
            supported
              ? 'Colours headings, terms, formulas, examples and key points as you write. Only black ink; your own colours stay.'
              : 'Needs the Android app: the handwriting is read on the tablet.'
          }
          label='Auto-colour handwriting'
          onChange={(enabled) => {
            saveInkSettings({ enabled });

            // Turning it on fetches the models straight away (once); the board waits for them.
            if (enabled && (models.state === 'missing' || models.state === 'failed')) void downloadInkModels();
          }}
        />
        {settings.enabled && supported && (
          <>
            <div className='flex min-h-11 items-center justify-between gap-3 py-3' data-ink-models={models.state}>
              <span>
                <span className='text-st-fg block text-sm font-medium'>Handwriting model (English)</span>
                <span className='text-st-muted block text-xs'>
                  {models.state === 'ready' && 'On this tablet — works offline.'}
                  {models.state === 'missing' && 'About 20 MB, downloaded once.'}
                  {models.state === 'unknown' && 'Checking…'}
                  {models.state === 'failed' && 'Download failed — check the connection and try again.'}
                  {models.state === 'downloading' && `Downloading… ${Math.round(models.progress * 100)}%`}
                </span>
                {models.state === 'downloading' && (
                  <span className='bg-st-raised mt-2 block h-1.5 w-full overflow-hidden rounded-full'>
                    <span
                      className='bg-st-accent block h-full transition-[width]'
                      style={{ width: `${Math.round(models.progress * 100)}%` }}
                    />
                  </span>
                )}
              </span>
              {(models.state === 'missing' || models.state === 'failed') && (
                <ActionButton
                  className='min-h-9 shrink-0 px-3 text-xs'
                  variant='primary'
                  onClick={() => void downloadInkModels()}
                >
                  Download
                </ActionButton>
              )}
            </div>
            <div className='flex flex-col gap-2 py-3'>
              <p className='text-st-fg text-sm font-medium'>When</p>
              <div className='flex flex-wrap gap-2' role='group'>
                <FilterChip active={settings.when === 'live'} onClick={() => saveInkSettings({ when: 'live' })}>
                  While I write
                </FilterChip>
                <FilterChip active={settings.when === 'manual'} onClick={() => saveInkSettings({ when: 'manual' })}>
                  Only when I tap “Colour the page”
                </FilterChip>
              </div>
              <p className='text-st-muted text-xs'>The “Colour the page” button on the board colours the whole page either way.</p>
            </div>
            <div className='flex flex-col gap-2 py-3'>
              <p className='text-st-fg text-sm font-medium'>Engine</p>
              <div className='flex flex-wrap gap-2' role='group'>
                <FilterChip active={settings.engine === 'device'} onClick={() => saveInkSettings({ engine: 'device' })}>
                  On the tablet
                </FilterChip>
                <FilterChip
                  active={settings.engine === 'device+cloud'}
                  onClick={() => saveInkSettings({ engine: 'device+cloud' })}
                >
                  Tablet + cloud for unclear lines
                </FilterChip>
              </div>
              <p className='text-st-muted text-xs'>
                Cloud sends only the recognised text of a line the tablet is unsure about — never the ink.
              </p>
            </div>
            <div className='flex flex-col py-3'>
              <div className='flex items-center justify-between gap-3'>
                <p className='text-st-fg text-sm font-medium'>Colours</p>
                {Object.keys(settings.palette).length > 0 && (
                  <ActionButton
                    className='min-h-9 px-3 text-xs'
                    variant='ghost'
                    onClick={() => saveInkSettings({ palette: {} })}
                  >
                    Reset
                  </ActionButton>
                )}
              </div>
              {INK_CLASSES.map((cls) => (
                <ClassColorRow key={cls} cls={cls} value={settings.palette[cls]} />
              ))}
            </div>
            <div className='flex min-h-11 items-center justify-between gap-3 py-3'>
              <span>
                <span className='text-st-fg block text-sm font-medium'>Remembered corrections</span>
                <span className='text-st-muted block text-xs'>
                  {remembered === 0
                    ? 'Select coloured writing on the board and pick its kind — it is remembered here.'
                    : `${remembered} phrase${remembered === 1 ? '' : 's'} you corrected are coloured your way.`}
                </span>
              </span>
              {remembered > 0 && (
                <ActionButton
                  className='min-h-9 shrink-0 px-3 text-xs'
                  variant='danger'
                  onClick={() => setConfirmForget(true)}
                >
                  Forget
                </ActionButton>
              )}
              {confirmForget && (
                <ConfirmSheet
                  danger
                  confirmLabel='Forget'
                  title='Forget your corrections?'
                  onClose={() => setConfirmForget(false)}
                  onConfirm={() => {
                    memory.clear();
                    memoryListeners.forEach((listener) => listener());
                  }}
                >
                  The {remembered} phrase{remembered === 1 ? '' : 's'} you corrected go back to automatic colours. This
                  can&apos;t be undone.
                </ConfirmSheet>
              )}
            </div>
            <ToggleRow
              checked={settings.debug}
              hint='Shows what was read, its kind and the time for each word on the board. The performance log gets kinds and times only, never the text.'
              label='Debug overlay'
              onChange={(debug) => saveInkSettings({ debug })}
            />
          </>
        )}
      </div>
    </Surface>
  );
}
