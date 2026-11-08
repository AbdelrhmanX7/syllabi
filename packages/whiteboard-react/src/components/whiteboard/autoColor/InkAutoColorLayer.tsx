import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Palette } from 'lucide-react';

import type { Canvas, FabricObject } from 'fabric';

import { InkAutoColorController } from './controller';
import { DEFAULT_INK_COLOR } from '../palette';
import { useWbStrings } from '../../../i18n/context';

import { inkClassKey } from './labels';
import { resolvePalette } from './recolor';

import type { AutoColorConfig, InkDebugEntry } from './model';
import type { InkClass } from './types';

export interface InkAutoColorLayerProps {
  canvas: Canvas | null;
  /** null / absent = off (nothing is captured or coloured). */
  config: AutoColorConfig | null | undefined;
  penColor: string;
  /** A handwriting tool (pen / brush / marker) is active. */
  inkTool: boolean;
  readOnly?: boolean;
  /** The board's history `commitNow` (one undo step per recolour batch). */
  commitHistory?: () => void;
}

const MENU_CLASSES: InkClass[] = ['heading', 'term', 'definition', 'formula', 'example', 'keypoint', 'plain'];

const isInkPath = (object: FabricObject) =>
  object.isType('Path') && (object as FabricObject & { globalCompositeOperation?: string }).globalCompositeOperation !== 'destination-out';

function selectedInkCount(canvas: Canvas): number {
  const active = canvas.getActiveObject();

  if (!active) return 0;
  const members = (active as unknown as { _objects?: FabricObject[] })._objects ?? [active];

  return members.filter(isInkPath).length;
}

/**
 * Auto-colour on the board: owns the controller for the canvas, shows the class menu while handwriting
 * is selected (pick a class = recolour + a correction the board remembers), and in debug mode a corner
 * list of the last words — recognised text, class, engine and latency.
 */
export function InkAutoColorLayer({ canvas, config, penColor, inkTool, readOnly, commitHistory }: InkAutoColorLayerProps) {
  const configRef = useRef(config);
  const penRef = useRef(penColor);
  const toolRef = useRef(inkTool);
  const commitRef = useRef(commitHistory);
  const controllerRef = useRef<InkAutoColorController | null>(null);
  const [rows, setRows] = useState<InkDebugEntry[]>([]);
  const [selected, setSelected] = useState(0);
  /** «Colour the page»: idle, running, or how many strokes the last run changed (shown briefly). */
  const [paint, setPaint] = useState<'idle' | 'running' | number>('idle');
  const enabled = Boolean(config) && !readOnly;
  const { t, dir } = useWbStrings();

  configRef.current = enabled ? (config ?? null) : null;
  penRef.current = penColor;
  toolRef.current = inkTool;
  commitRef.current = commitHistory;

  useEffect(() => {
    if (!canvas || !enabled) return;
    const controller = new InkAutoColorController({
      canvas,
      getConfig: () => configRef.current ?? null,
      getPenColor: () => penRef.current,
      isInkTool: () => toolRef.current,
      commitHistory: () => commitRef.current?.(),
      onDebug: (entries) => setRows(entries),
    });
    const observable = canvas as unknown as { on: (event: string, handler: () => void) => () => void };
    const sync = () => setSelected(selectedInkCount(canvas));
    const offs = ['selection:created', 'selection:updated', 'selection:cleared'].map((event) => observable.on(event, sync));

    controllerRef.current = controller;

    return () => {
      offs.forEach((off) => off());
      controller.dispose();
      controllerRef.current = null;
      setSelected(0);
    };
  }, [canvas, enabled]);

  useEffect(() => {
    if (typeof paint !== 'number') return;
    const timer = setTimeout(() => setPaint('idle'), 1_500);

    return () => clearTimeout(timer);
  }, [paint]);

  if (!enabled || !config) return null;
  const palette = resolvePalette(config.palette);
  const colorPage = async () => {
    const controller = controllerRef.current;

    if (!controller || paint === 'running') return;
    setPaint('running');
    const changed = await controller.colorAll().catch(() => 0);

    setPaint(changed);
  };

  return (
    <>
      {selected > 0 ? (
        <div
          aria-label={t('inkClass.menu')}
          className='pointer-events-auto absolute left-1/2 top-3 z-40 flex max-w-[calc(100%-24px)] -translate-x-1/2 gap-1 overflow-x-auto rounded-full border border-black/10 bg-white p-1 shadow-sm dark:border-white/10 dark:bg-neutral-900'
          data-ink-class-menu
          dir={dir}
          role='toolbar'
        >
          {MENU_CLASSES.map((cls) => (
            <button
              key={cls}
              className='flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-neutral-900 hover:bg-neutral-100 active:bg-neutral-200 dark:text-neutral-100 dark:hover:bg-neutral-800'
              type='button'
              onClick={() => void controllerRef.current?.overrideSelection(cls)}
            >
              <span
                aria-hidden
                className='h-3 w-3 shrink-0 rounded-full border border-black/20'
                style={{ background: palette[cls] ?? config.defaultInk ?? DEFAULT_INK_COLOR }}
              />
              {t(inkClassKey(cls))}
            </button>
          ))}
        </div>
      ) : null}
      {selected === 0 ? (
        <button
          aria-busy={paint === 'running'}
          className='pointer-events-auto absolute bottom-20 start-3 z-30 flex min-h-11 items-center gap-2 rounded-md border border-black/10 bg-white px-4 text-[14px] font-medium text-neutral-900 shadow-sm active:bg-neutral-100 disabled:opacity-70 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-100 dark:active:bg-neutral-800'
          data-ink-color-page
          dir={dir}
          disabled={paint === 'running'}
          type='button'
          onClick={() => void colorPage()}
        >
          {paint === 'running' ? (
            <Loader2 aria-hidden className='h-4 w-4 animate-spin' />
          ) : typeof paint === 'number' ? (
            <Check aria-hidden className='h-4 w-4' />
          ) : (
            <Palette aria-hidden className='h-4 w-4' />
          )}
          {paint === 'running'
            ? t('inkColor.running')
            : typeof paint === 'number'
              ? t(paint > 0 ? 'inkColor.done' : 'inkColor.nothing')
              : t('inkColor.page')}
        </button>
      ) : null}
      {config.debug && rows.length > 0 ? (
        <div
          aria-live='polite'
          className='pointer-events-none absolute bottom-20 left-3 z-30 w-64 rounded-xl border border-black/10 bg-white p-2 font-mono text-[11px] leading-tight text-neutral-900 shadow-sm dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-100'
          data-ink-autocolor-debug
          dir='ltr'
        >
          {rows.map((row) => (
            <div key={row.groupId} className='flex items-baseline gap-1.5 py-0.5'>
              <span className='min-w-0 flex-1 break-words' dir='auto'>
                {row.text || '∅'}
              </span>
              <span className='shrink-0 font-semibold' style={{ color: palette[row.cls] ?? undefined }}>
                {row.cls}
              </span>
              <span className='shrink-0 opacity-70'>
                {row.src} {row.engine}
                {row.script ? `/${row.script}` : ''} {row.recognizeMs}/{row.totalMs}ms
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
