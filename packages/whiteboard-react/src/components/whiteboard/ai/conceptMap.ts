import type { WbStringKey } from '../../../i18n/strings';
import { extractJsonObject } from './markdownBlocks';
import { sanitizeBox } from './pageAnalysis';

import type {
  ConceptEdgeArrow,
  ConceptMap,
  ConceptMapAnalysis,
  ConceptMapDirection,
  ConceptMapEdge,
  ConceptMapFixOp,
  ConceptMapNode,
  ConceptMapStyle,
  ConceptMapSuggestion,
  ConceptNodeShape,
} from './types';

/**
 * Concept maps — reading one the model transcribed from the teacher's ink, applying the fixes the
 * teacher accepted, and the style the board remembers so generated maps look like the teacher's.
 * All pure; the board objects are built in `boardObjects.ts`.
 */

const SHAPES: ConceptNodeShape[] = ['ellipse', 'rect', 'rounded', 'none', 'diamond'];
const ARROWS: ConceptEdgeArrow[] = ['none', 'end', 'both'];
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const NAMED_COLORS: Record<string, string> = {
  black: '#1f2937', red: '#dc2626', blue: '#2563eb', green: '#16a34a', orange: '#ea580c',
  purple: '#7c3aed', brown: '#92400e', pink: '#db2777', yellow: '#ca8a04', gray: '#6b7280', grey: '#6b7280',
};

export const DEFAULT_CONCEPT_STYLE: ConceptMapStyle = {
  direction: 'tb',
  shape: 'ellipse',
  nodeColors: ['#006fee', '#e11d48', '#22c55e', '#2f5bea'],
  edgeColor: '#18204a',
  strokeWidth: 2.5,
  arrow: 'end',
  font: 'typed',
  spacing: 1,
};

const str = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return undefined;
};

export function normalizeColor(value: unknown): string | undefined {
  const raw = str(value)?.toLowerCase();

  if (!raw) return undefined;
  if (HEX_RE.test(raw)) return raw;

  return NAMED_COLORS[raw];
}

const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => {
  const raw = str(value)?.toLowerCase() as T | undefined;

  return raw && allowed.includes(raw) ? raw : undefined;
};

/** The server's direction enum (TB | LR | RL | BT | radial) and ours (tb | ltr | rtl | radial). */
const DIRECTION_ALIASES: Record<string, ConceptMapDirection> = { tb: 'tb', bt: 'tb', td: 'tb', lr: 'ltr', ltr: 'ltr', rl: 'rtl', rtl: 'rtl', radial: 'radial' };

export const pickDirection = (value: unknown): ConceptMapDirection | undefined => {
  const raw = str(value)?.toLowerCase();

  return raw ? DIRECTION_ALIASES[raw] : undefined;
};

/** Ours → the server's, for `style` on /concept-map/generate. */
export const DIRECTION_WIRE: Record<ConceptMapDirection, 'TB' | 'LR' | 'RL' | 'radial'> = { tb: 'TB', ltr: 'LR', rtl: 'RL', radial: 'radial' };

export function parseConceptMap(input: unknown): ConceptMap | null {
  const value = typeof input === 'string' ? extractJsonObject(input) : input;

  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  // Accept both `{map:{…}}` and the map itself.
  const source = record.map && typeof record.map === 'object' ? (record.map as Record<string, unknown>) : record;
  const nodesRaw = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes: ConceptMapNode[] = [];
  const seen = new Set<string>();

  nodesRaw.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;

    const node = raw as Record<string, unknown>;
    const text = str(node.text ?? node.label ?? node.name);

    if (!text) return;

    let id = str(node.id) ?? `n${index + 1}`;

    while (seen.has(id)) id = `${id}_`;
    seen.add(id);

    const parsed: ConceptMapNode = { id, text };
    const bbox = sanitizeBox(node.bbox);
    const shape = pick(node.shape, SHAPES);
    const color = normalizeColor(node.color);
    const level = typeof node.level === 'number' ? node.level : Number.isFinite(Number(node.level)) ? Number(node.level) : undefined;

    if (bbox) parsed.bbox = bbox;
    if (shape) parsed.shape = shape;
    if (color) parsed.color = color;
    if (level !== undefined && Number.isFinite(level)) parsed.level = Math.max(0, Math.round(level));
    nodes.push(parsed);
  });

  if (nodes.length === 0) return null;

  const ids = new Set(nodes.map((node) => node.id));
  // Models sometimes link by TEXT instead of id.
  const byText = new Map(nodes.map((node) => [node.text, node.id]));
  const resolve = (ref: unknown) => {
    const key = str(ref);

    if (!key) return undefined;

    return ids.has(key) ? key : byText.get(key);
  };
  const edges: ConceptMapEdge[] = [];

  for (const raw of Array.isArray(source.edges) ? source.edges : Array.isArray(source.links) ? source.links : []) {
    if (!raw || typeof raw !== 'object') continue;

    const edge = raw as Record<string, unknown>;
    const from = resolve(edge.from ?? edge.source);
    const to = resolve(edge.to ?? edge.target);

    if (!from || !to || from === to) continue;

    const parsed: ConceptMapEdge = { from, to, arrow: pick(edge.arrow, ARROWS) ?? 'end' };
    const label = str(edge.label ?? edge.text);

    if (label) parsed.label = label;
    edges.push(parsed);
  }

  const map: ConceptMap = { nodes, edges };
  const title = str(source.title);
  const direction = pickDirection(source.direction);
  const style = parseStyle(source.style);

  if (title) map.title = title;
  if (direction) map.direction = direction;
  if (style) map.style = style;

  return map;
}

