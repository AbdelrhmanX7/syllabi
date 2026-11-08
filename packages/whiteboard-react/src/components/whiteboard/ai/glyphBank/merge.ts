/**
 * Pure bank arithmetic: adding a sample, clearing, and merging two copies of the bank (this device
 * and the server). No I/O — `store.ts` does the persistence and the sync loop on top of these.
 */
import type { GlyphBank, GlyphEntry, GlyphKey, GlyphSample } from './types';

import { EMPTY_GLYPH_BANK } from './types';

/** Samples per glyph the sheet keeps; the oldest is dropped when a fourth arrives. */
export const MAX_SAMPLES_PER_GLYPH = 3;

/**
 * A sample's identity across devices. Two devices never write the same strokes at the same
 * millisecond, so the creation time plus the first stroke's first point is unique in practice —
 * and it survives a JSON round trip, unlike object identity.
 */
export function sampleId(sample: GlyphSample): string {
  const first = sample.strokes[0]?.[0];
  const head = first ? `${first[0].toFixed(3)},${first[1].toFixed(3)}` : '';

  return `${sample.createdAt}:${sample.strokes.length}:${head}`;
}

export function bankSampleCount(bank: GlyphBank): number {
  return Object.values(bank.glyphs).reduce((sum, entry) => sum + entry.samples.length, 0);
}

/** Keys with at least one sample. */
export function bankCoveredKeys(bank: GlyphBank): Set<GlyphKey> {
  return new Set(
    Object.values(bank.glyphs)
      .filter((entry) => entry.samples.length > 0)
      .map((entry) => entry.key),
  );
}

export function addSampleToBank(
  bank: GlyphBank,
  key: GlyphKey,
  sample: GlyphSample,
  { max = MAX_SAMPLES_PER_GLYPH, now = Date.now() }: { max?: number; now?: number } = {},
): GlyphBank {
  const current = bank.glyphs[key]?.samples ?? [];
  const samples = [...current, sample].sort((a, b) => a.createdAt - b.createdAt).slice(-max);

  return {
    version: bank.version + 1,
    updatedAt: now,
    glyphs: { ...bank.glyphs, [key]: { key, samples } },
  };
}

/** Drop every sample of one glyph (the cell's «clear» after an accept). */
export function removeGlyphFromBank(bank: GlyphBank, key: GlyphKey, now = Date.now()): GlyphBank {
  if (!bank.glyphs[key]) return bank;
  const glyphs = { ...bank.glyphs };

  delete glyphs[key];

  return { version: bank.version + 1, updatedAt: now, glyphs };
}

/** «Clear my handwriting»: an empty bank one version on, so the server copy is replaced, not merged back in. */
export function clearedBank(bank: GlyphBank, now = Date.now()): GlyphBank {
  return { ...EMPTY_GLYPH_BANK, version: bank.version + 1, updatedAt: now };
}

function sampleIds(bank: GlyphBank): Set<string> {
  const ids = new Set<string>();

  for (const entry of Object.values(bank.glyphs)) for (const sample of entry.samples) ids.add(sampleId(sample));

  return ids;
}

/** True when both banks hold exactly the same samples (versions aside). */
export function sameBankContent(a: GlyphBank, b: GlyphBank): boolean {
  const idsA = sampleIds(a);
  const idsB = sampleIds(b);

  if (idsA.size !== idsB.size) return false;

  return Array.from(idsA).every((id) => idsB.has(id));
}

/**
 * Merge this device's bank with the server's. With a `base` (the server state this device last
 * synced to) it is a three-way merge: a sample the base had that `local` dropped was deleted here and
 * stays deleted; a sample only `remote` has was added elsewhere and is kept. Without a base it is a
 * plain union. Per glyph the newest {@link MAX_SAMPLES_PER_GLYPH} survive.
 *
 * The result's version is the higher of the two when nothing changed against `remote`, one more
 * otherwise — the number the next PUT carries as its expected version is `remote.version` regardless.
 */
export function mergeGlyphBanks(local: GlyphBank, remote: GlyphBank, base?: GlyphBank | null): GlyphBank {
  const localIds = sampleIds(local);
  const baseIds = base ? sampleIds(base) : null;
  const glyphs: Record<GlyphKey, GlyphEntry> = {};
  const seen = new Set<string>();
  const add = (key: GlyphKey, sample: GlyphSample) => {
    const id = sampleId(sample);

    if (seen.has(id)) return;
    seen.add(id);
    (glyphs[key] ??= { key, samples: [] }).samples.push(sample);
  };

  for (const entry of Object.values(local.glyphs)) for (const sample of entry.samples) add(entry.key, sample);
  for (const entry of Object.values(remote.glyphs)) {
    for (const sample of entry.samples) {
      const id = sampleId(sample);
      // Known to this device's last sync and gone from its bank now = deleted here.
      const deletedLocally = baseIds !== null && baseIds.has(id) && !localIds.has(id);

      if (!deletedLocally) add(entry.key, sample);
    }
  }

  for (const entry of Object.values(glyphs)) {
    entry.samples.sort((a, b) => a.createdAt - b.createdAt);
    if (entry.samples.length > MAX_SAMPLES_PER_GLYPH) entry.samples = entry.samples.slice(-MAX_SAMPLES_PER_GLYPH);
  }
  for (const key of Object.keys(glyphs)) if (glyphs[key].samples.length === 0) delete glyphs[key];

  const merged: GlyphBank = {
    version: Math.max(local.version, remote.version),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    glyphs,
  };

  if (!sameBankContent(merged, remote)) merged.version += 1;

  return merged;
}
