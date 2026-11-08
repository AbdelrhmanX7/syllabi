/**
 * Live co-editing of a shared notebook page (sharing phase 2 part B): the board document merged per
 * item. KEEP IN STEP with the server copy, `apps/server/src/services/share/live-merge.ts`. Both run the same
 * test cases, and the server cannot import the app packages.
 *
 * A board document is `{pages: [{id, canvasJSON, …}]}`. Each page's `canvasJSON` is Fabric JSON whose
 * `objects` are the page's items (strokes, text boxes, images, shapes). Each item carries a stable id in
 * `oid`. The editor gives new items a random one. Items saved before ids existed get one derived from
 * their own JSON (a hash plus how many identical items came before it on that page), so every device
 * and the server name an old item the same way without a migration.
 *
 * A change is a set of OPS, found by comparing a device's board against the version it last had:
 *   pages         page records added or changed (paper, size, PDF fields), never the per-device view
 *   removedPages  page ids taken out
 *   order         the page order, when it moved
 *   items         per page: `put` (whole item JSON, added or changed) and `del` (item ids)
 * The server applies ops to the CURRENT version under a per-page lock, so arrival order decides: the last
 * change to an item wins, a deleted item stays deleted unless someone puts it back later (undo).
 */

export const ITEM_ID_KEY = "oid";

export type Json = Record<string, unknown>;

export interface BoardPage {
  id: string;
  canvasJSON?: string;
  [key: string]: unknown;
}

export interface BoardDoc {
  pages: BoardPage[];
  [key: string]: unknown;
}

export interface PageItemOps {
  page: string;
  put?: Json[];
  del?: string[];
}

export interface LiveOps {
  pages?: Json[];
  removedPages?: string[];
  order?: string[];
  items?: PageItemOps[];
}

/** Page fields that belong to one device (where it is scrolled, its preview) or to the items. */
const NOT_META = new Set([
  "canvasJSON",
  "thumbnail",
  "viewportOffsetX",
  "viewportOffsetY",
  "viewportZoom",
]);

/** cyrb53: a small, fast, well-spread 53-bit string hash, the same in every JS runtime. */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const isObj = (v: unknown): v is Json =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export const itemIdOf = (item: unknown): string | null => {
  const id = isObj(item) ? item[ITEM_ID_KEY] : null;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : null;
};

interface ParsedCanvas {
  wrapper: Json;
  objects: Json[];
}

/** A page's Fabric JSON; null when it is present but unreadable (never overwrite what we cannot read). */
export function parseCanvas(canvasJSON: unknown): ParsedCanvas | null {
  if (canvasJSON === undefined || canvasJSON === null || canvasJSON === "")
    return { wrapper: {}, objects: [] };
  if (typeof canvasJSON !== "string") return null;
  try {
    const parsed = JSON.parse(canvasJSON);
    if (!isObj(parsed)) return null;
    const objects = Array.isArray(parsed.objects)
      ? parsed.objects.filter(isObj)
      : [];
    return { wrapper: parsed, objects };
  } catch {
    return null;
  }
}

export const stringifyCanvas = (canvas: ParsedCanvas): string =>
  JSON.stringify({ ...canvas.wrapper, objects: canvas.objects });

/**
 * Give every item without an id the one derived from its JSON. Mutates `objects`; true when any changed.
 * The hash covers the page id and the item exactly as stored, and the n-th identical item gets `.n`.
 */
export function assignLegacyIds(pageId: string, objects: Json[]): boolean {
  let changed = false;
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  for (const item of objects) {
    const id = itemIdOf(item);
    if (id) taken.add(id);
  }
  objects.forEach((item, index) => {
    if (itemIdOf(item)) return;
    const json = JSON.stringify(item);
    const n = seen.get(json) ?? 0;
    seen.set(json, n + 1);
    let id = `h${hashString(`${pageId}\n${json}`)}${n ? `.${n}` : ""}`;
    while (taken.has(id)) id = `${id}x`;
    taken.add(id);
    // The id goes first, where the editor writes it (custom properties come before `type`).
    objects[index] = { [ITEM_ID_KEY]: id, ...item };
    changed = true;
  });
  return changed;
}

