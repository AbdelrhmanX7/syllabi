// The local ring buffer the collector writes into and the uploader drains. Capped by count AND bytes;
// when full the OLDEST events go (the newest lag is what the next upload must carry). Events are kept
// as their JSON text: the byte cost is the string length, nothing is re-parsed to measure it, and an
// IndexedDB load at start-up reads strings, not 2000 object graphs.
//
// `MemoryPerfStore` is the pure implementation (tests, and the fallback when IndexedDB is blocked);
// `IdbPerfStore` (./idb-store.ts) keeps the same in-memory index and mirrors the bodies to disk.

import type { PerfEvent } from './types';

export const PERF_RING_MAX_EVENTS = 2000;
export const PERF_RING_MAX_BYTES = 2 * 1024 * 1024;

export interface PerfCaps {
  maxEvents: number;
  maxBytes: number;
}

export const DEFAULT_PERF_CAPS: PerfCaps = { maxEvents: PERF_RING_MAX_EVENTS, maxBytes: PERF_RING_MAX_BYTES };

export interface StoredPerfEvent {
  id: number;
  /** The event's JSON text. */
  json: string;
}

export interface PerfStoreStats {
  count: number;
  bytes: number;
  /** Events evicted by the caps since the last `takeDropped()`. */
  dropped: number;
}

export interface PerfStore {
  /** Append (oldest first). Evicts the oldest beyond the caps. */
  append(events: PerfEvent[]): Promise<void>;
  /** The oldest events whose JSON fits `maxBytes` (always at least one when any exist), oldest first. */
  peek(maxBytes: number, maxEvents?: number): Promise<StoredPerfEvent[]>;
  remove(ids: number[]): Promise<void>;
  stats(): PerfStoreStats;
  /** Read and reset the evicted counter (reported in the next batch). */
  takeDropped(): number;
  /** Put back a counter taken for a batch that failed to send. */
  restoreDropped(count: number): void;
  all(): Promise<StoredPerfEvent[]>;
  clear(): Promise<void>;
}

/**
 * The ordered id → byte-size index both stores share. Pure and synchronous: `add` returns the ids the
 * caps push out, the caller deletes their bodies.
 */
export class PerfRingIndex {
  private ids: number[] = [];
  private sizes = new Map<number, number>();
  private totalBytes = 0;
  private nextId = 1;
  dropped = 0;

  constructor(private readonly caps: PerfCaps = DEFAULT_PERF_CAPS) {}

  /** Seed from disk (ids ascending). */
  load(entries: { id: number; bytes: number }[]): void {
    this.ids = [];
    this.sizes.clear();
    this.totalBytes = 0;
    for (const entry of entries) {
      this.ids.push(entry.id);
      this.sizes.set(entry.id, entry.bytes);
      this.totalBytes += entry.bytes;
      if (entry.id >= this.nextId) this.nextId = entry.id + 1;
    }
  }

  add(bytes: number): { id: number; evicted: number[] } {
    const id = this.nextId++;

    this.ids.push(id);
    this.sizes.set(id, bytes);
    this.totalBytes += bytes;

    return { id, evicted: this.enforce() };
  }

  /** Evict the oldest until within the caps (never the last one); returns the evicted ids. */
  enforce(): number[] {
    const evicted: number[] = [];

    while (this.ids.length > 1 && (this.ids.length > this.caps.maxEvents || this.totalBytes > this.caps.maxBytes)) {
      const oldest = this.ids.shift() as number;

      this.totalBytes -= this.sizes.get(oldest) ?? 0;
      this.sizes.delete(oldest);
      evicted.push(oldest);
    }
    this.dropped += evicted.length;

    return evicted;
  }

  /** Oldest-first ids whose sizes sum to ≤ maxBytes (the first one always, so one huge event cannot wedge the queue). */
  head(maxBytes: number, maxEvents = Number.POSITIVE_INFINITY): number[] {
    const out: number[] = [];
    let sum = 0;

    for (const id of this.ids) {
      const size = this.sizes.get(id) ?? 0;

      if (out.length >= maxEvents) break;
      if (out.length > 0 && sum + size > maxBytes) break;
      out.push(id);
      sum += size;
    }

    return out;
  }

  remove(ids: number[]): void {
    if (ids.length === 0) return;
    const gone = new Set(ids);

    this.ids = this.ids.filter((id) => {
      if (!gone.has(id)) return true;
      this.totalBytes -= this.sizes.get(id) ?? 0;
      this.sizes.delete(id);

      return false;
    });
  }

  has(id: number): boolean {
    return this.sizes.has(id);
  }

  allIds(): number[] {
    return [...this.ids];
  }

  get count(): number {
    return this.ids.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.ids = [];
    this.sizes.clear();
    this.totalBytes = 0;
  }
}

/** UTF-8 byte length without allocating (non-ASCII text is 2–4 bytes a char). */
export function utf8Length(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }

  return bytes;
}

export class MemoryPerfStore implements PerfStore {
  protected readonly index: PerfRingIndex;
  protected readonly bodies = new Map<number, string>();

  constructor(caps: PerfCaps = DEFAULT_PERF_CAPS) {
    this.index = new PerfRingIndex(caps);
  }

  /** Add to the index + body map; returns what changed so a subclass can mirror it to disk. */
  protected appendLocal(events: PerfEvent[]): { added: StoredPerfEvent[]; evicted: number[] } {
    const added: StoredPerfEvent[] = [];
    const evicted: number[] = [];

    for (const event of events) {
      const json = JSON.stringify(event);
      const result = this.index.add(utf8Length(json));

      this.bodies.set(result.id, json);
      added.push({ id: result.id, json });
      for (const id of result.evicted) {
        this.bodies.delete(id);
        evicted.push(id);
      }
    }

    // An event added and evicted in the same call never needs writing.
    const gone = new Set(evicted);

    return { added: added.filter((entry) => !gone.has(entry.id)), evicted };
  }

  async append(events: PerfEvent[]): Promise<void> {
    this.appendLocal(events);
  }

  async peek(maxBytes: number, maxEvents?: number): Promise<StoredPerfEvent[]> {
    return this.index
      .head(maxBytes, maxEvents)
      .map((id) => ({ id, json: this.bodies.get(id) ?? 'null' }))
      .filter((entry) => entry.json !== 'null');
  }

  async remove(ids: number[]): Promise<void> {
    this.index.remove(ids);
    for (const id of ids) this.bodies.delete(id);
  }

  stats(): PerfStoreStats {
    return { count: this.index.count, bytes: this.index.bytes, dropped: this.index.dropped };
  }

  takeDropped(): number {
    const dropped = this.index.dropped;

    this.index.dropped = 0;

    return dropped;
  }

  restoreDropped(count: number): void {
    this.index.dropped += count;
  }

  async all(): Promise<StoredPerfEvent[]> {
    return this.index.allIds().map((id) => ({ id, json: this.bodies.get(id) ?? 'null' }));
  }

  async clear(): Promise<void> {
    this.index.clear();
    this.bodies.clear();
  }
}
