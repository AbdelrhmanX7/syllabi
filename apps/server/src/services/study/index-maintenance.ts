import fs from "fs";
import path from "path";
import mongoose, { Model, Types } from "mongoose";
import "@/models/study";

/** Mongoose's OWN bson (it bundles a copy): its EJSON round-trips the same ObjectId class mongoose uses. */
const { EJSON } = (mongoose.mongo as unknown as {
  BSON: { EJSON: { stringify(v: unknown, replacer?: undefined, space?: number, o?: { relaxed?: boolean }): string; parse(t: string, o?: { relaxed?: boolean }): any } };
}).BSON;

/**
 * Builds the schema-declared indexes of every `study_*` collection on a database that runs with
 * `autoIndex: false` (prod — config/db.ts), where none of them were ever created. Driven by
 * scripts/add-study-indexes.ts; the logic lives here so `tsc` and jest cover it.
 *
 * Never drops an index. A missing UNIQUE index whose collection already holds duplicates is made
 * buildable by keeping the newest-updated doc of each duplicate group and deleting the rest —
 * after the full losing docs are written to a backup file, inside transactions.
 */

type Keys = Record<string, any>;
type IndexOptions = Record<string, any>;
type AnyDoc = { _id: Types.ObjectId; updatedAt?: Date | null; createdAt?: Date | null } & Record<string, any>;

export const STUDY_COLLECTION_PREFIX = "study_";
const DELETE_CHUNK = 500;
const SAMPLE = 5;

/** Every registered mongoose model whose collection is `study_*`, sorted by collection name. */
export function studyModels(): Model<any>[] {
  return mongoose
    .modelNames()
    .map((n) => mongoose.model(n))
    .filter((m) => m.collection.collectionName.startsWith(STUDY_COLLECTION_PREFIX))
    .sort((a, b) => a.collection.collectionName.localeCompare(b.collection.collectionName));
}

/** Key spec identity: field order matters to MongoDB, so compare the ordered entries. */
export const keySig = (keys: Keys) => JSON.stringify(Object.entries(keys));

/** Index options the server needs (mongoose adds `background`; strip undefined). */
const serverOptions = (o: IndexOptions) => {
  const out: IndexOptions = {};
  for (const [k, v] of Object.entries(o ?? {})) if (v !== undefined && k !== "background") out[k] = v;
  return out;
};

export interface DupGroup {
  key: Record<string, unknown>;
  ids: Types.ObjectId[];
}

/** Recency of a doc: updatedAt, else createdAt, else the ObjectId's timestamp. */
export const recency = (d: AnyDoc) =>
  (d.updatedAt ? new Date(d.updatedAt).getTime() : NaN) || (d.createdAt ? new Date(d.createdAt).getTime() : NaN) || d._id.getTimestamp().getTime();

/**
 * PURE: for one duplicate group, the doc to keep (newest-updated; ties → the larger _id, i.e. the
 * later insert) and the losers to delete. Every input doc is either the keeper or a loser.
 */
export function selectKeeper<T extends AnyDoc>(docs: T[]): { keep: T; losers: T[] } {
  if (!docs.length) throw new Error("selectKeeper: empty group");
  const sorted = [...docs].sort((a, b) => recency(b) - recency(a) || String(b._id).localeCompare(String(a._id)));
  return { keep: sorted[0], losers: sorted.slice(1) };
}

