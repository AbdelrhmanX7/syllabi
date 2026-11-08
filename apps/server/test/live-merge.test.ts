/**
 * Live co-editing merge (sharing phase 2 part B). The SAME cases run against the app's copy
 * (apps/study/lib/notebooks/live-merge.test.ts); keep the two files in step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOps, diffDocs, ensureDocIds, mergeDocs, opsError } from "../src/services/share/live-merge";

type Item = Record<string, unknown>;
const stroke = (oid: string | null, x = 0, extra: Item = {}): Item => ({ type: "path", left: x, top: 0, path: [["M", x, 0]], ...(oid ? { oid } : {}), ...extra });
type Page = { id: string; canvasJSON: string; [key: string]: unknown };
const page = (id: string, items: Item[], extra: Item = {}): Page => ({ id, backgroundType: "blank", canvasJSON: JSON.stringify({ version: "7.2.0", objects: items }), thumbnail: "", ...extra });
const doc = (...pages: ReturnType<typeof page>[]) => ({ id: "d", title: "T", currentPageIndex: 0, pages });
const ids = (d: { pages: { id: string; canvasJSON?: string }[] }, pageId = "p1") =>
  (JSON.parse(d.pages.find((p) => p.id === pageId)!.canvasJSON!).objects as Item[]).map((o) => o.oid);

test("old items get the same derived id on every device, identical twins get .1", () => {
  const a = ensureDocIds(doc(page("p1", [stroke(null, 1), stroke(null, 1), stroke(null, 2)])));
  const b = ensureDocIds(doc(page("p1", [stroke(null, 1), stroke(null, 1), stroke(null, 2)])));
  const got = ids(a);
  assert.deepEqual(got, ids(b));
  assert.equal(new Set(got).size, 3);
  assert.match(String(got[1]), /\.1$/);
  // ids already there are kept
  assert.deepEqual(ids(ensureDocIds(doc(page("p1", [stroke("keep")])))), ["keep"]);
});

test("two editors drawing at once: both strokes survive, in either order", () => {
  const base = doc(page("p1", [stroke("a")]));
  const maya = doc(page("p1", [stroke("a"), stroke("m", 5)]));
  const sam = doc(page("p1", [stroke("a"), stroke("s", 9)]));
  const one = applyOps(applyOps(base, diffDocs(base, maya)), diffDocs(base, sam));
  const two = applyOps(applyOps(base, diffDocs(base, sam)), diffDocs(base, maya));
  assert.deepEqual(new Set(ids(one)), new Set(["a", "m", "s"]));
  assert.deepEqual(new Set(ids(two)), new Set(["a", "m", "s"]));
});

test("a delete on one side stays deleted after the other side's merge", () => {
  const base = doc(page("p1", [stroke("a"), stroke("b", 3)]));
  const maya = doc(page("p1", [stroke("b", 3)])); // erased a
  const sam = doc(page("p1", [stroke("a"), stroke("b", 3), stroke("s", 7)])); // drew s
  const server = applyOps(base, diffDocs(base, maya));
  const merged = mergeDocs(base, sam, server);
  assert.deepEqual(ids(merged), ["b", "s"]);
});

test("lasso move changes the item in place; the last change wins", () => {
  const base = doc(page("p1", [stroke("a", 0), stroke("b", 3)]));
  const moved = doc(page("p1", [stroke("a", 50), stroke("b", 3)]));
  const ops = diffDocs(base, moved)!;
  assert.deepEqual(ops.items, [{ page: "p1", put: [stroke("a", 50)] }]);
  const later = doc(page("p1", [stroke("a", 80), stroke("b", 3)]));
  const out = applyOps(applyOps(base, ops), diffDocs(moved, later));
  assert.equal((JSON.parse(out.pages[0].canvasJSON!).objects as Item[])[0].left, 80);
  assert.deepEqual(ids(out), ["a", "b"]); // same z-order
});

test("tiny float drift from re-saving is not a change", () => {
  const base = doc(page("p1", [stroke("a", 10)]));
  const drift = doc(page("p1", [stroke("a", 10.004)]));
  assert.equal(diffDocs(base, drift), null);
});

test("the per-device view (scroll, zoom, preview) never travels", () => {
  const base = doc(page("p1", [stroke("a")], { viewportZoom: 1, viewportOffsetY: 0 }));
  const scrolled = doc(page("p1", [stroke("a")], { viewportZoom: 2, viewportOffsetY: -400, thumbnail: "data:x" }));
  assert.equal(diffDocs(base, scrolled), null);
  // and applying someone's page change keeps my own view
  const mine = doc(page("p1", [stroke("a")], { viewportZoom: 3 }));
  const theirs = doc(page("p1", [stroke("a")], { viewportZoom: 1, backgroundType: "lined" }));
  const out = applyOps(mine, diffDocs(doc(page("p1", [stroke("a")], { viewportZoom: 1 })), theirs));
  assert.equal(out.pages[0].viewportZoom, 3);
  assert.equal(out.pages[0].backgroundType, "lined");
});

test("pages: add, remove, reorder, paper style", () => {
  const base = doc(page("p1", [stroke("a")]), page("p2", []));
  const next = doc(page("p2", [], { backgroundType: "grid", paperSpacingMm: 5 }), page("p3", [stroke("c")]));
  const ops = diffDocs(base, next)!;
  assert.deepEqual(ops.removedPages, ["p1"]);
  assert.deepEqual(ops.order, ["p2", "p3"]);
  const out = applyOps(base, ops);
  assert.deepEqual(out.pages.map((p) => p.id), ["p2", "p3"]);
  assert.equal(out.pages[0].backgroundType, "grid");
  assert.equal(out.pages[0].paperSpacingMm, 5);
  assert.deepEqual(ids(out, "p3"), ["c"]);
});

test("a page someone else added stays where they put it when I reorder", () => {
  const base = doc(page("p1", []), page("p2", []), page("p3", []));
  const server = doc(page("p1", []), page("x", []), page("p2", []), page("p3", []));
  const mine = doc(page("p3", []), page("p1", []), page("p2", []));
  const out = applyOps(server, diffDocs(base, mine));
  assert.deepEqual(out.pages.map((p) => p.id), ["p3", "p1", "x", "p2"]);
});

test("changes to a page that is gone are dropped; unreadable pages are never wiped", () => {
  const base = doc(page("p1", [stroke("a")]));
  const out = applyOps(base, { items: [{ page: "nope", put: [stroke("z")] }] });
  assert.deepEqual(out.pages.map((p) => p.id), ["p1"]);
  const broken = { ...doc(), pages: [{ id: "p1", canvasJSON: "{not json" }] };
  const kept = applyOps(broken, { items: [{ page: "p1", del: ["a"] }] });
  assert.equal(kept.pages[0].canvasJSON, "{not json");
});

test("undo after an erase puts the same id back", () => {
  const base = doc(page("p1", [stroke("a")]));
  const erased = applyOps(base, diffDocs(base, doc(page("p1", []))));
  assert.deepEqual(ids(erased), []);
  const undone = applyOps(erased, diffDocs(doc(page("p1", [])), base));
  assert.deepEqual(ids(undone), ["a"]);
});

test("ops shape check", () => {
  assert.equal(opsError({ items: [{ page: "p1", put: [stroke("a")], del: ["b"] }] }), null);
  assert.ok(opsError(null));
  assert.ok(opsError({ items: [{ page: "p1", put: [stroke(null)] }] }));
  assert.ok(opsError({ pages: [{ noId: true }] }));
  assert.ok(opsError({ items: [{ page: "p1", put: Array.from({ length: 6 }, (_, i) => stroke(`i${i}`)) }] }, { items: 5, pages: 5 }));
});

test("a page's recorded frame is set once: another tablet's width is not a change", () => {
  const base = doc(page("p1", [stroke("a")], { canvasWidthPx: 1000 }));
  assert.equal(diffDocs(base, doc(page("p1", [stroke("a")], { canvasWidthPx: 800 }))), null);
  // the first record still travels
  const fresh = doc(page("p1", [stroke("a")]));
  assert.equal(diffDocs(fresh, base)?.pages?.[0].canvasWidthPx, 1000);
  // a real setting change still does, frame and all
  assert.equal(diffDocs(base, doc(page("p1", [stroke("a")], { canvasWidthPx: 800, backgroundType: "grid" })))?.pages?.[0].backgroundType, "grid");
});