/** Every page of `doc` with ids on all items (pages whose JSON cannot be read are left alone). */
export function ensureDocIds<T extends BoardDoc>(doc: T): T {
  if (!doc || !Array.isArray(doc.pages)) return doc;
  let touched = false;
  const pages = doc.pages.map((page) => {
    const canvas = parseCanvas(page.canvasJSON);
    if (!canvas || !assignLegacyIds(page.id, canvas.objects)) return page;
    touched = true;
    return { ...page, canvasJSON: stringifyCanvas(canvas) };
  });
  return touched ? { ...doc, pages } : doc;
}

/** Numbers this close are the same coordinate (pages keep two decimals; Fabric re-derives boxes). */
const TOLERANCE = 0.05;

export function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= TOLERANCE;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equivalent(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => k in b && equivalent(a[k], b[k]));
  }
  return false;
}

export function pageMeta(page: BoardPage): Json {
  const meta: Json = {};
  for (const key of Object.keys(page).sort())
    if (!NOT_META.has(key) && page[key] !== undefined) meta[key] = page[key];
  return meta;
}

/**
 * The frame a page was first written in (`canvasWidthPx`, the PDF placement, the sheet shape). It is
 * recorded once, on the page's first save, from that device's pane, so two tablets can disagree. Once
 * a page has it, a different value from another device is not a change: comparing it would make each
 * tablet re-send its own frame and reload the other's editor back and forth.
 */
export const FRAME_KEYS = new Set(["canvasWidthPx", "pdfPlacement", "sheetAspect"]);

