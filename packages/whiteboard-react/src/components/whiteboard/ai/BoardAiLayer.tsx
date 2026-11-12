import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ActiveSelection } from 'fabric';
import { createPortal } from 'react-dom';
import { Loader2, Sparkles, Square, Spline, X } from 'lucide-react';

import type { Canvas, FabricObject } from 'fabric';

import { chatStorageKey } from './askChat';
import { BoardAiPanel } from './BoardAiPanel';
import { clampPanelPosition, clampPanelSize, placedPanelStyle, placedPanelWidth, readPanelPosition, safeLocalStorage, writePanelPosition } from './panelDrag';
import {
  AI_OBJECT_PROP,
  buildBlockObjects,
  buildGraphObjects,
  buildLayoutObjects,
  buildMarkerObjects,
  flattenObjectsToFile,
  objectsBounds,
  registerAiObjectPersistence,
  translateObjects,
} from './boardObjects';
import { layoutToPlacements, snapLayoutToLines } from './pageLayout';
import { BOARD_AI_COMMAND_EVENT, isBoardAiCommand } from './commands';
import { BOARD_BUDDY_REQUEST_EVENT, emitBoardBuddyState, isBoardBuddyRequest } from './buddy';
import { readConceptStyle, writeConceptStyle } from './conceptMap';
import {
  boundsOf,
  contentPixelBounds,
  detectInkLines,
  findFreeSpot,
  finishLasso,
  lassoPolygon,
  noticeSpot,
  placeBeside,
  planRegionRaster,
  polygonToPixels,
  sceneToScreen,
  screenToScene,
} from './lassoGeometry';
import { estimateHandStyle, inkSamplesFromObjects } from './handStyle';
import { buildHandwritingObjects } from './handwritingObjects';
import { readHandPrefs, writeHandPrefs } from './handwritingLayout';
import { boxToScene, markableQuestions } from './pageAnalysis';
import { canvasToJpegBlob, canvasToPngBlob, cropCanvas, ensureBoardFonts, onBoardFontsLate, prepareForVision } from './rasterize';
import { RemakeDissolveOverlay, RemakeDraftReview, RemakeReadyToast } from './RemakeDraftOverlay';
import { RemakeBoardGlow, RemakeStatusCard } from './RemakeGenerating';
import { remakeGeneratingInfo, sameGeneratingInfo } from './generatingState';
import { useRemakeDraft } from './useRemakeDraft';
import { remakeSnapshotLayers } from './remakeSnapshot';
import { buildOverlayObjects, composeOverlayPicture } from './typesetObjects';
import { clusterBoxes, clusterInk, parseTermsMap, placeBelowFree, planTermsMap, unionRect } from './termsMap';
import { buildTermsMapObjects } from './termsMapObjects';
import { checkCaptureRegion, groupInkLines, linesToClusters, parseStepCheck, pixelBoxToScene, placeStepMarks, stepCheckQuestion } from './stepCheck';
import { buildStepMarkObjects, isStepMark } from './stepCheckObjects';
import { parsePenPlan, planPenActions } from './penActions';
import { buildOccupancy, contentBlocks, findFreeBox } from './pageOccupancy';
import type { PxBox } from './pageOccupancy';
import { buildPenActionObjects } from './penActionObjects';
import { showPointerSprite } from './penPointer';
import { playObjectReveal, playPenTurn, playWriteOn } from './writeOn';
import type { WriteOnPlayback } from './writeOn';

import type { BoardAiPanelActions, CircleFollowUp, PanelSession } from './BoardAiPanel';
import type { PanelPlacement, PanelPoint, PanelSize } from './panelDrag';
import type { RemakeGeneratingInfo } from './generatingState';
import type { PlaceOverlay } from './useRemakeDraft';
import type { PageBackgroundInfo, SnapshotLayers } from './remakeSnapshot';
import type { BoardAiCommand } from './commands';
import type { StepCheckResult } from './stepCheck';
import type { BoardAiBlock, BoardAiService, ConceptMap, ConceptMapStyle, NormalizedBox, PageAnalysis, PenPageVerdict, SceneRect, ScenePoint } from './types';
import type { WhiteboardTool } from '../types';

import { measureChromeInsets } from '../utils/chromeInsets';
import { useWbStrings } from '../../../i18n/context';

/**
 * Everything the board AI does ON the board: the one-shot lasso, the marching-ants outline, the
 * «Ask AI» chip over a selection, the panel, and inserting answers as objects.
 *
 * The lasso is an overlay ABOVE the canvas that swallows its pointers, so a lasso can never leave
 * ink — and it exists only while the «Ask AI» mode is armed. A circle drawn with the pen is
 * always ink. After one lasso the overlay goes away and the teacher's nib is exactly as it was.
 */

export interface BoardAiRenderRequest {
  /** Scene rectangle to render. */
  region: SceneRect;
  /** Output px per scene unit. */
  scale: number;
  /** Only these objects, on white (the selection chip). Absent = page background + all ink. */
  objects?: FabricObject[];
  /** `background`: the page background only (PDF/image page, pinned pictures, grid) — no objects. */
  layers?: SnapshotLayers;
}

/** What the layer needs from the editor — rendering, page geometry, and a new page. */
export interface BoardAiEditorBridge {
  renderRegion: (request: BoardAiRenderRequest) => Promise<HTMLCanvasElement | null>;
  /** `backgroundOnly`: the frame of the background alone (ink outside it does not widen it). */
  getPageBounds: (options?: { backgroundOnly?: boolean }) => Promise<SceneRect | null>;
  /** What sits behind the page's ink — decides whether a remake may drop the ink. */
  getPageBackgroundInfo?: () => PageBackgroundInfo | null;
  /**
   * The page SHEET in scene units for «Explain on my page»: in the continuous layout the stacked
   * sheet under scene `y` (the current page's when omitted); null in the paged layout, where the
   * export bounds are the sheet.
   */
  getPageSheet?: (sceneY?: number) => SceneRect | null;
  getPageId: () => string | null;
  insertPageAfterCurrent: () => Promise<boolean>;
  /** Adds an IMAGE page (a picture background, like a PDF page) right after the current one. */
  insertImagePageAfterCurrent: (file: File) => Promise<boolean>;
  /**
   * «Similar copy» draft page: a blank page right after the current one, switched to, and TRANSIENT —
   * never saved, synced, published or exported until `keepDraftPage`. Null when it could not be made.
   */
  insertDraftPageAfterCurrent: () => Promise<string | null>;
  /** Makes the draft page an IMAGE page (locked picture background); false when the page is gone. */
  setDraftPageImage: (pageId: string, file: File) => Promise<boolean>;
  /** The teacher kept the draft: it becomes a real page of the board. */
  keepDraftPage: (pageId: string) => void;
  /** Removes the draft page; when it was on screen, lands on `returnToPageId`. */
  removeDraftPage: (pageId: string, returnToPageId: string | null) => Promise<void>;
  switchToPageId: (pageId: string) => Promise<void>;
  hasPage: (pageId: string) => boolean;
}

export interface BoardAiLayerProps {
  service: BoardAiService;
  canvas: Canvas | null;
  activeTool: WhiteboardTool;
  boardId?: string;
  penColor: string;
  penWidth: number;
  bridge: BoardAiEditorBridge;
  /** A toolbar press, as `{command, nonce}` so pressing the same button twice still fires. */
  command: { command: BoardAiCommand; nonce: number } | null;
  /** The page on screen — the draft overlay belongs to ITS page only. */
  currentPageId?: string | null;
  onLassoActiveChange?: (active: boolean) => void;
  /** The editor's selection bar carries «Ask AI» itself (as `ai-ask-selection`): no chip of our own. */
  hideSelectionChip?: boolean;
  /**
   * The «Similar copy» draft's generating state, for the editor: hide the board chrome while it is made
   * on screen, and mark its page in the page list. `null` = no draft.
   */
  onRemakeStateChange?: (info: RemakeGeneratingInfo | null) => void;
}

const DASH_STYLE_ID = 'wb-ai-ants-style';
/** The server takes 200 regions: the student's ink groups first, the rest for printed blocks. */
const PEN_MAX_INK_REGIONS = 160;
const PEN_MAX_PRINT_REGIONS = 40;
const BUDDY_INK = '#3b5bdb';
/** How long the buddy's temporary marks (and its pointers) stay before they fade. */
const BUDDY_MARKS_MS = 40_000;

interface BuddyMarks {
  objects: FabricObject[];
  playback: WriteOnPlayback | null;
  pointers: Array<() => void>;
  pageId: string | null;
  vpt: number[];
}

function ensureAntsStyle() {
  if (typeof document === 'undefined' || document.getElementById(DASH_STYLE_ID)) return;

  const style = document.createElement('style');

  style.id = DASH_STYLE_ID;
  style.textContent = '@keyframes wb-ai-ants { to { stroke-dashoffset: -16; } } .wb-ai-ants { animation: wb-ai-ants 0.6s linear infinite; }';
  document.head.appendChild(style);
}

/** An image block with a remote `src` → the same block with the picture inlined as a data URL. */
async function localiseImageBlock(block: Extract<BoardAiBlock, { type: 'image' }>): Promise<BoardAiBlock> {
  if (block.src.startsWith('data:')) return block;

  try {
    const blob = await (await fetch(block.src)).blob();
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();

      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });

    return dataUrl ? { ...block, src: dataUrl } : block;
  } catch {
    return block;
  }
}

const viewportOf = (canvas: Canvas) => [...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])];

/** Readable on white: the teacher's pen colour unless it is too light to read (yellow/white nibs). */
function readableInk(color: string): string {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];

  if (!hex) return '#18204a';

  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;

  return luminance > 0.6 ? '#18204a' : color;
}

interface LassoOverlayProps {
  mode: 'free' | 'rect';
  onModeChange: (mode: 'free' | 'rect') => void;
  onFinish: (points: Array<{ clientX: number; clientY: number }>, mode: 'free' | 'rect') => void;
  onCancel: () => void;
}