function parseStyle(value: unknown): Partial<ConceptMapStyle> | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const style: Partial<ConceptMapStyle> = {};
  const nodeColors = (Array.isArray(record.nodeColors) ? record.nodeColors : []).map(normalizeColor).filter(Boolean) as string[];
  const edgeColor = normalizeColor(record.edgeColor);
  const strokeWidth = Number(record.strokeWidth);
  const font = record.font === 'handwriting' || record.font === 'typed' ? record.font : undefined;
  const shape = pick(record.shape, SHAPES);
  const arrow = pick(record.arrow, ARROWS);

  if (nodeColors.length) style.nodeColors = nodeColors;
  if (edgeColor) style.edgeColor = edgeColor;
  if (Number.isFinite(strokeWidth) && strokeWidth > 0) style.strokeWidth = Math.min(12, strokeWidth);
  if (font) style.font = font;
  if (shape) style.shape = shape;
  if (arrow) style.arrow = arrow;

  return Object.keys(style).length > 0 ? style : undefined;
}

const SUGGESTION_KINDS = ['fact', 'missing_concept', 'link', 'spelling', 'other'] as const;

function parseFix(value: unknown, map: ConceptMap): ConceptMapFixOp | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const op = str(record.op ?? record.type);
  const id = str(record.id ?? record.node);
  const text = str(record.text ?? record.newText);
  const from = str(record.from);
  const to = str(record.to);
  const label = str(record.label);
  const hasNode = (nodeId: string | undefined) => Boolean(nodeId && map.nodes.some((node) => node.id === nodeId));

  switch (op) {
    case 'rename_node':
      return hasNode(id) && text ? { op, id: id!, text } : undefined;
    case 'add_node': {
      if (!text) return undefined;

      const fix: ConceptMapFixOp = { op, id: id && !hasNode(id) ? id : `new_${Math.abs(hash(text))}`, text };
      const parent = str(record.parent);

      if (hasNode(parent)) fix.parent = parent;
      if (label) fix.label = label;

      return fix;
    }
    case 'remove_node':
      return hasNode(id) ? { op, id: id! } : undefined;
    case 'add_edge':
      return hasNode(from) && hasNode(to) ? { op, from: from!, to: to!, ...(label ? { label } : {}) } : undefined;
    case 'remove_edge':
      return hasNode(from) && hasNode(to) ? { op, from: from!, to: to! } : undefined;
    case 'relabel_edge':
      return hasNode(from) && hasNode(to) && label ? { op, from: from!, to: to!, label } : undefined;
    default:
      return undefined;
  }
}

function hash(text: string): number {
  let h = 0;

  for (const char of text) h = (h * 31 + char.charCodeAt(0)) | 0;

  return h;
}

/**
 * The teacher endpoint's `fixes` (BE contract: {type, target: node id | "from->to", suggestion,
 * reason}) → our suggestions, each with an applicable fix where the target makes one obvious.
 */
