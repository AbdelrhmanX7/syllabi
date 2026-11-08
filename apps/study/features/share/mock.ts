// Demo-mode sharing (the mock transport calls `shareMockRoutes.json` before its own switch; undefined =
// not this path). Everything here is invented: made-up classmates and made-up material. «Make a copy»
// goes through the same transport (pages / questions / concept-map practice), so the copy shows up in
// the demo's notebooks, bank, flashcards and concept maps like anything else the user made.
// «Can edit»: the demo deck and concept map are shared to edit. Their study-route writes (PATCH / DELETE /
// POST /questions, PATCH /concept-maps/:id with the invented ids) are answered here, against this
// module's state, so edits stick for the session like they would on the owner's copy.
import type { ForkRecord, ForkResult, Share, SharedView, SharedWithMeItem, ShareResourceType, ShareRole } from './types';
import type { Page, Question, StudyClass } from '@/lib/api/types';

import { StudyApiError } from '@/lib/api/errors';
import { studyGet, studyPost, studyPutRaw } from '@/lib/api/http';

type Body = Record<string, unknown> | undefined;

const MINUTE = 60_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const token = () =>
  Array.from({ length: 43 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(Math.random() * 64)]).join('');

/* ------------------------------------------------------------------ invented material */

/** A handwritten-looking board: a title line and a few ink strokes (Fabric JSON, like a real page). */
function sampleBoard(title: string): string {
  const stroke = (left: number, top: number, d: (string | number)[][], color = '#1f3a8a') => ({
    type: 'Path',
    version: '7.2.0',
    left,
    top,
    originX: 'left',
    originY: 'top',
    fill: null,
    stroke: color,
    strokeWidth: 3,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    path: d,
  });
  const text = (left: number, top: number, value: string, size = 28, color = '#1f3a8a') => ({
    type: 'Textbox',
    version: '7.2.0',
    left,
    top,
    originX: 'left',
    originY: 'top',
    width: 620,
    text: value,
    fontSize: size,
    fontFamily: 'Caveat, Inter, sans-serif',
    fill: color,
  });
  const objects = [
    text(120, 70, title, 40),
    text(120, 140, 'Cell membrane = phospholipid bilayer', 28),
    text(120, 190, '• hydrophilic heads face water, tails inside', 24, '#334155'),
    text(120, 235, '• proteins: channels, carriers, receptors', 24, '#334155'),
    text(120, 280, '• osmosis: water moves toward higher solute', 24, '#334155'),
    stroke(120, 340, [['M', 0, 20], ['Q', 40, 0, 80, 20], ['Q', 120, 40, 160, 20], ['Q', 200, 0, 240, 20], ['Q', 280, 40, 320, 20]]),
    stroke(120, 380, [['M', 0, 20], ['Q', 40, 0, 80, 20], ['Q', 120, 40, 160, 20], ['Q', 200, 0, 240, 20], ['Q', 280, 40, 320, 20]]),
    stroke(470, 340, [['M', 0, 0], ['L', 0, 60], ['M', -12, 46], ['L', 0, 60], ['L', 12, 46]], '#b45309'),
    text(500, 355, 'water in', 22, '#b45309'),
  ];
  const now = Date.now();

  return JSON.stringify({
    id: 'shared',
    title,
    pages: [{ id: 'p1', backgroundType: 'lined', canvasJSON: JSON.stringify({ version: '7.2.0', objects }) }],
    currentPageIndex: 0,
    createdAt: now,
    updatedAt: now,
    thumbnail: '',
    viewportZoom: 1,
    schemaVersion: 1,
  });
}

