import type { EditorViewport, RulerEdgesRef } from '@repo/whiteboard-react';
import type { Pt, RulerPose } from '@/lib/ruler/geometry';
import { formatGround, formatScale, groundPerPaperMm, niceStep, paperToRoot, rootToPaper } from '@/lib/ruler/preset';
import type { GroundUnit, RulerPreset } from '@/lib/ruler/preset';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Settings2, X } from 'lucide-react';

import { ActionButton } from '@/components/ui/primitives';
import {
  CARD_WIDTH_MM,
  currentScale,
  MAX_PAGE_FACTOR,
  MIN_PAGE_FACTOR,
  MM_PER_INCH,
  pageCssPxPerMm,
  saveRulerPrefs,
  useRulerPrefs,
} from '@/lib/ruler/calibration';
import {
  angleBetween,
  clampCentre,
  displayAngle,
  hitsRuler,
  longEdges,
  midpoint,
  snapAngle,
  toLocal,
} from '@/lib/ruler/geometry';

const THICKNESS_MM = 34;
const MAX_LENGTH_MM = 300;
/** Page mode measures paper at any zoom: as long as the screen allows, up to 2 m of paper. */
const MAX_PAGE_LENGTH_MM = 2000;
const MIN_PAGE_LENGTH_MM = 20;
/** How far (screen px) from a ruler side a pen stroke still snaps to it. */
const PEN_SNAP_PX = 14;
const CARD_HEIGHT_MM = 53.98;

interface Base {
  pose: RulerPose;
  points: Pt[];
}

/**
 * The on-screen ruler. By default («Page») the ticks follow the PAGE: 1 mm of paper at the board's viewport
 * `zoom`, so a printed inch lines up. «Real» keeps them PHYSICAL (mm/inch of glass from
 * `lib/ruler/calibration`), independent of the zoom. The 0 end stays put while the zoom changes. A finger drags it; a second finger rotates it (magnet at 45° steps); the pen passes
 * straight through to the board, and a stroke drawn along a long side commits straight (the editor reads
 * the sides from `edgesRef`).
 *
 * Touch handling lives in CAPTURE listeners on the board root so only a finger that lands on the ruler
 * is taken: every other contact — and every pen contact — reaches the board's palm rejection and pen
 * capture untouched.
 */