export function fixesToSuggestions(fixes: unknown, map: ConceptMap): ConceptMapSuggestion[] {
  if (!Array.isArray(fixes)) return [];

  const has = (id: string) => map.nodes.some((node) => node.id === id);
  const byText = (text: string) => map.nodes.find((node) => node.text === text)?.id;

  return fixes
    .filter((raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === 'object')
    .map((raw, index): ConceptMapSuggestion | null => {
      const kind = (SUGGESTION_KINDS as readonly string[]).includes(String(raw.type)) ? (String(raw.type) as ConceptMapSuggestion['kind']) : 'other';
      const suggestion = str(raw.suggestion) ?? '';
      const reason = str(raw.reason) ?? '';
      const target = str(raw.target) ?? '';
      const message = [suggestion, reason].filter(Boolean).join(' — ');

      if (!message) return null;

      const result: ConceptMapSuggestion = { id: str(raw.id) ?? `f${index + 1}`, kind, message };
      const [fromRaw, toRaw] = target.includes('->') ? target.split('->').map((part) => part.trim()) : [];
      const from = fromRaw && (has(fromRaw) ? fromRaw : byText(fromRaw));
      const to = toRaw && (has(toRaw) ? toRaw : byText(toRaw));
      const nodeId = !target.includes('->') && target ? (has(target) ? target : byText(target)) : undefined;
      // A suggestion is applicable text only when it is short — a sentence of advice is not a label.
      const shortText = suggestion && suggestion.length <= 40 ? suggestion : undefined;

      if (from && to) {
        const exists = map.edges.some((edge) => edge.from === from && edge.to === to);

        if (exists && shortText) result.fix = { op: 'relabel_edge', from, to, label: shortText };
        else if (!exists) result.fix = { op: 'add_edge', from, to, ...(shortText ? { label: shortText } : {}) };
      } else if (kind === 'missing_concept' && shortText) {
        result.fix = { op: 'add_node', id: `new_${index + 1}`, text: shortText, ...(nodeId ? { parent: nodeId } : {}) };
      } else if ((kind === 'spelling' || kind === 'fact') && nodeId && shortText) {
        result.fix = { op: 'rename_node', id: nodeId, text: shortText };

        // «written on the board as «X»» — the label as drawn, when the reason quotes it.
        const drawn = kind === 'spelling' ? reason.match(/«([^»]+)»/)?.[1]?.trim() : undefined;

        if (drawn && drawn !== shortText) result.drawn = drawn;
      }

      return result;
    })
    .filter((item): item is ConceptMapSuggestion => item !== null);
}

export function parseConceptMapAnalysis(input: unknown): ConceptMapAnalysis | null {
  const raw = typeof input === 'string' ? extractJsonObject(input) : input;
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;

  // Teacher endpoint shape: {graph, fixes} (+ serverLayout from the generate route).
  if (record && record.graph && typeof record.graph === 'object') {
    const map = parseConceptMap(record.graph);

    if (!map) return null;
    if (record.serverLayout === true) map.serverLayout = true;

    const suggestions = fixesToSuggestions(record.fixes, map);

    // The server may hand back node text ALREADY corrected (spelling), naming the drawn form only in
    // the reason («written on the board as «granit»»). The copy must start from what the teacher drew,
    // so accepting the fix is what replaces it.
    for (const suggestion of suggestions) {
      if (suggestion.kind !== 'spelling' || suggestion.fix?.op !== 'rename_node' || !suggestion.drawn) continue;

      const id = suggestion.fix.id;
      const node = map.nodes.find((candidate) => candidate.id === id);

      if (node && node.text === suggestion.fix.text) node.text = suggestion.drawn;
    }

    return { map, suggestions, ...(typeof record.checked === 'boolean' ? { checked: record.checked } : {}) };
  }

  const value = raw;
  const map = parseConceptMap(value);

  if (!map) return null;

  const body = (value ?? {}) as Record<string, unknown>;
  const suggestions: ConceptMapSuggestion[] = [];

  (Array.isArray(body.suggestions) ? body.suggestions : []).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;

    const item = raw as Record<string, unknown>;
    const message = str(item.message ?? item.text ?? item.reason);

    if (!message) return;

    const kind = (SUGGESTION_KINDS as readonly string[]).includes(String(item.kind ?? item.type))
      ? (String(item.kind ?? item.type) as ConceptMapSuggestion['kind'])
      : 'other';
    const suggestion: ConceptMapSuggestion = { id: str(item.id) ?? `s${index + 1}`, kind, message };
    const fix = parseFix(item.fix ?? item.apply, map);

    if (fix) suggestion.fix = fix;
    suggestions.push(suggestion);
  });

  return { map, suggestions };
}