function LassoOverlay({ mode, onModeChange, onFinish, onCancel }: LassoOverlayProps) {
  const { t, dir } = useWbStrings();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<number | null>(null);
  const penSeenRef = useRef(false);
  const pointsRef = useRef<Array<{ clientX: number; clientY: number }>>([]);
  const frameRef = useRef<number | null>(null);
  const [path, setPath] = useState<string>('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const redraw = useCallback(() => {
    frameRef.current = null;

    const root = rootRef.current;
    const points = pointsRef.current;

    if (!root || points.length === 0) {
      setPath('');

      return;
    }

    const rect = root.getBoundingClientRect();
    const local = points.map((p) => ({ x: p.clientX - rect.left, y: p.clientY - rect.top }));

    if (mode === 'rect') {
      const first = local[0]!;
      const last = local[local.length - 1]!;

      setPath(`M${first.x},${first.y} H${last.x} V${last.y} H${first.x} Z`);
    } else {
      setPath(`M${local.map((p) => `${p.x},${p.y}`).join(' L')}`);
    }
  }, [mode]);

  const schedule = () => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(redraw);
  };

  const reset = () => {
    pointerRef.current = null;
    pointsRef.current = [];
    setPath('');
  };

  return (
    <div
      ref={rootRef}
      aria-label={t('ai.lasso.aria')}
      className='absolute inset-0 z-[15] cursor-crosshair'
      style={{ touchAction: 'none' }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={reset}
      onPointerDown={(event) => {
        if (pointerRef.current !== null) {
          // A second finger mid-lasso: the teacher is pinching, not circling.
          reset();

          return;
        }

        if (event.pointerType === 'pen') penSeenRef.current = true;
        // Palm on the glass while the pen is in use.
        if (event.pointerType === 'touch' && penSeenRef.current) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pointerRef.current = event.pointerId;
        pointsRef.current = [{ clientX: event.clientX, clientY: event.clientY }];
        schedule();
      }}
      onPointerMove={(event) => {
        if (pointerRef.current !== event.pointerId) return;

        const native = event.nativeEvent;
        const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];

        for (const sample of samples.length ? samples : [native]) {
          pointsRef.current.push({ clientX: sample.clientX, clientY: sample.clientY });
        }

        schedule();
      }}
      onPointerUp={(event) => {
        if (pointerRef.current !== event.pointerId) return;

        const points = pointsRef.current;

        reset();
        onFinish(points, mode);
      }}
    >
      <svg aria-hidden className='pointer-events-none absolute inset-0 h-full w-full'>
        {path ? (
          <path
            className='wb-ai-ants'
            d={path}
            fill='rgba(253, 224, 71, 0.12)'
            stroke='#18204a'
            strokeDasharray='6 4'
            strokeLinejoin='round'
            strokeWidth={2}
          />
        ) : null}
      </svg>
      <div className='pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4'>
        <div
          className='border-sk border-ink bg-paper text-ink shadow-sk pointer-events-auto flex items-center gap-2 rounded-sm px-3 py-1.5 text-xs font-semibold'
          dir={dir}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Sparkles aria-hidden className='h-4 w-4' />
          <span>{mode === 'rect' ? t('ai.lasso.rectHint') : t('ai.lasso.freeHint')}</span>
          <span className='bg-ink/15 mx-1 h-4 w-px' />
          <button
            aria-pressed={mode === 'free'}
            className={`flex items-center gap-1 rounded-sm px-2 py-0.5 ${mode === 'free' ? 'bg-citrine' : ''}`}
            type='button'
            onClick={() => onModeChange('free')}
          >
            <Spline aria-hidden className='h-3.5 w-3.5' />
            {t('ai.lasso.free')}
          </button>
          <button
            aria-pressed={mode === 'rect'}
            className={`flex items-center gap-1 rounded-sm px-2 py-0.5 ${mode === 'rect' ? 'bg-citrine' : ''}`}
            type='button'
            onClick={() => onModeChange('rect')}
          >
            <Square aria-hidden className='h-3.5 w-3.5' />
            {t('ai.lasso.rect')}
          </button>
          <button aria-label={t('ai.cancel')} className='hover:bg-ink/5 rounded-full p-1' type='button' onClick={onCancel}>
            <X aria-hidden className='h-3.5 w-3.5' />
          </button>
        </div>
      </div>
    </div>
  );
}