/** Duplicate groups for a unique key, honouring partialFilterExpression / sparse like the index will. */
export async function duplicateGroups(model: Model<any>, keys: Keys, options: IndexOptions): Promise<DupGroup[]> {
  const fields = Object.keys(keys);
  const match: Record<string, unknown> = { ...(options.partialFilterExpression ?? {}) };
  if (options.sparse) for (const f of fields) match[f] = { ...(match[f] as object), $exists: true };
  const rows = await model.collection
    .aggregate(
      [
        ...(Object.keys(match).length ? [{ $match: match }] : []),
        { $group: { _id: Object.fromEntries(fields.map((f) => [f.replace(/\./g, "__"), `$${f}`])), ids: { $push: "$_id" }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ],
      { allowDiskUse: true }
    )
    .toArray();
  return rows.map((r: any) => ({ key: r._id, ids: r.ids }));
}

export interface IndexPlan {
  collection: string;
  keys: Keys;
  options: IndexOptions;
  unique: boolean;
  ttl: boolean;
  /** An existing index has the same keys but different options — never touched. */
  conflict: string | null;
  dupGroups: DupGroup[];
}

const existingIndexes = async (model: Model<any>) => {
  try {
    return await model.collection.indexes();
  } catch (e: any) {
    if (e?.codeName === "NamespaceNotFound" || e?.code === 26) return []; // collection not created yet
    throw e;
  }
};

/** Missing schema indexes for one model (+ duplicate groups for the unique ones). Read-only. */
export async function planModel(model: Model<any>): Promise<IndexPlan[]> {
  const existing = await existingIndexes(model);
  const have = new Map(existing.map((ix: any) => [keySig(ix.key), ix]));
  const plans: IndexPlan[] = [];
  for (const [keys, rawOpts] of model.schema.indexes() as [Keys, IndexOptions][]) {
    const options = serverOptions(rawOpts);
    const found: any = have.get(keySig(keys));
    const unique = !!options.unique;
    const ttl = typeof options.expireAfterSeconds === "number" || options.expires !== undefined;
    if (found) {
      const mismatch = !!found.unique !== unique || (ttl && found.expireAfterSeconds === undefined);
      if (!mismatch) continue;
      plans.push({ collection: model.collection.collectionName, keys, options, unique, ttl, conflict: `existing index "${found.name}" has the same keys with different options`, dupGroups: [] });
      continue;
    }
    plans.push({
      collection: model.collection.collectionName,
      keys,
      options,
      unique,
      ttl,
      conflict: null,
      dupGroups: unique ? await duplicateGroups(model, keys, options) : [],
    });
  }
  return plans;
}

export interface RunReport {
  dryRun: boolean;
  backupFile: string | null;
  collections: {
    collection: string;
    missing: { keys: Keys; unique: boolean; ttl: boolean; conflict: string | null; dupGroups: number; dupDocsToDelete: number; sample: DupGroup[] }[];
    deleted: number;
    created: string[];
    failed: { keys: Keys; error: string }[];
  }[];
}

export async function addStudyIndexes(opts: { dryRun: boolean; backupDir: string; log?: (s: string) => void }): Promise<RunReport> {
  const log = opts.log ?? (() => {});
  const models = studyModels();
  const plans = new Map<Model<any>, IndexPlan[]>();
  for (const m of models) plans.set(m, await planModel(m));

  const report: RunReport = { dryRun: opts.dryRun, backupFile: null, collections: [] };
  // Losers per model, decided from the plan (union over all unique indexes of the model).
  const losersByModel = new Map<Model<any>, AnyDoc[]>();
  for (const [m, ps] of plans) {
    const loserIds = new Map<string, AnyDoc>();
    for (const p of ps.filter((x) => x.unique && !x.conflict && x.dupGroups.length)) {
      for (const g of p.dupGroups) {
        const docs = (await m.collection.find({ _id: { $in: g.ids } }).toArray()) as AnyDoc[];
        if (docs.length < 2) continue;
        for (const l of selectKeeper(docs).losers) loserIds.set(String(l._id), l);
      }
    }
    losersByModel.set(m, [...loserIds.values()]);
    report.collections.push({
      collection: m.collection.collectionName,
      missing: ps.map((p) => ({
        keys: p.keys,
        unique: p.unique,
        ttl: p.ttl,
        conflict: p.conflict,
        dupGroups: p.dupGroups.length,
        dupDocsToDelete: p.dupGroups.reduce((n, g) => n + g.ids.length - 1, 0),
        sample: p.dupGroups.slice(0, SAMPLE),
      })),
      deleted: 0,
      created: [],
      failed: [],
    });
  }
  if (opts.dryRun) return report;

  // 1. Backup of every doc that will be deleted — BEFORE any mutation.
  const toDelete = [...losersByModel].filter(([, l]) => l.length);
  if (toDelete.length) {
    fs.mkdirSync(opts.backupDir, { recursive: true });
    const file = path.join(opts.backupDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const payload = Object.fromEntries(toDelete.map(([m, l]) => [m.collection.collectionName, l]));
    fs.writeFileSync(file, EJSON.stringify(payload, undefined, 2, { relaxed: false }));
    report.backupFile = file;
    log(`[add-study-indexes] backup written: ${file}`);
  }

  // 2. Delete the losers, in transactions.
  for (const [m, losers] of toDelete) {
    const entry = report.collections.find((c) => c.collection === m.collection.collectionName)!;
    const session = await mongoose.startSession();
    try {
      for (let i = 0; i < losers.length; i += DELETE_CHUNK) {
        const ids = losers.slice(i, i + DELETE_CHUNK).map((d) => d._id);
        await session.withTransaction(async () => {
          const r = await m.collection.deleteMany({ _id: { $in: ids } }, { session });
          entry.deleted += r.deletedCount ?? 0;
        });
      }
    } finally {
      await session.endSession();
    }
  }

  // 3. Create every missing (non-conflicting) index. A failure (e.g. a duplicate written since the
  //    plan) is reported and the run continues; nothing is dropped.
  for (const [m, ps] of plans) {
    const entry = report.collections.find((c) => c.collection === m.collection.collectionName)!;
    for (const p of ps.filter((x) => !x.conflict)) {
      try {
        entry.created.push(await m.collection.createIndex(p.keys, p.options));
      } catch (e: any) {
        entry.failed.push({ keys: p.keys, error: String(e?.message ?? e).slice(0, 300) });
      }
    }
  }
  return report;
}

export function formatReport(r: RunReport): string {
  const lines = [`[add-study-indexes] ${r.dryRun ? "DRY RUN — nothing written" : "APPLIED"}${r.backupFile ? `  backup=${r.backupFile}` : ""}`];
  let missing = 0;
  let groups = 0;
  for (const c of r.collections) {
    if (!c.missing.length && !c.created.length) {
      lines.push(`  ${c.collection}: up to date`);
      continue;
    }
    lines.push(`  ${c.collection}:`);
    for (const ix of c.missing) {
      missing++;
      groups += ix.dupGroups;
      const tag = [ix.unique ? "UNIQUE" : "", ix.ttl ? "TTL" : ""].filter(Boolean).join("+");
      lines.push(`    missing ${JSON.stringify(ix.keys)}${tag ? ` [${tag}]` : ""}${ix.conflict ? `  SKIPPED: ${ix.conflict}` : ""}`);
      if (ix.dupGroups) {
        lines.push(`      ${ix.dupGroups} duplicate group(s), ${ix.dupDocsToDelete} doc(s) to delete; sample:`);
        for (const g of ix.sample) lines.push(`        ${JSON.stringify(g.key)} → ${g.ids.length} docs`);
      }
    }
    if (!r.dryRun) lines.push(`    deleted=${c.deleted} created=${c.created.length}${c.failed.length ? ` FAILED=${JSON.stringify(c.failed)}` : ""}`);
  }
  lines.push(`[add-study-indexes] collections=${r.collections.length} missingIndexes=${missing} duplicateGroups=${groups}`);
  return lines.join("\n");
}