const q = (stem: string, answer: string, topic: string, tags: string[] = []): Question =>
  ({
    id: uid('q'),
    classId: 'shared',
    topic,
    subtopic: null,
    difficulty: 2,
    source: { kind: 'manual', itemId: null, pageId: null, lectureId: null, ref: null },
    type: 'free',
    stem,
    imageUrl: null,
    choices: [],
    pairs: [],
    answer,
    solutionSteps: [],
    tags,
    stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
    srs: { dueAt: new Date().toISOString(), stability: 0, difficulty: 0, reps: 0, lapses: 0 },
    createdAt: ago(3 * DAY),
  }) as unknown as Question;

interface Incoming {
  item: SharedWithMeItem;
  view: SharedView['content'];
  /** Can edit: the owner's page / class / map id the study routes take. */
  resourceId?: string;
  topic?: string | null;
}

const DEMO_DECK_CLASS = 'shr_cls_organic';
const DEMO_MAP_ID = 'shr_map_cellcycle';

/** The invented items, made once per tab so «Can edit» changes stick. */
let incomingState: Incoming[] | null = null;

function incoming(): Incoming[] {
  incomingState ??= seedIncoming();

  return incomingState;
}

function seedIncoming(): Incoming[] {
  return [
    {
      item: { id: 'shr_demo_notebook', resourceType: 'notebook', title: 'Membranes and transport', ownerName: 'Maya Chen', role: 'viewer', sharedAt: ago(40 * MINUTE), updatedAt: ago(35 * MINUTE) },
      view: { kind: 'note', title: 'Membranes and transport', version: 4, contentUrl: null, updatedAt: ago(35 * MINUTE) },
    },
    {
      item: { id: 'shr_demo_deck', resourceType: 'deck', title: 'Organic functional groups', ownerName: 'Jonas Weber', role: 'editor', sharedAt: ago(5 * 3600_000), updatedAt: ago(2 * DAY) },
      resourceId: DEMO_DECK_CLASS,
      topic: 'Functional groups',
      view: {
        className: 'Organic Chemistry',
        topic: 'Functional groups',
        questions: [
          q('Hydroxyl group', '**–OH**, found in alcohols; makes molecules polar.', 'Functional groups', ['flashcard']),
          q('Carbonyl group', '**C=O**; aldehydes (end of chain) and ketones (middle).', 'Functional groups', ['flashcard']),
          q('Carboxyl group', '**–COOH**; acidic, gives carboxylic acids.', 'Functional groups', ['flashcard']),
          q('Amino group', '**–NH₂**; basic, found in amino acids.', 'Functional groups', ['flashcard']),
        ],
      },
    },
    {
      item: { id: 'shr_demo_questions', resourceType: 'questions', title: 'Kinematics (Physics 1)', ownerName: 'Priya Raman', role: 'viewer', sharedAt: ago(DAY), updatedAt: ago(DAY) },
      view: {
        className: 'Physics 1',
        topic: 'Kinematics',
        questions: [
          q('A ball is dropped from 20 m. How long until it hits the ground? (g = 9.8 m/s²)', '$t = \\sqrt{2h/g} \\approx 2.02\\,\\text{s}$', 'Kinematics'),
          q('A car speeds up from 0 to 27 m/s in 9 s. What is its average acceleration?', '$a = \\Delta v / \\Delta t = 3\\,\\text{m/s}^2$', 'Kinematics'),
          q('What does the area under a velocity–time graph give you?', 'The displacement.', 'Kinematics'),
        ],
      },
    },
    {
      item: { id: 'shr_demo_map', resourceType: 'conceptMap', title: 'Lecture 6: the cell cycle', ownerName: 'Leo Martins', role: 'editor', sharedAt: ago(3 * DAY), updatedAt: ago(3 * DAY) },
      resourceId: DEMO_MAP_ID,
      view: { className: 'Biology 101', lecture: 'Lecture 6: the cell cycle', week: 6, number: 3, promptTerms: ['interphase', 'mitosis', 'cytokinesis', 'checkpoint', 'cyclin', 'chromatid'] },
    },
  ];
}

/* ------------------------------------------------------------------ state (this tab only) */