export function RulerOverlay({
  root,
  edgesRef,
  zoom,
  pageNo,
  preset,
  saving,
  viewportRef,
  viewportTick,
  onClose,
  onSavePreset,
}: {
  root: HTMLElement | null;
  edgesRef: RulerEdgesRef;
  /** The board's current viewport zoom. */
  zoom: number;
  /** Board page number (1-based) and its saved preset, if any. */
  pageNo: number;
  preset: RulerPreset | null;
  saving: boolean;
  /** The editor's live viewport, and a counter that changes whenever it moves. */
  viewportRef: { current: (() => EditorViewport | null) | null };
  viewportTick: number;
  onClose: () => void;
  onSavePreset: (preset: RulerPreset) => void;
}) {
  const prefs = useRulerPrefs();
  const scale = useMemo(() => currentScale(prefs), [prefs]);
  const real = prefs.real === true;
  // `u` sizes the ruler body, glyphs and tick heights (always physical); `k` spaces the ticks.
  // Body, tick heights and glyphs use the device scale, never the manual card calibration: calibrating
  // stretches the ticks along the ruler, it must not make the ruler fat.
  const u = useMemo(() => currentScale({ ...prefs, pxPerMm: undefined }).cssPxPerMm, [prefs]);
  // A preset's factor wins over the stored one for this page only; touching the stretch handle takes it over.
  const [presetFactor, setPresetFactor] = useState<number | null>(null);
  const factor = presetFactor ?? prefs.pageFactor ?? 1;
  const k = real ? scale.cssPxPerMm : pageCssPxPerMm(zoom) * factor;
  const thickness = THICKNESS_MM * u;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pose, setPose] = useState<RulerPose | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const poseRef = useRef<RulerPose | null>(null);
  const calibratingRef = useRef(false);
  const ground = preset?.mapScale ? { scale: preset.mapScale, unit: preset.groundUnit ?? 'm' } : null;
  const lengthMm = useMemo(() => {
    const fit = Math.floor((size.w - 32) / k / 10) * 10;

    return Math.max(real ? 100 : MIN_PAGE_LENGTH_MM, Math.min(real ? MAX_LENGTH_MM : MAX_PAGE_LENGTH_MM, fit));
  }, [size.w, k, real]);
  const length = lengthMm * k;
  const geo = useRef({ length, thickness });

  const lastLength = useRef(length);
  // The paper point (mm) the 0 end is pinned to, until the user drags the ruler.
  const pinnedRef = useRef<{ xMm: number; yMm: number } | null>(null);

  geo.current = { length, thickness };
  calibratingRef.current = calibrating;

  const update = useCallback((next: RulerPose) => {
    poseRef.current = next;
    setPose(next);
  }, []);

  // A new length (zoom, mode, board width) keeps the 0 end where it is: slide the centre along the ruler.
  useLayoutEffect(() => {
    const prev = lastLength.current;

    lastLength.current = length;

    const current = poseRef.current;

    if (!current || prev === length || !root) return;

    const r = (current.angle * Math.PI) / 180;
    const shift = (length - prev) / 2;
    const rect = root.getBoundingClientRect();

    update(clampCentre({ ...current, cx: current.cx + shift * Math.cos(r), cy: current.cy + shift * Math.sin(r) }, rect.width, rect.height));
  }, [length, root, update]);

  // Apply a page's preset: angle and factor once per saved preset, the pin whenever the board pans or zooms.
  const appliedKey = useRef('');
  const firstAngle = useRef(0);

  useLayoutEffect(() => {
    const key = preset ? `${pageNo}:${preset.updatedAt}` : '';

    if (key === appliedKey.current) return;

    appliedKey.current = key;
    firstAngle.current = preset?.angleDeg ?? 0;
    setPresetFactor(preset?.pageFactor ?? null);
    pinnedRef.current = preset?.zeroAt ?? null;

    const current = poseRef.current;

    if (preset?.angleDeg !== undefined && current) update({ ...current, angle: preset.angleDeg });
  }, [pageNo, preset, update]);

  useLayoutEffect(() => {
    const pin = pinnedRef.current;
    const vp = viewportRef.current?.();
    const current = poseRef.current;

    if (!pin || !vp || !current || !root) return;

    const rect = root.getBoundingClientRect();
    const zero = paperToRoot(vp, rect.left, rect.top, pin.xMm, pin.yMm);
    const r = (current.angle * Math.PI) / 180;
    const next = { ...current, cx: zero.x + (length / 2) * Math.cos(r), cy: zero.y + (length / 2) * Math.sin(r) };

    if (Math.abs(next.cx - current.cx) > 0.01 || Math.abs(next.cy - current.cy) > 0.01 || next.angle !== current.angle) {
      lastLength.current = length;
      update(next);
    }
  }, [viewportTick, preset, pose, length, root, update, viewportRef]);

  // Board size, and the first placement (upper third, centred) once it is known.
  useEffect(() => {
    if (!root) return undefined;

    const measure = () => {
      const rect = root.getBoundingClientRect();

      setSize({ w: rect.width, h: rect.height });

      if (!poseRef.current && rect.width > 0) update({ cx: rect.width / 2, cy: rect.height / 3, angle: firstAngle.current });
    };
    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(root);

    return () => observer.disconnect();
  }, [root, update]);

  // The long sides, for the editor's stroke snapping.
  useEffect(() => {
    if (!root) return undefined;

    edgesRef.current = () => {
      const current = poseRef.current;

      if (!current || calibratingRef.current) return null;

      const rect = root.getBoundingClientRect();
      const { length: l, thickness: t } = geo.current;

      return longEdges(current, l, t).map(([a, b]) => ({
        x1: rect.left + a.x,
        y1: rect.top + a.y,
        x2: rect.left + b.x,
        y2: rect.top + b.y,
        snapPx: PEN_SNAP_PX,
      }));
    };

    return () => {
      edgesRef.current = null;
    };
  }, [root, edgesRef]);

  // Finger gestures (touch only; pen and mouse are never taken).
  useEffect(() => {
    if (!root) return undefined;

    const claimed = new Map<number, Pt>();
    const touchIds = new Set<number>();
    let base: Base | null = null;
    let startAngle = 0;

    const local = (e: { clientX: number; clientY: number }): Pt => {
      const rect = root.getBoundingClientRect();

      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const rebase = () => {
      if (poseRef.current) base = { pose: poseRef.current, points: [...claimed.values()] };

      const [a, b] = base?.points ?? [];

      startAngle = a && b ? angleBetween(a, b) : 0;
    };
    const apply = () => {
      if (!base) return;

      const pts = [...claimed.values()];
      const [p0, p1] = pts;
      const [b0, b1] = base.points;

      if (!p0 || !b0) return;

      let next: RulerPose;

      if (p1 && b1) {
        const delta = angleBetween(p0, p1) - startAngle;
        const mid = midpoint(p0, p1);
        const baseMid = midpoint(b0, b1);
        const r = (delta * Math.PI) / 180;
        const vx = base.pose.cx - baseMid.x;
        const vy = base.pose.cy - baseMid.y;

        next = {
          cx: mid.x + vx * Math.cos(r) - vy * Math.sin(r),
          cy: mid.y + vx * Math.sin(r) + vy * Math.cos(r),
          angle: snapAngle(base.pose.angle + delta),
        };
      } else {
        next = { ...base.pose, cx: base.pose.cx + p0.x - b0.x, cy: base.pose.cy + p0.y - b0.y };
      }

      const rect = root.getBoundingClientRect();

      // A dragged ruler is free: it no longer follows the page.
      pinnedRef.current = null;
      update(clampCentre(next, rect.width, rect.height));
    };
    const take = (e: Event) => {
      e.stopImmediatePropagation();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || calibratingRef.current || !poseRef.current) return;
      if ((e.target as Element | null)?.closest?.('[data-ruler-control]')) return;

      const p = local(e);

      if (claimed.size === 0) {
        if (!hitsRuler(poseRef.current, geo.current.length, geo.current.thickness, p, 6)) return;
      } else if (claimed.size >= 2) {
        take(e);

        return;
      }

      claimed.set(e.pointerId, p);
      rebase();
      take(e);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!claimed.has(e.pointerId)) return;

      claimed.set(e.pointerId, local(e));
      apply();
      take(e);
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (!claimed.has(e.pointerId)) return;

      claimed.delete(e.pointerId);
      rebase();
      take(e);
    };
    const onTouchStart = (e: TouchEvent) => {
      // `pointerdown` runs first: a contact it claimed (or swallowed as a third finger) is ours here too.
      if (claimed.size === 0) return;

      for (const t of Array.from(e.changedTouches)) touchIds.add(t.identifier);

      e.preventDefault();
      take(e);
    };
    const onTouchOther = (e: TouchEvent) => {
      const mine = Array.from(e.changedTouches).some((t) => touchIds.has(t.identifier));

      if (!mine) return;

      if (e.type !== 'touchmove') for (const t of Array.from(e.changedTouches)) touchIds.delete(t.identifier);

      if (e.cancelable) e.preventDefault();

      take(e);
    };
    const opts = { capture: true, passive: false } as const;

    root.addEventListener('pointerdown', onPointerDown, opts);
    root.addEventListener('pointermove', onPointerMove, opts);
    root.addEventListener('pointerup', onPointerEnd, opts);
    root.addEventListener('pointercancel', onPointerEnd, opts);
    root.addEventListener('touchstart', onTouchStart, opts);
    root.addEventListener('touchmove', onTouchOther, opts);
    root.addEventListener('touchend', onTouchOther, opts);
    root.addEventListener('touchcancel', onTouchOther, opts);

    return () => {
      root.removeEventListener('pointerdown', onPointerDown, opts);
      root.removeEventListener('pointermove', onPointerMove, opts);
      root.removeEventListener('pointerup', onPointerEnd, opts);
      root.removeEventListener('pointercancel', onPointerEnd, opts);
      root.removeEventListener('touchstart', onTouchStart, opts);
      root.removeEventListener('touchmove', onTouchOther, opts);
      root.removeEventListener('touchend', onTouchOther, opts);
      root.removeEventListener('touchcancel', onTouchOther, opts);
    };
  }, [root, update]);

  // Page mode: a finger on the right-end handle stretches the tick spacing to fit the map's own scale bar.
  // The 0 end stays where it is (the length effect above slides the centre). Never the pen.
  const onStretchDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'pen' || !root || !poseRef.current) return;

    e.stopPropagation();

    const start = poseRef.current;
    const r = (start.angle * Math.PI) / 180;
    const dir = { x: Math.cos(r), y: Math.sin(r) };
    const half = geo.current.length / 2;
    const zero = { x: start.cx - dir.x * half, y: start.cy - dir.y * half };
    const rect0 = root.getBoundingClientRect();
    const along = (x: number, y: number, rect: DOMRect) => (x - rect.left - zero.x) * dir.x + (y - rect.top - zero.y) * dir.y;
    const startAlong = along(e.clientX, e.clientY, rect0);
    const startFactor = factor;

    if (startAlong <= 0) return;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;

      const a = along(ev.clientX, ev.clientY, root.getBoundingClientRect());

      if (a <= 0) return;

      const next = Math.min(MAX_PAGE_FACTOR, Math.max(MIN_PAGE_FACTOR, (startFactor * a) / startAlong));

      if (presetFactor !== null) setPresetFactor(next);
      else saveRulerPrefs({ pageFactor: next });
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;

      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
    };

    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  };

  // The factor, angle and 0 end (converted back to paper mm) that open the page like this next time.
  const savePreset = () => {
    const vp = viewportRef.current?.();
    const current = poseRef.current;

    if (!vp || !current || !root) return;

    const rect = root.getBoundingClientRect();
    const r = (current.angle * Math.PI) / 180;
    const zeroX = current.cx - (length / 2) * Math.cos(r);
    const zeroY = current.cy - (length / 2) * Math.sin(r);
    const { xMm, yMm } = rootToPaper(vp, rect.left, rect.top, zeroX, zeroY);

    pinnedRef.current = { xMm, yMm };
    onSavePreset({
      ...(preset?.mapScale ? { mapScale: preset.mapScale, groundUnit: preset.groundUnit } : {}),
      pageFactor: factor,
      angleDeg: displayAngle(current.angle),
      zeroAt: { xMm: Math.round(xMm * 100) / 100, yMm: Math.round(yMm * 100) / 100 },
      setBy: 'user',
      updatedAt: new Date().toISOString(),
    });
  };

  if (!pose) return null;

  return (
    <div className='pointer-events-none absolute inset-0 z-20' data-ruler>
      <div
        className='border-st-line bg-st-surface/70 absolute left-0 top-0 rounded-sm border backdrop-blur-[1px]'
        style={{
          width: length,
          height: thickness,
          transform: `translate(${pose.cx - length / 2}px, ${pose.cy - thickness / 2}px) rotate(${pose.angle}deg)`,
          transformOrigin: `${length / 2}px ${thickness / 2}px`,
        }}
      >
        <RulerTicks ground={ground} inch k={k} lengthMm={lengthMm} thickness={thickness} u={u} />
        <div className='text-st-fg pointer-events-none absolute inset-0 flex items-center justify-center gap-3 text-xs font-medium tabular-nums'>
          <span>{displayAngle(pose.angle)}°</span>
          <span className='text-st-muted'>{lengthMm / 10} cm</span>
          {ground && <span className='text-st-muted'>{formatScale(ground.scale)}</span>}
        </div>
        {!real && (
          <div
            aria-label='Stretch the ticks to fit the map scale'
            className='bg-st-accent pointer-events-auto absolute right-1 top-1/2 h-12 w-5 -translate-y-1/2 cursor-ew-resize touch-none rounded-full'
            data-ruler-control
            title='Hold 0 on the map, drag to stretch the ticks'
            onDoubleClick={() => {
              setPresetFactor(null);
              saveRulerPrefs({ pageFactor: null });
            }}
            onPointerDown={onStretchDown}
          />
        )}
        <div className='absolute bottom-1 right-1 flex gap-1' data-ruler-control>
          <ActionButton
            aria-label={real ? 'Ruler follows the screen. Switch to page scale' : 'Ruler follows the page. Switch to real size'}
            aria-pressed={!real}
            className='pointer-events-auto min-h-9 px-2 text-xs'
            title={real ? 'Real: millimetres of the glass' : 'Page: millimetres of the paper at this zoom'}
            variant='ghost'
            onClick={() => saveRulerPrefs({ real: !real })}
          >
            {real ? 'Real' : 'Page'}
          </ActionButton>
          {!real && (
            <ActionButton
              aria-label='Save this ruler position for the page'
              className='pointer-events-auto min-h-9 min-w-9 px-2'
              disabled={saving}
              title='Save for page: the ruler opens here next time'
              variant='ghost'
              onClick={savePreset}
            >
              <Bookmark className='h-4 w-4' />
            </ActionButton>
          )}
          <ActionButton
            aria-label='Calibrate the ruler'
            className='pointer-events-auto min-h-9 min-w-9 px-2'
            title='Calibrate with a card'
            variant='ghost'
            onClick={() => setCalibrating(true)}
          >
            <Settings2 className='h-4 w-4' />
          </ActionButton>
          <ActionButton
            aria-label='Hide the ruler'
            className='pointer-events-auto min-h-9 min-w-9 px-2'
            title='Hide the ruler'
            variant='ghost'
            onClick={onClose}
          >
            <X className='h-4 w-4' />
          </ActionButton>
        </div>
      </div>
      {calibrating && <CalibrationCard bodyK={u} k={scale.cssPxPerMm} source={scale.source} onDone={() => setCalibrating(false)} />}
    </div>
  );
}

