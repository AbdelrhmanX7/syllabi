// Demo mode: notebook details (PATCH fields + POST /pages/:id/describe) with deterministic fake AI.
// Same rules as the server (apps/server/src/services/study/page-meta.ts): a field the owner edited
// is never written by the "AI", and a cover picture is never made here (colour + icon only).
import type { DescribedPage, MetaEdited, MetaField, Page, PageCoverColor } from '../types';

import { StudyApiError } from '../errors';

import { isAutoNoteTitle } from '@/lib/notebooks/note-title';
import { META_DESCRIPTION_MAX, normalizeTags } from '@/lib/notebooks/page-meta';

const FIELDS: MetaField[] = ['title', 'description', 'tags', 'cover'];
const ICONS = ['book-open', 'calculator', 'sigma', 'atom', 'flask-conical', 'leaf', 'globe', 'brain', 'code', 'lightbulb'];
const COLORS: PageCoverColor[] = ['blue', 'star', 'green', 'amber', 'red', 'slate'];

/** Subject words the fake AI recognises in a notebook's name → its tags + icon. */
const SUBJECTS: { match: RegExp; tags: string[]; icon: string }[] = [
  { match: /calc|limit|deriv|integr/i, tags: ['math', 'calculus'], icon: 'sigma' },
  { match: /math|algebra|matrix|vector/i, tags: ['math', 'algebra'], icon: 'calculator' },
  { match: /phys|motion|force|energy/i, tags: ['physics'], icon: 'atom' },
  { match: /stat|probab/i, tags: ['statistics'], icon: 'chart-line' },
  { match: /chem/i, tags: ['chemistry'], icon: 'flask-conical' },
  { match: /bio|cell|gene/i, tags: ['biology'], icon: 'dna' },
  { match: /hist|war|empire/i, tags: ['history'], icon: 'landmark' },
  { match: /code|program|python|java/i, tags: ['programming'], icon: 'code' },
];

const hash = (value: string) => [...value].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/** Missing fields on a demo page saved before notebook details existed. */
export function withMetaDefaults(page: Page): Page {
  return {
    description: null,
    tags: [],
    cover: null,
    coverUrl: null,
    mathTools: 'auto',
    metaAiAt: null,
    metaAiVersion: null,
    ...page,
    metaEdited: editedOf(page),
  };
}

function editedOf(page: Page): MetaEdited {
  const flags = page.metaEdited;

  return {
    title: typeof flags?.title === 'boolean' ? flags.title : !isAutoNoteTitle(page.title),
    description: flags?.description === true,
    tags: flags?.tags === true,
    cover: typeof flags?.cover === 'boolean' ? flags.cover : page.cover?.by === 'user',
  };
}

const bad = (message: string) => new StudyApiError(400, message, 'VALIDATION_ERROR');

/** PATCH /pages/:id notebook-detail fields (title itself is handled by patchPageFields). */
export function patchPageMeta(page: Page, body: Record<string, unknown> | undefined): Page {
  const patch = body ?? {};
  const edited = editedOf(page);

  if ('title' in patch) edited.title = patch.titleByApp !== true;
  if ('description' in patch) {
    const value = patch.description;

    if (value !== null && (typeof value !== 'string' || value.length > META_DESCRIPTION_MAX))
      throw bad('description must be a string (max 300) or null');
    page.description = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || null : null;
    edited.description = true;
  }
  if ('tags' in patch) {
    if (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== 'string')) throw bad('tags must be a list');
    page.tags = normalizeTags(patch.tags as string[]);
    edited.tags = true;
  }
  if ('mathTools' in patch) {
    if (!['auto', 'on', 'off'].includes(String(patch.mathTools))) throw bad('mathTools must be auto, on or off');
    page.mathTools = patch.mathTools as Page['mathTools'];
  }
  if ('cover' in patch) {
    if (patch.cover !== null) throw bad('cover can only be removed');
    page.cover = null;
    page.coverUrl = null;
    edited.cover = true;
  }
  if (Array.isArray(patch.aiPick)) {
    for (const field of patch.aiPick as MetaField[]) if (FIELDS.includes(field)) edited[field] = false;
    if (patch.aiPick.length) page.metaAiVersion = null;
  }
  page.metaEdited = edited;

  return page;
}

/** POST /pages/:id/describe — fake AI from the notebook's name, class code and version. */
export function describeMockPage(page: Page, body: Record<string, unknown> | undefined, className: string | null): DescribedPage {
  const force = body?.force === true;
  const only = body?.only === 'cover';
  const current = withMetaDefaults(page);

  if (!force && !only && current.metaAiVersion !== null && current.metaAiVersion !== undefined && page.version <= current.metaAiVersion) {
    return { ...current, coverPending: false };
  }

  const edited = editedOf(page);

  if (only) edited.cover = false;
  const source = `${page.title} ${className ?? ''} ${typeof body?.fileName === 'string' ? body.fileName : ''}`;
  const subject = SUBJECTS.find((entry) => entry.match.test(source));
  const seed = hash(page.id);
  const topic = subject ? subject.tags[subject.tags.length - 1] : 'study';
  const tags = normalizeTags([...(subject?.tags ?? ['notes']), ...(className ? [className] : [])]);
  const title = `${topic[0].toUpperCase()}${topic.slice(1)} notes${page.version ? ` · part ${1 + (page.version % 4)}` : ''}`;

  if (!only) {
    if (!edited.title) page.title = title;
    if (!edited.description)
      page.description = `Handwritten ${topic} notes${className ? ` for ${className}` : ''}: worked examples and key ideas to review.`;
    if (!edited.tags) page.tags = tags;
    page.metaAiVersion = page.version;
  }
  if (!edited.cover) {
    page.cover = {
      kind: 'color',
      color: COLORS[(seed + (only ? page.version + 1 : 0)) % COLORS.length],
      icon: subject?.icon ?? ICONS[seed % ICONS.length],
      by: 'ai',
      updatedAt: new Date().toISOString(),
    };
    page.coverUrl = null;
  }
  page.metaEdited = edited;
  page.metaAiAt = new Date().toISOString();

  return { ...withMetaDefaults(page), coverPending: false };
}