const mine = new Map<string, Share>();
const forks: ForkRecord[] = [];
const refKey = (type: string, id: string, topic: string | null) => `${type}|${id}|${topic ?? ''}`;

const notFound = () => new StudyApiError(404, "This link doesn't work any more, or it wasn't shared with this account.", 'NOT_FOUND');
const bad = (message: string) => new StudyApiError(400, message, 'VALIDATION_ERROR');

function emailsOf(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad('emails must be a list');
  const out: string[] = [];

  for (const raw of v) {
    const email = String(raw).trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad(`"${String(raw)}" is not an email address`);
    if (!out.includes(email)) out.push(email);
  }

  return out;
}

const roleOf = (v: unknown): ShareRole => {
  if (v === undefined || v === null) return 'viewer';
  if (v === 'viewer' || v === 'editor') return v;
  throw bad('role must be viewer or editor');
};

function rolesOf(v: unknown): { email: string; role: ShareRole }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad('roles must be a list');

  return v.map((r) => ({ email: String((r as { email?: unknown })?.email ?? '').toLowerCase(), role: roleOf((r as { role?: unknown })?.role) }));
}

function applyChanges(
  share: Share,
  add: string[],
  remove: string[],
  link: unknown,
  role: ShareRole = 'viewer',
  roles: { email: string; role: ShareRole }[] = [],
): Share {
  const people = share.people
    .filter((p) => !remove.includes(p.email))
    .map((p) => ({ ...p, role: roles.find((r) => r.email === p.email)?.role ?? p.role }));

  for (const email of add) {
    if (!people.some((p) => p.email === email)) people.push({ email, role, name: null, joined: false });
  }
  let next: Share['link'] = share.link;

  if (link === true && !next) {
    const t = token();

    next = { role: 'viewer', token: t, url: `${typeof window === 'undefined' ? '' : window.location.origin}/shared/?id=${t}` };
  }
  if (link === false) next = null;

  return { ...share, people, link: next, updatedAt: new Date().toISOString() };
}

function findIncoming(idOrToken: string): Incoming | null {
  const fromList = incoming().find((i) => i.item.id === idOrToken);

  if (fromList) return fromList;
  // The user's own share, opened through its link (what the recipient would see).
  const own = [...mine.values()].find((s) => s.id === idOrToken || s.link?.token === idOrToken);

  if (!own) return null;

  return {
    item: { id: own.id, resourceType: own.resourceType, title: own.title, ownerName: 'You', role: 'viewer', sharedAt: own.createdAt, updatedAt: own.updatedAt },
    view: incoming().find((i) => i.item.resourceType === own.resourceType)!.view,
  };
}

async function viewOf(found: Incoming): Promise<SharedView> {
  const content =
    found.item.resourceType === 'notebook'
      ? { ...(found.view as object), contentUrl: `data:application/json,${encodeURIComponent(sampleBoard(found.item.title))}` }
      : found.view;

  const isOwner = found.item.ownerName === 'You';
  const role: ShareRole = isOwner ? 'editor' : found.item.role;

  return {
    share: {
      id: found.item.id,
      resourceType: found.item.resourceType,
      title: found.item.title,
      ownerName: found.item.ownerName,
      isOwner,
      role,
      ...(role === 'editor' && found.resourceId ? { resourceId: found.resourceId, topic: found.topic ?? null } : {}),
      updatedAt: found.item.updatedAt,
      editedBy: found.item.editedBy ?? null,
    },
    content: content as SharedView['content'],
  };
}

async function firstClass(): Promise<StudyClass | null> {
  const classes = await studyGet<StudyClass[]>('/classes');

  return classes[0] ?? null;
}