/** The teacher's accepted fixes, applied to a COPY of the map (the original ink is never touched). */
export function applyConceptFixes(map: ConceptMap, fixes: ConceptMapFixOp[]): ConceptMap {
  const nodes = map.nodes.map((node) => ({ ...node }));
  let edges = map.edges.map((edge) => ({ ...edge }));

  for (const fix of fixes) {
    switch (fix.op) {
      case 'rename_node': {
        const node = nodes.find((candidate) => candidate.id === fix.id);

        if (node) node.text = fix.text;
        break;
      }
      case 'add_node': {
        if (nodes.some((node) => node.id === fix.id)) break;

        const parent = fix.parent ? nodes.find((node) => node.id === fix.parent) : undefined;

        nodes.push({ id: fix.id, text: fix.text, level: parent?.level !== undefined ? parent.level + 1 : undefined });

        if (parent) edges.push({ from: parent.id, to: fix.id, arrow: 'end', ...(fix.label ? { label: fix.label } : {}) });
        break;
      }
      case 'remove_node': {
        const index = nodes.findIndex((node) => node.id === fix.id);

        if (index >= 0) nodes.splice(index, 1);
        edges = edges.filter((edge) => edge.from !== fix.id && edge.to !== fix.id);
        break;
      }
      case 'add_edge':
        if (!edges.some((edge) => edge.from === fix.from && edge.to === fix.to)) {
          edges.push({ from: fix.from, to: fix.to, arrow: 'end', ...(fix.label ? { label: fix.label } : {}) });
        }
        break;
      case 'remove_edge':
        edges = edges.filter((edge) => !(edge.from === fix.from && edge.to === fix.to));
        break;
      case 'relabel_edge': {
        const edge = edges.find((candidate) => candidate.from === fix.from && candidate.to === fix.to);

        if (edge) edge.label = fix.label;
        break;
      }
      default:
        break;
    }
  }

  return { ...map, nodes, edges };
}

/**
 * The style a map was drawn in: the model's own `style` wins, then what the nodes/edges show
 * (dominant shape, colours), then `fallback` — typically the teacher's current pen colour/width.
 */
