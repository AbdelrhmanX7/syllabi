import type { Item, Page, Transcript } from '@/lib/api/types';
import type { CSSProperties, PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { YouTubePlayer } from './lib/youtube';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { FlashcardsButton } from './components/ExtractQuestionsButton';
import { NotebookPage } from './components/NotebookPage';
import { SummaryCard, TranscriptPanel } from './components/TranscriptPanel';
import { createPlaybackClock, usePlaybackValue } from './lib/playbackClock';
import {
  clampMiniPosition,
  clampNotesRatio,
  miniPlayerWidth,
  readNotesRatio,
  writeNotesRatio,
} from './lib/studyLayout';
import { createPage, getItem, getVideoTranscript, listPages, queueVideoTranscript } from './lib/api';
import { uploadPageDoc } from './lib/pageContent';
import { formatClock } from './lib/transcript';
import { decideTranscript } from './lib/videoTranscript';
import { loadYouTubeApi } from './lib/youtube';

import { AskTutorButton, useStudyBoardAi } from '@/features/tutor';
import { useSeekTarget } from '@/features/tutor/lib/seek';
import { canFetchCaptionsOnDevice, fetchCaptionsOnDevice, toTranscriptUpload } from '@/lib/youtube/captions';
import { requeueVideoTranscript, uploadVideoTranscript } from '@/lib/api/endpoints';
import { isStudyApiError } from '@/lib/api/errors';

export interface VideoStudyProps {
  item?: Item;
  itemId?: string;
  onBack?: () => void;
  /** Seek here once the player is ready; defaults to `?t=` (seconds) in the URL — tutor source chips. */
  startAtSec?: number;
}

type TranscriptState =
  | { kind: 'loading' }
  | { kind: 'ready'; transcript: Transcript }
  | { kind: 'pending' }
  | { kind: 'failed'; message: string };

const TRANSCRIPT_POLL_MS = 5_000;

/** `?t=` in seconds (also `1m20s` / `80s`), as tutor transcript chips link it. */
function readStartParam(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('t');

  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);

  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : null;
}
// The server summarises after the transcript lands; that took > 2 min locally (E2E 2026-10-05).
const SUMMARY_WAIT_MS = 300_000;

/**
 * With notes open: `split` = video column + notes (on a narrow / portrait screen: the video tab),
 * `mini` = notes with a small floating player, `focus` = notes alone.
 */
type StudyView = 'split' | 'mini' | 'focus';

const VIEW_LABELS: Record<'wide' | 'narrow', [StudyView, string][]> = {
  wide: [
    ['split', 'Split'],
    ['mini', 'Mini video'],
    ['focus', 'Notes only'],
  ],
  narrow: [
    ['split', 'Video'],
    ['focus', 'Notes'],
    ['mini', 'Notes + mini video'],
  ],
};

/** Side by side only on a wide landscape screen; else the video and the notes take turns. */
const WIDE_QUERY = '(min-width: 900px) and (orientation: landscape)';

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);

  query.addEventListener('change', onChange);

  return () => query.removeEventListener('change', onChange);
}

const readWide = () => window.matchMedia(WIDE_QUERY).matches;
const MINI_BAR_PX = 32;

