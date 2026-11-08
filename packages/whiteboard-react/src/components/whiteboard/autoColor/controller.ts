/**
 * Auto-colour, the Fabric half: watches committed pen strokes, groups them (`grouping.ts`), recognises
 * and classifies each line after a pen-lift pause, and recolours the default-ink words.
 *
 * Contract with the board:
 * - Raw pen samples (x, y, time) come from passive capture-phase pointer listeners — the committed Path
 *   cannot be used for recognition: the calligraphy brush commits a filled OUTLINE, not the centreline
 *   the pen travelled. Nothing is added to the board's own pointer hot path.
 * - One recolour batch = ONE undo step: the pending history checkpoint is committed before the batch, the
 *   strokes are announced through `object:modified` (the editor's mutation path) and the checkpoint is
 *   committed again straight after. A batch never runs while a contact is down.
 * - The cross-fade only sets the colour; `object:modified` fires once per stroke at the final colour.
 * - A stroke the student recoloured is never touched again; recolouring an auto-coloured word is a
 *   CORRECTION (telemetry + the phrase memory).
 */
import { BaseFabricObject, Path, Point, util } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { invalidateInkBake } from '../utils/inkBake';
import { isPointerDown } from '../utils/inputActivity';
import { inkDetailText, inkTelemetry } from '../utils/inkTelemetry';

import { boxOfPoints, horizontalGap, InkGrouper, median, writingDirection } from './grouping';
import { AMBIGUOUS_CONFIDENCE } from './model';
import { detectCorrection, INK_AUTO_PROP, isInkAutoMarker, mixColor, planRecolor, resolvePalette, sameColor } from './recolor';
import { classifyLine, SEG_BULLET } from './rules';
import { pickLineScript, pickScript, scriptOfText, textInScript } from './script';

import type { InkGroupState, InkLineState } from './grouping';
import type { AutoColorConfig, InkBox, InkClassification, InkDebugEntry, InkDirection, InkScript, InkStrokeInput } from './model';
import type { InkAutoMarker, RecolorChange, RecolorTarget } from './recolor';
import type { InkCandidate, InkClass, InkLineForCloud, InkPoint } from './types';

const DEFAULT_PAUSE_MS = 800;
const DEFAULT_FADE_MS = 180;
const RECOGNIZE_TIMEOUT_MS = 4_000;
const CLOUD_TIMEOUT_MS = 6_000;
const TRACE_MATCH_MS = 1_500;
const DEBUG_ROWS = 12;
/** Lines the grouper keeps: a whole page, so «colour the page» still has the first line. */
const MAX_LINES = 2_000;

/** Keep the marker through `toJSON` (Fabric drops unlisted props). Idempotent. */
export function registerInkAutoPersistence(): void {
  const base = BaseFabricObject as unknown as { customProperties?: string[] };

  if (!base.customProperties?.includes(INK_AUTO_PROP)) {
    base.customProperties = [...(base.customProperties ?? []), INK_AUTO_PROP];
  }

  // `Path` may own its list (shape snap registers there), which the history fingerprint reads: add it there
  // too, so an undo snapshot sees a marker change even when the colour did not move.
  const own = Object.prototype.hasOwnProperty.call(Path, 'customProperties') ? Path.customProperties : undefined;

  if (own && !own.includes(INK_AUTO_PROP)) Path.customProperties = [...own, INK_AUTO_PROP];
}

export interface InkAutoColorHost {
  canvas: Canvas;
  getConfig(): AutoColorConfig | null;
  /** The pen's colour setting right now. */
  getPenColor(): string;
  /** A handwriting tool (pen / brush / marker) is active. */
  isInkTool(): boolean;
  /** Take the board's pending undo checkpoint now. */
  commitHistory?(): void;
  onDebug?(entries: InkDebugEntry[]): void;
}

interface Trace {
  pointerId: number;
  client: number[];
  startedAt: number;
  endedAt: number;
  consumed: boolean;
}

interface StrokeMeta {
  defaultInk: boolean;
  createdColor: string;
}

interface GroupTiming {
  recognizeMs: number;
  script: InkScript | null;
  engine: string;
  /** The recognize event waits for the line's script decision before it is reported. */
  reported: boolean;
  ok: boolean;
  outline: boolean;
}

interface PlannedChange {
  object: FabricObject;
  change: RecolorChange;
  /** The colour unit (line + segment): changed all together or not at all. */
  unit: string;
}

interface LineResult {
  line: InkLineState;
  ordered: InkGroupState[];
  classes: InkClassification[];
  dir: InkDirection | null;
  /** The line's version the result was computed from; a newer one means the line grew meanwhile. */
  version: number;
  /** How long the rules took (classification proper, recognition excluded). */
  classifyMs: number;
}

const isEraserMark = (object: FabricObject) =>
  (object as FabricObject & { globalCompositeOperation?: string }).globalCompositeOperation === 'destination-out';