export function deriveConceptStyle(map: ConceptMap, fallback: Partial<ConceptMapStyle> = {}): ConceptMapStyle {
  const base: ConceptMapStyle = { ...DEFAULT_CONCEPT_STYLE, ...fallback };
  const shapes = new Map<ConceptNodeShape, number>();

  for (const node of map.nodes) if (node.shape) shapes.set(node.shape, (shapes.get(node.shape) ?? 0) + 1);

  const dominantShape = Array.from(shapes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  const colors = Array.from(new Set(map.nodes.map((node) => node.color).filter((color): color is string => Boolean(color))));
  const arrows = new Map<ConceptEdgeArrow, number>();

  for (const edge of map.edges) arrows.set(edge.arrow ?? 'end', (arrows.get(edge.arrow ?? 'end') ?? 0) + 1);

  const dominantArrow = Array.from(arrows.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    ...base,
    direction: map.direction ?? base.direction,
    shape: map.style?.shape ?? (dominantShape && dominantShape !== 'diamond' ? dominantShape : base.shape),
    nodeColors: map.style?.nodeColors?.length ? map.style.nodeColors : colors.length ? colors : base.nodeColors,
    edgeColor: map.style?.edgeColor ?? base.edgeColor,
    strokeWidth: map.style?.strokeWidth ?? base.strokeWidth,
    arrow: map.style?.arrow ?? dominantArrow ?? base.arrow,
    font: map.style?.font ?? base.font,
  };
}

/** Assigns `level` from the edges when the source has none (roots = no incoming edge). */
export function withLevels(map: ConceptMap): ConceptMap {
  if (map.nodes.every((node) => node.level !== undefined)) return map;

  const incoming = new Map(map.nodes.map((node) => [node.id, 0]));

  for (const edge of map.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  const level = new Map<string, number>();
  const roots = map.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  const queue = roots.length ? [...roots] : map.nodes.slice(0, 1).map((node) => node.id);

  queue.forEach((id) => level.set(id, 0));

  while (queue.length) {
    const current = queue.shift()!;

    for (const edge of map.edges) {
      if (edge.from === current && !level.has(edge.to)) {
        level.set(edge.to, (level.get(current) ?? 0) + 1);
        queue.push(edge.to);
      }
    }
  }

  return { ...map, nodes: map.nodes.map((node) => ({ ...node, level: node.level ?? level.get(node.id) ?? 1 })) };
}

// ---------------------------------------------------------------------------
// Remembered style: per board, with a per-device «my style» default.
// ---------------------------------------------------------------------------

const STYLE_KEY_PREFIX = 'wb-ai-concept-style:';
const DEVICE_STYLE_KEY = `${STYLE_KEY_PREFIX}device`;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const safeStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function readConceptStyle(boardId: string | undefined, storage: StorageLike | null = safeStorage()): ConceptMapStyle | null {
  if (!storage) return null;

  for (const key of [boardId ? `${STYLE_KEY_PREFIX}board:${boardId}` : null, DEVICE_STYLE_KEY]) {
    if (!key) continue;

    try {
      const raw = storage.getItem(key);

      if (!raw) continue;

      const parsed = JSON.parse(raw) as Partial<ConceptMapStyle>;

      if (parsed && typeof parsed === 'object') return { ...DEFAULT_CONCEPT_STYLE, ...parsed };
    } catch {
      /* corrupt entry — try the next */
    }
  }

  return null;
}

/** Saves for this board AND as the device default, so the next board starts in the same hand. */
export function writeConceptStyle(boardId: string | undefined, style: ConceptMapStyle, storage: StorageLike | null = safeStorage()): void {
  if (!storage) return;

  const raw = JSON.stringify(style);

  try {
    if (boardId) storage.setItem(`${STYLE_KEY_PREFIX}board:${boardId}`, raw);
    storage.setItem(DEVICE_STYLE_KEY, raw);
  } catch {
    /* quota / private mode — style is a convenience */
  }
}

export const SUGGESTION_KIND_LABELS: Record<ConceptMapSuggestion['kind'], WbStringKey> = {
  fact: 'ai.suggestion.fact',
  missing_concept: 'ai.suggestion.missing_concept',
  link: 'ai.suggestion.link',
  spelling: 'ai.suggestion.spelling',
  other: 'ai.suggestion.other',
};

export const DIRECTION_LABELS: Record<ConceptMapDirection, WbStringKey> = {
  rtl: 'ai.direction.rtl',
  ltr: 'ai.direction.ltr',
  tb: 'ai.direction.tb',
  radial: 'ai.direction.radial',
};

/**
 * The teacher's ink colours, straight from the pixels of their map — the guest model reads the map
 * through a text transcript, which loses colour. Near-white and grey are background/paper; very dark
 * pixels are "black ink". Colours are bucketed coarsely and returned most-used first.
 */
export function dominantInkColors(data: Uint8ClampedArray, { stride = 3, max = 3 }: { stride?: number; max?: number } = {}): string[] {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();

  for (let offset = 0; offset < data.length; offset += 4 * stride) {
    const r = data[offset]!;
    const g = data[offset + 1]!;
    const b = data[offset + 2]!;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);

    if (data[offset + 3]! < 128 || minC > 225) continue; // paper

    const saturation = maxC === 0 ? 0 : (maxC - minC) / maxC;

    if (saturation < 0.25 && maxC > 90) continue; // grey: grid, anti-aliasing

    const key = saturation < 0.25 ? 'ink' : `${r >> 5}-${g >> 5}-${b >> 5}`;
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };

    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }

  const total = Array.from(buckets.values()).reduce((sum, bucket) => sum + bucket.count, 0);
  const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0');

  const hueOf = (r: number, g: number, b: number) => {
    const maxC = Math.max(r, g, b);
    const delta = maxC - Math.min(r, g, b);

    if (delta === 0) return -1;

    const h = maxC === r ? ((g - b) / delta) % 6 : maxC === g ? (b - r) / delta + 2 : (r - g) / delta + 4;

    return (h * 60 + 360) % 360;
  };
  const picked: Array<{ hex: string; hue: number }> = [];

  // Anti-aliased edges of one stroke land in neighbouring buckets — one hue counts once.
  for (const [key, bucket] of Array.from(buckets.entries()).sort((a, b) => b[1].count - a[1].count)) {
    if (bucket.count < total * 0.03 || picked.length >= max) continue;

    const r = bucket.r / bucket.count;
    const g = bucket.g / bucket.count;
    const b = bucket.b / bucket.count;
    const hue = key === 'ink' ? -1 : hueOf(r, g, b);
    const sameHue = picked.some((other) => (other.hue < 0 || hue < 0 ? other.hue === hue : Math.min(Math.abs(other.hue - hue), 360 - Math.abs(other.hue - hue)) < 30));

    if (!sameHue) picked.push({ hex: key === 'ink' ? '#18204a' : `#${hex(r)}${hex(g)}${hex(b)}`, hue });
  }

  return picked.map((color) => color.hex);
}
