import { StudyPage, IStudyPage, IPageVersionEntry } from "@/models/study/page";
import { deleteStudyObject, pageContentKey } from "@/services/study/storage";

/**
 * "Earlier versions" thinning. The board saves after every short pause, so a single study session made
 * dozens of versions and every one was kept forever. What stays:
 *   - the newest RECENT_ALWAYS versions (a device may still merge against one of them),
 *   - the last hour: one per 5 minutes,
 *   - the last day: one per hour,
 *   - the last 30 days: one per day,
 * always the newest version in each slot. Anything else is removed from the log and from storage.
 */
export const RECENT_ALWAYS = 10;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TIERS = [
  { within: HOUR, slot: 5 * MIN },
  { within: DAY, slot: HOUR },
  { within: 30 * DAY, slot: DAY },
];

export type DatedVersion = { version: number; at: number };

/** The versions to keep (pure). `current` is always kept. */
export function versionsToKeep(versions: DatedVersion[], current: number, now = Date.now()): Set<number> {
  const keep = new Set<number>([current]);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  for (const v of sorted) if (v.version > current - RECENT_ALWAYS) keep.add(v.version);
  const taken = new Set<string>();
  for (const v of sorted) {
    const age = now - v.at;
    const tier = TIERS.findIndex((t) => age < t.within);
    if (tier < 0) continue;
    const slot = `${tier}:${Math.floor(v.at / TIERS[tier].slot)}`;
    // Newest first, so the first version seen in a slot is the one kept.
    if (!taken.has(slot)) {
      taken.add(slot);
      keep.add(v.version);
    }
  }
  return keep;
}

/**
 * Every version 1..current with a date: logged versions use their own; unlogged ones (AI drawings, or
 * saved before the log existed) take the date of the next newer logged version (they are no newer than
 * it), or now when nothing newer is logged.
 */
export function datedVersions(current: number, log: IPageVersionEntry[], now = Date.now()): DatedVersion[] {
  const byVersion = new Map(log.map((e) => [e.version, new Date(e.at).getTime()]));
  const out: DatedVersion[] = [];
  let newer = now;
  for (let v = current; v >= 1; v--) {
    const at = byVersion.get(v);
    if (at !== undefined) newer = at;
    out.push({ version: v, at: at ?? newer });
  }
  return out;
}

const lastRun = new Map<string, number>();
const RUN_EVERY_MS = MIN;

/** Thin one page's earlier versions. Safe to call often: runs at most once a minute per page. */
export async function prunePageVersions(pageId: string, opts: { force?: boolean } = {}): Promise<number> {
  const now = Date.now();
  if (!opts.force && now - (lastRun.get(pageId) ?? 0) < RUN_EVERY_MS) return 0;
  lastRun.set(pageId, now);
  if (lastRun.size > 5000) lastRun.clear();

  const page = await StudyPage.findOne({ _id: pageId }, { version: 1, versionLog: 1, userId: 1, prunedThrough: 1 }).lean<IStudyPage>();
  if (!page || page.version < 2) return 0;
  const log = page.versionLog ?? [];
  const logged = new Set(log.map((e) => e.version));
  const keep = versionsToKeep(datedVersions(page.version, log, now), page.version, now);
  // Unlogged versions at or below prunedThrough were already removed from storage on an earlier run.
  const floor = page.prunedThrough ?? 0;
  const drop: number[] = [];
  const addToLog: IPageVersionEntry[] = [];
  const dated = new Map(datedVersions(page.version, log, now).map((d) => [d.version, d.at]));
  for (let v = 1; v < page.version; v++) {
    if (keep.has(v)) {
      // A kept unlogged version gets an entry so the list (which reads the log) shows it.
      if (!logged.has(v)) addToLog.push({ version: v, userId: page.userId, name: "", at: new Date(dated.get(v) ?? now), restoredFrom: null, key: null });
    } else if (logged.has(v) || v > floor) {
      drop.push(v);
    }
  }
  if (!drop.length && !addToLog.length) return 0;

  const keyOf = new Map(log.map((e) => [e.version, e.key]));
  const userId = String(page.userId);
  // Storage first: a failed delete leaves the version listed, never a listed version with no board.
  await Promise.all(
    drop.map((v) => deleteStudyObject(keyOf.get(v) || pageContentKey(userId, pageId, v)).catch(() => undefined))
  );
  const highestUnlogged = Math.max(floor, ...drop.filter((v) => !logged.has(v)));
  await StudyPage.updateOne(
    { _id: pageId },
    { $pull: { versionLog: { version: { $in: drop } } }, $set: { prunedThrough: highestUnlogged } },
    { timestamps: false }
  );
  if (addToLog.length) {
    await StudyPage.updateOne(
      { _id: pageId },
      { $push: { versionLog: { $each: addToLog, $sort: { version: 1 } } } },
      { timestamps: false }
    );
  }
  return drop.length;
}