export function BoardAiLayer({
  service,
  canvas,
  activeTool,
  boardId,
  penColor,
  penWidth,
  bridge,
  command,
  currentPageId = null,
  hideSelectionChip = false,
  onLassoActiveChange,
  onRemakeStateChange,
}: BoardAiLayerProps) {
  const { t, dir } = useWbStrings();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [lassoActive, setLassoActive] = useState(false);
  const [lassoMode, setLassoMode] = useState<'free' | 'rect'>(() => {
    try {
      return localStorage.getItem('wb-ai-lasso-mode') === 'rect' ? 'rect' : 'free';
    } catch {
      return 'free';
    }
  });
  const [session, setSession] = useState<PanelSession | null>(null);
  const sessionRef = useRef<PanelSession | null>(null);
  /**
   * «Circle new writing» in flight: the panel steps aside (hidden, still mounted) while the lasso is
   * armed, and the circled picture continues this thread. Cleared once the lasso is done or dropped.
   */
  const [circling, setCircling] = useState<{ followUp: CircleFollowUp; chatKey: string } | null>(null);
  const circlingRef = useRef<{ followUp: CircleFollowUp; chatKey: string } | null>(null);

  sessionRef.current = session;
  const [outline, setOutline] = useState<ScenePoint[] | null>(null);
  const [anchor, setAnchor] = useState<SceneRect | null>(null);
  const [panelPosition, setPanelPosition] = useState<React.CSSProperties | null>(null);
  /**
   * Where (and how big) the teacher put the panel — dragged, resized, or remembered from an earlier
   * drag; null = the automatic spot. What is shown is this placement with its header kept on screen.
   */
  const wantedSpotRef = useRef<PanelPlacement | null>(null);
  /** The panel element — portalled out of the layer, so it cannot be found under `rootRef`. */
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  /**
   * Where the panel is portalled: the fullscreen element when the board is fullscreen (anything
   * outside it is not drawn), else the body — above all the board chrome, so it can go anywhere.
   */
  const [panelHost, setPanelHost] = useState<Element | null>(null);
  /** The board's font, carried onto the portalled panel (it no longer inherits it). */
  const [panelFont, setPanelFont] = useState<string | undefined>(undefined);

  useEffect(() => {
    const pick = () => {
      setPanelHost(document.fullscreenElement ?? document.body);

      if (rootRef.current) setPanelFont(getComputedStyle(rootRef.current).fontFamily || undefined);
    };

    pick();
    document.addEventListener('fullscreenchange', pick);

    return () => document.removeEventListener('fullscreenchange', pick);
  }, []);
  /** A plain string sits under the top chrome; an insert's notice carries a spot clear of what it placed. */
  const [notice, setNotice] = useState<string | { text: string; style: React.CSSProperties } | null>(null);
  const [selectionChip, setSelectionChip] = useState<{ left: number; top: number } | null>(null);
  const [, setViewTick] = useState(0);
  const [storedStyle, setStoredStyle] = useState<ConceptMapStyle | null>(() => readConceptStyle(boardId));
  const analyzedRef = useRef<{ region: SceneRect; pageId: string | null } | null>(null);
  /** The page snapshot a remake reads — figures are cut from it, positions map onto its region. */
  const remakeSourceRef = useRef<{ canvas: HTMLCanvasElement; region: SceneRect; lines: NormalizedBox[] } | null>(null);
  /** The last insert had no room on screen and went under the existing content. */
  const placedBelowRef = useRef(false);
  const busyRef = useRef(false);
  /** «Map my terms» in flight: its status line, and how to stop it. */
  const [termsStatus, setTermsStatus] = useState<string | null>(null);
  const termsAbortRef = useRef<AbortController | null>(null);
  /** «Explain on my page»: what was selected when the panel opened (empty = the whole page). */
  const penSelectionRef = useRef<FabricObject[]>([]);
  const buddyMarksRef = useRef<BuddyMarks | null>(null);
  const buddyFadeRef = useRef<number | null>(null);
  const buddyAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    ensureAntsStyle();
    registerAiObjectPersistence();
  }, []);

  // Plex arrived only after an insert gave up waiting for it: re-measure the AI text on the page,
  // which was laid out with the fallback font's widths.
  useEffect(() => {
    if (!canvas) return;

    return onBoardFontsLate(() => {
      const visit = (object: FabricObject) => {
        const children = (object as unknown as { getObjects?: () => FabricObject[] }).getObjects?.();

        children?.forEach(visit);

        if ('initDimensions' in object && typeof (object as { initDimensions?: unknown }).initDimensions === 'function') {
          (object as unknown as { initDimensions: () => void }).initDimensions();
          object.setCoords();
        }
      };

      canvas.getObjects().filter((object) => (object as unknown as Record<string, unknown>).wbAi).forEach(visit);
      canvas.requestRenderAll();
    });
  }, [canvas]);

  useEffect(() => setStoredStyle(readConceptStyle(boardId)), [boardId]);

  useEffect(() => {
    onLassoActiveChange?.(lassoActive);
  }, [lassoActive, onLassoActiveChange]);

  useEffect(() => {
    if (!notice) return;

    const timer = setTimeout(() => setNotice(null), 4000);

    return () => clearTimeout(timer);
  }, [notice]);

  // Revoke preview URLs when a session ends.
  useEffect(() => {
    const url = session && 'previewUrl' in session ? session.previewUrl : null;

    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [session]);

  /** Canvas-element offset inside the layer, and CSS→canvas scale (normally 1). */
  const canvasFrame = useCallback(() => {
    const root = rootRef.current;
    const element = (canvas as unknown as { upperCanvasEl?: HTMLCanvasElement } | null)?.upperCanvasEl ?? canvas?.getElement();

    if (!root || !element || !canvas) return null;

    const rootRect = root.getBoundingClientRect();
    const canvasRect = element.getBoundingClientRect();

    return {
      rootRect,
      canvasRect,
      offsetX: canvasRect.left - rootRect.left,
      offsetY: canvasRect.top - rootRect.top,
      cssScale: canvas.getWidth() / (canvasRect.width || canvas.getWidth() || 1),
    };
  }, [canvas]);

  const sceneRectToLayer = useCallback(
    (rect: SceneRect): SceneRect | null => {
      const frame = canvasFrame();

      if (!frame || !canvas) return null;

      const vpt = viewportOf(canvas);
      const a = sceneToScreen({ x: rect.left, y: rect.top }, vpt);
      const b = sceneToScreen({ x: rect.left + rect.width, y: rect.top + rect.height }, vpt);

      return {
        left: a.x / frame.cssScale + frame.offsetX,
        top: a.y / frame.cssScale + frame.offsetY,
        width: (b.x - a.x) / frame.cssScale,
        height: (b.y - a.y) / frame.cssScale,
      };
    },
    [canvas, canvasFrame],
  );

  const closeSession = useCallback(() => {
    setSession(null);
    setOutline(null);
    setAnchor(null);
    setPanelPosition(null);
    wantedSpotRef.current = null;
  }, []);

  /** The panel floats in viewport pixels (portalled, `position: fixed`), so its room is the window. */
  const viewportArea = useCallback((): PanelSize => ({ width: window.innerWidth, height: window.innerHeight }), []);

  /** Shows the wanted placement with only the header kept on screen. */
  const fitPlacedPanel = useCallback(() => {
    const wanted = wantedSpotRef.current;

    if (!wanted || typeof window === 'undefined') return;

    const area = viewportArea();
    const sized = wanted.width !== undefined && wanted.height !== undefined ? { ...wanted, ...clampPanelSize({ width: wanted.width, height: wanted.height }, area) } : wanted;
    const next = placedPanelStyle(sized, area);

    setPanelPosition((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.width === next.width &&
      current.height === next.height &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [viewportArea]);

  const positionPanel = useCallback(
    (sceneAnchor: SceneRect | null) => {
      const root = rootRef.current;

      if (!root) return;

      const box = root.getBoundingClientRect();
      const { width, height } = box;
      // Where the teacher last dragged the panel wins over the automatic spot.
      const remembered = readPanelPosition(safeLocalStorage());

      wantedSpotRef.current = remembered;

      if (remembered) {
        fitPlacedPanel();

        return;
      }

      if (width < 640) {
        setPanelPosition({ left: box.left + 8, right: Math.max(8, window.innerWidth - box.right + 8), bottom: Math.max(8, window.innerHeight - box.bottom + 8), maxHeight: '72dvh' });

        return;
      }

      const size = { width: Math.min(384, width - 16), height: Math.min(520, height - 16) };
      const layerAnchor = sceneAnchor ? sceneRectToLayer(sceneAnchor) : null;
      const spot = layerAnchor ? placeBeside(layerAnchor, size, { width, height }, 16) : { left: 16, top: 72 };

      // Layer px → viewport px (the panel is fixed). Kept as the wanted spot (not stored) so a
      // rotation re-applies it and the header can never end up off screen.
      wantedSpotRef.current = { left: box.left + spot.left, top: box.top + spot.top };
      fitPlacedPanel();
    },
    [fitPlacedPanel, sceneRectToLayer],
  );

  const openAskSession = useCallback(
    async (
      rendered: HTMLCanvasElement,
      sceneBounds: SceneRect,
      polygon: ScenePoint[],
      source: 'lasso' | 'selection',
      pixelPolygon?: ScenePoint[],
      continued?: { followUp: CircleFollowUp; chatKey: string } | null,
    ) => {
      // What the model will read: white paper, dark ink, trimmed, big enough — see visionPrep.ts.
      const prepared = await prepareForVision(rendered, { polygon: pixelPolygon });
      const blob = await canvasToPngBlob(prepared.canvas);

      if (!blob) {
        setNotice(t('ai.layer.captureFailed'));

        return;
      }

      setOutline(polygon);
      setAnchor(sceneBounds);
      setSession({
        mode: 'ask',
        image: blob,
        previewUrl: URL.createObjectURL(blob),
        source,
        sent: { width: prepared.canvas.width, height: prepared.canvas.height, ...prepared.info },
        // A continued thread stays on the thread it came from, whatever page is on screen now.
        chatKey: continued?.chatKey ?? chatStorageKey(boardId, currentPageId ?? bridge.getPageId()),
        ...(continued ? { followUp: continued.followUp } : {}),
      });
      positionPanel(sceneBounds);
    },
    [boardId, bridge, currentPageId, positionPanel],
  );

  /** Header drag: place (header kept on screen), keep any dragged size, remember once the drag ends. */
  const movePanel = useCallback(
    (point: PanelPoint, _size: PanelSize, done: boolean) => {
      const previous = wantedSpotRef.current;

      wantedSpotRef.current = { ...(previous?.width !== undefined && previous.height !== undefined ? { width: previous.width, height: previous.height } : {}), left: point.left, top: point.top };
      fitPlacedPanel();

      if (done) {
        const area = viewportArea();
        const wanted = wantedSpotRef.current;
        const width = wanted.width ?? panelElementRef.current?.offsetWidth ?? placedPanelWidth(area.width);

        // Remember the spot as shown (clamped), not where the pointer overshot to.
        wantedSpotRef.current = { ...wanted, ...clampPanelPosition(wanted, width, area) };
        writePanelPosition(safeLocalStorage(), wantedSpotRef.current);
      }
    },
    [fitPlacedPanel, viewportArea],
  );

  /** Corner drag: the panel keeps its top-left and takes the dragged size (between the minimum and the screen). */
  const resizePanel = useCallback(
    (size: PanelSize, done: boolean) => {
      const element = panelElementRef.current;
      const box = element?.getBoundingClientRect();
      const previous = wantedSpotRef.current;
      const spot = previous ?? (box ? { left: box.left, top: box.top } : null);

      if (!spot) return;

      wantedSpotRef.current = { left: spot.left, top: spot.top, ...clampPanelSize(size, viewportArea()) };
      fitPlacedPanel();

      if (done) writePanelPosition(safeLocalStorage(), wantedSpotRef.current);
    },
    [fitPlacedPanel, viewportArea],
  );

  const handleLassoFinish = useCallback(
    async (clientPoints: Array<{ clientX: number; clientY: number }>, mode: 'free' | 'rect') => {
      const frame = canvasFrame();

      if (!canvas || !frame) return;

      const vpt = viewportOf(canvas);
      const scenePoints = clientPoints.map((p) =>
        screenToScene({ x: (p.clientX - frame.canvasRect.left) * frame.cssScale, y: (p.clientY - frame.canvasRect.top) * frame.cssScale }, vpt),
      );
      const zoom = vpt[0] || 1;
      const shape = finishLasso(scenePoints, { mode, minSize: 14 / zoom });

      if (!shape) return; // a tap — stay armed

      const continued = circlingRef.current;

      circlingRef.current = null;
      // One-shot: the overlay goes away, the nib was never touched.
      setLassoActive(false);

      if (busyRef.current) return;
      busyRef.current = true;

      try {
        const polygon = lassoPolygon(shape);
        const bounds = boundsOf(polygon);
        // Rendered generously (≥ 2.5× screen); prepareForVision trims and scales to what the model needs.
        const plan = planRegionRaster(bounds, { zoom, devicePixelRatio: window.devicePixelRatio || 1, minScreenFactor: 2.5, paddingScreenPx: 12 });
        const rendered = await bridge.renderRegion({ region: plan.region, scale: plan.scale });

        if (!rendered) {
          setNotice(t('ai.layer.captureFailed'));

          return;
        }

        await openAskSession(rendered, bounds, polygon, 'lasso', shape.kind === 'polygon' ? polygonToPixels(polygon, plan) : undefined, continued);
      } finally {
        busyRef.current = false;
      }
    },
    [bridge, canvas, canvasFrame, openAskSession],
  );

  const askAboutSelection = useCallback(async () => {
    if (!canvas || busyRef.current) return;

    const objects = canvas.getActiveObjects();

    if (objects.length === 0) return;

    const corners = objects.flatMap((object) => object.getCoords());
    const bounds = boundsOf(corners.map((p) => ({ x: p.x, y: p.y })));
    const zoom = viewportOf(canvas)[0] || 1;

    // An ActiveSelection renders its members in group space; drop it so each renders where it is.
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    busyRef.current = true;

    try {
      const plan = planRegionRaster(bounds, { zoom, devicePixelRatio: window.devicePixelRatio || 1, minScreenFactor: 2.5, paddingScreenPx: 12 });
      const rendered = await bridge.renderRegion({ region: plan.region, scale: plan.scale, objects });

      if (rendered) {
        const rect: SceneRect = plan.region;

        await openAskSession(rendered, bounds, [
          { x: rect.left, y: rect.top },
          { x: rect.left + rect.width, y: rect.top },
          { x: rect.left + rect.width, y: rect.top + rect.height },
          { x: rect.left, y: rect.top + rect.height },
        ], 'selection');
      }
    } finally {
      busyRef.current = false;
    }
  }, [bridge, canvas, openAskSession]);

  /**
   * «Map my terms»: the selected handwritten terms → ink clusters → the service's structure → a map
   * drawn below the selection in the owner's own ink (copies of their strokes, hand-drawn outlines
   * and arrows, linking phrases in their handwriting). The originals are never touched; the whole
   * map lands in one tick = one undo step.
   */
  const mapTerms = useCallback(async () => {
    if (!canvas || busyRef.current || !service.mapTerms) return;

    const selected = canvas.getActiveObjects().filter((object) => object.visible !== false);

    if (selected.length === 0) {
      setNotice(t('ai.terms.noInk'));

      return;
    }

    // Members of an ActiveSelection report group-relative boxes; dropped, each is where it is.
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    busyRef.current = true;

    const controller = new AbortController();

    termsAbortRef.current = controller;

    try {
      const rects = selected.map((object) => {
        object.setCoords();

        const rect = object.getBoundingRect();

        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      });
      // The owner's hand: from the selected ink first (that IS the style to match), else the page.
      const hand = estimateHandStyle(inkSamplesFromObjects(selected)) ?? estimateHandStyle(inkSamplesFromObjects(canvas.getObjects()));
      const heights = rects.map((rect) => rect.height).sort((a, b) => a - b);
      const letterHeight = hand?.letterHeight || (heights[heights.length >> 1] ?? 20) * 0.8 || 20;
      const clusters = clusterInk(rects, { letterHeight });
      const bounds = unionRect(rects);
      const zoom = viewportOf(canvas)[0] || 1;
      const raster = planRegionRaster(bounds, { zoom, devicePixelRatio: window.devicePixelRatio || 1, minScreenFactor: 2, maxEdge: 2000, paddingScreenPx: 12 });
      const rendered = await bridge.renderRegion({ region: raster.region, scale: raster.scale, objects: selected });
      const image = rendered ? await canvasToPngBlob(rendered) : null;

      if (!rendered || !image) {
        setNotice(t('ai.layer.captureFailed'));

        return;
      }

      const pageAtStart = bridge.getPageId();
      let raw: unknown = null;
      let failure: string | null = null;

      setTermsStatus(t('ai.terms.reading'));

      try {
        const stream = service.mapTerms(
          {
            image,
            imageSize: { width: rendered.width, height: rendered.height },
            clusters: clusterBoxes(clusters, raster.region),
            lang: 'en' as const,
          },
          controller.signal,
        );

        for await (const event of stream) {
          if (event.type === 'status') setTermsStatus(event.data);
          else if (event.type === 'terms_map') raw = event.data;
          else if (event.type === 'error') failure = event.data;

          if (event.type === 'done' || event.type === 'error') break;
        }
      } catch (error) {
        if (controller.signal.aborted) return;

        failure = error instanceof Error && error.message ? error.message : null;
      }

      if (controller.signal.aborted) return;

      const result = raw ? parseTermsMap(raw, clusters.map((cluster) => cluster.id)) : null;

      if (!result) {
        setNotice(failure ?? t('ai.terms.failed'));

        return;
      }

      setTermsStatus(t('ai.terms.drawing'));

      const plan = planTermsMap(result, new Map(clusters.map((cluster) => [cluster.id, cluster.rect])), { letterHeight });
      const built = await buildTermsMapObjects(plan, {
        sources: new Map(clusters.map((cluster) => [cluster.id, cluster.members.map((index) => selected[index]!)])),
        color: hand?.color ?? readableInk(penColor),
        strokeWidth: hand?.strokeWidth || Math.max(1, penWidth),
        hand,
        zoom,
        batch: `ai-${Date.now().toString(36)}`,
      });

      if (controller.signal.aborted || built.objects.length === 0) return;

      if (bridge.getPageId() !== pageAtStart) {
        setNotice(t('ai.layer.pageChanged'));

        return;
      }

      const occupied = canvas
        .getObjects()
        .filter((object) => object.visible !== false)
        .map((object) => object.getBoundingRect());
      const spot = placeBelowFree(bounds, { width: plan.width, height: plan.height }, occupied, letterHeight * 1.5);

      translateObjects(built.objects, spot.left, spot.top);

      // The write-on plays only when the map lands in view; off screen it would play to nobody.
      const host = rootRef.current;
      const vpt = viewportOf(canvas);
      const viewBottom = (canvas.getHeight() - (vpt[5] ?? 0)) / zoom;
      const playback = host && spot.top < viewBottom ? playObjectReveal(canvas, host, built.steps) : null;

      setTermsStatus(null);

      if (playback) await playback.done;

      if (bridge.getPageId() !== pageAtStart) {
        playback?.dispose();
        setNotice(t('ai.layer.pageChanged'));

        return;
      }

      // One tick: every add lands in the same idle snapshot → ONE undo step.
      canvas.add(...built.objects);
      canvas.renderAll();
      playback?.dispose();
      setNotice(t('ai.terms.added'));
    } finally {
      busyRef.current = false;
      termsAbortRef.current = null;
      setTermsStatus(null);
    }
  }, [bridge, canvas, penColor, penWidth, service, t]);

  const cancelMapTerms = useCallback(() => {
    termsAbortRef.current?.abort();
    termsAbortRef.current = null;
    setTermsStatus(null);
  }, []);

  useEffect(() => () => termsAbortRef.current?.abort(), []);

  /**
   * «Explain on my page»: opens the pen panel about the selection (when there is one) or the page.
   * The selection is remembered and dropped, so the capture renders each stroke where it is.
   */
  const openPenExplain = useCallback(() => {
    if (!canvas || !service.penPlan) return;

    const selected = canvas.getActiveObjects().filter((object) => object.visible !== false);

    penSelectionRef.current = selected;
    setLassoActive(false);
    setOutline(null);

    if (selected.length > 0) {
      const bounds = boundsOf(selected.flatMap((object) => object.getCoords()).map((p) => ({ x: p.x, y: p.y })));

      canvas.discardActiveObject();
      canvas.requestRenderAll();
      setAnchor(bounds);
      setSession({ mode: 'pen', source: 'selection' });
      positionPanel(bounds);

      return;
    }

    setAnchor(null);
    setSession({ mode: 'pen', source: 'page' });
    positionPanel(null);
  }, [canvas, positionPanel, service]);

  /**
   * The pen turn: the page sheet → JPEG + ink clusters → the service's plan → hand-drawn strokes,
   * a written note and the pointer, played on the overlay in order, then added in ONE tick = one undo
   * step. Cancelling (the signal) discards the overlay and nothing joins the board.
   */
  const penExplain = useCallback(
    async (
      question: string,
      signal: AbortSignal,
      onStatus: (line: string | null) => void,
      buddy?: { origin?: { x: number; y: number } },
    ): Promise<{ say?: string; added: number; verdict?: PenPageVerdict }> => {
      if (!canvas || !service.penPlan) throw Object.assign(new Error(t('ai.pen.unavailable')), { code: 'NOT_AVAILABLE' });

      const pageAtStart = bridge.getPageId();
      const onCanvas = new Set(canvas.getObjects());
      // The buddy asks about the live selection (if any); the panel about the one it remembered.
      const selected = buddy
        ? canvas.getActiveObjects().filter((object) => object.visible !== false && !(object as unknown as Record<string, unknown>)[AI_OBJECT_PROP])
        : penSelectionRef.current.filter((object) => onCanvas.has(object));
      const all = canvas.getObjects().filter((object) => object.visible !== false);
      const rectOf = (object: FabricObject): SceneRect => {
        object.setCoords();

        const rect = object.getBoundingRect();

        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      };
      const isInk = (object: FabricObject) =>
        object.isType('Path') &&
        !(object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] &&
        typeof object.stroke === 'string' &&
        (object as unknown as { globalCompositeOperation?: string }).globalCompositeOperation !== 'destination-out';
      // The sheet the model's coordinates live on: under the selection in the continuous layout, else
      // the current page's.
      const selectionBounds = selected.length ? unionRect(selected.map(rectOf)) : null;
      const sheet = bridge.getPageSheet?.(selectionBounds ? selectionBounds.top + selectionBounds.height / 2 : undefined) ?? (await bridge.getPageBounds());

      if (!sheet || sheet.width <= 0 || sheet.height <= 0) throw new Error(t('ai.layer.pageCaptureFailed'));

      const onSheet = (rect: SceneRect) =>
        rect.left < sheet.left + sheet.width && rect.left + rect.width > sheet.left && rect.top < sheet.top + sheet.height && rect.top + rect.height > sheet.top;
      const pageObjects = all.filter((object) => onSheet(rectOf(object)));
      const sourceInk = (selected.length ? selected : pageObjects).filter(isInk);

      if (sourceInk.length === 0 && !question) throw new Error(t('ai.pen.noInk'));

      const hand = estimateHandStyle(inkSamplesFromObjects(sourceInk)) ?? estimateHandStyle(inkSamplesFromObjects(pageObjects.filter(isInk)));
      const rects = sourceInk.map(rectOf);
      const heights = rects.map((rect) => rect.height).sort((a, b) => a - b);
      const letterHeight = hand?.letterHeight || (heights[heights.length >> 1] ?? sheet.height * 0.025) * 0.8 || sheet.height * 0.02;
      const clusters = clusterInk(rects, { letterHeight });

      onStatus(t('ai.pen.reading'));
      if (buddy) emitBoardBuddyState({ phase: 'reading' });

      // The whole sheet as the model sees it: a JPEG with the long edge at 1600 px.
      const scale = Math.min(4, 1600 / Math.max(sheet.width, sheet.height));
      const rendered = await bridge.renderRegion({ region: sheet, scale });
      const image = rendered ? await canvasToJpegBlob(rendered) : null;

      if (!rendered || !image) throw new Error(t('ai.layer.pageCaptureFailed'));
      if (signal.aborted) return { added: 0 };

      // What is really on the page, from its pixels (printed text and pictures too, not only ink):
      // notes go into true empty space, and printed blocks become regions the model can name.
      const px = rendered.width / sheet.width;
      let grid: ReturnType<typeof buildOccupancy> | null = null;

      try {
        const context = rendered.getContext('2d');
        const pixels = context?.getImageData(0, 0, rendered.width, rendered.height);

        grid = pixels ? buildOccupancy(pixels.data, rendered.width, rendered.height) : null;
      } catch {
        grid = null; // a tainted canvas: fall back to the ink boxes
      }

      // A page that reads as «full» everywhere (dark ruling, a photo background) tells us nothing.
      if (grid && grid.fill > 0.85) grid = null;

      const regionRects = new Map<string, SceneRect>(clusters.slice(0, PEN_MAX_INK_REGIONS).map((cluster) => [cluster.id, cluster.rect]));
      const regions = clusterBoxes(clusters.slice(0, PEN_MAX_INK_REGIONS), sheet);

      // Printed regions come from the page WITHOUT the ink, so a scribble across two columns does not
      // weld them into one.
      let printGrid: typeof grid = null;

      if (grid) {
        try {
          const paper = await bridge.renderRegion({ region: sheet, scale, layers: 'background' });
          const pixels = paper?.getContext('2d')?.getImageData(0, 0, paper.width, paper.height);

          printGrid = pixels && paper && paper.width === rendered.width ? buildOccupancy(pixels.data, paper.width, paper.height) : null;
        } catch {
          printGrid = null;
        }

        if (signal.aborted) return { added: 0 };
      }

      if (printGrid && printGrid.fill <= 0.85) {
        const inkRects = clusters.map((cluster) => cluster.rect);
        const tooBig = sheet.width * sheet.height * 0.3;
        let printed = 0;

        for (const block of contentBlocks(printGrid, { max: PEN_MAX_PRINT_REGIONS })) {
          const rect = { left: sheet.left + block.x / px, top: sheet.top + block.y / px, width: block.w / px, height: block.h / px };
          // Mostly the student's ink → already a region of its own.
          const inked = inkRects.reduce((sum, ink) => {
            const w = Math.min(rect.left + rect.width, ink.left + ink.width) - Math.max(rect.left, ink.left);
            const h = Math.min(rect.top + rect.height, ink.top + ink.height) - Math.max(rect.top, ink.top);

            return w > 0 && h > 0 ? sum + w * h : sum;
          }, 0);

          if (inked > rect.width * rect.height * 0.3 || rect.width * rect.height > tooBig) continue;

          const [box] = clusterBoxes([{ id: `p${(printed += 1)}`, rect } as (typeof clusters)[number]], sheet);

          if (!box || box.bbox.w <= 0 || box.bbox.h <= 0) continue;

          regionRects.set(box.id, rect);
          regions.push(box);
        }
      }

      const placed: PxBox[] = [];
      const reach = Math.max(rendered.width, rendered.height) * 0.35;
      // The part of the sheet on screen (clear of the top and bottom bars): marks go where they can be seen.
      const view = viewportOf(canvas);
      const viewZoom = view[0] || 1;
      const seen = {
        x: ((-view[4]! + 24) / viewZoom - sheet.left) * px,
        y: ((-view[5]! + 64) / viewZoom - sheet.top) * px,
        w: (Math.max(0, canvas.getWidth() - 48) / viewZoom) * px,
        h: (Math.max(0, canvas.getHeight() - 128) / viewZoom) * px,
      };
      const place = grid
        ? (wanted: SceneRect): SceneRect | null => {
            const want = { x: (wanted.left - sheet.left) * px, y: (wanted.top - sheet.top) * px, w: wanted.width * px, h: wanted.height * px };
            // A spot that is on screen gets its note on screen (or a bubble) — never ink out of sight.
            const inView = want.x >= seen.x && want.x <= seen.x + seen.w && want.y >= seen.y && want.y <= seen.y + seen.h;
            const box = inView ? findFreeBox(grid!, want, placed, reach, seen) : findFreeBox(grid!, want, placed, reach);

            if (!box) return null;

            placed.push(box);

            return { left: sheet.left + box.x / px, top: sheet.top + box.y / px, width: wanted.width, height: wanted.height };
          }
        : undefined;

      onStatus(t('ai.pen.planning'));
      if (buddy) emitBoardBuddyState({ phase: 'planning' });

      const raw = await service.penPlan(
        {
          image,
          imageSize: { width: rendered.width, height: rendered.height },
          clusters: regions,
          ...(question ? { question } : {}),
          lang: 'en' as const,
          v: 2 as const,
        },
        signal,
      );

      if (signal.aborted) return { added: 0 };

      const result = parsePenPlan(raw, Array.from(regionRects.keys()));

      if (!result) throw new Error(t('ai.pen.failed'));
      if (bridge.getPageId() !== pageAtStart) throw new Error(t('ai.layer.pageChanged'));

      onStatus(t('ai.pen.drawing'));
      if (buddy) emitBoardBuddyState({ phase: 'drawing' });

      const zoom = viewportOf(canvas)[0] || 1;
      const strokeWidth = hand?.strokeWidth || Math.max(1, penWidth);
      const plan = planPenActions(result, {
        page: sheet,
        clusters: regionRects,
        occupied: pageObjects.map(rectOf),
        letterHeight,
        strokeWidth,
        ...(place ? { place } : {}),
      });
      const built = await buildPenActionObjects(plan, {
        // The buddy writes in its own blue, so its marks never read as the student's ink.
        color: buddy ? BUDDY_INK : (hand?.color ?? readableInk(penColor)),
        strokeWidth,
        hand,
        zoom,
        batch: `ai-pen-${Date.now().toString(36)}`,
      });

      if (signal.aborted) return { added: 0 };
      if (bridge.getPageId() !== pageAtStart) throw new Error(t('ai.layer.pageChanged'));

      const host = rootRef.current;
      const pointers: Array<() => void> = [];
      const hostBox = host?.getBoundingClientRect();
      const from = buddy?.origin && hostBox ? { left: buddy.origin.x - hostBox.left, top: buddy.origin.y - hostBox.top } : undefined;
      const playback = host
        ? playPenTurn(canvas, host, built.steps, {
            linger: !!buddy,
            pencil: !!buddy,
            onPointer: (at, note) => {
              const layer = sceneRectToLayer({ left: at.x, top: at.y, width: 0, height: 0 });

              if (layer) {
                pointers.push(
                  showPointerSprite(host, { left: layer.left, top: layer.top }, note, buddy ? { ttlMs: BUDDY_MARKS_MS, pencil: true, ...(from ? { from } : {}) } : undefined),
                );
              }
            },
          })
        : null;
      const onAbort = () => playback?.skip();

      signal.addEventListener('abort', onAbort);

      try {
        if (playback) await playback.done;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }

      if (signal.aborted || bridge.getPageId() !== pageAtStart) {
        playback?.dispose();
        pointers.forEach((dispose) => dispose());

        if (!signal.aborted) throw new Error(t('ai.layer.pageChanged'));

        return { added: 0 };
      }

      if (buddy) {
        // Temporary: the marks stay on the overlay; «Keep» adds these same objects later.
        buddyMarksRef.current = { objects: built.objects, playback, pointers, pageId: pageAtStart, vpt: [...viewportOf(canvas)] };

        return { ...(result.say ? { say: result.say } : {}), ...(result.verdict ? { verdict: result.verdict } : {}), added: built.objects.length };
      }

      // One tick: every add lands in the same idle snapshot → ONE undo step.
      if (built.objects.length > 0) {
        canvas.add(...built.objects);
        canvas.renderAll();
      }

      playback?.dispose();

      return { ...(result.say ? { say: result.say } : {}), ...(result.verdict ? { verdict: result.verdict } : {}), added: built.objects.length };
    },
    [bridge, canvas, penColor, penWidth, sceneRectToLayer, service, t],
  );

  /** Ends the buddy's temporary marks (fade timer, «Clear», a new question, a page change). */
  const clearBuddyMarks = useCallback((announce: boolean) => {
    const marks = buddyMarksRef.current;

    if (buddyFadeRef.current !== null) window.clearTimeout(buddyFadeRef.current);
    buddyFadeRef.current = null;
    buddyMarksRef.current = null;

    if (!marks) return;

    marks.playback?.dispose();
    marks.pointers.forEach((dispose) => dispose());

    if (announce) emitBoardBuddyState({ phase: 'cleared' });
  }, []);

  const keepBuddyMarks = useCallback(() => {
    const marks = buddyMarksRef.current;

    if (!canvas || !marks) return;

    clearBuddyMarks(false);

    if (bridge.getPageId() !== marks.pageId || marks.objects.length === 0) {
      emitBoardBuddyState({ phase: 'cleared' });

      return;
    }

    // One tick → one undo step, exactly like the panel's «Explain on my page».
    canvas.add(...marks.objects);
    canvas.renderAll();
    emitBoardBuddyState({ phase: 'kept', added: marks.objects.length });
  }, [bridge, canvas, clearBuddyMarks]);

  const askBuddy = useCallback(
    async (question: string, origin?: { x: number; y: number }) => {
      buddyAbortRef.current?.abort();
      clearBuddyMarks(false);

      const controller = new AbortController();

      buddyAbortRef.current = controller;

      try {
        const { say, added, verdict } = await penExplain(question.trim(), controller.signal, () => undefined, origin ? { origin } : {});

        if (controller.signal.aborted) return;

        emitBoardBuddyState({ phase: 'done', ...(say ? { say } : {}), ...(verdict ? { verdict } : {}), marks: added });

        if (added > 0) buddyFadeRef.current = window.setTimeout(() => clearBuddyMarks(true), BUDDY_MARKS_MS);
      } catch (error) {
        if (controller.signal.aborted) return;

        const code = (error as { code?: unknown })?.code;

        emitBoardBuddyState({
          phase: 'error',
          message: error instanceof Error && error.message ? error.message : t('ai.pen.failed'),
          ...(typeof code === 'string' ? { code } : {}),
        });
      } finally {
        if (buddyAbortRef.current === controller) buddyAbortRef.current = null;
      }
    },
    [clearBuddyMarks, penExplain, t],
  );

  useEffect(() => {
    if (!canvas || !service.penPlan) return;

    const onRequest = (event: Event) => {
      const request = (event as CustomEvent<unknown>).detail;

      if (!isBoardBuddyRequest(request)) return;
      if (request.type === 'ask') void askBuddy(request.question, request.origin);
      else if (request.type === 'keep') keepBuddyMarks();
      else {
        buddyAbortRef.current?.abort();
        clearBuddyMarks(true);
      }
    };
    // The marks follow pan/zoom; the pointers (screen sprites) go once the view moves; a new page ends it all.
    const onRender = () => {
      const marks = buddyMarksRef.current;

      if (!marks) return;

      if (bridge.getPageId() !== marks.pageId) {
        clearBuddyMarks(true);

        return;
      }

      const vpt = viewportOf(canvas);

      if (marks.pointers.length > 0 && vpt.some((value, index) => Math.abs(value - (marks.vpt[index] ?? value)) > 0.5)) {
        marks.pointers.forEach((dispose) => dispose());
        marks.pointers = [];
      }

      marks.playback?.repaint?.();
    };

    window.addEventListener(BOARD_BUDDY_REQUEST_EVENT, onRequest);
    canvas.on('after:render', onRender as never);

    return () => {
      window.removeEventListener(BOARD_BUDDY_REQUEST_EVENT, onRequest);
      canvas.off('after:render', onRender as never);
    };
  }, [askBuddy, bridge, canvas, clearBuddyMarks, keepBuddyMarks, service.penPlan]);

  useEffect(
    () => () => {
      buddyAbortRef.current?.abort();
      clearBuddyMarks(false);
    },
    [clearBuddyMarks],
  );

  const renderPage = useCallback(
    async (maxEdge: number, minScreenFactor = 2, layers: SnapshotLayers = 'all') => {
      // Continuous layout: the CURRENT page's sheet (the one under the view's centre). The export
      // bounds there are the union of every hydrated page's ink in the stacked scene — the whole
      // document, shrunk until the handwriting could not be read.
      const sheet = bridge.getPageSheet?.() ?? null;
      const bounds = checkCaptureRegion(sheet, sheet ? null : await bridge.getPageBounds(layers === 'background' ? { backgroundOnly: true } : undefined));

      if (!bounds) return null;

      const plan = planRegionRaster(bounds, { zoom: 1, devicePixelRatio: 2, minScreenFactor, maxEdge, paddingScreenPx: 0 });
      const rendered = await bridge.renderRegion({ region: plan.region, scale: plan.scale, layers });

      return rendered ? { rendered, region: plan.region } : null;
    },
    [bridge],
  );

  /**
   * «Check this page»: takes the step marks off the given sheet (the current page's when none is
   * given). Found by their tag, not by a remembered reference — after a reload or a continuous-scroll
   * rehydrate the marks on the canvas are new instances.
   */
  const takeStepMarks = useCallback(
    (sheet?: SceneRect | null) => {
      if (!canvas) return [];

      const area = sheet ?? bridge.getPageSheet?.() ?? null;
      const marks = canvas.getObjects().filter((object) => {
        if (!isStepMark(object)) return false;
        if (!area) return true; // paged layout: the canvas holds the current page only

        const rect = object.getBoundingRect();

        return rect.left < area.left + area.width && rect.left + rect.width > area.left && rect.top < area.top + area.height && rect.top + rect.height > area.top;
      });

      if (marks.length > 0) {
        canvas.remove(...marks);
        canvas.requestRenderAll();
      }

      return marks;
    },
    [bridge, canvas],
  );

  const clearStepMarks = useCallback(() => takeStepMarks().length, [takeStepMarks]);

  /**
   * «Check this page» as a step checker: the CURRENT page only (its sheet in the continuous layout),
   * its handwriting grouped into lines (= steps), cropped to the written part → the vision model via
   * the pen-plan route with a grading question → one ✓/✗/! per step, anchored to the line it names,
   * added in ONE tick (one undo step). A re-run removes the previous marks first.
   */
  const runStepCheck = useCallback(
    async (
      signal: AbortSignal,
      onStatus: (line: string | null) => void,
      { sheet, startSheet, pageAtStart }: { sheet: SceneRect; startSheet: SceneRect | null; pageAtStart: string | null },
    ): Promise<{ result: StepCheckResult; marked: number; preview: Blob }> => {
      if (!canvas || !service.penPlan) throw Object.assign(new Error(t('ai.pen.unavailable')), { code: 'NOT_AVAILABLE' });

      const rectOf = (object: FabricObject): SceneRect => {
        object.setCoords();

        const rect = object.getBoundingRect();

        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      };
      const isInk = (object: FabricObject) =>
        object.visible !== false &&
        object.isType('Path') &&
        !(object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] &&
        typeof object.stroke === 'string' &&
        (object as unknown as { globalCompositeOperation?: string }).globalCompositeOperation !== 'destination-out';
      const onSheet = (rect: SceneRect) =>
        rect.left < sheet.left + sheet.width && rect.left + rect.width > sheet.left && rect.top < sheet.top + sheet.height && rect.top + rect.height > sheet.top;
      const pageInk = canvas.getObjects().filter((object) => isInk(object) && onSheet(rectOf(object)));
      const inkRects = pageInk.map(rectOf);

      if (inkRects.length === 0) throw new Error(t('ai.check.noInk'));

      const hand = estimateHandStyle(inkSamplesFromObjects(pageInk));
      const heights = inkRects.map((rect) => rect.height).sort((a, b) => a - b);
      const letterHeight = hand?.letterHeight || (heights[heights.length >> 1] ?? sheet.height * 0.025) * 0.8;
      const lines = groupInkLines(clusterInk(inkRects, { letterHeight }).map((cluster) => cluster.rect));

      // The sheet at up to 2048 px, cropped to its written part (the printed question included): the
      // model gets the handwriting at the best resolution the route keeps (it scales to 1600 px).
      const plan = planRegionRaster(sheet, { zoom: 1, devicePixelRatio: 2, minScreenFactor: 2, maxEdge: 2048, paddingScreenPx: 0 });
      let rendered = await bridge.renderRegion({ region: plan.region, scale: plan.scale });

      if (!rendered) throw new Error(t('ai.layer.pageCaptureFailed'));

      let region = plan.region;
      const pixels = rendered.getContext('2d')?.getImageData(0, 0, rendered.width, rendered.height).data;
      const box = pixels ? contentPixelBounds(pixels, rendered.width, rendered.height, { padding: 32, stride: 3 }) : null;

      if (box && box.width * box.height < rendered.width * rendered.height * 0.85) {
        region = pixelBoxToScene(region, rendered.width, box);
        rendered = cropCanvas(rendered, box);

        // The crop is redrawn sharper when it is small: its long edge up to the 1600 px the route
        // keeps (≤ 4× scene), so a few lines of working are not sent as a thumbnail.
        const sharper = Math.min(4, 1600 / Math.max(region.width, region.height));

        if (sharper > (rendered.width / region.width) * 1.15) {
          rendered = (await bridge.renderRegion({ region, scale: sharper })) ?? rendered;
        }
      }

      const image = await canvasToJpegBlob(rendered);

      if (!image) throw new Error(t('ai.layer.pageCaptureFailed'));
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const clusters = linesToClusters(lines, region);

      // Proof of what went up: one page, its size, and how many steps it was split into.
      console.info('[board-ai] check page', {
        pageId: pageAtStart,
        continuous: Boolean(startSheet),
        sheet,
        region,
        image: `${rendered.width}x${rendered.height}`,
        bytes: image.size,
        lines: clusters.length,
      });

      onStatus(t('ai.check.checking'));

      const raw = await service.penPlan(
        {
          image,
          imageSize: { width: rendered.width, height: rendered.height },
          clusters,
          question: stepCheckQuestion(clusters.length),
          lang: 'en' as const,
        },
        signal,
      );

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // The tags the model saw are the clustered lines, in order (a line wholly outside the crop is
      // impossible — the crop holds all the ink — so ids and indexes line up).
      const sent = new Set(clusters.map((cluster) => cluster.id));
      const result = parseStepCheck(raw, lines.filter((line) => sent.has(line.id)), region);

      if (!result) throw new Error(t('ai.check.failed'));

      // Paged layout: the page must still be the one checked. Continuous: scene coordinates are
      // global, so scrolling is fine as long as that sheet is still where it was.
      const still = startSheet ? bridge.getPageSheet?.(sheet.top + sheet.height / 2) : null;

      if (startSheet ? !still || still.top !== sheet.top : bridge.getPageId() !== pageAtStart) throw new Error(t('ai.layer.pageChanged'));

      // Continuous: the checked page may have been scrolled far enough to be dehydrated meanwhile.
      const live = new Set(canvas.getObjects());

      if (!pageInk.some((object) => live.has(object))) throw new Error(t('ai.layer.pageChanged'));

      const marks = placeStepMarks(result.steps, lines, sheet);
      const objects = buildStepMarkObjects(marks, lines, { batch: `ai-check-${Date.now().toString(36)}` });

      if (objects.length > 0) {
        canvas.add(...objects);
        canvas.requestRenderAll();
      }

      return { result, marked: objects.length, preview: image };
    },
    [bridge, canvas, service, t],
  );

  const checkSteps = useCallback(
    async (signal: AbortSignal, onStatus: (line: string | null) => void): Promise<{ result: StepCheckResult; marked: number; preview: Blob }> => {
      if (!canvas || !service.penPlan) throw Object.assign(new Error(t('ai.pen.unavailable')), { code: 'NOT_AVAILABLE' });

      onStatus(t('ai.check.capturing'));

      const pageAtStart = bridge.getPageId();
      const startSheet = bridge.getPageSheet?.() ?? null;
      const sheet = checkCaptureRegion(startSheet, startSheet ? null : await bridge.getPageBounds());

      if (!sheet) throw new Error(t('ai.layer.pageCaptureFailed'));

      // The previous run's marks come off first (the model must not see its own ✓/✗), and go back if
      // this run fails or is cancelled — a cancel never leaves the page with no result at all.
      const previous = takeStepMarks(sheet);

      try {
        return await runStepCheck(signal, onStatus, { sheet, startSheet, pageAtStart });
      } catch (failure) {
        const onCanvas = new Set(canvas.getObjects());
        const back = previous.filter((object) => !onCanvas.has(object));
        const samePage = startSheet ? bridge.getPageSheet?.(sheet.top + sheet.height / 2)?.top === sheet.top : bridge.getPageId() === pageAtStart;

        if (back.length > 0 && samePage && !canvas.getObjects().some(isStepMark)) {
          canvas.add(...back);
          canvas.requestRenderAll();
        }

        throw failure;
      }
    },
    [bridge, canvas, runStepCheck, service, t, takeStepMarks],
  );

  const snapshotOriginal = useCallback(async () => {
    // The image-edit model redraws what it sees: the page at full detail, capped at the 2048 px the
    // server normalises to anyway. Background only (no handwriting) unless the page IS its ink — see
    // remakeSnapshot.ts. The dissolve's soft original is made from this same snapshot.
    const page = await renderPage(2048, 3, remakeSnapshotLayers(bridge.getPageBackgroundInfo?.()));
    const blob = page ? await canvasToPngBlob(page.rendered) : null;

    return page && blob ? { blob, canvas: page.rendered } : null;
  }, [bridge, renderPage]);

  const placeOverlay = useCallback<PlaceOverlay>(
    async ({ pageId, result, request, picture, preview }) => {
      const blocks = result.layout?.blocks;

      if (!blocks?.length) return null;

      // The streamed-questions preview: laid out on the picture as if it were the page, never on the board.
      if (preview) {
        if (!picture) return null;

        const page = { left: 0, top: 0, width: picture.width, height: picture.height };
        const objects = await buildOverlayObjects(blocks, page, {
          handwriting: request.handwrittenText ? { penWidth } : null,
        });

        if (objects.length === 0) return null;

        const flat = composeOverlayPicture(picture.source, { width: picture.width, height: picture.height }, objects, page);

        return { source: flat, width: flat.width, height: flat.height, url: flat.toDataURL('image/jpeg', 0.85) };
      }

      if (!canvas) return null;

      // The draft page is loaded asynchronously after its picture is set: wait until it is on screen.
      for (let attempt = 0; attempt < 40 && bridge.getPageId() !== pageId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      if (bridge.getPageId() !== pageId) return null;

      const page = await bridge.getPageBounds();

      if (!page) return null;

      const objects = await buildOverlayObjects(blocks, page, {
        batch: `ai-${Date.now().toString(36)}`,
        handwriting: request.handwrittenText ? { penWidth } : null,
      });

      if (objects.length === 0 || bridge.getPageId() !== pageId) return null;

      let composed: { source: HTMLCanvasElement; width: number; height: number; url: string } | null = null;

      if (picture) {
        const flat = composeOverlayPicture(picture.source, { width: picture.width, height: picture.height }, objects, page);

        composed = { source: flat, width: flat.width, height: flat.height, url: flat.toDataURL('image/jpeg', 0.85) };
      }

      // Added in one tick: one undo step, saved with the page when the teacher keeps it.
      canvas.add(...objects);
      canvas.requestRenderAll();

      return composed;
    },
    [bridge, canvas, penWidth],
  );

  const remake = useRemakeDraft({ service, bridge, currentPageId, snapshotOriginal, notify: setNotice, placeOverlay });
  const remakeInfoRef = useRef<RemakeGeneratingInfo | null>(null);
  const remakeReportRef = useRef(onRemakeStateChange);
  const remakeInfo = remakeGeneratingInfo(remake.draft, remake.onPage);

  remakeReportRef.current = onRemakeStateChange;

  // Reported only when it changes: the editor re-renders the chrome on each report.
  useEffect(() => {
    if (sameGeneratingInfo(remakeInfoRef.current, remakeInfo)) return;

    remakeInfoRef.current = remakeInfo;
    remakeReportRef.current?.(remakeInfo);
  });

  // Unmounting (the board closes) brings the chrome back.
  useEffect(() => () => remakeReportRef.current?.(null), []);

  // The review card comes with the chrome: it sits above a bottom-docked toolbar, never under it.
  const reviewOnPage = Boolean(remake.draft && remake.onPage && remake.draft.phase === 'review');
  const [reviewInset, setReviewInset] = useState(0);

  useEffect(() => {
    if (!reviewOnPage) return;

    const measure = () => {
      const root = rootRef.current;

      if (!root) return;

      const box = root.getBoundingClientRect();

      setReviewInset(measureChromeInsets({ left: box.left, top: box.top, width: box.width, height: box.height }).bottom);
    };

    // After the chrome's slide-in has settled.
    const timer = setTimeout(measure, 220);

    measure();
    window.addEventListener('resize', measure);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', measure);
    };
  }, [reviewOnPage]);

  const openAnalyze = useCallback(async () => {
    if (busyRef.current) return;

    // A service that can mark up the page (Study): a STEP check of the handwriting, run by the panel
    // (it captures, so a re-run reads the page as it is then). Otherwise the teacher's question check.
    if (service.penPlan) {
      setLassoActive(false);
      setOutline(null);
      setAnchor(null);
      setSession({ mode: 'stepcheck', run: Date.now() });

      // Beside the writing (and the margin its marks go in), never on top of it.
      const written = canvas
        ? canvas
            .getObjects()
            .filter((object) => object.visible !== false && object.isType('Path') && !(object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] && object.isOnScreen())
            .map((object) => {
              const rect = object.getBoundingRect();

              return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            })
        : [];
      const inkBox = written.length ? unionRect(written) : null;
      const margin = inkBox ? Math.min(120, Math.max(48, inkBox.height * 0.15)) : 0;
      // The printed question runs wider than the ink: the anchor reaches to where a panel at the
      // screen's far edge would start, so the panel sits in the margin, not over the page text.
      const vpt = canvas ? viewportOf(canvas) : null;
      const zoom = vpt?.[0] || 1;
      const viewRight = canvas && vpt ? (canvas.getWidth() - (vpt[4] ?? 0)) / zoom : null;
      const right = inkBox ? Math.max(inkBox.left + inkBox.width + margin, viewRight !== null ? viewRight - (384 + 72) / zoom : -Infinity) : 0;

      positionPanel(inkBox ? { left: inkBox.left - margin, top: inkBox.top, width: right - (inkBox.left - margin), height: inkBox.height } : null);

      return;
    }

    busyRef.current = true;

    try {
      setLassoActive(false);

      const page = await renderPage(2048);

      if (!page) {
        setNotice(t('ai.layer.pageCaptureFailed'));

        return;
      }

      // Only the written part of the page goes up: margins cost the model resolution, not context.
      let { rendered, region } = page;
      const context = rendered.getContext('2d');
      const pixels = context?.getImageData(0, 0, rendered.width, rendered.height).data;
      const box = pixels ? contentPixelBounds(pixels, rendered.width, rendered.height, { padding: 32, stride: 3 }) : null;

      if (box && box.width * box.height < rendered.width * rendered.height * 0.85) {
        const scale = rendered.width / region.width;

        rendered = cropCanvas(rendered, box);
        region = { left: region.left + box.x / scale, top: region.top + box.y / scale, width: box.width / scale, height: box.height / scale };
      }

      const blob = await canvasToPngBlob(rendered);

      if (!blob) {
        setNotice(t('ai.layer.pageCaptureFailed'));

        return;
      }

      analyzedRef.current = { region, pageId: bridge.getPageId() };
      setOutline(null);
      setAnchor(null);
      setSession({ mode: 'analyze', image: blob, previewUrl: URL.createObjectURL(blob) });
      positionPanel(null);
    } finally {
      busyRef.current = false;
    }
  }, [bridge, canvas, positionPanel, renderPage, service.penPlan]);

  const openRemake = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;

    try {
      setLassoActive(false);

      // The WHOLE page, uncropped: the copy reproduces its margins and positions. Every «new page»
      // path reads the page WITHOUT handwriting (owner rule; blank/grid pages keep their ink — see
      // remakeSnapshot.ts), so the editable copy's text and cut-out figures come from the print only.
      const page = await renderPage(2048, 2, remakeSnapshotLayers(bridge.getPageBackgroundInfo?.()));
      const blob = page ? await canvasToPngBlob(page.rendered) : null;

      if (!page || !blob) {
        setNotice(t('ai.layer.pageCaptureFailed'));

        return;
      }


      // Line positions from a ≤800 px copy — cheap, and plenty for line-level boxes.
      const probe = page.rendered;
      const scale = Math.min(1, 800 / Math.max(probe.width, probe.height));
      const small = document.createElement('canvas');

      small.width = Math.max(1, Math.round(probe.width * scale));
      small.height = Math.max(1, Math.round(probe.height * scale));

      const smallCtx = small.getContext('2d');

      smallCtx?.drawImage(probe, 0, 0, small.width, small.height);

      const pixels = smallCtx?.getImageData(0, 0, small.width, small.height).data;
      const lines = pixels ? detectInkLines(pixels, small.width, small.height, { mergeGap: 3 }) : [];

      remakeSourceRef.current = { canvas: page.rendered, region: page.region, lines };
      setOutline(null);
      setAnchor(null);
      setSession({
        mode: 'remake',
        image: blob,
        previewUrl: URL.createObjectURL(blob),
        imageSize: { width: page.rendered.width, height: page.rendered.height },
        lines: lines.slice(0, 80),
      });
      positionPanel(null);
    } finally {
      busyRef.current = false;
    }
  }, [bridge, positionPanel, renderPage]);

  // A rotated tablet / resized window: re-apply the placement, so the header is back on screen and a
  // resized panel is no bigger than the new screen.
  useEffect(() => {
    if (!session) return;

    window.addEventListener('resize', fitPlacedPanel);
    window.addEventListener('orientationchange', fitPlacedPanel);

    return () => {
      window.removeEventListener('resize', fitPlacedPanel);
      window.removeEventListener('orientationchange', fitPlacedPanel);
    };
  }, [fitPlacedPanel, session]);

  /** The page's «Ask AI» chat, reopened to read or continue — no lasso, text follow-ups. */
  const openChat = useCallback(() => {
    setLassoActive(false);
    setOutline(null);
    setAnchor(null);
    setSession({ mode: 'chat', chatKey: chatStorageKey(boardId, currentPageId ?? bridge.getPageId()) });
    positionPanel(null);
  }, [boardId, bridge, currentPageId, positionPanel]);

  /** «Circle new writing»: arm the lasso without dropping the thread; the panel waits out of the way. */
  const circleMore = useCallback((followUp: CircleFollowUp) => {
    const current = sessionRef.current;
    const chatKey = current && (current.mode === 'ask' || current.mode === 'chat') ? current.chatKey : chatStorageKey(boardId, currentPageId ?? bridge.getPageId());
    const next = { followUp, chatKey };

    circlingRef.current = next;
    setCircling(next);
    setLassoActive(true);
  }, [boardId, bridge, currentPageId]);

  // The lasso dropped (Esc, the toolbar, a finished circle): the panel comes back as it was.
  useEffect(() => {
    if (lassoActive) return;

    circlingRef.current = null;
    setCircling(null);
  }, [lassoActive]);

  const openGenerate = useCallback(() => {
    setLassoActive(false);
    setOutline(null);
    setAnchor(null);
    setSession({ mode: 'generate' });
    positionPanel(null);
  }, [positionPanel]);

  const handleCommand = useCallback(
    (next: BoardAiCommand) => {
      switch (next) {
        case 'ai-lasso-once':
          setLassoActive((active) => {
            if (!active) {
              setSession(null);
              setOutline(null);
            }

            return !active;
          });
          break;
        case 'ai-ask-selection':
          void askAboutSelection();
          break;
        case 'ai-map-terms':
          void mapTerms();
          break;
        case 'ai-pen-explain':
          openPenExplain();
          break;
        case 'ai-generate':
          openGenerate();
          break;
        case 'ai-chat':
          openChat();
          break;
        case 'ai-analyze-page':
          void openAnalyze();
          break;
        case 'ai-remake-page':
          void openRemake();
          break;
        case 'ai-cancel':
          setLassoActive(false);
          cancelMapTerms();
          closeSession();
          break;
        default:
          break;
      }
    },
    [askAboutSelection, cancelMapTerms, closeSession, mapTerms, openAnalyze, openChat, openGenerate, openPenExplain, openRemake],
  );

  useEffect(() => {
    if (command) handleCommand(command.command);
    // The nonce is the trigger; the handler identity is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.nonce]);

  useEffect(() => {
    const onCommand = (event: Event) => {
      const value = (event as CustomEvent<{ command?: unknown }>).detail?.command;

      if (isBoardAiCommand(value)) handleCommand(value);
    };

    window.addEventListener(BOARD_AI_COMMAND_EVENT, onCommand);

    return () => window.removeEventListener(BOARD_AI_COMMAND_EVENT, onCommand);
  }, [handleCommand]);

  // Re-project the outline / chip when the board pans or zooms.
  useEffect(() => {
    if (!canvas || (!outline && activeTool !== 'select')) return;

    let frame: number | null = null;
    const last = viewportOf(canvas);
    const onRender = () => {
      const now = viewportOf(canvas);

      if (now.every((value, index) => value === last[index])) return;

      now.forEach((value, index) => {
        last[index] = value;
      });

      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          setViewTick((tick) => tick + 1);
        });
      }
    };

    canvas.on('after:render', onRender as never);

    return () => {
      canvas.off('after:render', onRender as never);

      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [activeTool, canvas, outline]);

  // «Ask AI» chip over a selection (select tool only).
  useEffect(() => {
    if (!canvas || activeTool !== 'select') {
      setSelectionChip(null);

      return;
    }

    let frame: number | null = null;
    const refresh = () => {
      frame = null;

      const objects = canvas.getActiveObjects();

      if (objects.length === 0) {
        setSelectionChip(null);

        return;
      }

      const bounds = boundsOf(objects.flatMap((object) => object.getCoords()).map((p) => ({ x: p.x, y: p.y })));
      const layer = sceneRectToLayer(bounds);

      if (!layer) return;

      const next = { left: layer.left + layer.width, top: Math.max(4, layer.top - 40) };

      setSelectionChip((current) => (current && Math.abs(current.left - next.left) < 1 && Math.abs(current.top - next.top) < 1 ? current : next));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(refresh);
    };
    const events = ['selection:created', 'selection:updated', 'selection:cleared', 'object:moving', 'object:scaling', 'object:modified', 'after:render'] as const;

    events.forEach((name) => canvas.on(name, schedule as never));
    schedule();

    return () => {
      events.forEach((name) => canvas.off(name, schedule as never));

      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [activeTool, canvas, sceneRectToLayer]);

  // --- inserting -----------------------------------------------------------------------------------

  /**
   * Places `objects` in the part of the view no chrome covers and adds them. Returns where the insert
   * notice should sit so it does not cover them (layer px), or null when nothing was added.
   */
  const commit = useCallback(
    (
      objects: FabricObject[],
      placeNear: SceneRect | null,
      {
        topAligned = false,
        reveal,
      }: {
        topAligned?: boolean;
        /**
         * Plays something over the placed area BEFORE the objects join the board (the handwriting
         * write-on), given how far they moved. Resolves with a cleanup run after they are drawn.
         */
        reveal?: (dx: number, dy: number) => Promise<(() => void) | void>;
      } = {},
    ): React.CSSProperties | null => {
      if (!canvas || objects.length === 0) return null;

      const vpt = viewportOf(canvas);
      const zoom = vpt[0] || 1;
      const fullView = { left: -(vpt[4] ?? 0) / zoom, top: -(vpt[5] ?? 0) / zoom, width: canvas.getWidth() / zoom, height: canvas.getHeight() / zoom };
      // The toolbar (however many rows it wrapped into), the title bar and the host's cluster cover
      // the board's edges: measured live (utils/chromeInsets), plus a margin, they are cut out of the
      // view so an inserted table's header row never lands under the toolbar.
      const frame = canvasFrame();
      const margin = 16;
      const chromePx = frame
        ? measureChromeInsets(
            { left: frame.canvasRect.left, top: frame.canvasRect.top, width: frame.canvasRect.width, height: frame.canvasRect.height },
            rootRef.current?.ownerDocument ?? document,
          )
        : { top: 56, right: 0, bottom: 0, left: 0 };
      const toScene = (px: number) => ((px + margin) * (frame?.cssScale ?? 1)) / zoom;
      const inset = { top: toScene(chromePx.top), right: toScene(chromePx.right), bottom: toScene(chromePx.bottom), left: toScene(chromePx.left) };
      const view = {
        left: fullView.left + inset.left,
        top: fullView.top + inset.top,
        width: Math.max(1, fullView.width - inset.left - inset.right),
        height: Math.max(1, fullView.height - inset.top - inset.bottom),
      };
      const bounds = objectsBounds(objects);
      let target: { left: number; top: number };

      if (placeNear) {
        const spot = placeBeside(
          { left: placeNear.left - view.left, top: placeNear.top - view.top, width: placeNear.width, height: placeNear.height },
          { width: bounds.width, height: bounds.height },
          { width: view.width, height: view.height },
          18 / zoom,
        );

        target = { left: spot.left + view.left, top: spot.top + view.top };
      } else {
        target = { left: 0, top: 0 };
      }

      // The chrome owns the top strip; an answer taller than the free area starts right under it
      // (the teacher scrolls down through it) instead of being centred off both edges.
      const topLimit = view.top;

      if (!placeNear || bounds.height > view.height) {
        target = {
          left: placeNear ? target.left : view.left + Math.max(0, (view.width - bounds.width) / 2),
          top: topAligned || bounds.height > view.height ? topLimit : view.top + (view.height - bounds.height) / 2,
        };
      }

      target.top = Math.max(target.top, topLimit);

      // Unanchored content (generate, corrected page) goes where the board is still empty when the
      // view has room for it; only a full view accepts an overlap.
      if (!placeNear) {
        const occupied = canvas
          .getObjects()
          .filter((object) => object.visible !== false)
          .map((object) => object.getBoundingRect());
        const spot = findFreeSpot(view, { width: bounds.width, height: bounds.height }, occupied, {
          minTop: topLimit,
          step: 24 / zoom,
          margin: 12 / zoom,
        });

        if (spot) {
          target = spot;
        } else {
          // The view is full: go under everything on screen rather than on top of the teacher's work.
          const below = occupied
            .filter((rect) => rect.left < view.left + view.width && rect.left + rect.width > view.left && rect.top < view.top + view.height)
            .reduce((bottom, rect) => Math.max(bottom, rect.top + rect.height), topLimit);

          target = { left: view.left + (view.width - bounds.width) / 2, top: below + 40 / zoom };
          placedBelowRef.current = true;
        }
      }

      const dx = target.left - bounds.left;
      const dy = target.top - bounds.top;

      translateObjects(objects, dx, dy);

      const addAll = () => {
        // One tick: every add lands in the same idle snapshot → ONE undo step.
        canvas.add(...objects);

        if (activeTool === 'select') {
          canvas.setActiveObject(objects.length === 1 ? objects[0]! : new ActiveSelection(objects, { canvas }));
        }
      };

      if (reveal) {
        const pageAtStart = bridge.getPageId();

        void reveal(dx, dy).then((cleanup) => {
          // The teacher left the page mid-animation: do not write the answer onto another page.
          if (bridge.getPageId() !== pageAtStart) {
            cleanup?.();
            setNotice(t('ai.layer.pageChanged'));

            return;
          }

          addAll();
          // Drawn synchronously so the real ink is on screen before the overlay goes: no blank frame.
          canvas.renderAll();
          cleanup?.();
        });
      } else {
        addAll();
        canvas.requestRenderAll();
      }

      const placed = sceneRectToLayer({ left: target.left, top: target.top, width: bounds.width, height: bounds.height });
      const rootRect = frame?.rootRect;

      if (!rootRect) return null;

      const layerChrome = measureChromeInsets(
        { left: rootRect.left, top: rootRect.top, width: rootRect.width, height: rootRect.height },
        rootRef.current?.ownerDocument ?? document,
      );

      return noticeSpot(rootRect.height, layerChrome, placed);
    },
    [activeTool, bridge, canvas, canvasFrame, sceneRectToLayer],
  );

  const batchId = () => `ai-${Date.now().toString(36)}`;

  const ink = readableInk(penColor);
  const handPrefs = useMemo<BoardAiPanelActions['handPrefs']>(
    () => ({ read: () => readHandPrefs(boardId), save: (prefs) => writeHandPrefs(boardId, prefs) }),
    [boardId],
  );
  const penStyle = useMemo<Partial<ConceptMapStyle>>(
    () => ({ nodeColors: [ink], edgeColor: ink, strokeWidth: Math.max(1.5, Math.min(6, penWidth || 2.5)) }),
    [ink, penWidth],
  );
  const saveStyle = useCallback(
    (style: ConceptMapStyle) => {
      writeConceptStyle(boardId, style);
      setStoredStyle(style);
    },
    [boardId],
  );

  const actions = useMemo<BoardAiPanelActions>(() => {
    const zoomOf = () => (canvas ? viewportOf(canvas)[0] || 1 : 1);

    return {
      insertBlocks: async (incoming: BoardAiBlock[], { withAnswers, handwriting }) => {
        // A generated picture is downloaded NOW and kept inside the board (data URL in the object),
        // so it works offline and outlives the URL it came from.
        const blocks = await Promise.all(incoming.map((block) => (block.type === 'image' ? localiseImageBlock(block) : block)));
        let spot: React.CSSProperties | null;
        let unmatched = false;

        if (handwriting && canvas) {
          // «Match my handwriting»: the teacher's slant / size / nib / colour from the ink on this page.
          const style = handwriting.matchHand ? estimateHandStyle(inkSamplesFromObjects(canvas.getObjects())) : null;

          unmatched = handwriting.matchHand && !style;

          const built = await buildHandwritingObjects(blocks, {
            zoom: zoomOf(),
            color: ink,
            withAnswers,
            // Written lines break at about 60 % of the board's width, like a teacher's column.
            widthPx: Math.max(320, Math.min(900, canvas.getWidth() * 0.6)),
            batch: batchId(),
            penWidth,
            style,
          });
          const host = rootRef.current;

          spot = commit(built.objects, anchor, {
            reveal: host
              ? async (dx, dy) => {
                  const playback = playWriteOn(canvas, host, built.strokes, { fill: built.fill, strokeWidth: built.strokeWidth, offset: { dx, dy } });

                  await playback.done;

                  return playback.dispose;
                }
              : undefined,
          });
        } else {
          const objects = await buildBlockObjects(blocks, { zoom: zoomOf(), color: ink, withAnswers, widthPx: 520, batch: batchId() });

          spot = commit(objects, anchor);
        }

        // The answer is on the board now; the panel would only sit on top of it.
        closeSession();
        // A generated picture has no text by design — the labels are the teacher's to write.
        const pictures = blocks.filter((block) => block.type === 'image');
        const hasPicture = pictures.length > 0;
        const labelled = pictures.some((block) => block.type === 'image' && block.labels?.length);
        const text = placedBelowRef.current
          ? t('ai.layer.addedBelow')
          : labelled
            ? t('ai.layer.imageWithLabels')
            : hasPicture
            ? t('ai.layer.imageNoLabels')
            : unmatched
              ? t('ai.layer.notEnoughInk')
              : t('ai.layer.added');

        setNotice(spot ? { text, style: spot } : text);
        placedBelowRef.current = false;
      },
      insertBlocksOnNewPage: async (blocks: BoardAiBlock[]) => {
        if (!(await bridge.insertPageAfterCurrent())) return;

        await new Promise((resolve) => requestAnimationFrame(resolve));

        const objects = await buildBlockObjects(blocks, { zoom: zoomOf(), color: ink, withAnswers: true, widthPx: 620, batch: batchId() });

        analyzedRef.current = null;
        setOutline(null);
        const spot = commit(objects, null, { topAligned: true });
        const text = t('ai.layer.correctedOnNewPage');

        setNotice(spot ? { text, style: spot } : text);
      },
      markErrors: async (analysis: PageAnalysis) => {
        const analyzed = analyzedRef.current;

        if (!analyzed || !canvas) return 0;

        if (analyzed.pageId !== bridge.getPageId()) {
          setNotice(t('ai.layer.pageChangedSinceCheck'));

          return 0;
        }

        const objects: FabricObject[] = [];
        const batch = batchId();

        // The ✗ and the right answer are Plex text: never measured in a fallback font.
        await ensureBoardFonts();

        for (const question of markableQuestions(analysis)) {
          const box = question.givenAnswerBbox ?? question.bbox;

          if (!box) continue;

          const rect = boxToScene(box, analyzed.region);

          objects.push(
            ...buildMarkerObjects(rect, { zoom: zoomOf(), correctAnswer: question.correctAnswer, ring: Boolean(question.givenAnswerBbox), batch }),
          );
        }

        if (objects.length > 0) {
          canvas.add(...objects);
          canvas.requestRenderAll();
        }

        return objects.length;
      },
      insertConceptMap: async (map: ConceptMap, style: ConceptMapStyle, where: 'beside' | 'new-page') => {
        if (where === 'new-page') {
          if (!(await bridge.insertPageAfterCurrent())) return;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        const zoom = zoomOf();
        const width = canvas ? canvas.getWidth() : 1200;
        const height = canvas ? canvas.getHeight() : 800;
        const objects = await buildGraphObjects(map, style, {
          zoom,
          color: ink,
          kind: 'concept',
          batch: batchId(),
          maxWidthPx: width * (where === 'beside' && anchor ? 0.5 : 0.86),
          maxHeightPx: height * 0.8,
        });

        const spot = commit(objects, where === 'beside' ? anchor : null);
        closeSession();
        const text = placedBelowRef.current ? t('ai.layer.addedBelow') : t('ai.layer.mapAdded');

        setNotice(spot ? { text, style: spot } : text);
        placedBelowRef.current = false;
      },
      startRemakeDraft: async (request) => {
        const ok = await remake.start(request);

        if (ok) closeSession();

        return ok;
      },
      insertRemadePage: async (layout, { asImage }) => {
        const source = remakeSourceRef.current;

        if (!source || !canvas) return false;

        const snapped = snapLayoutToLines(layout, source.lines);
        const objects = await buildLayoutObjects(layoutToPlacements(snapped, source.region), {
          sourcePage: source.canvas,
          sourceRect: source.region,
          batch: batchId(),
        });

        if (objects.length === 0) return false;

        if (asImage) {
          const file = await flattenObjectsToFile(objects, source.region);

          if (!file || !(await bridge.insertImagePageAfterCurrent(file))) return false;
        } else {
          if (!(await bridge.insertPageAfterCurrent())) return false;
          await new Promise((resolve) => requestAnimationFrame(resolve));

          // The blank page opens at its own viewport, not the original's scroll: lay the copy's page
          // top-centred in what the teacher now sees. Relative positions are untouched. One tick.
          const vpt = viewportOf(canvas);
          const zoom = vpt[0] || 1;
          const viewLeft = -(vpt[4] ?? 0) / zoom;
          const viewTop = -(vpt[5] ?? 0) / zoom;
          const viewWidth = canvas.getWidth() / zoom;

          translateObjects(objects, viewLeft + (viewWidth - source.region.width) / 2 - source.region.left, viewTop + 24 / zoom - source.region.top);
          canvas.add(...objects);
          canvas.requestRenderAll();
        }

        closeSession();
        setNotice(t('ai.layer.remakeAdded'));

        return true;
      },
      snapshotPage: async () => {
        const page = await renderPage(1600);

        return page ? canvasToPngBlob(page.rendered) : null;
      },
      storedStyle,
      saveStyle,
      penStyle,
      handPrefs,
      circleMore,
      ...(service.penPlan ? { penExplain, checkSteps, clearStepMarks } : {}),
    };
  }, [anchor, bridge, canvas, checkSteps, circleMore, clearStepMarks, closeSession, commit, handPrefs, ink, penExplain, penStyle, penWidth, remake.start, renderPage, saveStyle, service.penPlan, storedStyle]);

  // --- render ----------------------------------------------------------------------------------------

  // Recomputed every render on purpose — the view tick re-renders on pan/zoom.
  const outlinePath = (() => {
    if (!outline || !canvas) return null;

    const frame = canvasFrame();

    if (!frame) return null;

    const vpt = viewportOf(canvas);

    return `M${outline
      .map((point) => {
        const screen = sceneToScreen(point, vpt);

        return `${screen.x / frame.cssScale + frame.offsetX},${screen.y / frame.cssScale + frame.offsetY}`;
      })
      .join(' L')} Z`;
  })();

  const draft = remake.draft;
  const draftFrame = draft && remake.onPage && draft.phase !== 'review' ? canvasFrame() : null;
  const generatingOnPage = Boolean(draft && remake.onPage && draft.phase !== 'review');

  return (
    <div ref={rootRef} className='pointer-events-none absolute inset-0 z-[16]'>
      {draft && remake.onPage && draft.phase !== 'review' ? (
        <RemakeDissolveOverlay
          content={remake.content}
          draft={draft}
          next={remake.next}
          style={
            draftFrame
              ? { left: draftFrame.offsetX, top: draftFrame.offsetY, width: draftFrame.canvasRect.width, height: draftFrame.canvasRect.height }
              : { inset: 0 }
          }
          onRevealed={remake.revealed}
        />
      ) : null}

      {generatingOnPage && draft ? <RemakeBoardGlow key={`glow-${draft.run}`} finishing={draft.phase === 'revealing'} /> : null}
      {generatingOnPage && draft ? (
        <RemakeStatusCard
          key={`status-${draft.run}`}
          draft={draft}
          statusLine={remake.statusLine}
          onBack={draft.originalPageId ? remake.backToOriginal : null}
          onCancel={remake.cancel}
        />
      ) : null}

      {draft && remake.onPage && draft.phase === 'review' && draft.result ? (
        <RemakeDraftReview
          bottomInset={reviewInset}
          busy={remake.busy}
          result={draft.result}
          onDiscard={() => void remake.discard()}
          onKeep={() => void remake.keep()}
          onRetry={remake.retry}
        />
      ) : null}

      {draft && !remake.onPage && draft.readyElsewhere ? <RemakeReadyToast onDismiss={remake.dismissToast} onOpen={remake.open} /> : null}

      {outlinePath ? (
        <svg aria-hidden className='pointer-events-none absolute inset-0 h-full w-full'>
          <path d={outlinePath} fill='none' stroke='#fbfaf6' strokeWidth={4} />
          <path className='wb-ai-ants' d={outlinePath} fill='none' stroke='#18204a' strokeDasharray='6 4' strokeWidth={2} />
        </svg>
      ) : null}

      {lassoActive ? (
        <div className='pointer-events-auto absolute inset-0'>
          <LassoOverlay
            mode={lassoMode}
            onCancel={() => setLassoActive(false)}
            onFinish={(points, mode) => void handleLassoFinish(points, mode)}
            onModeChange={(mode) => {
              setLassoMode(mode);

              try {
                localStorage.setItem('wb-ai-lasso-mode', mode);
              } catch {
                /* convenience */
              }
            }}
          />
        </div>
      ) : null}

      {selectionChip && !hideSelectionChip && !lassoActive && !session ? (
        <div className='pointer-events-none absolute' style={{ left: selectionChip.left, top: selectionChip.top, transform: 'translateX(-100%)' }}>
          <button
            className='rounded-sk border-sk border-ink bg-citrine text-ink shadow-sk active:shadow-sk-pressed pointer-events-auto flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1.5 text-[11px] font-semibold active:translate-x-0.5 active:translate-y-0.5'
            type='button'
            onClick={() => void askAboutSelection()}
          >
            <Sparkles aria-hidden className='h-3.5 w-3.5' />
            {t('toolbar.askAi')}
          </button>
        </div>
      ) : null}

      {session && panelPosition && panelHost
        ? createPortal(
            <BoardAiPanel
              actions={actions}
              className='fixed z-[95]'
              elementRef={panelElementRef}
              service={service}
              session={session}
              style={{ ...(panelFont ? { fontFamily: panelFont } : {}), ...panelPosition, ...(circling && lassoActive ? { display: 'none' } : {}) }}
              onClose={closeSession}
              onMove={movePanel}
              onResize={resizePanel}
            />,
            panelHost,
          )
        : null}

      {termsStatus ? (
        <div className='pointer-events-none absolute inset-x-0 top-16 z-[41] flex justify-center px-4'>
          <div
            className='border-sk border-ink bg-paper text-ink shadow-sk pointer-events-auto flex items-center gap-2 rounded-full py-1 pe-1 ps-3 text-xs font-semibold'
            dir={dir}
            role='status'
          >
            <Loader2 aria-hidden className='h-3.5 w-3.5 animate-spin' />
            <span>{termsStatus}</span>
            <button
              aria-label={t('ai.terms.cancel')}
              className='hover:bg-ink/5 flex h-7 w-7 items-center justify-center rounded-full'
              type='button'
              onClick={cancelMapTerms}
            >
              <X aria-hidden className='h-3.5 w-3.5' />
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div
          className={`pointer-events-none absolute inset-x-0 z-[41] flex justify-center px-4 ${typeof notice === 'string' ? 'top-16' : ''}`}
          style={typeof notice === 'string' ? undefined : notice.style}
        >
          <div className='border-sk border-ink bg-paper text-ink shadow-sk rounded-sm px-3 py-1.5 text-xs font-semibold' dir={dir} role='status'>
            {typeof notice === 'string' ? notice : notice.text}
          </div>
        </div>
      ) : null}
    </div>
  );
}