function RulerTicks({
  k,
  u,
  lengthMm,
  thickness,
  inch,
  ground,
}: {
  /** A map scale: the lower edge reads ground distance instead of inches. */
  ground: { scale: number; unit: GroundUnit } | null;
  /** CSS px per mm along the ruler. */
  k: number;
  /** CSS px per physical mm: sizes tick heights and glyphs. */
  u: number;
  lengthMm: number;
  thickness: number;
  inch: boolean;
}) {
  const top: React.ReactNode[] = [];
  // Zoomed far out the ticks crowd: thin them so neighbours stay >= ~5 px apart and labels >= ~24 px.
  const minorMm = k >= 5 ? 1 : k >= 1 ? 5 : 10;
  const labelMm = k * 10 >= 24 ? 10 : k * 50 >= 24 ? 50 : 100;

  for (let mm = 0; mm <= lengthMm; mm += minorMm) {
    const cm = mm % 10 === 0;
    const half = mm % 5 === 0;
    const len = (cm ? 6 : half ? 4 : 2.5) * u;

    top.push(<line key={`t${mm}`} x1={mm * k} x2={mm * k} y1={0} y2={len} />);

    if (mm > 0 && mm % labelMm === 0) {
      top.push(
        <text key={`l${mm}`} fontSize={Math.max(9, 3.2 * u)} stroke='none' textAnchor='middle' x={mm * k} y={6 * u + 3.6 * u}>
          {mm / 10}
        </text>,
      );
    }
  }

  const bottom: React.ReactNode[] = [];

  if (ground) {
    // Ground units per px along the ruler, then the smallest round step whose labels sit >= ~44 px apart.
    const perMm = groundPerPaperMm(ground.scale, ground.unit);
    const { step, minors } = niceStep((44 / k) * perMm);
    const minor = step / minors;
    const total = lengthMm * perMm;

    for (let i = 0; i * minor <= total + 1e-9; i += 1) {
      const value = i * minor;
      const x = (value / perMm) * k;
      const major = i % minors === 0;

      bottom.push(<line key={`g${i}`} x1={x} x2={x} y1={thickness} y2={thickness - (major ? 6 : 3) * u} />);

      if (major && i > 0) {
        bottom.push(
          <text key={`gn${i}`} fontSize={Math.max(9, 3.2 * u)} stroke='none' textAnchor='middle' x={x} y={thickness - 6 * u - 1.2 * u}>
            {formatGround(value)}
          </text>,
        );
      }
    }
  } else if (inch) {
    const eighths = Math.floor(lengthMm / (MM_PER_INCH / 8));
    const stride = (MM_PER_INCH / 8) * k >= 5 ? 1 : (MM_PER_INCH / 4) * k >= 5 ? 2 : (MM_PER_INCH / 2) * k >= 5 ? 4 : 8;
    const labelEvery = MM_PER_INCH * k >= 24 ? 8 : 16;

    for (let i = 0; i <= eighths; i += stride) {
      const x = ((i * MM_PER_INCH) / 8) * k;
      const len = (i % 8 === 0 ? 6 : i % 4 === 0 ? 4.5 : i % 2 === 0 ? 3.5 : 2.5) * u;

      bottom.push(<line key={`i${i}`} x1={x} x2={x} y1={thickness} y2={thickness - len} />);

      if (i % labelEvery === 0 && i > 0) {
        bottom.push(
          <text key={`n${i}`} fontSize={Math.max(9, 3.2 * u)} stroke='none' textAnchor='middle' x={x} y={thickness - len - 1.2 * u}>
            {i / 8}
          </text>,
        );
      }
    }
  }

  return (
    <svg
      aria-hidden
      className='text-st-fg pointer-events-none absolute left-0 top-0 overflow-visible'
      fill='currentColor'
      height={thickness}
      stroke='currentColor'
      strokeOpacity={0.7}
      strokeWidth={1}
      width={lengthMm * k}
    >
      {top}
      {bottom}
      <text fontSize={Math.max(8, 2.6 * u)} stroke='none' x={1.2 * u} y={9.5 * u}>
        cm
      </text>
      {(ground || inch) && (
        <text fontSize={Math.max(8, 2.6 * u)} stroke='none' x={1.2 * u} y={thickness - 7.5 * u}>
          {ground ? ground.unit : 'in'}
        </text>
      )}
    </svg>
  );
}

