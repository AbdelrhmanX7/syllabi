// Notebook details: AI-made name, description, tags and cover.
// The lists mirror the server's (apps/server/src/services/study/page-meta.ts): change both together.
import type { MetaEdited, Page, PageCoverColor } from '@/lib/api/types';

export const META_DESCRIPTION_MAX = 300;
export const META_TAGS_MAX = 6;
export const META_TAG_MAX_CHARS = 24;
/** Content versions past the last describe before the app asks again. */
export const META_REDESCRIBE_VERSIONS = 5;
/** At most one automatic describe per notebook in this window. */
export const META_DESCRIBE_GAP_MS = 10 * 60 * 1000;

/** One tag the way the server stores it: lowercase, trimmed, no leading '#', ≤ 24 chars. */
export function normalizeTag(raw: string): string {
  const value = raw
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  return value.length > META_TAG_MAX_CHARS ? value.slice(0, META_TAG_MAX_CHARS).trim() : value;
}

export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];

  for (const tag of raw) {
    const value = normalizeTag(tag);

    if (value && !out.includes(value)) out.push(value);
    if (out.length >= META_TAGS_MAX) break;
  }

  return out;
}

/** The muted line under a notebook row: tags first, then when it changed. */
export function noteRowLine(tags: readonly string[] | null | undefined, when: string, label?: string): string {
  return [label, ...(tags ?? []).slice(0, 3), when].filter(Boolean).join(' · ');
}

/** Flags from a backend that may not send them yet (absent = nothing edited). */
export function editedOf(page: Pick<Page, 'metaEdited'>): MetaEdited {
  const flags = page.metaEdited ?? null;

  return {
    title: flags?.title === true,
    description: flags?.description === true,
    tags: flags?.tags === true,
    cover: flags?.cover === true,
  };
}

/** Brand colours a colour cover may use → tile fill + the icon ink that reads on it. */
export const COVER_COLORS: Record<PageCoverColor, { fill: string; ink: string }> = {
  blue: { fill: '#DCE5FD', ink: '#2347C4' },
  star: { fill: '#FFF0C7', ink: '#18204A' },
  green: { fill: '#D7F0E4', ink: '#1F6E4C' },
  amber: { fill: '#FBE8C8', ink: '#8A5606' },
  red: { fill: '#F9DCD8', ink: '#A8332A' },
  slate: { fill: '#E3E5EE', ink: '#3F4566' },
};

export const coverColorOf = (color: string | null | undefined) =>
  COVER_COLORS[(color ?? 'blue') as PageCoverColor] ?? COVER_COLORS.blue;

/**
 * Should the app ask AI to describe this notebook now? Only for the owner's own notebooks with
 * something on the pages, when never described or the content moved ≥ 5 versions past the last one.
 */
export function wantsAutoDescribe(
  page: Pick<Page, 'version' | 'metaAiVersion' | 'shared'> & { metaAiVersion?: number | null },
  hasContent: boolean,
): boolean {
  if (page.shared || !hasContent) return false;
  // A backend without notebook details sends no metaAiVersion field at all: leave it alone.
  if (!('metaAiVersion' in page) || page.metaAiVersion === undefined) return false;
  if (page.metaAiVersion === null) return true;

  return (page.version ?? 0) - page.metaAiVersion >= META_REDESCRIBE_VERSIONS;
}

const lastKey = (pageId: string) => `study_describe_at:${pageId}`;

/** True (and the clock is stamped) when no automatic describe ran for this notebook in the last 10 minutes. */
export function claimDescribeSlot(pageId: string, now = Date.now()): boolean {
  try {
    const last = Number(window.localStorage.getItem(lastKey(pageId)) ?? 0);

    if (Number.isFinite(last) && now - last < META_DESCRIBE_GAP_MS) return false;
    window.localStorage.setItem(lastKey(pageId), String(now));

    return true;
  } catch {
    return memorySlot(pageId, now);
  }
}

const memory = new Map<string, number>();

function memorySlot(pageId: string, now: number): boolean {
  const last = memory.get(pageId) ?? 0;

  if (now - last < META_DESCRIBE_GAP_MS) return false;
  memory.set(pageId, now);

  return true;
}

/** Ink objects or a PDF / image background on any board page. */
export function boardHasContent(
  pages: readonly { canvasJSON?: string | null; pdfAssetId?: string | null; pdfImageUrl?: string | null }[],
): boolean {
  return pages.some(
    (page) => Boolean(page.pdfAssetId || page.pdfImageUrl) || /"objects"\s*:\s*\[\s*\{/.test(page.canvasJSON ?? ''),
  );
}

/** Every tag on these notebooks, most used first (ties alphabetical, so the filter strip keeps its order). */
export function tagsInUse(pages: readonly Pick<Page, 'tags'>[]): string[] {
  const counts = new Map<string, number>();

  for (const page of pages) for (const tag of new Set(page.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

/** Notebooks carrying `tag`; no tag = all of them. */
export function withTag<T extends Pick<Page, 'tags'>>(pages: readonly T[], tag: string | null): T[] {
  return tag ? pages.filter((page) => (page.tags ?? []).includes(tag)) : [...pages];
}

/** At most `max` tags to show on a card, plus how many more are hidden. */
export function cardTags(tags: readonly string[] | null | undefined, max = 3): { shown: string[]; more: number } {
  const all = tags ?? [];

  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}