async function fork(found: Incoming): Promise<ForkResult> {
  const type: ShareResourceType = found.item.resourceType;
  let result: ForkResult;

  if (type === 'notebook') {
    const page = await studyPost<Page>('/pages', { classId: null, title: found.item.title, kind: 'note' });

    await studyPutRaw(`/pages/${encodeURIComponent(page.id)}/content/blob?baseVersion=0`, sampleBoard(found.item.title), 'application/json');
    result = { resourceType: type, resourceId: page.id, topic: null, classId: null };
  } else if (type === 'deck' || type === 'questions') {
    const cls = await firstClass();

    if (!cls) throw bad('Add a class first, then make a copy.');
    const content = found.view as { topic: string | null; questions: Question[] };

    await studyPost<Question[]>('/questions', {
      questions: content.questions.map((question) => ({
        classId: cls.id,
        topic: question.topic,
        type: question.type,
        difficulty: question.difficulty,
        stem: question.stem,
        answer: question.answer,
        solutionSteps: question.solutionSteps,
        tags: question.tags,
      })),
    });
    result = { resourceType: type, resourceId: cls.id, topic: content.topic, classId: cls.id };
  } else {
    const cls = await firstClass();

    if (!cls) throw bad('Add a class first, then make a copy.');
    const terms = (found.view as { promptTerms: string[] }).promptTerms;
    const map = await studyPost<{ id: string }>('/concept-maps/practice', { classId: cls.id, promptTerms: terms });

    result = { resourceType: type, resourceId: map.id, topic: null, classId: cls.id };
  }
  forks.unshift({
    resourceType: type,
    resourceId: result.resourceId,
    topic: result.topic,
    forkedFrom: { shareId: found.item.id, ownerName: found.item.ownerName, title: found.item.title, resourceType: type },
    createdAt: new Date().toISOString(),
  });

  return result;
}

/* ------------------------------------------------------------------ «Can edit» writes on the invented items */

const YOU = { name: 'You', at: null as string | null };

function touch(found: Incoming) {
  const now = new Date().toISOString();

  found.item = { ...found.item, updatedAt: now, editedBy: { ...YOU, at: now } };
}

function deckWithQuestion(id: string): { found: Incoming; content: { questions: Question[] } } | null {
  for (const found of incoming()) {
    const content = found.view as { questions?: Question[] };

    if (found.item.role === 'editor' && content.questions?.some((q) => q.id === id)) return { found, content: content as { questions: Question[] } };
  }

  return null;
}

/** PATCH / DELETE /questions/:id and POST /questions for the demo deck; undefined = not ours. */
function editRoutes(method: string, segments: string[], body: Body): { value: unknown } | undefined {
  if (segments[0] === 'questions' && segments[1] && segments.length === 2 && (method === 'PATCH' || method === 'DELETE')) {
    const hit = deckWithQuestion(decodeURIComponent(segments[1]));

    if (!hit) return undefined;
    const index = hit.content.questions.findIndex((q) => q.id === decodeURIComponent(segments[1]));

    if (method === 'DELETE') {
      hit.content.questions.splice(index, 1);
      touch(hit.found);

      return { value: undefined };
    }
    if (body?.classId !== undefined || body?.topic !== undefined) throw new StudyApiError(403, 'Only the owner can change that', 'FORBIDDEN');
    const prev = hit.content.questions[index];
    const next = {
      ...prev,
      ...(typeof body?.stem === 'string' ? { stem: body.stem } : {}),
      ...(typeof body?.answer === 'string' ? { answer: body.answer } : {}),
      editedBy: { ...YOU, at: new Date().toISOString() },
    } as Question;

    hit.content.questions[index] = next;
    touch(hit.found);

    return { value: next };
  }
  if (segments[0] === 'questions' && segments.length === 1 && method === 'POST') {
    const list = Array.isArray(body?.questions) ? (body!.questions as Record<string, unknown>[]) : [];
    const found = incoming().find((i) => i.resourceId && i.resourceId === list[0]?.classId && i.item.role === 'editor');

    if (!found || found.item.resourceType === 'conceptMap') return undefined;
    const content = found.view as { questions: Question[] };
    const added = list.map((raw) => ({
      ...q(String(raw.stem ?? ''), String(raw.answer ?? ''), String(raw.topic ?? found.topic ?? 'General'), (raw.tags as string[]) ?? []),
      editedBy: { ...YOU, at: new Date().toISOString() },
    }));

    content.questions.push(...added);
    touch(found);

    return { value: added };
  }
  if (segments[0] === 'concept-maps' && segments.length === 2 && method === 'PATCH') {
    const found = incoming().find((i) => i.resourceId === decodeURIComponent(segments[1]) && i.item.resourceType === 'conceptMap');

    if (!found) return undefined;
    if (body?.score !== undefined || body?.notesPageIds !== undefined) throw new StudyApiError(403, 'Only the owner can change the score', 'FORBIDDEN');
    const terms = Array.isArray(body?.promptTerms) ? (body!.promptTerms as unknown[]).map((t) => String(t).trim()).filter(Boolean) : [];

    if (!terms.length) throw bad('promptTerms must be 1–15 terms');
    touch(found);
    found.view = { ...(found.view as object), promptTerms: terms, editedBy: found.item.editedBy } as SharedView['content'];

    return { value: { id: found.resourceId, promptTerms: terms, editedBy: found.item.editedBy } };
  }

  return undefined;
}