/** Hold a real credit card (85.60 mm) against the screen and drag the edge until they match. */
function CalibrationCard({ bodyK, k, source, onDone }: { bodyK: number; k: number; source: string; onDone: () => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const width = CARD_WIDTH_MM * k;

  return (
    <div
      className='bg-st-surface border-st-clay-edge shadow-clay rounded-st-lg pointer-events-auto absolute left-1/2 top-1/2 z-30 flex max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 border-2 p-4'
      data-ruler-control
      dir='ltr'
    >
      <p className='text-st-fg text-sm font-medium'>Drag the right edge until the box is as wide as a real card</p>
      <div className='relative' style={{ height: CARD_HEIGHT_MM * bodyK, width }}>
        <div className='border-st-accent bg-st-accent/10 absolute inset-0 rounded-[3.5mm] border-2' />
        <div
          aria-label='Card width'
          className='bg-st-accent absolute -right-3 top-1/2 h-12 w-6 -translate-y-1/2 cursor-ew-resize touch-none rounded-full'
          role='slider'
          aria-valuemax={100}
          aria-valuemin={70}
          aria-valuenow={Math.round(width / k)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, width };
          }}
          onPointerMove={(e) => {
            if (drag.current) saveRulerPrefs({ pxPerMm: (drag.current.width + e.clientX - drag.current.x) / CARD_WIDTH_MM });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        />
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-st-muted text-xs'>
          {source === 'manual' ? 'Manual' : source === 'device' ? 'Known tablet' : 'Default'} · {k.toFixed(2)} px/mm
        </span>
        <div className='flex gap-2'>
          <ActionButton className='min-h-9 px-3 text-xs' variant='ghost' onClick={() => saveRulerPrefs({ pxPerMm: null })}>
            Reset
          </ActionButton>
          <ActionButton className='min-h-9 px-3 text-xs' variant='secondary' onClick={onDone}>
            Done
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
