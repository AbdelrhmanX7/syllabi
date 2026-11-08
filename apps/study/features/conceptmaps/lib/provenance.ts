// «Built from»: what the backend fed the model for a reference map, a grade, a prediction or a notes
// digest (`model` + `sources` on the final frame, the attempt DTO and the cached digest). Pure.

export type SourceKind =
  | 'past_maps'
  | 'textbook'
  | 'slides'
  | 'page'
  | 'transcript'
  | 'notes'
  | 'model_answer'
  /** A picture on the notebook page (a photo sent from the phone) the terms were read from. */
  | 'image';

export interface SourceRef {
  kind: SourceKind;
  title: string;
  /** A study item the app can open (`/item/?id=`). */
  itemId?: string;
}

/** Absent on old cached attempts / digests: `model` null, `sources` []. */
export interface Provenance {
  model: string | null;
  sources: SourceRef[];
}

export const NO_PROVENANCE: Provenance = { model: null, sources: [] };

const KINDS: readonly SourceKind[] = ['past_maps', 'textbook', 'slides', 'page', 'transcript', 'notes', 'model_answer', 'image'];

export const SOURCE_LABEL: Record<SourceKind, string> = {
  model_answer: 'Model answer',
  notes: 'Lecture notes',
  image: 'Photo',
  page: 'Readings',
  slides: 'Slides',
  transcript: 'Transcripts',
  textbook: 'Textbook',
  past_maps: 'Past maps',
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Unknown kinds and malformed rows are dropped; order is kept (the backend sends prompt order). */
export function parseSources(raw: unknown): SourceRef[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    const row = record(item);
    const kind = text(row?.kind) as SourceKind;

    if (!row || !KINDS.includes(kind)) return [];
    const itemId = text(row.itemId);

    return [{ kind, title: text(row.title) || SOURCE_LABEL[kind], ...(itemId ? { itemId } : {}) }];
  });
}

export function parseProvenance(data: unknown): Provenance {
  const body = record(data);

  return { model: text(body?.model) || null, sources: parseSources(body?.sources) };
}

export const hasProvenance = (value: Partial<Provenance> | null | undefined): boolean =>
  !!value && (!!value.model || (value.sources?.length ?? 0) > 0);

/** «GPT-6.1» for the primary model; anything else is the DeepSeek fallback. Null when unknown. */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;

  return /gpt-6\.1-sol/i.test(model) ? 'GPT-6.1' : 'DeepSeek (fallback)';
}

export interface SourceGroup {
  kind: SourceKind;
  label: string;
  count: number;
  items: SourceRef[];
}

/** One chip per kind, in order of first appearance. */
export function groupSources(sources: SourceRef[]): SourceGroup[] {
  const groups = new Map<SourceKind, SourceGroup>();

  for (const source of sources) {
    const group = groups.get(source.kind);

    if (group) {
      group.count += 1;
      group.items.push(source);
    } else groups.set(source.kind, { kind: source.kind, label: SOURCE_LABEL[source.kind], count: 1, items: [source] });
  }

  return [...groups.values()];
}

/** «Model answer» alone (there is only ever one); every other kind carries its count. */
export const chipText = (group: SourceGroup): string =>
  group.kind === 'model_answer' && group.count === 1 ? group.label : `${group.label} ${group.count}`;
