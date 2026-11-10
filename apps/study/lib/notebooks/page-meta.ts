// Notebook details: AI-made name, description, tags and cover, plus the math tools switch.
// The lists mirror the server's (apps/server/src/services/study/page-meta.ts): change both together.
import type { MathToolsMode, MetaEdited, Page, PageCoverColor } from '@/lib/api/types';

export const META_DESCRIPTION_MAX = 300;
export const META_TAGS_MAX = 6;
export const META_TAG_MAX_CHARS = 24;
/** Content versions past the last describe before the app asks again. */
export const META_REDESCRIBE_VERSIONS = 5;
/** At most one automatic describe per notebook in this window. */
export const META_DESCRIBE_GAP_MS = 10 * 60 * 1000;

/** Tags that mean "formulas live here": with math tools on Auto, any of these shows the math symbol bar. */
export const MATH_TAGS = [
  'math',
  'maths',
  'mathematics',
  'calculus',
  'precalculus',
  'pre-calculus',
  'algebra',
  'linear algebra',
  'geometry',
  'trigonometry',
  'trig',
  'statistics',
  'stats',
  'probability',
  'physics',
  'mechanics',
  'differential equations',
  'equations',
  'discrete math',
  'number theory',
  'chemistry',
  'econometrics',
  'integrals',
  'derivatives',
  'matrices',
  'vectors',
] as const;
const MATH_TAG_SET = new Set<string>(MATH_TAGS);

export function isMathTag(tag: string): boolean {
  const value = tag.trim().toLowerCase();

  if (!value) return false;
  if (MATH_TAG_SET.has(value)) return true;

  return value.split(/[\s/-]+/).some((word) => MATH_TAG_SET.has(word));
}

export const hasMathTag = (tags: readonly string[] | null | undefined) => (tags ?? []).some(isMathTag);

/** Whether the board shows the math symbol bar. */
export function mathToolsOn(mode: MathToolsMode | null | undefined, tags: readonly string[] | null | undefined): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;

  return hasMathTag(tags);
}

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
