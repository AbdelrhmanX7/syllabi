/**
 * The board's undo/redo model — pure data, no Fabric, no React.
 *
 * ## What an entry is
 *
 * A page's content is an ordered list of per-object JSON strings in the PAGE-LOCAL frame (exactly the
 * strings the page's stored `canvasJSON` holds in its `objects` array, so the stored format is
 * untouched). An entry records, for each page an action changed, the list before and after it. Lists
 * share their strings with the previous state, so fifty entries on a dense page cost fifty small
 * deltas, not fifty copies of the page.
 *
 * Page-level edits are entries too: a sheet inserted into (or deleted from) the document.
 *
 * ## Scopes
 *
 * Entries live in a stack per SCOPE. The continuous PDF layout uses one scope for the whole document
 * (writing on page 1, scrolling, writing on page 4 → two undos walk back through both); the paged board
 * uses one scope per page, as it always has. The committed state of a page is shared by every scope.
 *
 * ## Why a page's state is committed at all
 *
 * `before` is the page's committed state when the action began; the editor commits a new state at the
 * end of each gesture. A page whose content changed under the model WITHOUT an entry (a reload that
 * found different content) is re-seeded via {@link BoardHistoryModel.seedPage}, which clears the stacks
 * that mention it — undoing onto content the entry was not recorded against would corrupt the page.
 */

export type PageState = readonly string[];

export interface PageContentChange {
  pageId: string;
  before: PageState;
  after: PageState;
}

export interface ContentEntry {
  kind: 'content';
  changes: PageContentChange[];
  /** Approximate memory the entry alone holds (strings not shared between before and after). */
  bytes: number;
}

export interface PageListEntry<TPage = unknown> {
  kind: 'insert-page' | 'delete-page';
  pageId: string;
  page: TPage;
  index: number;
  bytes: number;
}

export type HistoryEntry<TPage = unknown> = ContentEntry | PageListEntry<TPage>;

interface Stack<TPage> {
  past: HistoryEntry<TPage>[];
  future: HistoryEntry<TPage>[];
  bytes: number;
}

export interface BoardHistoryModelOptions {
  maxEntries?: number;
  /** Ceiling on the memory a scope's past may hold (UTF-16 code units, close enough to bytes). */
  maxBytes?: number;
}

export const DEFAULT_MAX_HISTORY_ENTRIES = 100;
export const DEFAULT_MAX_HISTORY_BYTES = 24 * 1024 * 1024;

export function samePageState(a: PageState | undefined, b: PageState | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }

  return true;
}

/** The strings one side holds that the other does not — what an entry costs beyond the shared state. */
function deltaBytes(before: PageState, after: PageState): number {
  const counts = new Map<string, number>();

  for (const value of before) counts.set(value, (counts.get(value) ?? 0) + 1);

  let bytes = 0;

  for (const value of after) {
    const count = counts.get(value) ?? 0;

    if (count > 0) {
      counts.set(value, count - 1);
    } else {
      bytes += value.length;
    }
  }

  counts.forEach((count, value) => {
    bytes += count * value.length;
  });

  return bytes;
}

/** Numbers this close are the same coordinate (the page JSON keeps two decimals; Fabric re-derives boxes). */
const EQUIVALENT_NUMBER_TOLERANCE = 0.05;

function equivalentValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= EQUIVALENT_NUMBER_TOLERANCE;

  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equivalentValues(value, b[index]));

  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a);
    const bRecord = b as Record<string, unknown>;

    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every((key) => key in bRecord && equivalentValues((a as Record<string, unknown>)[key], bRecord[key]))
    );
  }

  return false;
}