/** A YouTube Canvas item: player + follow-along transcript + summary, with a notebook page beside it. */
export function VideoStudy({ item: initialItem, itemId, onBack, startAtSec }: VideoStudyProps) {
  const [item, setItem] = useState<Item | null>(initialItem ?? null);
  const [transcript, setTranscript] = useState<TranscriptState>({ kind: 'loading' });
  // The playing second is NOT state here: a 4 Hz tick would re-render the whole screen, notes board
  // included. Only the transcript and the time chips subscribe.
  const [clock] = useState(createPlaybackClock);
  const [tab, setTab] = useState<'transcript' | 'summary'>('transcript');
  const [notesPage, setNotesPage] = useState<Page | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [view, setView] = useState<StudyView>('split');
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [notesRatio, setNotesRatio] = useState(readNotesRatio);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const wide = useSyncExternalStore(subscribeWide, readWide, () => true);
  const areaRef = useRef<HTMLDivElement>(null);
  const playerBoxRef = useRef<HTMLDivElement>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const flushNotesRef = useRef<(() => Promise<void>) | null>(null);
  const miniPosRef = useRef<{ x: number; y: number } | null>(null);
  const startAtRef = useRef(startAtSec);

  startAtRef.current = startAtSec;
  // A lasso ask on the notes is about this video at the current second.
  const boardAi = useStudyBoardAi(notesPage?.id ?? null, item?.classId ?? null, () =>
    item ? { itemId: item.id, videoAt: { itemId: item.id, t: Math.floor(clock.get()) } } : {},
  );
  const id = initialItem?.id ?? itemId ?? null;
  const videoId = item?.video?.videoId ?? null;
  const itemLoaded = item !== null;

  useEffect(() => {
    if (!initialItem && itemId)
      void getItem(itemId)
        .then(setItem)
        .catch(() => setItem(null));
  }, [initialItem, itemId]);

  // Transcript: server copy if there is one; else the tablet's own caption fetch (uploaded so the
  // server can summarise it); else ask the server; poll while anything is pending.
  useEffect(() => {
    // Wait for the item: the on-device fetch needs its YouTube id.
    if (!id || !itemLoaded) return;
    let cancelled = false;
    let timer: number | undefined;
    const ctx = {
      deviceAvailable: canFetchCaptionsOnDevice(),
      triedDevice: false,
      queued: false,
      /** Captions fetched here are on screen: never replace them with a worse state. */
      deviceShown: false,
      now: 0,
      summaryUntil: Date.now() + SUMMARY_WAIT_MS,
    };
    const later = () => {
      timer = window.setTimeout(() => void step(), TRANSCRIPT_POLL_MS);
    };

    const step = async (): Promise<void> => {
      const dto = await getVideoTranscript(id).catch(() => null);

      if (cancelled) return;
      if (ctx.deviceShown && !(dto && dto.segments?.length > 0)) {
        if (Date.now() < ctx.summaryUntil) later();

        return;
      }
      const action = decideTranscript(dto, { ...ctx, now: Date.now() });

      switch (action.kind) {
        case 'show':
          setTranscript({ kind: 'ready', transcript: action.transcript });
          if (action.pollForSummary) later();

          return;
        case 'wait':
          setTranscript({ kind: 'pending' });
          later();

          return;
        case 'device': {
          ctx.triedDevice = true;
          setTranscript({ kind: 'pending' });
          const captions = videoId ? await fetchCaptionsOnDevice(videoId) : null;

          if (cancelled) return;
          if (!captions) return step();
          setTranscript({ kind: 'ready', transcript: { segments: captions.segments, summary: null, keyPoints: [] } });
          ctx.deviceShown = true;
          try {
            const upload = () => uploadVideoTranscript(id, toTranscriptUpload(captions));
            const result = (await upload().catch(async (error: unknown) => {
              // 409 CONFLICT = a concurrent write; one retry after a beat settles it.
              if (!isStudyApiError(error, 409)) throw error;
              await new Promise((resolve) => setTimeout(resolve, 1000));

              return upload();
            })) as { kept?: 'uploaded' | 'existing' };

            if (cancelled) return;
            ctx.summaryUntil = Date.now() + SUMMARY_WAIT_MS;
            // `existing` = the server kept its own, longer transcript: show that one now.
            if (result?.kept === 'existing') return step();
            later();
          } catch {
            // Refused (404 / validation): the captions stay on screen, the server tries ASR.
            await requeueVideoTranscript(id).catch(() => undefined);
          }

          return;
        }
        case 'queue':
          ctx.queued = true;
          setTranscript({ kind: 'pending' });
          await queueVideoTranscript(id).catch(() => undefined);
          if (!cancelled) later();

          return;
        case 'unavailable':
          setTranscript({ kind: 'failed', message: action.message });
      }
    };

    void step();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, videoId, itemLoaded]);

  // The player is created once per video and never re-parented (moving an iframe reloads it): its box
  // is laid over the layout's video slot, or floats as the mini player.
  useEffect(() => {
    if (!videoId || !playerHostRef.current) return;
    let disposed = false;
    let interval: number | undefined;
    const mount = document.createElement('div');

    playerHostRef.current.replaceChildren(mount);
    loadYouTubeApi()
      .then((YT) => {
        if (disposed) return;
        playerRef.current = new YT.Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: () => {
              const start = startAtRef.current ?? readStartParam();

              if (start !== null && start > 0) {
                playerRef.current?.seekTo(start, true);
                clock.set(start);
              }
              // 4 Hz; the clock notifies only on change, subscribers only when their cue / second changes.
              interval = window.setInterval(() => {
                const t = playerRef.current?.getCurrentTime();

                if (typeof t === 'number') clock.set(t);
              }, 250);
            },
            onError: (event) => setPlayerError(`YouTube player error ${event.data}`),
          },
        });
      })
      .catch((error: Error) => setPlayerError(error.message));

    return () => {
      disposed = true;
      window.clearInterval(interval);
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId, clock]);

  const seek = useCallback(
    (sec: number) => {
      playerRef.current?.seekTo(sec, true);
      playerRef.current?.playVideo();
      clock.set(sec);
    },
    [clock],
  );

  // A tutor transcript chip for THIS video, clicked in the Ask sheet on top of it.
  useSeekTarget(item?.id, seek);

  const openNotes = async () => {
    if (!item) return;
    setNotesError(null);
    try {
      const existing = (await listPages({ itemId: item.id })).find((page) => page.kind === 'note');

      setView(readWide() ? 'split' : 'focus');
      setNotesPage(
        existing ??
          (await createPage({ classId: item.classId, itemId: item.id, title: `Notes · ${item.title}`, kind: 'note' })),
      );
    } catch (error) {
      setNotesError(error instanceof Error ? error.message : 'Could not open notes');
    }
  };

  const closeNotes = async () => {
    const page = notesPage;

    setNotesPage(null);
    if (!page) return;
    await flushNotesRef.current?.().catch(() => undefined);
    await uploadPageDoc(page.id, page.version).catch(() => undefined);
  };

  const notesOpen = notesPage !== null;
  const videoVisible = !notesOpen || view === 'split';
  const notesVisible = notesOpen && (wide || view !== 'split');
  const splitWide = notesOpen && wide && view === 'split';
  const placement: 'slot' | 'mini' | 'hidden' = videoVisible ? 'slot' : view === 'mini' ? 'mini' : 'hidden';

  // Lay the player box over the slot / at the mini spot. Direct style writes: a divider drag or a
  // resize moves it without a React render.
  useLayoutEffect(() => {
    const box = playerBoxRef.current;
    const area = areaRef.current;

    if (!box || !area) return;
    const place = () => {
      const areaRect = area.getBoundingClientRect();
      let rect: { x: number; y: number; width: number; height: number } | null = null;

      if (placement === 'slot' && slotEl && slotEl.offsetWidth > 0) {
        const slot = slotEl.getBoundingClientRect();

        rect = { x: slot.left - areaRect.left, y: slot.top - areaRect.top, width: slot.width, height: slot.height };
      } else if (placement === 'mini') {
        const width = miniPlayerWidth(areaRect.width);
        const size = { width, height: Math.round((width * 9) / 16) + MINI_BAR_PX };
        // Bottom-left by default: the board keeps its page controls and pen buttons on the right.
        const start = miniPosRef.current ?? { x: 24, y: areaRect.height - size.height - 24 };
        const pos = clampMiniPosition(start.x, start.y, size, areaRect);

        miniPosRef.current = pos;
        rect = { ...pos, ...size };
      }
      box.style.visibility = rect ? 'visible' : 'hidden';
      if (!rect) return;
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    };
    const observer = new ResizeObserver(place);

    place();
    observer.observe(area);
    if (slotEl) observer.observe(slotEl);

    return () => observer.disconnect();
  }, [placement, slotEl, videoId]);

  const startMiniDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = playerBoxRef.current;
    const area = areaRef.current;

    if (!box || !area || (event.target as HTMLElement).closest('button')) return;
    const bar = event.currentTarget;
    const from = { x: event.clientX, y: event.clientY, left: box.offsetLeft, top: box.offsetTop };
    const move = (moveEvent: PointerEvent) => {
      const pos = clampMiniPosition(
        from.left + moveEvent.clientX - from.x,
        from.top + moveEvent.clientY - from.y,
        { width: box.offsetWidth, height: box.offsetHeight },
        { width: area.clientWidth, height: area.clientHeight },
      );

      miniPosRef.current = pos;
      box.style.left = `${pos.x}px`;
      box.style.top = `${pos.y}px`;
    };
    const end = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
    };

    bar.setPointerCapture(event.pointerId);
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  };

  // The divider writes the CSS variable while dragging (no render per move); the ratio is kept on release.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const area = areaRef.current;

    if (!area) return;
    const handle = event.currentTarget;
    const rect = area.getBoundingClientRect();
    let next = notesRatio;
    const move = (moveEvent: PointerEvent) => {
      next = clampNotesRatio(1 - (moveEvent.clientX - rect.left) / rect.width, rect.width);
      area.style.setProperty('--notes-ratio', String(next));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setNotesRatio(next);
      writeNotesRatio(next);
    };

    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const nudgeRatio = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? 0.03 : event.key === 'ArrowRight' ? -0.03 : 0;

    if (!step) return;
    event.preventDefault();
    const next = clampNotesRatio(notesRatio + step, areaRef.current?.clientWidth ?? 0);

    setNotesRatio(next);
    writeNotesRatio(next);
  };

  const ready = transcript.kind === 'ready' ? transcript.transcript : null;
  const sidePanel = (
    // Collapsed: just its tab bar, so the video takes the column.
    <div className={`flex min-h-0 flex-col ${transcriptOpen || !notesOpen ? 'flex-1' : 'shrink-0'}`}>
      <div className='flex items-center gap-1 border-b border-st-line px-3 pt-2'>
        {(['transcript', 'summary'] as const).map((key) => (
          <button
            key={key}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize ${
              tab === key && transcriptOpen
                ? 'border-st-clay-edge text-st-fg'
                : 'border-transparent text-st-muted hover:text-st-fg'
            }`}
            type='button'
            onClick={() => {
              setTab(key);
              setTranscriptOpen(true);
            }}
          >
            {key}
          </button>
        ))}
        <span className='flex-1' />
        <TimeChip clock={clock} />
        {notesOpen && (
          <button
            aria-expanded={transcriptOpen}
            className='mb-1 h-8 rounded-lg px-2 text-sm text-st-muted hover:bg-st-raised'
            type='button'
            onClick={() => setTranscriptOpen((open) => !open)}
          >
            {transcriptOpen ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {(transcriptOpen || !notesOpen) && (
        <div className='min-h-0 flex-1 overflow-y-auto'>
          {transcript.kind === 'loading' && <p className='p-4 text-sm text-st-muted'>Loading transcript…</p>}
          {transcript.kind === 'pending' && (
            <p className='p-4 text-sm text-st-muted'>Preparing the transcript. It appears here when ready.</p>
          )}
          {transcript.kind === 'failed' && <p className='p-4 text-sm text-st-muted'>{transcript.message}.</p>}
          {ready &&
            (tab === 'transcript' ? (
              <TranscriptPanel clock={clock} segments={ready.segments} onSeek={seek} />
            ) : (
              <SummaryCard keyPoints={ready.keyPoints} summary={ready.summary} />
            ))}
        </div>
      )}
    </div>
  );

  // The slot the player box is laid over; it reserves the video's space in the layout.
  const videoSlot = (
    <div
      ref={setSlotEl}
      className={`w-full bg-st-shadow ${notesOpen && !transcriptOpen ? 'min-h-0 flex-1' : 'aspect-video shrink-0'}`}
    >
      {!videoId && (
        <div className='flex h-full items-center justify-center text-sm text-white/70'>
          {item ? 'This item has no YouTube video.' : 'Loading…'}
        </div>
      )}
    </div>
  );
  const playerErrorNote = playerError && <p className='px-4 py-2 text-sm text-st-danger'>{playerError}</p>;

  return (
    <div className='flex h-full min-h-0 flex-col bg-st-bg text-st-fg'>
      <header className='flex items-center gap-3 border-b border-st-line px-4 py-3'>
        {onBack && (
          <button
            className='h-10 rounded-lg px-3 text-sm hover:bg-st-raised'
            type='button'
            onClick={onBack}
          >
            Back
          </button>
        )}
        <h1 className='min-w-0 flex-1 truncate text-base font-semibold'>{item?.title ?? 'Video'}</h1>
        {notesError && <span className='text-sm text-st-danger'>{notesError}</span>}
        {notesOpen && (
          <div className='flex shrink-0 rounded-lg bg-st-raised/70 p-0.5' role='group'>
            {VIEW_LABELS[wide ? 'wide' : 'narrow'].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={view === key}
                className={`h-9 rounded-md border-2 px-3 text-sm font-medium ${
                  view === key
                    ? 'border-st-clay-edge bg-st-surface text-st-fg'
                    : 'border-transparent text-st-muted hover:text-st-fg'
                }`}
                type='button'
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {item && (
          <AskTutorButton
            classId={item.classId}
            context={() => ({ itemId: item.id, videoAt: { itemId: item.id, t: Math.floor(clock.get()) } })}
            contextLabel={() => `${item.title} · at ${formatClock(clock.get())}`}
            label='Ask about this moment'
          />
        )}
        {item && (
          <FlashcardsButton
            classId={item.classId}
            disabledReason={transcript.kind === 'ready' ? null : 'Available once the transcript is ready'}
            source={{ itemId: item.id }}
          />
        )}
        <button
          className='h-10 rounded-st border-2 border-st-accent-lip bg-st-accent px-4 text-sm font-medium text-st-accent-fg hover:bg-st-accent/90 disabled:opacity-50 shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
          disabled={!item}
          type='button'
          onClick={notesPage ? closeNotes : openNotes}
        >
          {notesPage ? 'Close notes' : 'Take notes'}
        </button>
      </header>
      <div
        ref={areaRef}
        className='relative flex min-h-0 flex-1 overflow-hidden'
        style={{ '--notes-ratio': clampNotesRatio(notesRatio, 0) } as CSSProperties}
      >
        <section
          className={
            !videoVisible
              ? 'hidden'
              : notesOpen
                ? `flex min-h-0 flex-col bg-st-surface ${splitWide ? 'min-w-[300px] shrink-0' : 'min-w-0 flex-1'}`
                : `flex min-h-0 min-w-0 flex-1 ${wide ? '' : 'flex-col'}`
          }
          style={splitWide ? { width: 'calc((1 - var(--notes-ratio)) * 100%)' } : undefined}
        >
          {notesOpen ? (
            <>
              {videoSlot}
              {playerErrorNote}
              {sidePanel}
            </>
          ) : (
            <>
              <div className={`flex flex-col ${wide ? 'min-w-0 flex-1 overflow-y-auto' : ''}`}>
                {videoSlot}
                {playerErrorNote}
              </div>
              <div
                className={`flex min-h-0 flex-col bg-st-surface ${
                  wide ? 'w-[400px] shrink-0 border-l border-st-line' : 'flex-1'
                }`}
              >
                {sidePanel}
              </div>
            </>
          )}
        </section>
        {splitWide && (
          // A focusable separator is the ARIA splitter pattern (arrow keys resize).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <div
            aria-label='Resize video and notes'
            aria-orientation='vertical'
            aria-valuemax={90}
            aria-valuemin={10}
            aria-valuenow={Math.round(notesRatio * 100)}
            className='group flex w-3 shrink-0 cursor-col-resize touch-none items-center justify-center border-x border-st-line bg-st-raised'
            role='separator'
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onKeyDown={nudgeRatio}
            onPointerDown={startResize}
          >
            <span className='h-10 w-1 rounded-full bg-st-muted group-hover:bg-st-ink/60' />
          </div>
        )}
        {notesPage && (
          <section className={notesVisible ? 'h-full min-w-0 flex-1' : 'hidden'}>
            <NotebookPage
              boardAi={boardAi}
              classId={item?.classId ?? null}
              flushRef={flushNotesRef}
              pageId={notesPage.id}
              pageTitle={notesPage.title}
            />
          </section>
        )}
        {videoId && (
          <div
            ref={playerBoxRef}
            className={`absolute z-20 flex flex-col overflow-hidden bg-st-shadow ${
              placement === 'mini' ? 'rounded-xl border-2 border-st-clay-edge shadow-clay' : ''
            }`}
          >
            <div
              className={
                placement === 'mini'
                  ? 'flex shrink-0 cursor-grab touch-none select-none items-center gap-1 bg-st-accent px-2 text-xs text-st-accent-fg'
                  : 'hidden'
              }
              style={{ height: MINI_BAR_PX }}
              onPointerDown={startMiniDrag}
            >
              <TimeChip clock={clock} />
              <span className='flex-1' />
              <button className='h-7 rounded px-2 hover:bg-st-accent/90' type='button' onClick={() => setView('split')}>
                Dock
              </button>
              <button className='h-7 rounded px-2 hover:bg-st-accent/90' type='button' onClick={() => setView('focus')}>
                Hide
              </button>
            </div>
            <div className='min-h-0 flex-1'>
              <div ref={playerHostRef} className='h-full w-full' />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The playing time; re-renders once a second, alone. */
function TimeChip({ clock }: { clock: ReturnType<typeof createPlaybackClock> }) {
  const sec = usePlaybackValue(clock, Math.floor);

  return <span className='px-2 text-xs tabular-nums text-st-muted'>{formatClock(sec)}</span>;
}

export default VideoStudy;
