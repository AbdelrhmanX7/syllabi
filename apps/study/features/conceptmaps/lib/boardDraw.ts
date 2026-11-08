// «Draw on board»: the AI reference map handed to a notebook page's board, which draws it in hand
// ink on open (the engine's `pendingConceptMap`). Two device tables over a Storage-like store, so the
// tests need no DOM:
//
//   pending   page id → the graph to draw there, consumed ONCE by the board after its document loads
//   pages     map id  → the notebook page its reference was drawn on (+ which graph), so a second tap
//                       opens that page instead of making another, and the page knows its map
import type { KeyValueStore } from '../notes/links';
import type { ReferenceMap } from '../types';

import { layoutDiagram } from './diagram';

export const PENDING_DRAW_KEY = 'study_cm_board_draw';
export const REFERENCE_PAGES_KEY = 'study_cm_reference_pages';
/** Fired on `window` when a draw is queued, so a board already open on that page draws it now. */
export const BOARD_DRAW_EVENT = 'study:board-draw';

/** A queued draw older than this is stale (the page was never opened) and is dropped. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingRow {
  graph: ReferenceMap;
  at: number;
}

export interface ReferencePage {
  pageId: string;
  /** `graphSignature` of the graph last drawn there. */
  signature: string;
}

function readJson<T extends object>(store: KeyValueStore | null, key: string): Partial<Record<string, T>> {
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(key) ?? '{}') as unknown;

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<Record<string, T>>) : {};
  } catch {
    return {};
  }
}

function writeJson(store: KeyValueStore | null, key: string, value: object): boolean {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));

    return true;
  } catch {
    return false;
  }
}

const isGraph = (value: unknown): value is ReferenceMap =>
  Boolean(value) && typeof value === 'object' && Array.isArray((value as ReferenceMap).nodes) && Array.isArray((value as ReferenceMap).edges);

/** Same nodes + links → same signature (provenance and order of keys do not count). */
export function graphSignature(graph: ReferenceMap): string {
  const text = JSON.stringify([
    graph.title ?? '',
    graph.nodes.map((node) => [node.id, node.text]),
    graph.edges.map((edge) => [edge.from, edge.to, edge.label ?? '']),
  ]);
  let hash = 5381;

  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;

  return `${graph.nodes.length}:${graph.edges.length}:${(hash >>> 0).toString(36)}`;
}

export function queueBoardDraw(store: KeyValueStore | null, pageId: string, graph: ReferenceMap, now = Date.now()): boolean {
  const table = readJson<PendingRow>(store, PENDING_DRAW_KEY);
  // Only what the board draws: the provenance stays behind.
  const { provenance: _provenance, ...drawn } = graph;

  for (const [id, row] of Object.entries(table)) if (!row || now - row.at > PENDING_TTL_MS) delete table[id];
  table[pageId] = { graph: drawn, at: now };

  return writeJson(store, PENDING_DRAW_KEY, table);
}

/** The graph waiting for this page (not removed — `clearBoardDraw` once the board has drawn it). */
export function peekBoardDraw(store: KeyValueStore | null, pageId: string, now = Date.now()): ReferenceMap | null {
  const row = readJson<PendingRow>(store, PENDING_DRAW_KEY)[pageId];

  if (!row || !isGraph(row.graph) || typeof row.at !== 'number' || now - row.at > PENDING_TTL_MS) return null;

  return row.graph;
}

export function clearBoardDraw(store: KeyValueStore | null, pageId: string): void {
  const table = readJson<PendingRow>(store, PENDING_DRAW_KEY);

  if (!(pageId in table)) return;
  delete table[pageId];
  writeJson(store, PENDING_DRAW_KEY, table);
}

export function referencePageFor(store: KeyValueStore | null, mapId: string): ReferencePage | null {
  const row = readJson<ReferencePage>(store, REFERENCE_PAGES_KEY)[mapId];

  return row && typeof row.pageId === 'string' && row.pageId ? { pageId: row.pageId, signature: typeof row.signature === 'string' ? row.signature : '' } : null;
}

export function rememberReferencePage(store: KeyValueStore | null, mapId: string, page: ReferencePage): boolean {
  const table = readJson<ReferencePage>(store, REFERENCE_PAGES_KEY);

  table[mapId] = page;

  return writeJson(store, REFERENCE_PAGES_KEY, table);
}

/** Map ids whose reference was drawn on this page. */
export function mapsDrawnOnPage(store: KeyValueStore | null, pageId: string): string[] {
  return Object.entries(readJson<ReferencePage>(store, REFERENCE_PAGES_KEY))
    .filter(([, row]) => row?.pageId === pageId)
    .map(([mapId]) => mapId);
}

/** Forget a page that no longer exists (a 404 on open), so the next tap makes a fresh one. */
export function forgetReferencePage(store: KeyValueStore | null, mapId: string): void {
  const table = readJson<ReferencePage>(store, REFERENCE_PAGES_KEY);

  delete table[mapId];
  writeJson(store, REFERENCE_PAGES_KEY, table);
}

/**
 * What the board gets: the backend graph shape (`bbox` arrays, labelled end-arrows) that the engine's
 * `parseConceptMap` reads, with the boxes marked as a ready layout. The boxes are the viewer's own
 * layered layout (`layoutDiagram`), normalised to 0..1 — never the backend's `bbox`: that grid knows
 * nothing about text length, so the ink drawn from it ran arrows through nodes and phrases onto each
 * other. (The board's hand planner now re-runs the same layered layout on its WRITTEN sizes and
 * ignores these boxes; they stay for other readers of the wire shape.)
 */
export function boardGraphInput(graph: ReferenceMap): Record<string, unknown> {
  const diagram = layoutDiagram(graph.nodes, graph.edges);
  const boxes = new Map(
    diagram.nodes.map((node) => [
      node.id,
      [node.x / diagram.width, node.y / diagram.height, node.w / diagram.width, node.h / diagram.height],
    ]),
  );

  return {
    ...(graph.title ? { title: graph.title } : {}),
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      text: node.text,
      ...(node.level === undefined ? {} : { level: node.level }),
      ...(boxes.has(node.id) ? { bbox: boxes.get(node.id) } : {}),
    })),
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, arrow: 'end', ...(edge.label ? { label: edge.label } : {}) })),
  };
}

/** «Plate Tectonics — reference map». */
export const referencePageTitle = (title: string) => `${title.trim() || 'Concept map'} — reference map`;