/** `b`'s page settings equal `a`'s, not counting the frame keys `a` already has. */
export function sameMeta(a: BoardPage, b: BoardPage): boolean {
  const left = pageMeta(a);
  const right = pageMeta(b);
  for (const key of FRAME_KEYS)
    if (left[key] !== undefined && left[key] !== null) {
      delete left[key];
      delete right[key];
    }
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * True when `ops` only changes items on pages `doc` already has: page settings that match (frame
 * aside), nothing removed, the same page order. Such ops go on screen item by item; anything else
 * reloads the editor.
 */
export function itemsOnlyFor(doc: BoardDoc, ops: LiveOps): boolean {
  if (ops.removedPages?.length) return false;
  const local = new Map(doc.pages.map((p) => [p.id, p] as const));
  for (const meta of ops.pages ?? []) {
    const page = isObj(meta) && typeof meta.id === "string" ? local.get(meta.id) : undefined;
    if (!page || !sameMeta(page, meta as BoardPage)) return false;
  }
  if (ops.order && ops.order.join("\n") !== doc.pages.map((p) => p.id).join("\n")) return false;
  return true;
}

function itemsById(
  page: BoardPage,
): Map<string, { item: Json; json: string }> | null {
  const canvas = parseCanvas(page.canvasJSON);
  if (!canvas) return null;
  assignLegacyIds(page.id, canvas.objects);
  const map = new Map<string, { item: Json; json: string }>();
  for (const item of canvas.objects) {
    const id = itemIdOf(item);
    if (id && !map.has(id)) map.set(id, { item, json: JSON.stringify(item) });
  }
  return map;
}

/** What `next` changed relative to `base`; null when nothing did. */
export function diffDocs(
  base: BoardDoc | null,
  next: BoardDoc,
): LiveOps | null {
  const basePages = new Map((base?.pages ?? []).map((p) => [p.id, p] as const));
  const nextIds = new Set(next.pages.map((p) => p.id));
  const ops: LiveOps = {};
  const pages: Json[] = [];
  const items: PageItemOps[] = [];

  for (const page of next.pages) {
    const before = basePages.get(page.id);
    if (!before || !sameMeta(before, page)) pages.push(pageMeta(page));
    if (before && before.canvasJSON === page.canvasJSON) continue;
    const mine = itemsById(page);
    if (!mine) continue;
    const theirs = before
      ? itemsById(before)
      : new Map<string, { item: Json; json: string }>();
    if (!theirs) continue;
    const put: Json[] = [];
    const del: string[] = [];
    for (const [id, entry] of mine) {
      const old = theirs.get(id);
      if (
        !old ||
        (old.json !== entry.json && !equivalent(old.item, entry.item))
      )
        put.push(entry.item);
    }
    for (const id of theirs.keys()) if (!mine.has(id)) del.push(id);
    if (put.length || del.length)
      items.push({
        page: page.id,
        ...(put.length ? { put } : {}),
        ...(del.length ? { del } : {}),
      });
  }

  const removed = (base?.pages ?? [])
    .filter((p) => !nextIds.has(p.id))
    .map((p) => p.id);
  const baseOrder = (base?.pages ?? [])
    .map((p) => p.id)
    .filter((id) => nextIds.has(id));
  const nextOrder = next.pages
    .map((p) => p.id)
    .filter((id) => basePages.has(id));
  if (pages.length) ops.pages = pages;
  if (removed.length) ops.removedPages = removed;
  if (
    baseOrder.join("\n") !== nextOrder.join("\n") ||
    pages.some((p) => !basePages.has(String(p.id)))
  )
    ops.order = next.pages.map((p) => p.id);
  if (items.length) ops.items = items;
  return Object.keys(ops).length ? ops : null;
}

const emptyCanvasJson = (doc: BoardDoc): string => {
  for (const page of doc.pages) {
    const canvas = parseCanvas(page.canvasJSON);
    if (canvas && typeof canvas.wrapper.version === "string")
      return JSON.stringify({ version: canvas.wrapper.version, objects: [] });
  }
  return JSON.stringify({ objects: [] });
};

/** Put `ops` into `doc` (a new document; `doc` is not changed). Ops for pages that are gone are dropped. */
export function applyOps<T extends BoardDoc>(
  doc: T,
  ops: LiveOps | null | undefined,
): T {
  if (!ops) return doc;
  const removed = new Set(
    (ops.removedPages ?? []).filter((id) => typeof id === "string"),
  );
  let pages: BoardPage[] = (Array.isArray(doc.pages) ? doc.pages : []).filter(
    (p) => !removed.has(p.id),
  );

  for (const meta of ops.pages ?? []) {
    if (
      !isObj(meta) ||
      typeof meta.id !== "string" ||
      !meta.id ||
      removed.has(meta.id)
    )
      continue;
    const index = pages.findIndex((p) => p.id === meta.id);
    const clean: Json = {};
    for (const key of Object.keys(meta))
      if (!NOT_META.has(key)) clean[key] = meta[key];
    if (index >= 0) {
      const old = pages[index];
      const kept: Json = {};
      for (const key of Object.keys(old))
        if (NOT_META.has(key)) kept[key] = old[key];
      // the frame is recorded once: the first record wins over another tablet's (or a missing one)
      for (const key of FRAME_KEYS)
        if (old[key] !== undefined && old[key] !== null) kept[key] = old[key];
      pages = pages.slice();
      pages[index] = { ...(clean as BoardPage), ...kept, id: meta.id };
    } else {
      pages = [
        ...pages,
        {
          ...(clean as BoardPage),
          id: meta.id,
          canvasJSON: emptyCanvasJson(doc),
          thumbnail: "",
        },
      ];
    }
  }

  for (const op of ops.items ?? []) {
    if (!isObj(op) || typeof op.page !== "string") continue;
    const index = pages.findIndex((p) => p.id === op.page);
    if (index < 0) continue;
    const canvas = parseCanvas(pages[index].canvasJSON);
    if (!canvas) continue;
    assignLegacyIds(op.page, canvas.objects);
    const dels = new Set(
      (Array.isArray(op.del) ? op.del : []).filter(
        (id): id is string => typeof id === "string",
      ),
    );
    let objects = dels.size
      ? canvas.objects.filter((item) => !dels.has(itemIdOf(item) ?? ""))
      : canvas.objects.slice();
    for (const item of Array.isArray(op.put) ? op.put : []) {
      const id = itemIdOf(item);
      if (!id) continue;
      const at = objects.findIndex((o) => itemIdOf(o) === id);
      if (at >= 0) objects[at] = item;
      else objects = [...objects, item];
    }
    pages = pages.slice();
    pages[index] = {
      ...pages[index],
      canvasJSON: stringifyCanvas({ wrapper: canvas.wrapper, objects }),
    };
  }

  if (Array.isArray(ops.order)) {
    const present = new Map(pages.map((p) => [p.id, p] as const));
    const ordered: BoardPage[] = [];
    const placed = new Set<string>();
    for (const id of ops.order) {
      const page = typeof id === "string" ? present.get(id) : undefined;
      if (page && !placed.has(id)) {
        ordered.push(page);
        placed.add(id);
      }
    }
    // Pages this device did not know about (someone else added them) stay after the page they followed.
    pages.forEach((page, i) => {
      if (placed.has(page.id)) return;
      let after = -1;
      for (let j = i - 1; j >= 0; j--) {
        const at = ordered.indexOf(pages[j]);
        if (at >= 0) {
          after = at;
          break;
        }
      }
      ordered.splice(after + 1, 0, page);
      placed.add(page.id);
    });
    pages = ordered;
  }

  const out = { ...doc, pages } as T;
  const current = (doc as Json).currentPageIndex;
  if (typeof current === "number" && pages.length)
    (out as Json).currentPageIndex = Math.min(
      Math.max(0, current),
      pages.length - 1,
    );
  return out;
}

/** Three-way merge: `local`'s changes since `base`, put onto `remote`. */
export const mergeDocs = <T extends BoardDoc>(
  base: BoardDoc | null,
  local: BoardDoc,
  remote: T,
): T => applyOps(remote, diffDocs(base, local));

/** Shape check for ops arriving over the wire. Returns an error message or null. */
export function opsError(
  ops: unknown,
  limits = { items: 5000, pages: 500 },
): string | null {
  if (!isObj(ops)) return "ops must be an object";
  const { pages, removedPages, order, items } = ops as Record<string, unknown>;
  if (
    pages !== undefined &&
    (!Array.isArray(pages) ||
      pages.length > limits.pages ||
      pages.some((p) => !isObj(p) || typeof p.id !== "string"))
  )
    return "ops.pages must be a list of page records with an id";
  if (
    removedPages !== undefined &&
    (!Array.isArray(removedPages) ||
      removedPages.some((id) => typeof id !== "string"))
  )
    return "ops.removedPages must be a list of ids";
  if (
    order !== undefined &&
    (!Array.isArray(order) ||
      order.length > limits.pages * 4 ||
      order.some((id) => typeof id !== "string"))
  )
    return "ops.order must be a list of ids";
  if (items !== undefined) {
    if (!Array.isArray(items)) return "ops.items must be a list";
    let count = 0;
    for (const op of items) {
      if (!isObj(op) || typeof op.page !== "string")
        return "each ops.items entry needs a page id";
      if (
        op.put !== undefined &&
        (!Array.isArray(op.put) || op.put.some((item) => !itemIdOf(item)))
      )
        return "ops.items put must be items with an id";
      if (
        op.del !== undefined &&
        (!Array.isArray(op.del) || op.del.some((id) => typeof id !== "string"))
      )
        return "ops.items del must be a list of ids";
      count +=
        (Array.isArray(op.put) ? op.put.length : 0) +
        (Array.isArray(op.del) ? op.del.length : 0);
    }
    if (count > limits.items)
      return `at most ${limits.items} item changes per push`;
  }
  return null;
}