/* ------------------------------------------------------------------ routes */

function json(method: string, path: string, body: Body): { value: unknown } | undefined {
  const [pathname, search = ''] = path.split('?');
  const segments = pathname.split('/').filter(Boolean);

  if (segments[0] !== 'share') return editRoutes(method, segments, body);
  const [, a, b] = segments;
  const query = new URLSearchParams(search);

  if (method === 'GET' && a === 'with-me') return { value: { items: incoming().map((i) => i.item) } };
  if (method === 'GET' && a === 'forks') return { value: { items: forks } };
  if (method === 'GET' && a === 'mine') {
    const k = refKey(query.get('resourceType') ?? '', query.get('resourceId') ?? '', query.get('topic'));

    return { value: { share: mine.get(k) ?? null } };
  }
  if (method === 'GET' && a === 'view' && b) {
    const found = findIncoming(decodeURIComponent(b));

    if (!found) throw notFound();

    return { value: viewOf(found) };
  }
  if (method === 'POST' && a === 'fork' && b) {
    const found = findIncoming(decodeURIComponent(b));

    if (!found) throw notFound();

    return { value: fork(found) };
  }
  if (method === 'POST' && !a) {
    const type = String(body?.resourceType ?? '') as ShareResourceType;
    const id = String(body?.resourceId ?? '');
    const topic = (body?.topic as string | null | undefined) || null;

    if (!['notebook', 'deck', 'questions', 'conceptMap'].includes(type) || !id) throw bad('resourceType and resourceId are required');
    const k = refKey(type, id, topic);
    const now = new Date().toISOString();
    const base: Share = mine.get(k) ?? {
      id: uid('shr'),
      resourceType: type,
      resourceId: id,
      topic,
      title: String(body?.title ?? topic ?? 'Shared item'),
      people: [],
      link: null,
      createdAt: now,
      updatedAt: now,
    };
    const share = applyChanges(base, emailsOf(body?.emails), [], body?.link, roleOf(body?.role));

    mine.set(k, share);

    return { value: { share } };
  }
  if (a && !b && (method === 'PATCH' || method === 'DELETE')) {
    const entry = [...mine.entries()].find(([, s]) => s.id === a);

    if (!entry) throw notFound();
    if (method === 'DELETE') {
      mine.delete(entry[0]);

      return { value: undefined };
    }
    const share = applyChanges(
      entry[1],
      emailsOf(body?.addEmails),
      emailsOf(body?.removeEmails),
      body?.link,
      roleOf(body?.role),
      rolesOf(body?.roles),
    );

    mine.set(entry[0], share);

    return { value: { share } };
  }

  return undefined;
}

export const shareMockRoutes = { json };