/** The property that holds a stroke's ink: `stroke` for a pencil line, `fill` for the brush's outline. */
function inkProp(object: FabricObject): 'stroke' | 'fill' {
  const stroke = (object as { stroke?: unknown }).stroke;

  return typeof stroke === 'string' && stroke !== '' && stroke !== 'transparent' ? 'stroke' : 'fill';
}

export function inkColorOf(object: FabricObject): string {
  const value = (object as unknown as Record<string, unknown>)[inkProp(object)];

  return typeof value === 'string' ? value : '';
}

export function markerOf(object: FabricObject): InkAutoMarker | null {
  const value = (object as unknown as Record<string, unknown>)[INK_AUTO_PROP];

  return isInkAutoMarker(value) ? value : null;
}

function setMarker(object: FabricObject, marker: InkAutoMarker | null): void {
  (object as unknown as Record<string, unknown>)[INK_AUTO_PROP] = marker ?? undefined;
}

function sceneBox(object: FabricObject): InkBox {
  const rect = object.getBoundingRect();

  return { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height };
}

function overlapsBox(a: InkBox, b: InkBox, slack: number): boolean {
  return a.left - slack <= b.right && b.left - slack <= a.right && a.top - slack <= b.bottom && b.top - slack <= a.bottom;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function withTimeout<T>(run: (signal: AbortSignal | undefined) => Promise<T>, ms: number): Promise<T> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('timeout'));
    }, ms);

    run(controller?.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Members of a selection (or the object itself). */
function membersOf(target: FabricObject): FabricObject[] {
  return (target as unknown as { _objects?: FabricObject[] })._objects ?? [target];
}

export class InkAutoColorController {
  readonly grouper = new InkGrouper({ maxLines: MAX_LINES });
  private readonly host: InkAutoColorHost;
  private readonly objects = new Map<string, FabricObject>();
  private readonly ids = new WeakMap<FabricObject, string>();
  private readonly meta = new WeakMap<FabricObject, StrokeMeta>();
  private readonly timings = new Map<string, GroupTiming>();
  private readonly groupClass = new Map<string, InkClass>();
  private readonly lineVersion = new Map<string, number>();
  /** The version each line was last classified at (a line with an erased word is re-classified). */
  private readonly processedVersion = new Map<string, number>();
  /** Every model's candidates per word, kept so the line's script can re-pick each word's reading. */
  private readonly candidates = new Map<string, InkCandidate[]>();
  /** Colour batches run one at a time, so a fade never meets another batch's half-mixed colours. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lineIndex = new Map<string, number>();
  /** Strokes whose pen trace could not be matched (their outline was sent instead). */
  private readonly outlineStrokes = new Set<string>();
  private readonly disposers: Array<() => void> = [];
  private traces: Trace[] = [];
  private live: Trace | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private lines = 0;
  private busy = false;
  private again = false;
  private applying = false;
  private lastScript: InkScript | null = null;
  private debug: InkDebugEntry[] = [];
  private disposed = false;
  /** While «colour the page» runs: the lines' changes collect here and go out as ONE batch. */
  private collect: PlannedChange[] | null = null;

  constructor(host: InkAutoColorHost) {
    this.host = host;
    registerInkAutoPersistence();
    this.install();
  }

  dispose(): void {
    this.disposed = true;

    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.disposers.splice(0).forEach((dispose) => dispose());
  }

  private config(): AutoColorConfig | null {
    return this.disposed ? null : this.host.getConfig();
  }

  /** Strokes are read as written but coloured only by {@link colorAll}. */
  private manual(): boolean {
    return this.config()?.mode === 'manual';
  }

  // --- capture -------------------------------------------------------------------------------------

  private upper(): HTMLCanvasElement | undefined {
    return (this.host.canvas as unknown as { upperCanvasEl?: HTMLCanvasElement }).upperCanvasEl;
  }

  private install(): void {
    const { canvas } = this.host;
    const upper = this.upper();

    if (typeof window !== 'undefined' && upper) {
      const onDown = (event: PointerEvent) => {
        if (!this.config() || event.target !== upper || !event.isPrimary) return;
        this.live = {
          pointerId: event.pointerId,
          client: [event.clientX, event.clientY, event.timeStamp],
          startedAt: event.timeStamp,
          endedAt: event.timeStamp,
          consumed: false,
        };
      };
      const onMove = (event: PointerEvent) => {
        const live = this.live;

        if (!live || event.pointerId !== live.pointerId) return;
        const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];

        if (samples.length > 0) {
          for (const sample of samples) live.client.push(sample.clientX, sample.clientY, sample.timeStamp);
        } else {
          live.client.push(event.clientX, event.clientY, event.timeStamp);
        }

        // A runaway contact (a palm resting for minutes) must not grow without bound.
        if (live.client.length > 30_000) live.client.length = 30_000;
      };
      const onUp = (event: PointerEvent) => {
        const live = this.live;

        if (!live || event.pointerId !== live.pointerId) return;
        live.client.push(event.clientX, event.clientY, event.timeStamp);
        live.endedAt = event.timeStamp;
        this.traces.push(live);
        this.traces = this.traces.slice(-4);
        this.live = null;
      };
      const options = { capture: true, passive: true } as const;

      window.addEventListener('pointerdown', onDown, options);
      window.addEventListener('pointermove', onMove, options);
      window.addEventListener('pointerup', onUp, options);
      window.addEventListener('pointercancel', onUp, options);
      this.disposers.push(() => {
        window.removeEventListener('pointerdown', onDown, options);
        window.removeEventListener('pointermove', onMove, options);
        window.removeEventListener('pointerup', onUp, options);
        window.removeEventListener('pointercancel', onUp, options);
      });
    }

    const observable = canvas as unknown as {
      on: (event: string, handler: (event: { path?: FabricObject; target?: FabricObject }) => void) => () => void;
    };

    // After the board's own `path:created` handler (which may discard a stray dot): read on the next task,
    // with the pen colour and tool as they were at the commit.
    this.disposers.push(
      observable.on('path:created', (event) => {
        const path = event.path;

        if (!path || !this.config()) return;
        const penColor = this.host.getPenColor();
        const inkTool = this.host.isInkTool();

        setTimeout(() => this.onStroke(path, penColor, inkTool), 0);
      }),
    );
    this.disposers.push(
      observable.on('object:removed', (event) => {
        const id = event.target ? this.ids.get(event.target) : undefined;

        if (!id) return;
        const lineId = this.grouper.groupOfStroke(id)?.lineId;

        this.objects.delete(id);
        this.outlineStrokes.delete(id);
        this.grouper.removeStroke(id);

        // The line lost a word: classify what is left on the next pause.
        if (lineId && this.grouper.line(lineId)) {
          this.lineVersion.set(lineId, (this.lineVersion.get(lineId) ?? 0) + 1);
          const config = this.config();

          if (config && !this.manual()) this.armPause(config.pauseMs ?? DEFAULT_PAUSE_MS);
        }
      }),
    );
    this.disposers.push(observable.on('object:modified', (event) => this.onModified(event.target)));
  }

  private takeTrace(): Trace | null {
    const at = now();

    for (let index = this.traces.length - 1; index >= 0; index -= 1) {
      const trace = this.traces[index];

      if (!trace.consumed && at - trace.endedAt <= TRACE_MATCH_MS) {
        trace.consumed = true;

        return trace;
      }
    }

    return null;
  }

  /** The pen trace in scene space (null when it does not land on the committed path). */
  private tracePoints(trace: Trace, box: InkBox): InkPoint[] | null {
    const { canvas } = this.host;
    const upper = this.upper();

    if (!upper) return null;
    const rect = upper.getBoundingClientRect();
    const sx = rect.width > 0 ? canvas.getWidth() / rect.width : 1;
    const sy = rect.height > 0 ? canvas.getHeight() / rect.height : 1;
    const inverse = util.invertTransform(canvas.viewportTransform);
    const points: InkPoint[] = [];

    for (let index = 0; index + 2 < trace.client.length; index += 3) {
      const viewport = new Point((trace.client[index] - rect.left) * sx, (trace.client[index + 1] - rect.top) * sy);
      const scene = util.transformPoint(viewport, inverse);

      points.push({ x: scene.x, y: scene.y, t: trace.client[index + 2] });
    }

    if (points.length === 0) return null;
    const traced = boxOfPoints(points);
    const slack = Math.max(24, 0.3 * Math.max(box.right - box.left, box.bottom - box.top));

    return overlapsBox(traced, box, slack) ? points : null;
  }

  /** Fallback when no trace matches: the path's own vertices, spread over the stroke's time. */
  private pathPoints(object: FabricObject, startedAt: number, endedAt: number): InkPoint[] {
    const { path, pathOffset } = object as Path;
    const matrix = object.calcTransformMatrix();
    const out: InkPoint[] = [];
    const commands = (path ?? []) as unknown as Array<Array<string | number>>;

    for (const command of commands) {
      const n = command.length;

      if (n < 3) continue;
      const scene = util.transformPoint(new Point(Number(command[n - 2]) - pathOffset.x, Number(command[n - 1]) - pathOffset.y), matrix);

      out.push({ x: scene.x, y: scene.y, t: 0 });
    }

    out.forEach((point, index) => {
      point.t = startedAt + ((endedAt - startedAt) * index) / Math.max(1, out.length - 1);
    });

    return out;
  }

  private onStroke(path: FabricObject, penColor: string, inkTool: boolean): void {
    const config = this.config();

    if (!config || !inkTool || !path.isType('Path') || isEraserMark(path)) return;
    // The board may have discarded it (a stray dot, an erase-hold tail).
    if (!this.host.canvas.getObjects().includes(path)) return;
    if (this.ids.has(path)) return;
    const defaultInk = config.defaultInk ?? '#000000';
    const trace = this.takeTrace();
    const endedAt = trace?.endedAt ?? now();
    const startedAt = trace?.startedAt ?? endedAt - 200;

    // The PEN setting decides: the committed colour may be a contrast shade of it (smart ink contrast on
    // dark paper), and that shade is still the default ink.
    const added = this.track(path, sameColor(penColor, defaultInk), startedAt, endedAt, trace);

    if (this.manual()) return;
    // Moving to a new line closes the last one right away; everything else waits for the pause.
    if (added.lineChanged && added.previousLineId) void this.flush(added.previousLineId);
    this.armPause(config.pauseMs ?? DEFAULT_PAUSE_MS);
  }

  /** Register a stroke with the grouper (its pen trace when one matches, else its own outline). */
  private track(path: FabricObject, defaultInk: boolean, startedAt: number, endedAt: number, trace: Trace | null) {
    this.meta.set(path, { defaultInk, createdColor: inkColorOf(path) });
    this.seq += 1;
    const id = `s${this.seq}`;

    this.objects.set(id, path);
    this.ids.set(path, id);
    const box = sceneBox(path);
    const traced = trace ? this.tracePoints(trace, box) : null;
    const points = traced ?? this.pathPoints(path, startedAt, endedAt);

    // Telemetry: how often recognition had to fall back to the committed outline (a mapping problem).
    if (!traced) this.outlineStrokes.add(id);
    const stroke: InkStrokeInput = { id, points, box, startedAt, endedAt };
    const added = this.grouper.addStroke(stroke);

    this.lineVersion.set(added.lineId, (this.lineVersion.get(added.lineId) ?? 0) + 1);

    if (!this.lineIndex.has(added.lineId)) {
      this.lineIndex.set(added.lineId, this.lines);
      this.lines += 1;
    }

    return added;
  }

  /**
   * Ink on the page this session did not see written (opened from storage, or written while auto-colour
   * was off): default-ink and auto-coloured strokes, in the order they were drawn. No pen trace survives
   * a save, so each is read from its outline.
   */
  private adoptUntracked(defaultInk: string): number {
    const base = now() - 3_600_000;
    let adopted = 0;

    for (const object of this.host.canvas.getObjects()) {
      if (this.ids.has(object) || !object.isType('Path') || isEraserMark(object)) continue;
      const marker = markerOf(object);
      const plainInk = sameColor(inkColorOf(object), defaultInk);

      if (!marker && !plainInk) continue;
      const startedAt = base + adopted * 300;

      this.track(object, plainInk || sameColor(marker?.o ?? '', defaultInk), startedAt, startedAt + 200, null);
      adopted += 1;
    }

    return adopted;
  }

  /**
   * «Colour the page»: read and classify every line not yet coloured — strokes written this session and
   * the ink already on the page — and colour them all as ONE undo step. Returns how many strokes changed.
   */
  async colorAll(): Promise<number> {
    const config = this.config();

    if (!config) return 0;

    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }

    this.adoptUntracked(config.defaultInk ?? '#000000');

    for (let tries = 0; this.busy && tries < 600 && !this.disposed; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const sink: PlannedChange[] = [];
    const started = now();

    this.collect = sink;

    try {
      await this.flush(null);
      await this.chain;
    } finally {
      this.collect = null;
    }

    if (sink.length === 0 || !this.config()) return 0;
    await this.serial(() => this.runBatch(sink, config.fadeMs ?? DEFAULT_FADE_MS));
    inkTelemetry({ op: 'recolor', ms: now() - started, chars: sink.length, src: 'page' });

    return sink.length;
  }

  private armPause(ms: number): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      void this.flush(null);
    }, ms);
  }

  // --- corrections ---------------------------------------------------------------------------------

  private textOfGroup(groupId: string): string {
    return this.grouper.group(groupId)?.text ?? '';
  }

  private noteCorrection(marker: InkAutoMarker, to: InkClass | 'manual', afterMs: number): void {
    inkTelemetry({ op: 'correction', from: marker.c, to, ms: afterMs, src: 'auto' });

    if (to === 'manual') return;
    const text = this.textOfGroup(marker.g);

    if (text) this.config()?.memory?.remember(text, to);
  }

  private onModified(target: FabricObject | undefined): void {
    if (this.applying || !target || !this.config()) return;
    const palette = resolvePalette(this.config()?.palette);
    const seen = new Set<string>();

    for (const object of membersOf(target)) {
      const marker = markerOf(object);

      if (!marker) continue;
      const correction = detectCorrection(marker, inkColorOf(object), palette, Date.now());

      if (!correction) continue;
      // The student's colour wins from now on; the marker goes in the same undo step as their edit.
      setMarker(object, null);
      this.groupClass.delete(marker.g);

      if (seen.has(marker.g)) continue;
      seen.add(marker.g);
      this.noteCorrection(marker, correction.to, correction.afterMs);
    }
  }

  /**
   * The class menu: give the selected auto-coloured (or default-ink) strokes `cls`. One undo step;
   * logged as a correction for every word that had another class, and remembered for its phrase.
   * Returns how many strokes changed.
   */
  async overrideSelection(cls: InkClass): Promise<number> {
    const config = this.config();
    const active = this.host.canvas.getActiveObject();

    if (!config || !active) return 0;
    const palette = resolvePalette(config.palette);
    const at = Date.now();
    const planned: Array<{ object: FabricObject; change: RecolorChange }> = [];
    const corrected = new Set<string>();

    const want = palette[cls] ?? null;

    // An explicit choice: it applies to ink the student coloured too (that is what they selected).
    for (const object of membersOf(active)) {
      if (!object.isType('Path') || isEraserMark(object)) continue;
      const marker = markerOf(object);
      const color = inkColorOf(object);
      const groupId = marker?.g ?? this.grouper.groupOfStroke(this.ids.get(object) ?? '')?.id ?? 'manual';
      const original = marker?.o ?? color;
      // `m: 1`: the student chose it — auto-colour never recolours it again (a «plain» choice too).
      const change: RecolorChange | null =
        want === null
          ? marker?.m && marker.c === cls && sameColor(color, original)
            ? null
            : { id: '0', from: color, to: original, marker: { c: cls, k: original, o: original, g: groupId, at, m: 1 } }
          : sameColor(color, want) && marker?.c === cls && marker.m
            ? null
            : { id: '0', from: color, to: want, marker: { c: cls, k: want, o: original, g: groupId, at, m: 1 } };

      if (!change) continue;
      planned.push({ object, change });

      if (marker && marker.c !== cls && !corrected.has(marker.g)) {
        corrected.add(marker.g);
        this.noteCorrection(marker, cls, at - marker.at);
      }

      this.groupClass.set(groupId, cls);
    }

    if (planned.length === 0) return 0;
    await this.serial(() => this.runBatch(planned.map((entry) => ({ ...entry, unit: 'manual' })), 0));

    return planned.length;
  }

  // --- recognise + classify ------------------------------------------------------------------------

  private async flush(onlyLineId: string | null): Promise<void> {
    if (this.busy) {
      this.again = true;

      return;
    }

    this.busy = true;

    try {
      const lines = this.grouper.lines.filter(
        (line) =>
          (onlyLineId === null || line.id === onlyLineId) &&
          (line.groups.some((group) => group.dirty) || (this.processedVersion.get(line.id) ?? -1) !== (this.lineVersion.get(line.id) ?? 0)),
      );

      for (const line of lines) {
        if (!this.config()) break;
        await this.processLine(line);
      }
    } catch {
      // A failed recognition leaves the ink as written.
    } finally {
      this.busy = false;

      if (this.again) {
        this.again = false;
        void this.flush(null);
      }
    }
  }

  private async recognizeGroup(group: InkGroupState, line: InkLineState, lineDir: InkDirection | null, preContext: string): Promise<void> {
    const recognizer = this.config()?.recognizer;
    const strokes = this.grouper.groupStrokes(group).sort((a, b) => a.startedAt - b.startedAt);

    group.dirty = false;

    if (!recognizer || strokes.length === 0) {
      this.timings.set(group.id, { recognizeMs: 0, script: null, engine: 'none', reported: true, ok: false, outline: false });

      return;
    }

    const t0 = strokes[0].startedAt;
    const dirHint = writingDirection(strokes) ?? lineDir;
    const started = now();
    const candidates = await withTimeout(
      (signal) =>
        recognizer.recognize(
          {
            strokes: strokes.map((stroke) =>
              stroke.points.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, t: Math.max(0, Math.round(p.t - t0)) })),
            ),
            langs: ['en'],
            preContext: preContext.slice(-20),
            writingArea: { width: Math.max(1, line.box.right - line.box.left), height: Math.max(1, line.height * 1.6) },
          },
          signal,
        ),
      RECOGNIZE_TIMEOUT_MS,
    ).catch(() => null);
    const recognizeMs = now() - started;
    const pick = candidates ? pickScript(candidates, dirHint, this.lastScript) : null;

    // A first reading; the line's script decides the final one (processLine).
    group.text = pick?.text ?? '';
    this.candidates.set(group.id, candidates ?? []);
    this.timings.set(group.id, {
      recognizeMs,
      script: pick?.script ?? null,
      engine: recognizer.id,
      reported: false,
      ok: Boolean(pick),
      outline: strokes.some((stroke) => this.outlineStrokes.has(stroke.id)),
    });
  }

  /**
   * One script for the whole line (its words are often fragments a per-word pick flips on), then each
   * word's text re-read in it. Reports the line's fresh `recognize` events.
   */
  private settleScript(line: InkLineState, ordered: InkGroupState[], dir: InkDirection | null): void {
    const words = ordered.map((group) => ({ candidates: this.candidates.get(group.id) ?? [], weight: group.strokeIds.length }));
    const script = pickLineScript(words, dir, this.lastScript);

    if (script) {
      this.lastScript = script;

      for (const group of ordered) {
        const candidates = this.candidates.get(group.id);

        if (candidates && candidates.length > 0) group.text = textInScript(candidates, script);
      }
    }

    const lineIndex = this.lineIndex.get(line.id) ?? 0;

    for (const group of ordered) {
      const timing = this.timings.get(group.id);

      if (!timing || timing.reported) continue;
      timing.reported = true;
      if (script && timing.ok) timing.script = script;
      inkTelemetry({
        op: 'recognize',
        engine: timing.engine,
        lang: timing.script ?? '-',
        ms: timing.recognizeMs,
        src: `${timing.ok ? 'ok' : 'none'}-${timing.outline ? 'outline' : 'trace'}`,
        chars: group.text.length,
        extra: [
          ['t', inkDetailText(group.text, 40)],
          ['bb', `${Math.round(group.box.right - group.box.left)}x${Math.round(group.box.bottom - group.box.top)}`],
          ['n', group.strokeIds.length],
          ['L', lineIndex],
        ],
      });
    }
  }

  private async processLine(line: InkLineState): Promise<void> {
    const version = this.lineVersion.get(line.id) ?? 0;

    // Re-cut the whole line into words with its settled letter height before anything is read.
    this.grouper.settleLine(line);
    const dir = this.grouper.lineDirection(line);
    const ordered = this.grouper.readingOrder(line, dir);
    let preContext = '';

    // Words in reading order, so each word's preContext is the text before it.
    for (const group of ordered) {
      if (group.dirty) await this.recognizeGroup(group, line, dir, preContext);
      preContext = `${preContext} ${group.text}`.trim().slice(-20);
    }

    this.settleScript(line, ordered, dir);
    const classifyStart = now();
    const classes = this.classify(line, ordered, dir);
    const result: LineResult = { line, ordered, classes, dir, version, classifyMs: now() - classifyStart };

    this.processedVersion.set(line.id, version);
    await this.apply(result);
    this.maybeEscalate(result);
  }

  private lineCues(line: InkLineState, ordered: InkGroupState[]) {
    const pageHeights = this.grouper.lines.filter((l) => l.letterHeights.length > 0).map((l) => l.height);
    const pageHeight = pageHeights.length > 1 ? median(pageHeights) : line.height;
    const lineWidth = Math.max(1, line.box.right - line.box.left);
    const underlines = line.decorations.filter((d) => d.kind === 'underline');
    const boxes = line.decorations.filter((d) => d.kind === 'box');
    const words = ordered.map((group) => {
      const groupWidth = Math.max(1, group.box.right - group.box.left);
      const underlined = underlines.some(
        (d) => Math.min(d.box.right, group.box.right) - Math.max(d.box.left, group.box.left) >= 0.5 * groupWidth,
      );
      const cx = (group.box.left + group.box.right) / 2;
      const cy = (group.box.top + group.box.bottom) / 2;
      const boxed = boxes.some((d) => cx >= d.box.left && cx <= d.box.right && cy >= d.box.top && cy <= d.box.bottom);

      return { text: group.text, cues: { underlined, boxed, colon: Boolean(group.colon), bullet: Boolean(group.bullet) } };
    });

    return {
      words,
      sizeRatio: pageHeight > 0 ? line.height / pageHeight : 1,
      fullyUnderlined: underlines.some((d) => d.box.right - d.box.left >= 0.8 * lineWidth),
    };
  }

  private classify(line: InkLineState, ordered: InkGroupState[], dir: InkDirection | null): InkClassification[] {
    const { words, sizeRatio, fullyUnderlined } = this.lineCues(line, ordered);
    const classes = classifyLine(words, { sizeRatio, groupCount: ordered.length, fullyUnderlined, dir });
    const memory = this.config()?.memory;

    if (!memory) return classes;

    // The student's own corrections beat the rules: a remembered phrase, then a remembered word.
    const lineText = ordered.map((group) => group.text).join(' ').trim();
    const lineHit = lineText ? memory.lookup(lineText) : null;

    if (lineHit) return classes.map((current) => (current.seg === SEG_BULLET ? current : { ...current, cls: lineHit, conf: 0.95, src: 'memory' as const }));

    // Per segment (never per word: a segment is one colour): its phrase, else the first remembered word.
    const out = [...classes];
    const segs = new Map<number, number[]>();

    classes.forEach((current, index) => {
      const seg = current.seg ?? 1000 + index;

      segs.set(seg, [...(segs.get(seg) ?? []), index]);
    });

    segs.forEach((members, seg) => {
      if (seg === SEG_BULLET) return;
      const phrase = members.map((index) => ordered[index].text).join(' ').trim();
      const hit =
        (phrase ? memory.lookup(phrase) : null) ??
        members.map((index) => (ordered[index].text ? memory.lookup(ordered[index].text) : null)).find((cls) => cls !== null) ??
        null;

      if (hit) for (const index of members) out[index] = { ...classes[index], cls: hit, conf: 0.9, src: 'memory' };
    });

    return out;
  }

  /** Strokes to colour for each word: its own ink plus the decorations that mark it. */
  private targetsFor(line: InkLineState, group: InkGroupState, ordered: InkGroupState[]): FabricObject[] {
    const out: FabricObject[] = [];

    for (const id of group.strokeIds) {
      const object = this.objects.get(id);

      if (object) out.push(object);
    }

    for (const decoration of line.decorations) {
      // A decoration takes the class of the first word (reading order) it touches.
      const owner = ordered.find((candidate) => horizontalGap(candidate.box, decoration.box) === 0);

      if (owner?.id !== group.id) continue;
      const object = this.objects.get(decoration.strokeId);

      if (object) out.push(object);
    }

    return out;
  }

  private async waitForPenUp(): Promise<void> {
    for (let tries = 0; isPointerDown() && tries < 600 && !this.disposed; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Run colour batches one at a time (a fade never meets another batch's half-mixed colours). */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);

    this.chain = next.catch(() => undefined);

    return next;
  }

  private apply(result: LineResult): Promise<void> {
    const queuedAt = now();

    return this.serial(() => this.applyNow(result, now() - queuedAt));
  }

  private async applyNow(result: LineResult, queueMs: number): Promise<void> {
    const config = this.config();

    if (!config) return;
    const waitStart = now();

    // Plan only once the pen is up, from the line as it is then: a line that grew meanwhile is left
    // as it is — its own pause re-classifies it WHOLE, so no segment is coloured from half a line.
    await this.waitForPenUp();
    const waitMs = now() - waitStart;

    if (this.disposed || !this.config()) return;
    if ((this.lineVersion.get(result.line.id) ?? 0) !== result.version || !this.grouper.line(result.line.id)) return;
    const palette = resolvePalette(config.palette);
    const planned: PlannedChange[] = [];
    const at = Date.now();
    const rows: InkDebugEntry[] = [];
    const ends: number[] = [];
    const finishedAt = now();
    const lineIndex = this.lineIndex.get(result.line.id) ?? 0;
    const lineText = result.ordered
      .map((group) => group.text)
      .join(' ')
      .trim();

    result.ordered.forEach((group, index) => {
      const classification = result.classes[index] ?? { cls: 'plain' as const, conf: 0, src: 'none' as const };
      const cls = classification.cls;
      const unit = `${result.line.id}:${classification.seg ?? `w${index}`}`;
      const objects = this.targetsFor(result.line, group, result.ordered);
      const targets: RecolorTarget[] = objects.map((object, n) => {
        const meta = this.meta.get(object);

        return {
          id: String(n),
          color: inkColorOf(object),
          marker: markerOf(object),
          defaultInk: meta?.defaultInk ?? false,
          createdColor: meta?.createdColor ?? null,
        };
      });

      for (const change of planRecolor(targets, cls, palette, group.id, at)) {
        planned.push({ object: objects[Number(change.id)], change, unit });
      }

      const previous = this.groupClass.get(group.id);
      const timing = this.timings.get(group.id);

      this.groupClass.set(group.id, cls);

      if (previous === cls && !timing) return;
      const lastEnd = this.grouper.groupStrokes(group).reduce((max, stroke) => Math.max(max, stroke.endedAt), 0);
      const row: InkDebugEntry = {
        groupId: group.id,
        text: group.text,
        script: timing?.script ?? (group.text ? scriptOfText(group.text) : null),
        cls,
        conf: classification.conf,
        src: classification.src,
        engine: timing?.engine ?? (classification.src === 'cloud' ? 'cloud' : (config.recognizer?.id ?? 'none')),
        recognizeMs: Math.round(timing?.recognizeMs ?? 0),
        totalMs: lastEnd > 0 ? Math.round(Math.max(0, finishedAt - lastEnd)) : 0,
      };
      rows.push(row);
      ends.push(lastEnd);
      this.timings.delete(group.id);
    });

    let batchMs = 0;

    if (this.collect) {
      this.collect.push(...planned);
    } else if (planned.length > 0) {
      const batchStart = now();

      await this.runBatch(planned, config.fadeMs ?? DEFAULT_FADE_MS);
      batchMs = now() - batchStart;
      inkTelemetry({ op: 'recolor', ms: batchMs, chars: planned.length });
    }

    const appliedAt = now();

    rows.forEach((row, index) => {
      if (ends[index] > 0) row.totalMs = Math.round(Math.max(0, appliedAt - ends[index]));
      const group = result.ordered.find((candidate) => candidate.id === row.groupId);

      inkTelemetry({
        op: 'classify',
        engine: row.engine,
        lang: row.script ?? '-',
        cls: row.cls,
        conf: row.conf,
        // ms = the rules alone (synchronous, sub-ms). Where the rest of pen-lift → colour went:
        // lift = all of it (the pen-lift pause included), w = waiting for the pen to lift, q = queued
        // behind another batch, f = the recolour batch (the cross-fade).
        ms: row.src === 'cloud' ? row.totalMs : result.classifyMs,
        src: row.src,
        chars: row.text.length,
        extra: [
          ['t', inkDetailText(row.text, 40)],
          ['bb', group ? `${Math.round(group.box.right - group.box.left)}x${Math.round(group.box.bottom - group.box.top)}` : undefined],
          ['n', group?.strokeIds.length],
          ['L', lineIndex],
          ['lift', row.totalMs],
          ['w', waitMs],
          ['q', queueMs],
          ['f', batchMs],
          ['line', inkDetailText(lineText, 60)],
        ],
      });
    });

    if (rows.length > 0) this.pushDebug(rows);
  }

  private pushDebug(rows: InkDebugEntry[]): void {
    if (!this.config()?.debug) return;
    const ids = new Set(rows.map((row) => row.groupId));

    this.debug = [...rows, ...this.debug.filter((row) => !ids.has(row.groupId))].slice(0, DEBUG_ROWS);
    this.host.onDebug?.(this.debug);
  }

  /**
   * Apply one batch of colour changes: fade, then announce once → one undo step. A segment (`unit`) is
   * all-or-nothing: if any of its strokes is no longer the colour the plan was made from, none of it
   * changes; every stroke that does change moves in the same animation frame.
   */
  private async runBatch(planned: PlannedChange[], fadeMs: number): Promise<void> {
    await this.waitForPenUp();

    if (this.disposed) return;
    const { canvas } = this.host;
    const onCanvas = new Set(canvas.getObjects());
    const present = planned.filter(({ object }) => onCanvas.has(object));
    const stale = new Set(present.filter(({ object, change }) => !sameColor(inkColorOf(object), change.from)).map(({ unit }) => unit));
    const live = present.filter(({ unit }) => !stale.has(unit));

    if (live.length === 0) return;
    const reduced =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.host.commitHistory?.();
    this.applying = true;

    try {
      if (fadeMs > 0 && !reduced && typeof requestAnimationFrame === 'function') {
        const start = now();

        await new Promise<void>((resolve) => {
          const step = () => {
            const t = Math.min(1, (now() - start) / fadeMs);

            if (t >= 1 || this.disposed) {
              resolve();

              return;
            }

            for (const { object, change } of live) object.set(inkProp(object), mixColor(change.from, change.to, t));
            canvas.requestRenderAll();
            requestAnimationFrame(step);
          };

          requestAnimationFrame(step);
        });
      }

      for (const { object, change } of live) {
        object.set(inkProp(object), change.to);
        setMarker(object, change.marker);
        object.set('dirty', true);
        canvas.fire('object:modified', { target: object } as never);
      }

      invalidateInkBake(canvas);
      canvas.requestRenderAll();
    } finally {
      this.applying = false;
    }

    this.host.commitHistory?.();
  }

  // --- cloud escalation ----------------------------------------------------------------------------

  private maybeEscalate(result: LineResult): void {
    const version = result.version;
    const cloud = this.config()?.cloud;

    if (!cloud) return;
    const text = result.ordered
      .map((group) => group.text)
      .join(' ')
      .trim();
    const ambiguous = result.classes.some((c) => c.cls === 'plain' && c.conf < AMBIGUOUS_CONFIDENCE);

    if (!ambiguous || !text) return;
    const { words, sizeRatio } = this.lineCues(result.line, result.ordered);
    const pageLeft = Math.min(...this.grouper.lines.map((line) => line.box.left));
    const request: InkLineForCloud = {
      text,
      lang: scriptOfText(text) ?? 'en',
      cues: {
        relHeight: Math.round(sizeRatio * 100) / 100,
        underlined: words.some((w) => w.cues.underlined),
        boxed: words.some((w) => w.cues.boxed),
        indent: Math.round(Math.max(0, result.line.box.left - pageLeft) / Math.max(1, result.line.height)),
        lineIndex: this.lineIndex.get(result.line.id) ?? 0,
      },
    };
    const started = now();

    void withTimeout((signal) => cloud.classify([request], signal), CLOUD_TIMEOUT_MS)
      .then(async (answers) => {
        const answer = answers[0];
        const ms = now() - started;

        if (!answer) return;
        inkTelemetry({ op: 'classify', engine: 'cloud', lang: request.lang, cls: answer.cls, conf: answer.confidence, ms, src: 'cloud-line', chars: text.length });

        // The line changed since: its next pause classifies it again.
        if ((this.lineVersion.get(result.line.id) ?? 0) !== version || !this.grouper.line(result.line.id)) return;
        if (answer.confidence < AMBIGUOUS_CONFIDENCE || answer.cls === 'plain') return;
        // The cloud only upgrades words the rules left ambiguous; it never overrides a rule decision.
        const classes = result.classes.map((current) =>
          current.cls === 'plain' && current.conf < AMBIGUOUS_CONFIDENCE ? { ...current, cls: answer.cls, conf: answer.confidence, src: 'cloud' as const } : current,
        );

        await this.apply({ ...result, classes });
      })
      .catch(() => undefined);
  }
}