/** Two serialized objects that describe the same object up to coordinate noise. */
export function equivalentObjectJson(a: string, b: string): boolean {
  if (a === b) return true;

  try {
    return equivalentValues(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}

function entryPageIds(entry: HistoryEntry<unknown>): string[] {
  return entry.kind === 'content' ? entry.changes.map((change) => change.pageId) : [entry.pageId];
}

export class BoardHistoryModel<TPage = unknown> {
  private readonly stacks = new Map<string, Stack<TPage>>();
  private readonly committed = new Map<string, PageState>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: BoardHistoryModelOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_HISTORY_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_HISTORY_BYTES;
  }

  private stack(scope: string): Stack<TPage> {
    let stack = this.stacks.get(scope);

    if (!stack) {
      stack = { bytes: 0, future: [], past: [] };
      this.stacks.set(scope, stack);
    }

    return stack;
  }

  canUndo(scope: string): boolean {
    return (this.stacks.get(scope)?.past.length ?? 0) > 0;
  }

  canRedo(scope: string): boolean {
    return (this.stacks.get(scope)?.future.length ?? 0) > 0;
  }

  getCommitted(pageId: string): PageState | undefined {
    return this.committed.get(pageId);
  }

  hasCommitted(pageId: string): boolean {
    return this.committed.has(pageId);
  }

  /**
   * The page's content as it was loaded or hydrated. Unknown page → it becomes the baseline. Known page
   * with the same content → nothing (a page coming back into view, an autosave round trip). The same
   * content written slightly differently (a reload re-derives a path's box from its rounded points:
   * `width` 60.008 → 60) → the recorded strings are re-keyed to the loaded ones, so the stack keeps
   * working on the reloaded objects. Known page with DIFFERENT content → it changed outside the history:
   * every stack that mentions it is cleared. Returns true when stacks were cleared.
   */
  seedPage(pageId: string, state: PageState): boolean {
    const previous = this.committed.get(pageId);

    this.committed.set(pageId, state);

    if (previous === undefined || samePageState(previous, state)) return false;

    if (previous.length === state.length && previous.every((value, index) => equivalentObjectJson(value, state[index] as string))) {
      this.rekey(pageId, previous, state);

      return false;
    }

    let cleared = false;

    this.stacks.forEach((stack) => {
      const mentions = [...stack.past, ...stack.future].some((entry) => entryPageIds(entry).includes(pageId));

      if (mentions) {
        stack.past = [];
        stack.future = [];
        stack.bytes = 0;
        cleared = true;
      }
    });

    return cleared;
  }

  /** Swap the strings `from[i]` → `to[i]` in every recorded state of the page. */
  private rekey(pageId: string, from: PageState, to: PageState): void {
    const map = new Map<string, string>();

    from.forEach((value, index) => {
      if (value !== to[index]) map.set(value, to[index] as string);
    });

    if (map.size === 0) return;

    const swap = (state: PageState): PageState => (state.some((value) => map.has(value)) ? state.map((value) => map.get(value) ?? value) : state);

    this.stacks.forEach((stack) => {
      for (const entry of [...stack.past, ...stack.future]) {
        if (entry.kind !== 'content') continue;

        for (const change of entry.changes) {
          if (change.pageId !== pageId) continue;

          change.before = swap(change.before);
          change.after = swap(change.after);
        }
      }
    });
  }

  /** Forget a page's committed state (it left the document for good). Stacks are untouched. */
  forgetPage(pageId: string): void {
    this.committed.delete(pageId);
  }

  /**
   * Commit the pages' current states. Pages whose state did not change are skipped; when any did, ONE
   * entry holds all of them (a stroke dragged from page 1 to page 2 is one undo). A page without a
   * committed state is taken as a baseline (nothing to undo to). Clears the scope's redo.
   */
  commit(scope: string, states: ReadonlyArray<{ pageId: string; state: PageState }>): ContentEntry | null {
    const changes: PageContentChange[] = [];

    for (const { pageId, state } of states) {
      const before = this.committed.get(pageId);

      if (before === undefined) {
        this.committed.set(pageId, state);

        continue;
      }

      if (samePageState(before, state)) continue;

      changes.push({ after: state, before, pageId });
      this.committed.set(pageId, state);
    }

    if (changes.length === 0) return null;

    const entry: ContentEntry = {
      bytes: changes.reduce((sum, change) => sum + deltaBytes(change.before, change.after), 0),
      changes,
      kind: 'content',
    };

    this.push(scope, entry);

    return entry;
  }

  /** Record a sheet inserted at / deleted from `index`. `page` is what a redo / undo puts back. */
  recordPageList(scope: string, kind: PageListEntry['kind'], page: TPage, pageId: string, index: number, bytes = 0): void {
    this.push(scope, { bytes, index, kind, page, pageId });
  }

  private push(scope: string, entry: HistoryEntry<TPage>): void {
    const stack = this.stack(scope);

    stack.past.push(entry);
    stack.bytes += entry.bytes;
    stack.future = [];
    this.trim(stack);
  }

  private trim(stack: Stack<TPage>): void {
    // The newest entry always stays, so the last action is undoable whatever it weighs.
    while (stack.past.length > 1 && (stack.past.length > this.maxEntries || stack.bytes > this.maxBytes)) {
      const dropped = stack.past.shift();

      stack.bytes -= dropped?.bytes ?? 0;
    }
  }

  /**
   * Take the newest entry off the scope's past. The caller applies its inverse and then calls
   * {@link settleUndo} (applied) or {@link cancelUndo} (it could not be applied — the entry goes back).
   */
  beginUndo(scope: string): HistoryEntry<TPage> | null {
    const stack = this.stacks.get(scope);
    const entry = stack?.past.pop() ?? null;

    if (stack && entry) stack.bytes -= entry.bytes;

    return entry;
  }

  settleUndo(scope: string, entry: HistoryEntry<TPage>): void {
    if (entry.kind === 'content') {
      for (const change of entry.changes) this.committed.set(change.pageId, change.before);
    } else if (entry.kind === 'insert-page') {
      this.committed.delete(entry.pageId);
    }

    this.stack(scope).future.push(entry);
  }

  cancelUndo(scope: string, entry: HistoryEntry<TPage>): void {
    const stack = this.stack(scope);

    stack.past.push(entry);
    stack.bytes += entry.bytes;
  }

  beginRedo(scope: string): HistoryEntry<TPage> | null {
    return this.stacks.get(scope)?.future.pop() ?? null;
  }

  settleRedo(scope: string, entry: HistoryEntry<TPage>): void {
    if (entry.kind === 'content') {
      for (const change of entry.changes) this.committed.set(change.pageId, change.after);
    } else if (entry.kind === 'delete-page') {
      this.committed.delete(entry.pageId);
    }

    const stack = this.stack(scope);

    stack.past.push(entry);
    stack.bytes += entry.bytes;
    this.trim(stack);
  }

  cancelRedo(scope: string, entry: HistoryEntry<TPage>): void {
    this.stack(scope).future.push(entry);
  }

  /** Drop one scope's stacks (a hydration window that is gone, a page deleted in the paged board). */
  dropScope(scope: string): void {
    this.stacks.delete(scope);
  }

  /** Everything forgotten — a remount on a replaced document. */
  clear(): void {
    this.stacks.clear();
    this.committed.clear();
  }
}
